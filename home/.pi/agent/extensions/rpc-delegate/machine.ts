/**
 * RPC-delegate lifecycle machine — one child per rpc_delegate_task call.
 *
 * Supervises a child pi (`pi --mode rpc --no-session`) through:
 * spawn → handshake (get_state) → prompt → run (event-driven) →
 * collect → stop (orderly shutdown ladder) → final outcome.
 *
 * The machine owns legality; services own IO (typed stubs here, wired in
 * index.ts, controllable stubs in test.ts — tmux-delegate pattern). The
 * machine receives a small typed event set, NOT raw RPC records: the
 * transport (transport.ts) converts raw JSONL into AGENT_x / TOOL_x / MESSAGE_END
 * events and keeps big evidence (text tails, stderr) in capped rings outside
 * context. Machine context holds only small scalars, counts, and rings
 * (tool names), plus the transport handle services need.
 *
 * State flow (every path except spawn-fail passes through collecting and
 * stopping — single collect path, single shutdown path, flat finals):
 *
 *   idle ──BEGIN──> spawning ──ok──> handshaking ──ok──> prompting
 *                      │                 │                  │
 *                    fail→ error      fail/t.o.→cancelling  response/handled
 *                                                        ├─ started/queued → running
 *                                                        ├─ handled → collecting (error, no-run)
 *                                                        └─ rejected/timeout → cancelling
 *
 *   running ──AGENT_SETTLED──> collecting (outcome settled; success evaluated
 *             at final routing)        ──CHILD_DEAD──> collecting (error)
 *           ──DEADLINE (after timeoutSecs)──> cancelling (timeout)
 *           ──KILL──> cancelling (aborted)   ──PROTOCOL_FATAL──> cancelling
 *           ──STEER/TOOL_x/EXT_UI/AGENT_x──> running (self, evidence)
 *           fast completion: agent_settled seen while prompting → running's
 *           `always` routes to collecting before the run deadline arms.
 *
 *   cancelling (ladder: clear_queue → abort → stdin close → TERM pg → KILL)
 *           ──CANCEL_DONE──> collecting
 *   collecting (artifact read, once) ──COLLECT_DONE──> stopping
 *   stopping (stats/export best-effort → orderly shutdown → TERM pg → KILL)
 *           ──CHILD_EXIT──> success | error | timeout | aborted
 *   spawn-fail: error directly — no collect (nothing ran), wired spawn
 *   service self-cleans (tmux-delegate parity).
 *
 * Outcome routing at stopping: timeout/aborted map directly; error maps
 * error; settled evaluates success semantics — run started + settled +
 * final assistant stopReason not error/abort/pending (artifact policy
 * "artifacts" forgives a bad stopReason when artifacts were collected;
 * default "stopReason" wins). CHILD_DEAD can arrive in ANY non-final state;
 * each state maps it (error via collecting, ignore where the local service
 * already observes exit, finals drop it).
 */
import { assign, fromPromise, setup } from "xstate";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ArtifactEntry {
	path: string;
	content: string;
	missing: boolean;
	/** Path exists but could not be read (EISDIR/EACCES/…) — counted like missing, never fake content. */
	readError?: string;
	truncated?: boolean;
}

export type DelegateStatus = "running" | "success" | "error" | "timeout" | "aborted";

/** Loose get_session_stats data — pi-version dependent, kept as evidence. */
export interface SessionStatsData {
	tokens?: ({ totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } & Record<string, unknown>);
	cost?: number;
	contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
	[k: string]: unknown;
}

/** Command response record (loose — raw RPC response fields we consume). */
export interface CommandResponse {
	success: boolean;
	data?: Record<string, unknown> | null;
	error?: string | null;
	[k: string]: unknown;
}

/** Bounded evidence held by the transport (outside machine context). */
export interface TransportEvidence {
	stderrTail: string;
	assistantTextTail: string;
	lastUsage: unknown | null;
	uiAutoCancelled: number;
	fatalReason: string | null;
}

/**
 * Machine-side view of the RPC transport. Real RpcTransport (transport.ts)
 * implements this; tests inject fakes. Keeps machine.ts free of node
 * child_process types — services call through this narrow surface.
 */
export interface TransportHandle {
	/** Send a JSONL command; resolves with the correlated response record.
	 *  Rejects on timeout (CommandTimeoutError), protocol fatal, or child death. */
	sendCommand(cmd: Record<string, unknown>, timeoutMs: number): Promise<CommandResponse>;
	alive(): boolean;
	closeStdin(): void;
	/** SIGTERM the child process group + watchdog (staged ladders call this). */
	killTerm(): void;
	/** SIGKILL the child process group + watchdog. */
	killKill(): void;
	/** TERM now + KILL shortly — abort paths that must not wait. */
	killHard(): void;
	/** Resolve when the child exits, or false after ms. */
	waitForExit(ms: number): Promise<boolean>;
	exitCode(): number | null;
	pid(): number | null;
	getEvidence(): TransportEvidence;
}

export interface RpcContext {
	/** Delegation id (also passed as the child's --name). */
	sessionId: string;
	task: string;
	agentPrompt: string | null;
	provider: string | null;
	model: string | null;
	/** Child tool allowlist (null = child default tools). */
	tools: string[] | null;
	artifactPolicy: "stopReason" | "artifacts";
	timeoutSecs: number;
	workingDir: string;
	artifactPaths: string[];

	/** IO handle — set from spawnService output. Null before spawn (and on spawn-fail). */
	transport: TransportHandle | null;
	childPid: number | null;
	childExit: number | null;
	childExitSignal: string | null;

	/** Child identity from the get_state handshake. */
	childSessionId: string | null;
	childModelId: string | null;

	// Run evidence (small scalars/counts/rings only)
	promptDisposition: string | null;
	runStartedSeen: boolean;
	agentSettledSeen: boolean;
	agentEndWillRetry: number;
	lastAssistantStopReason: string | null;
	lastAssistantError: string | null;
	toolCalls: number;
	lastToolNames: string[];
	uiRequests: number;
	lastSteer: string | null;

	// Outcome plumbing — set on the way into collecting/cancelling; routes finals
	outcome: "settled" | "error" | "timeout" | "aborted" | null;
	deadlineHit: boolean;
	failureDetail: string | null;
	protoFatal: string | null;

	artifacts: ArtifactEntry[];
	collected: boolean;
	summary: string;

	// stopService output (best-effort)
	usage: SessionStatsData | null;
	sessionExportPath: string | null;
}

// ---------------------------------------------------------------------------
// Events — the small typed set the transport forwards. Raw records never
// reach the machine.
// ---------------------------------------------------------------------------

/** Launch plumbing — content-through-events (never stored in context). */
export interface SpawnLaunch {
	pi: { command: string; args: string[] };
	parentPid: number;
	/** Machine-event sink — the transport forwards events through this. */
	sink: (ev: RpcEvent) => void;
	/** watchdog.mjs path (external orphan watchdog). */
	watchdogPath: string;
}

export type RpcEvent =
	| {
			type: "BEGIN";
			sessionId: string;
			task: string;
			agentPrompt: string | null;
			provider: string | null;
			model: string | null;
			tools: string[] | null;
			artifactPolicy: "stopReason" | "artifacts";
			timeoutSecs: number;
			workingDir: string;
			artifactPaths: string[];
			launch: SpawnLaunch;
	  }
	| { type: "KILL" }
	| { type: "CHILD_DEAD"; code: number | null; signal: string | null }
	| { type: "PROTOCOL_FATAL"; reason: string }
	| { type: "AGENT_START" }
	| { type: "AGENT_END"; willRetry: boolean }
	| { type: "AGENT_SETTLED" }
	| { type: "MESSAGE_END"; stopReason: string | null; errorMessage: string | null } // assistant only
	| { type: "TOOL_START"; toolName: string }
	| { type: "TOOL_END"; toolName: string; isError: boolean }
	| { type: "EXT_UI_REQUEST"; method: string; title: string }
	| { type: "STEER"; message: string };

// ---------------------------------------------------------------------------
// Service contracts (typed stubs; index.ts wires real IO, test.ts stubs)
// ---------------------------------------------------------------------------

export interface SpawnInput {
	sessionId: string;
	task: string;
	agentPrompt: string | null;
	provider: string | null;
	model: string | null;
	tools: string[] | null;
	workingDir: string;
	timeoutSecs: number;
	launch: SpawnLaunch;
}
export interface SpawnOutput {
	pid: number;
	transport: TransportHandle;
}

export interface HandshakeInput {
	transport: TransportHandle;
}
export interface HandshakeOutput {
	sessionId: string | null;
	modelId: string | null;
}

export interface PromptInput {
	transport: TransportHandle;
	task: string;
}
export interface PromptOutput {
	disposition: string;
}

export interface CollectInput {
	artifactPaths: string[];
	workingDir: string;
}
export interface CollectOutput {
	artifacts: ArtifactEntry[];
}

export interface CancelInput {
	transport: TransportHandle | null;
}
export interface CancelOutput {
	exitCode: number | null;
}

export interface StopInput {
	transport: TransportHandle | null;
	sessionId: string;
	/** Export the child session to HTML for debugging (failure paths). */
	exportSession: boolean;
}
export interface StopOutput {
	exitCode: number | null;
	usage: SessionStatsData | null;
	exportPath: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers — shared by guards, actions, and the tool
// ---------------------------------------------------------------------------

export function initialContext(): RpcContext {
	return {
		sessionId: "",
		task: "",
		agentPrompt: null,
		provider: null,
		model: null,
		tools: null,
		artifactPolicy: "stopReason",
		timeoutSecs: 300,
		workingDir: "",
		artifactPaths: [],
		transport: null,
		childPid: null,
		childExit: null,
		childExitSignal: null,
		childSessionId: null,
		childModelId: null,
		promptDisposition: null,
		runStartedSeen: false,
		agentSettledSeen: false,
		agentEndWillRetry: 0,
		lastAssistantStopReason: null,
		lastAssistantError: null,
		toolCalls: 0,
		lastToolNames: [],
		uiRequests: 0,
		lastSteer: null,
		outcome: null,
		deadlineHit: false,
		failureDetail: null,
		protoFatal: null,
		artifacts: [],
		collected: false,
		summary: "",
		usage: null,
		sessionExportPath: null,
	};
}

/** stopReason values that fail success semantics (plan: error/abort; pending
 *  is a protocol-weird final message). "length"/"deferred" surface as notes,
 *  not failures. */
const FAILING_STOP_REASONS = new Set(["error", "aborted", "pending"]);

export function stopReasonFails(stopReason: string | null): boolean {
	return stopReason !== null && FAILING_STOP_REASONS.has(stopReason);
}

/** Success semantics: run started + settled + final assistant stopReason ok
 *  (or artifacts collected and artifact policy trumps it). Returns a readable
 *  reason on failure. */
export function evaluateSuccess(c: RpcContext): { ok: boolean; reason: string | null } {
	if (c.promptDisposition === "handled") {
		return { ok: false, reason: "prompt was consumed by an input handler (disposition 'handled') — no agent run" };
	}
	if (!c.runStartedSeen) return { ok: false, reason: "no agent run started (agent_start never observed)" };
	if (!c.agentSettledSeen) return { ok: false, reason: "agent never settled (agent_settled not observed)" };
	const collectedCount = c.artifacts.filter((a) => !a.missing && !a.readError).length;
	if (stopReasonFails(c.lastAssistantStopReason) || c.lastAssistantError) {
		if (c.artifactPolicy === "artifacts" && collectedCount > 0) return { ok: true, reason: null };
		return {
			ok: false,
			reason: c.lastAssistantError
				? `final assistant message errored: ${c.lastAssistantError}`
				: `final assistant stopReason '${c.lastAssistantStopReason}'`,
		};
	}
	return { ok: true, reason: null };
}

/** Export the child session for debugging on failure-ish outcomes (called at
 *  stopping-time, after collect, so the artifact policy is evaluable). */
export function wantSessionExport(c: RpcContext): boolean {
	if (c.outcome === "error" || c.outcome === "timeout") return true;
	if (c.outcome === "settled") return !evaluateSuccess(c).ok;
	return false;
}

export function paramsViolation(
	task: string,
	timeoutSecs: number,
	artifactPaths: string[],
	provider: string | null,
	model: string | null,
	tools: string[] | null,
	artifactPolicy: string,
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
	if (provider && !model) {
		return "provider requires model (pass both, or neither)";
	}
	if (model !== null && !model.trim()) {
		return "model must be a non-empty string";
	}
	if (tools) {
		if (tools.length === 0) return "tools must be a non-empty allowlist or omitted";
		if (tools.length > 32) return `too many tools (${tools.length} > 32)`;
		if (tools.some((t) => !t.trim())) return "tool names must be non-empty strings";
	}
	if (artifactPolicy !== "stopReason" && artifactPolicy !== "artifacts") {
		return `artifactPolicy must be "stopReason" or "artifacts" (got ${artifactPolicy})`;
	}
	return null;
}

export function buildSummary(artifactPaths: string[], artifacts: ArtifactEntry[]): string {
	const collected = artifacts.filter((a) => !a.missing && !a.readError).length;
	const missing = artifacts.filter((a) => a.missing);
	const unreadable = artifacts.filter((a) => a.readError);
	let summary = `Collected ${collected}/${artifactPaths.length} artifacts.`;
	if (missing.length > 0) summary += ` Missing: ${missing.map((m) => m.path).join(", ")}.`;
	if (unreadable.length > 0) summary += ` Unreadable: ${unreadable.map((u) => u.path).join(", ")}.`;
	return summary;
}

/** Machine state value → tool status (non-terminal states collapse to "running"). */
export function statusOf(value: string): DelegateStatus {
	if (value === "success" || value === "error" || value === "timeout" || value === "aborted") {
		return value;
	}
	return "running";
}

const TOOL_RING_CAP = 8;

function pushToolRing(ring: string[], name: string): string[] {
	const next = [...ring, name];
	return next.length > TOOL_RING_CAP ? next.slice(next.length - TOOL_RING_CAP) : next;
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

function errMsg(ev: unknown): string {
	const e = (ev as { error?: unknown })?.error;
	return e instanceof Error ? e.message : String(e);
}

export const rpcMachine = setup({
	types: {
		context: {} as RpcContext,
		events: {} as RpcEvent,
	},
	delays: {
		// Run deadline — separate from every command timeout; arms at run start.
		// (Named delay: array-form `after` delay functions are not invoked.)
		runDeadline: ({ context }) => context.timeoutSecs * 1000,
	},
	actors: {
		// Typed stubs — real services injected via rpcMachine.provide() (index.ts;
		// test.ts wires controlled stubs). Unwired entry lands in a readable error.
		spawnService: fromPromise<SpawnOutput, SpawnInput>(async () => {
			throw new Error("spawnService not wired — rpcMachine.provide() must inject the spawn service");
		}),
		handshakeService: fromPromise<HandshakeOutput, HandshakeInput>(async () => {
			throw new Error("handshakeService not wired — rpcMachine.provide() must inject the handshake service");
		}),
		promptService: fromPromise<PromptOutput, PromptInput>(async () => {
			throw new Error("promptService not wired — rpcMachine.provide() must inject the prompt service");
		}),
		collectService: fromPromise<CollectOutput, CollectInput>(async () => {
			throw new Error("collectService not wired — rpcMachine.provide() must inject the collect service");
		}),
		cancelService: fromPromise<CancelOutput, CancelInput>(async () => {
			throw new Error("cancelService not wired — rpcMachine.provide() must inject the cancel service");
		}),
		stopService: fromPromise<StopOutput, StopInput>(async () => {
			throw new Error("stopService not wired — rpcMachine.provide() must inject the stop service");
		}),
	},
	guards: {
		beginLegal: ({ context, event }) =>
			event.type === "BEGIN" &&
			paramsViolation(
				event.task,
				event.timeoutSecs,
				event.artifactPaths,
				event.provider,
				event.model,
				event.tools,
				event.artifactPolicy,
			) === null &&
			context.sessionId === "",
		// promptService onDone routing (started/queued vs handled — no run)
		promptStarted: ({ event }) => {
			if (!("output" in event)) return false;
			const out = (event as { output: PromptOutput }).output;
			return out.disposition !== "handled";
		},
		promptHandled: ({ event }) => {
			if (!("output" in event)) return false;
			return (event as { output: PromptOutput }).output.disposition === "handled";
		},
		// Fast-completion race: settled already seen when running is entered
		settledFast: ({ context }) => context.agentSettledSeen && context.outcome === null,
		// Final routing at stopping (outcome + success semantics)
		routeTimeout: ({ context }) => context.outcome === "timeout",
		routeAborted: ({ context }) => context.outcome === "aborted",
		routeError: ({ context }) =>
			context.outcome === "error" ||
			context.outcome === null ||
			(context.outcome === "settled" && !evaluateSuccess(context).ok),
		routeSuccess: ({ context }) =>
			context.outcome === "settled" && evaluateSuccess(context).ok,
	},
	actions: {
		begin: assign(({ event }) => {
			if (event.type !== "BEGIN") return {};
			return {
				sessionId: event.sessionId,
				task: event.task,
				agentPrompt: event.agentPrompt,
				provider: event.provider,
				model: event.model,
				tools: event.tools,
				artifactPolicy: event.artifactPolicy,
				timeoutSecs: event.timeoutSecs,
				workingDir: event.workingDir,
				artifactPaths: event.artifactPaths,
			};
		}),
		recordSpawn: assign(({ event }) => {
			if (!("output" in event)) return {};
			const out = (event as { output: SpawnOutput }).output;
			return { childPid: out.pid, transport: out.transport };
		}),
		recordSpawnError: assign(({ event }) => {
			if (!("error" in event)) return {};
			return { failureDetail: `Failed to spawn RPC child: ${errMsg(event)}` };
		}),
		recordHandshake: assign(({ event }) => {
			if (!("output" in event)) return {};
			const out = (event as { output: HandshakeOutput }).output;
			return { childSessionId: out.sessionId, childModelId: out.modelId };
		}),
		markHandshakeError: assign(({ event }) => ({
			outcome: "error" as const,
			failureDetail: `Handshake failed: ${errMsg(event)}`,
		})),
		markPromptAccepted: assign(({ event }) => {
			if (!("output" in event)) return {};
			const out = (event as { output: PromptOutput }).output;
			return { promptDisposition: out.disposition, runStartedSeen: true };
		}),
		markHandled: assign(() => ({
			promptDisposition: "handled",
			outcome: "error" as const,
			failureDetail:
				"prompt was consumed by an input handler or extension command (disposition 'handled') — no agent run for this task",
		})),
		markPromptError: assign(({ event }) => ({
			outcome: "error" as const,
			failureDetail: `Prompt rejected or timed out: ${errMsg(event)}`,
		})),
		markDeadline: assign(({ context }) => ({
			outcome: "timeout" as const,
			deadlineHit: true,
			failureDetail: `run deadline exceeded (${context.timeoutSecs}s)`,
		})),
		markAborted: assign(({ context }) =>
			context.outcome === null ? { outcome: "aborted" as const } : {},
		),
		markFatal: assign(({ context, event }) => {
			if (event.type !== "PROTOCOL_FATAL") return {};
			return context.outcome === null
				? {
						outcome: "error" as const,
						protoFatal: event.reason,
						failureDetail: `RPC protocol violation: ${event.reason}`,
					}
				: { protoFatal: event.reason };
		}),
		markSettled: assign(({ context }) => {
			if (context.outcome !== null) return { agentSettledSeen: true };
			return { agentSettledSeen: true, outcome: "settled" as const };
		}),
		markChildDead: assign(({ context, event }) => {
			if (event.type !== "CHILD_DEAD") return {};
			const base = {
				childExit: event.code,
				childExitSignal: event.signal,
			};
			if (context.outcome !== null) return base;
			return {
				...base,
				outcome: "error" as const,
				failureDetail: `RPC child process died (exit ${event.code ?? "?"}${event.signal ? `, signal ${event.signal}` : ""}) — run lost`,
			};
		}),
		recordChildExit: assign(({ event }) => {
			if (event.type !== "CHILD_DEAD") return {};
			return { childExit: event.code, childExitSignal: event.signal };
		}),
		// Evidence self-transition actions (no target — no state re-entry)
		seeAgentStart: assign(() => ({ runStartedSeen: true })),
		// Settled observed before the prompt response resolved its path —
		// evidence only; running's `always` (settledFast) routes once accepted.
		seeSettled: assign(() => ({ agentSettledSeen: true })),
		seeAgentEnd: assign(({ event, context }) =>
			event.type === "AGENT_END"
				? { agentEndWillRetry: context.agentEndWillRetry + (event.willRetry ? 1 : 0) }
				: {},
		),
		seeMessageEnd: assign(({ event }) =>
			event.type === "MESSAGE_END"
				? { lastAssistantStopReason: event.stopReason, lastAssistantError: event.errorMessage }
				: {},
		),
		seeToolStart: assign(({ context, event }) =>
			event.type === "TOOL_START"
				? { toolCalls: context.toolCalls + 1, lastToolNames: pushToolRing(context.lastToolNames, event.toolName) }
				: {},
		),
		// Tool END only enters the ring when it failed — starts carry the name.
		seeToolEnd: assign(({ context, event }) =>
			event.type === "TOOL_END" && event.isError
				? { lastToolNames: pushToolRing(context.lastToolNames, `${event.toolName} (error)`) }
				: {},
		),
		seeUiRequest: assign(({ context }) => ({ uiRequests: context.uiRequests + 1 })),
		steerSent: assign(({ event }) => (event.type === "STEER" ? { lastSteer: event.message } : {})),
		collect: assign(({ context, event }) => {
			if (!("output" in event)) return {};
			const out = (event as { output: CollectOutput }).output;
			return {
				artifacts: out.artifacts,
				summary: buildSummary(context.artifactPaths, out.artifacts),
				collected: true,
			};
		}),
		collectFailed: assign(({ context, event }) => {
			if (!("error" in event)) return {};
			const msg = errMsg(event);
			return {
				artifacts: [],
				summary: `Collection failed: ${msg} (${context.artifactPaths.length} artifacts declared)`,
				collected: true,
			};
		}),
		recordStop: assign(({ event, context }) => {
			if (!("output" in event)) return {};
			const out = (event as { output: StopOutput }).output;
			return {
				childExit: out.exitCode ?? context.childExit,
				usage: out.usage ?? null,
				sessionExportPath: out.exportPath ?? null,
			};
		}),
	},
}).createMachine({
	id: "rpc-delegate",
	context: initialContext,
	initial: "idle",
	states: {
		idle: {
			on: { BEGIN: { guard: "beginLegal", target: "spawning", actions: "begin" } },
		},
		spawning: {
			invoke: {
				src: "spawnService",
				input: ({ event }) => {
					if (event.type !== "BEGIN") throw new Error(`spawning entered by ${event.type}`);
					return {
						sessionId: event.sessionId,
						task: event.task,
						agentPrompt: event.agentPrompt,
						provider: event.provider,
						model: event.model,
						tools: event.tools,
						workingDir: event.workingDir,
						timeoutSecs: event.timeoutSecs,
						launch: event.launch,
					};
				},
				onDone: { target: "handshaking", actions: "recordSpawn" },
				// Spawn-fail self-cleans (wired service kills what it made):
				// no transport handle, no collect, no stop — straight to error.
				onError: { target: "error", actions: "recordSpawnError" },
			},
			on: {
				KILL: { target: "cancelling", actions: "markAborted" },
				CHILD_DEAD: { target: "error", actions: "markChildDead" },
				PROTOCOL_FATAL: { target: "cancelling", actions: "markFatal" },
			},
		},
		handshaking: {
			invoke: {
				src: "handshakeService",
				input: ({ context }) => ({ transport: context.transport! }),
				onDone: { target: "prompting", actions: "recordHandshake" },
				onError: { target: "cancelling", actions: "markHandshakeError" },
			},
			on: {
				KILL: { target: "cancelling", actions: "markAborted" },
				CHILD_DEAD: { target: "collecting", actions: "markChildDead" },
				PROTOCOL_FATAL: { target: "cancelling", actions: "markFatal" },
			},
		},
		prompting: {
			invoke: {
				src: "promptService",
				input: ({ context }) => ({ transport: context.transport!, task: context.task }),
				onDone: [
					{ guard: "promptHandled", target: "collecting", actions: "markHandled" },
					{ guard: "promptStarted", target: "running", actions: "markPromptAccepted" },
				],
				onError: { target: "cancelling", actions: "markPromptError" },
			},
			// Fast-completion insurance: lifecycle events may arrive while the
			// prompt response is still in flight (response is written at
			// acceptance; run events follow) — record evidence, decide on response.
			on: {
				AGENT_START: { actions: "seeAgentStart" },
				AGENT_END: { actions: "seeAgentEnd" },
				AGENT_SETTLED: { actions: "seeSettled" },
				MESSAGE_END: { actions: "seeMessageEnd" },
				TOOL_START: { actions: "seeToolStart" },
				TOOL_END: { actions: "seeToolEnd" },
				EXT_UI_REQUEST: { actions: "seeUiRequest" },
				KILL: { target: "cancelling", actions: "markAborted" },
				CHILD_DEAD: { target: "collecting", actions: "markChildDead" },
				PROTOCOL_FATAL: { target: "cancelling", actions: "markFatal" },
			},
		},
		running: {
			// Run deadline — separate from every command timeout; arms at run start.
			after: { runDeadline: { target: "cancelling", actions: "markDeadline" } },
			// Fast completion race: agent_settled observed during prompting.
			always: [{ guard: "settledFast", target: "collecting", actions: "markSettled" }],
			on: {
				AGENT_START: { actions: "seeAgentStart" },
				AGENT_END: { actions: "seeAgentEnd" },
				AGENT_SETTLED: { target: "collecting", actions: "markSettled" },
				MESSAGE_END: { actions: "seeMessageEnd" },
				TOOL_START: { actions: "seeToolStart" },
				TOOL_END: { actions: "seeToolEnd" },
				EXT_UI_REQUEST: { actions: "seeUiRequest" },
				STEER: { actions: "steerSent" },
				KILL: { target: "cancelling", actions: "markAborted" },
				CHILD_DEAD: { target: "collecting", actions: "markChildDead" },
				PROTOCOL_FATAL: { target: "cancelling", actions: "markFatal" },
			},
		},
		// Cancellation ladder (clear_queue → abort → stdin close → TERM pg →
		// KILL), tolerant of dead/missing transport. Outcome was marked on entry.
		// Abort/deadline outcomes still collect (explicit policy — documented
		// difference from tmux-delegate's user-abort).
		cancelling: {
			invoke: {
				src: "cancelService",
				input: ({ context }) => ({ transport: context.transport }),
				onDone: { target: "collecting" },
				// Wired ladders never throw (best-effort rungs); an unwired stub
				// rejection would otherwise crash the actor — route on, collect
				// still runs, stopping routes finals by the marked outcome.
				onError: { target: "collecting" },
			},
			on: {
				// The ladder service observes exit itself; record the evidence.
				CHILD_DEAD: { actions: "recordChildExit" },
			},
		},
		collecting: {
			invoke: {
				src: "collectService",
				input: ({ context }) => ({
					artifactPaths: context.artifactPaths,
					workingDir: context.workingDir,
				}),
				onDone: { actions: "collect" },
				onError: { actions: "collectFailed" },
			},
			always: [{ guard: ({ context }) => context.collected, target: "stopping" }],
			on: {
				// Late user abort during collect: mark aborted, let collect finish
				// (self-transition — no re-entry, the invoke keeps running).
				KILL: { actions: "markAborted" },
				CHILD_DEAD: { actions: "recordChildExit" },
			},
		},
		stopping: {
			invoke: {
				src: "stopService",
				input: ({ context }) => ({
					transport: context.transport,
					sessionId: context.sessionId,
					exportSession: wantSessionExport(context),
				}),
				onDone: [
					{ guard: "routeTimeout", target: "timeout", actions: "recordStop" },
					{ guard: "routeAborted", target: "aborted", actions: "recordStop" },
					{ guard: "routeError", target: "error", actions: "recordStop" },
					{ guard: "routeSuccess", target: "success", actions: "recordStop" },
				],
				// Defensive: a stopService rejection routes the same finals by the
				// marked outcome (an unhandled rejection would crash the actor).
				onError: [
					{ guard: "routeTimeout", target: "timeout" },
					{ guard: "routeAborted", target: "aborted" },
					{ guard: "routeError", target: "error" },
					{ guard: "routeSuccess", target: "success" },
				],
			},
			on: {
				// The exit usually beats stopService's bounded wait: record the
				// evidence, but let stopService's onDone do the final routing —
				// its output carries usage + session export. A wedged service is
				// bounded (wait → TERM → KILL), so no route-on-exit fallback.
				CHILD_DEAD: { actions: "recordChildExit" },
			},
		},
		// Terminal states are final: late events are dropped.
		success: {},
		error: {},
		timeout: {},
		aborted: {},
	},
});
