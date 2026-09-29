/**
 * Delegation lifecycle machine for the tmux-delegate extension.
 *
 * One actor per delegate_task call — the machine is transient; the tool call
 * is its lifetime. The machine owns the FULL lifecycle and drives it via
 * invoked services (XState v5 `fromPromise`): spawn → monitor (the poll
 * loop) → collect. Every lifecycle decision — probe done → exit,
 * probe not-alive → session-dead, deadline → timeout, abort → kill — lives
 * in machine transitions or in the wired services' IO loop, NOT in the tool
 * (the old shape kept the poll loop in the tool: the machine "owned"
 * legality while the tool owned the lifecycle — half-true). The tool is now
 * thin: validate params with the machine's pure validators, send
 * BEGIN_DELEGATION, watch the abort signal (→ KILL), wait for settle, and
 * build the result from the snapshot. Status = state value, statusOf().
 *
 * Event flow (machine-driven; executors do IO, services wrap them and are
 * injected via `delegateMachine.provide()` — machine.ts ships typed stubs
 * only, throwing "not wired", so tests run without tmux):
 *
 *   BEGIN_DELEGATION {params, launch}   idle -> spawning (invoke spawnService)
 *     spawnService ok                   -> running (files recorded; invoke monitorService)
 *     spawnService fail                 -> error (failureDetail; NO collect — the
 *                                          task never ran; spawn self-cleans)
 *   running: monitorService (probe loop)
 *     {kind:"exit",  exitCode 0}        -> collecting (outcome success)
 *     {kind:"exit",  exitCode != 0}     -> collecting (outcome error)
 *     {kind:"dead"}                     -> collecting (outcome error)
 *     {kind:"deadline"}                -> collecting (outcome timeout; the
 *                                          service killed the session at
 *                                          the deadline before resolving)
 *     monitorService rejection          -> collecting (outcome error; wiring
 *                                          bug — readable failureDetail)
 *   collecting: invoke collectService (once per delegation)
 *     ok | fail                        -> success | error | timeout (the
 *                                          recorded outcome routes the final
 *                                          state; a collect failure records
 *                                          empty artifacts + the error as
 *                                          stderr — collection failed, not
 *                                          the task)
 *   KILL (user abort; tool observes its AbortSignal)
 *                                      -> aborted (NO collect — legacy: user
 *                                         abort reads no artifacts). Exiting
 *                                         `running` aborts monitorService; the
 *                                         wired service observes its
 *                                         AbortSignal and kills the tmux
 *                                         session best-effort.
 *
 * Terminal states are final: no events are handled there — late events are
 * dropped. Session-dead beats the old flow: a session that dies without
 * writing the signal file (external kill, OOM, bash crash) used to burn the
 * whole timeout; the service's liveness probe now resolves {kind:"dead"}
 * and the machine lands in `error` with a readable reason.
 */
import { assign, fromPromise, setup } from "xstate";

export interface ArtifactEntry {
	path: string;
	content: string;
	missing: boolean;
	/** Path exists but could not be read (EISDIR/EACCES/…) — counted like a
	 *  missing artifact (not collected), never as fake content. */
	readError?: string;
	truncated?: boolean;
}

/** Files the spawn executor creates (paths only; tool-side cleanup needs
 *  them all — kept in context, small strings). */
export interface SpawnFiles {
	signalFile: string;
	stderrFile: string;
	taskFile: string;
	scriptFile: string;
	promptFile: string | null;
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
	/** Spawn-created files (signalFile/stderrFile drive monitor + collect;
	 *  the tool's cleanup pass needs the rest). Null before spawn. */
	files: SpawnFiles | null;
	exitCode: number | null;
	/** Terminal outcome chosen on the way into `collecting` — routes the
	 *  final state after collect settles (single collect path, flat finals). */
	outcome: "success" | "error" | "timeout" | null;
	/** Human-readable failure detail (spawn error / session died) — shown as summary when no artifacts collected. */
	failureDetail: string | null;
	stderr: string;
	artifacts: ArtifactEntry[];
	summary: string;
	collected: boolean;
}

/** Launch params the spawn executor needs — computed tool-side, flow through
 *  the event into the service input (never into the snapshot — slide-deck's
 *  content-through-events pattern). */
export interface SpawnLaunch {
	/** Dir the tmux socket lives in (socketPath's parent). */
	socketDir: string;
	/** Extra system prompt for the delegated pi, or null. */
	agentPrompt: string | null;
	/** This pi's pid (parent kill-chain tagging). */
	parentPid: number;
	/** pi binary to run in the session (resolved by the extension — the
	 *  running pi's own invocation; spawn.mjs consumes { command, args }). */
	pi: { command: string; args: string[] };
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
			/** Spawn executor params (service input parity — not stored in context). */
			launch: SpawnLaunch;
	  }
	| { type: "KILL" };

// ---------------------------------------------------------------------------
// Service contracts (typed stubs here; index.ts wires the executors)
// ---------------------------------------------------------------------------

export interface SpawnServiceInput {
	sessionId: string;
	socketPath: string;
	task: string;
	workingDir: string;
	timeoutSecs: number;
	launch: SpawnLaunch;
}
export interface SpawnServiceOutput {
	sessionId: string;
	socketPath: string;
	files: SpawnFiles;
}

/** What the monitor service's poll loop concluded. */
export type MonitorOutcome =
	| { kind: "exit"; exitCode: number }
	| { kind: "dead" }
	| { kind: "deadline" };

export interface MonitorServiceInput {
	sessionId: string;
	socketPath: string;
	timeoutSecs: number;
	files: Pick<SpawnFiles, "signalFile" | "stderrFile">;
}
/** Monitor output IS the outcome ({kind, exitCode?}); the wired service
 *  resolves it — and kills the tmux session itself for "deadline" (and on
 *  its AbortSignal) — the lifecycle decision and its IO travel together. */
export type MonitorServiceOutput = MonitorOutcome;

export interface CollectServiceInput {
	artifactPaths: string[];
	workingDir: string;
	stderrFile: string | null;
}
export interface CollectServiceOutput {
	artifacts: ArtifactEntry[];
	stderr: string;
}

export function initialContext(): DelegateContext {
	return {
		sessionId: "",
		socketPath: "",
		task: "",
		monitor: false,
		timeoutSecs: 300,
		workingDir: "",
		artifactPaths: [],
		files: null,
		exitCode: null,
		outcome: null,
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
		summary += ` Unreadable: ${unreadable.map((u) => u.path).join(", ")}.`;
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
	actors: {
		// Typed stubs only — real executors are injected via
		// `delegateMachine.provide({ actors })` (index.ts wires spawn.mjs +
		// the probe loop + collect.mjs; test.ts wires controlled stubs —
		// slide-deck pattern). Machine.ts stays IO-free; an unwired machine
		// entering spawning/running lands in `error` with these errors.
		spawnService: fromPromise<SpawnServiceOutput, SpawnServiceInput>(
			async () => {
				throw new Error(
					"spawnService not wired — machine.provide() must inject the spawn executor",
				);
			},
		),
		monitorService: fromPromise<MonitorServiceOutput, MonitorServiceInput>(
			async () => {
				throw new Error(
					"monitorService not wired — machine.provide() must inject the monitor executor",
				);
			},
		),
		collectService: fromPromise<CollectServiceOutput, CollectServiceInput>(
			async () => {
				throw new Error(
					"collectService not wired — machine.provide() must inject the collect executor",
				);
			},
		),
	},
	guards: {
		beginLegal: ({ context, event }) =>
			event.type === "BEGIN_DELEGATION" &&
			paramsViolation(event.task, event.timeoutSecs, event.artifactPaths) === null &&
			context.sessionId === "",
		// monitorService onDone routing (DoneActorEvent carries `output`;
		// the local const narrows the outcome union — exitCode exists only
		// on the "exit" member)
		exitZero: ({ event }) => {
			if (!("output" in event)) return false;
			const out = (event as { output: MonitorServiceOutput }).output;
			return out.kind === "exit" && out.exitCode === 0;
		},
		exitNonZero: ({ event }) => {
			if (!("output" in event)) return false;
			const out = (event as { output: MonitorServiceOutput }).output;
			return out.kind === "exit" && out.exitCode !== 0;
		},
		monitorDead: ({ event }) =>
			"output" in event && (event as { output: MonitorServiceOutput }).output.kind === "dead",
		monitorDeadline: ({ event }) =>
			"output" in event &&
			(event as { output: MonitorServiceOutput }).output.kind === "deadline",
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
		recordSpawn: assign(({ event }) => {
			// onDone of spawnService — output echoes the id/socket (evidence
			// parity; the tool precomputed them) and carries the files
			if (!("output" in event)) return {};
			const out = (event as { output: SpawnServiceOutput }).output;
			return { sessionId: out.sessionId, socketPath: out.socketPath, files: out.files };
		}),
		recordSpawnError: assign(({ event }) => {
			// onError of spawnService — ErrorActorEvent carries `error`
			if (!("error" in event)) return {};
			const msg = String(
				(event as { error: unknown }).error instanceof Error
					? (event as { error: Error }).error.message
					: (event as { error: unknown }).error,
			);
			return { failureDetail: `Failed to create tmux session: ${msg}` };
		}),
		recordExit: assign(({ event }) => {
			if (!("output" in event)) return {};
			const out = (event as { output: MonitorServiceOutput }).output;
			return out.kind === "exit" ? { exitCode: out.exitCode } : {};
		}),
		// outcome marks — set on the way into `collecting`; route the final
		// state after collect settles (always-guards read them)
		markSuccess: assign(() => ({ outcome: "success" as const })),
		markError: assign(() => ({ outcome: "error" as const })),
		markTimeout: assign(() => ({ outcome: "timeout" as const })),
		recordMonitorError: assign(({ event }) => {
			// onError of monitorService — the monitor itself failed (wiring
			// bug): the task's fate is unknown; readable error, not a wedge
			if (!("error" in event)) return {};
			const msg = String(
				(event as { error: unknown }).error instanceof Error
					? (event as { error: Error }).error.message
					: (event as { error: unknown }).error,
			);
			return { failureDetail: `Monitor failed: ${msg}` };
		}),
		recordDead: assign(() => ({
			failureDetail:
				"session died without writing an exit code (tmux session gone, no signal file) — likely killed externally, OOM-killed, or bash crashed",
		})),
		recordAborted: assign(() => ({
			summary: "Aborted by user",
		})),
		collect: assign(({ context, event }) => {
			// onDone of collectService
			if (!("output" in event)) return {};
			const out = (event as { output: CollectServiceOutput }).output;
			return {
				artifacts: out.artifacts,
				stderr: out.stderr,
				summary: buildSummary(context.artifactPaths, out.artifacts),
				collected: true,
			};
		}),
		collectFailed: assign(({ context, event }) => {
			// onError of collectService — the collection failed, not the
			// task: empty artifacts, the error surfaced as stderr
			if (!("error" in event)) return {};
			const msg = String(
				(event as { error: unknown }).error instanceof Error
					? (event as { error: Error }).error.message
					: (event as { error: unknown }).error,
			);
			return {
				artifacts: [],
				stderr: `collection failed: ${msg}`,
				summary: `Collection failed: ${msg} (${context.artifactPaths.length} artifacts declared)`,
				collected: true,
			};
		}),
	},
}).createMachine({
	id: "delegate",
	context: () => initialContext(),
	initial: "idle",
	states: {
		idle: {
			on: {
				BEGIN_DELEGATION: { guard: "beginLegal", target: "spawning", actions: "begin" },
			},
		},
		spawning: {
			invoke: {
				src: "spawnService",
				input: ({ event }) => {
					if (event.type !== "BEGIN_DELEGATION") {
						throw new Error(`spawning entered by ${event.type}`);
					}
					return {
						sessionId: event.sessionId,
						socketPath: event.socketPath,
						task: event.task,
						workingDir: event.workingDir,
						timeoutSecs: event.timeoutSecs,
						launch: event.launch,
					};
				},
				onDone: { target: "running", actions: "recordSpawn" },
				// spawn failure self-cleans (executor behavior): no files to
				// clean, no artifacts to read — collect must NOT run
				onError: { target: "error", actions: "recordSpawnError" },
			},
			// user abort during spawn: exit aborts spawnService (the wired
			// service best-effort kills the session it may have created; the
			// tool's post-settle kill pass closes the race). A late spawn
			// result has no handler in `aborted` and is dropped.
			on: {
				KILL: { target: "aborted", actions: "recordAborted" },
			},
		},
		running: {
			invoke: {
				src: "monitorService",
				input: ({ context }) => ({
					sessionId: context.sessionId,
					socketPath: context.socketPath,
					timeoutSecs: context.timeoutSecs,
					files: {
						signalFile: context.files?.signalFile ?? "",
						stderrFile: context.files?.stderrFile ?? "",
					},
				}),
				onDone: [
					{
						guard: "exitZero",
						target: "collecting",
						actions: ["recordExit", "markSuccess"],
					},
					{
						guard: "exitNonZero",
						target: "collecting",
						actions: ["recordExit", "markError"],
					},
					{
						guard: "monitorDead",
						target: "collecting",
						actions: ["recordDead", "markError"],
					},
					{
						guard: "monitorDeadline",
						target: "collecting",
						actions: "markTimeout",
					},
				],
				// monitor rejection is a wiring bug (the wired service treats
				// probe failures as not-done/alive and resolves instead) —
				// collect still runs (task fate unknown; the artifacts are the
				// evidence), routed to `error`
				onError: {
					target: "collecting",
					actions: ["recordMonitorError", "markError"],
				},
			},
			// user abort: exit aborts monitorService; the wired service
			// observes its AbortSignal and kills the tmux session
			on: {
				KILL: { target: "aborted", actions: "recordAborted" },
			},
		},
		// Single collect path: entered once per delegation (never from
		// aborted, never from spawn-fail), one invoke definition, flat
		// terminal finals. The `always` routes only after collect settled
		// (collected flag gates it — outcome is set on entry, before the
		// collect runs).
		collecting: {
			invoke: {
				src: "collectService",
				input: ({ context }) => ({
					artifactPaths: context.artifactPaths,
					workingDir: context.workingDir,
					stderrFile: context.files?.stderrFile ?? null,
				}),
				// ok or fail: the outcome routes the final state; a collect
				// failure records empty artifacts + the error as stderr
				// (collection failed, not the task)
				onDone: { actions: "collect" },
				onError: { actions: "collectFailed" },
			},
			always: [
				{
					guard: ({ context }) => context.collected && context.outcome === "success",
					target: "success",
				},
				{
					guard: ({ context }) => context.collected && context.outcome === "error",
					target: "error",
				},
				{
					guard: ({ context }) => context.collected && context.outcome === "timeout",
					target: "timeout",
				},
			],
		},
		// Terminal states: final, no handlers — late events dropped.
		success: {},
		error: {},
		timeout: {},
		aborted: {},
	},
});
