/**
 * Delegation lifecycle machine for the tmux-delegate extension.
 *
 * One actor per delegate_task call — the machine is transient; the tool call
 * is its lifetime. Machine owns legality (event order: begin → spawn →
 * exit/deadline/kill → collect); executors own IO (spawn, probe, collect,
 * kill, cleanup) and embed evidence in events. The old ad-hoc status enum is
 * gone: tool results are built from the machine snapshot — status = state
 * value, see statusOf().
 *
 * Event flow (executor-driven, two-phase per IO step):
 *   BEGIN_DELEGATION -> (spawn IO)   -> SPAWN_OK | SPAWN_FAIL
 *   (probe IO)                        -> EXIT_SEEN {exitCode}
 *                                    | SESSION_DEAD            (no signal file, tmux session gone)
 *                                    | DEADLINE_HIT           (timeout)
 *                                    | KILL                   (user abort)
 *   (collect IO)                     -> COLLECT_DONE {artifacts, stderr}   (terminal states only)
 *
 * SESSION_DEAD is an improvement over the legacy flow: a session that dies
 * without writing the signal file (external kill, OOM, bash crash) used to
 * burn the whole timeout; now the probe reports liveness and the machine
 * lands in `error` with a readable reason instead of `timeout`.
 */
import { assign, setup } from "xstate";

export interface ArtifactEntry {
	path: string;
	content: string;
	missing: boolean;
	/** Path exists but could not be read (EISDIR/EACCES/…) — counted like a
	 *  missing artifact (not collected), never as fake content. */
	readError?: string;
	truncated?: boolean;
}

/** Tool-facing status: machine state value, with non-terminal states collapsed to "running". */
export type DelegateStatus = "running" | "success" | "error" | "timeout" | "aborted";

export interface DelegateContext {
	sessionId: string;
	socketPath: string;
	task: string;
	monitor: boolean;
	timeoutSecs: number;
	workingDir: string;
	artifactPaths: string[];
	exitCode: number | null;
	/** Human-readable failure detail (spawn error / session died) — shown as summary when no artifacts collected. */
	failureDetail: string | null;
	stderr: string;
	artifacts: ArtifactEntry[];
	summary: string;
	collected: boolean;
}

export type DelegateEvent =
	| {
			type: "BEGIN_DELEGATION";
			sessionId: string;
			socketPath: string;
			task: string;
			monitor: boolean;
			timeoutSecs: number;
			workingDir: string;
			artifactPaths: string[];
	  }
	| { type: "SPAWN_OK" }
	| { type: "SPAWN_FAIL"; error: string }
	| { type: "EXIT_SEEN"; exitCode: number }
	| { type: "SESSION_DEAD" }
	| { type: "DEADLINE_HIT" }
	| { type: "KILL" }
	| { type: "COLLECT_DONE"; artifacts: ArtifactEntry[]; stderr: string };

export function initialContext(): DelegateContext {
	return {
		sessionId: "",
		socketPath: "",
		task: "",
		monitor: false,
		timeoutSecs: 300,
		workingDir: "",
		artifactPaths: [],
		exitCode: null,
		failureDetail: null,
		stderr: "",
		artifacts: [],
		summary: "",
		collected: false,
	};
}

// ---------------------------------------------------------------------------
// Pure validators — shared by guards and the tool precheck (single source of
// truth; readable reasons surface directly in tool rejections)
// ---------------------------------------------------------------------------

export function paramsViolation(
	task: string,
	timeoutSecs: number,
	artifactPaths: string[],
): string | null {
	if (!task.trim()) {
		return "task is empty — describe what the delegated pi should do and the artifact files it should write";
	}
	if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) {
		return `timeout must be a positive number of seconds (got ${timeoutSecs})`;
	}
	const empty = artifactPaths.filter((p) => !p.trim());
	if (empty.length > 0) {
		return `artifact paths must be non-empty strings (got ${empty.length} empty)`;
	}
	// collect.mjs inlines every artifact's content into one JSON payload
	// (50KB each, maxBuffer-bounded) — cap the declared count so a huge list
	// cannot overflow the collect executor and lose everything
	if (artifactPaths.length > 64) {
		return `too many artifact paths (${artifactPaths.length} > 64) — declare fewer, larger artifacts`;
	}
	const seen = new Set<string>();
	const dupes: string[] = [];
	for (const p of artifactPaths) {
		const key = p.trim();
		if (seen.has(key)) dupes.push(key);
		seen.add(key);
	}
	if (dupes.length > 0) {
		return `duplicate artifact paths (each artifact is read once): ${dupes.join(", ")}`;
	}
	return null;
}

export function buildSummary(artifactPaths: string[], artifacts: ArtifactEntry[]): string {
	const collected = artifacts.filter((a) => !a.missing && !a.readError).length;
	const missing = artifacts.filter((a) => a.missing);
	const unreadable = artifacts.filter((a) => a.readError);
	let summary = `Collected ${collected}/${artifactPaths.length} artifacts.`;
	if (missing.length > 0) {
		summary += ` Missing: ${missing.map((m) => m.path).join(", ")}.`;
	}
	if (unreadable.length > 0) {
		summary += ` Unreadable: ${unreadable.map((m) => m.path).join(", ")}.`;
	}
	return summary;
}

/** Machine state value → tool status (idle/spawning/running collapse to "running"). */
export function statusOf(value: string): DelegateStatus {
	if (value === "success" || value === "error" || value === "timeout" || value === "aborted") {
		return value;
	}
	return "running";
}

export const delegateMachine = setup({
	types: {
		context: {} as DelegateContext,
		events: {} as DelegateEvent,
	},
	guards: {
		beginLegal: ({ context, event }) =>
			event.type === "BEGIN_DELEGATION" &&
			paramsViolation(event.task, event.timeoutSecs, event.artifactPaths) === null &&
			context.sessionId === "",
		exitZero: ({ event }) => event.type === "EXIT_SEEN" && event.exitCode === 0,
		notCollected: ({ context }) => !context.collected,
	},
	actions: {
		begin: assign(({ event }) => {
			if (event.type !== "BEGIN_DELEGATION") return {};
			return {
				sessionId: event.sessionId,
				socketPath: event.socketPath,
				task: event.task,
				monitor: event.monitor,
				timeoutSecs: event.timeoutSecs,
				workingDir: event.workingDir,
				artifactPaths: event.artifactPaths,
			};
		}),
		recordSpawnError: assign(({ event }) => {
			if (event.type !== "SPAWN_FAIL") return {};
			return { failureDetail: `Failed to create tmux session: ${event.error}` };
		}),
		recordDead: assign(() => ({
			failureDetail:
				"session died without writing an exit code (tmux session gone, no signal file) — likely killed externally, OOM-killed, or bash crashed",
		})),
		recordAborted: assign(() => ({
			summary: "Aborted by user",
		})),
		recordExit: assign(({ event }) => {
			if (event.type !== "EXIT_SEEN") return {};
			return { exitCode: event.exitCode };
		}),
		collect: assign(({ context, event }) => {
			if (event.type !== "COLLECT_DONE") return {};
			return {
				artifacts: event.artifacts,
				stderr: event.stderr,
				summary: buildSummary(context.artifactPaths, event.artifacts),
				collected: true,
			};
		}),
	},
}).createMachine({
	id: "delegate",
	context: ({}) => initialContext(),
	initial: "idle",
	states: {
		idle: {
			on: {
				BEGIN_DELEGATION: { guard: "beginLegal", target: "spawning", actions: "begin" },
			},
		},
		spawning: {
			on: {
				SPAWN_OK: "running",
				SPAWN_FAIL: { target: "error", actions: "recordSpawnError" },
			},
		},
		running: {
			on: {
				EXIT_SEEN: [
					{ guard: "exitZero", target: "success", actions: "recordExit" },
					{ target: "error", actions: "recordExit" },
				],
				SESSION_DEAD: { target: "error", actions: "recordDead" },
				DEADLINE_HIT: "timeout",
				KILL: { target: "aborted", actions: "recordAborted" },
			},
		},
		// Terminal states: artifacts/stderr collected once, then stay
		success: { on: { COLLECT_DONE: { guard: "notCollected", actions: "collect" } } },
		error: { on: { COLLECT_DONE: { guard: "notCollected", actions: "collect" } } },
		timeout: { on: { COLLECT_DONE: { guard: "notCollected", actions: "collect" } } },
		aborted: { on: { COLLECT_DONE: { guard: "notCollected", actions: "collect" } } },
	},
});
