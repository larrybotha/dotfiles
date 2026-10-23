/**
 * RPC-delegate lifecycle machine — one child per rpc_delegate_task call.
 *
 * Supervises a child pi (`pi --mode rpc --no-session`) through:
 * spawn → handshake (get_state) → prompt → run (event-driven) →
 * collect → stop (orderly shutdown ladder) → final outcome.
 *
 * The machine owns legality; services own IO (typed stubs here, wired in
 * index.ts, controllable stubs in test.ts). The
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
 *           ──DEADLINE (after timeoutSecs — hard-cap backstop)──> cancelling (timeout)
 *           ──STALL_DETECTED (silent child, no tool open)──> cancelling (timeout)
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
 *   service self-cleans.
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
	/** Millis of the last protocol byte from the child (null before any output)
	 *  — progress surfaces silence; the stall timer resets on it. */
	lastRecordAt: number | null;
	/** Child tools currently open (tool_execution_start − end) — the stall
	 *  timer is suppressed while > 0 (a child tool may run silently). */
	openTools: number;
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
	/** Child pi pid (pi rewrites its argv via process.title — the --name flag
	 *  is invisible to pgrep, so PID is the reliable process identity). */
	childPid(): number | null;
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
	getEvidence(): TransportEvidence;
}

/** The caller's request — carried unchanged through BEGIN → context → spawn
 *  (single-sourced: RpcContext, the BEGIN event, and SpawnInput compose from
 *  it; field docs live here once). */
export interface RequestSpec {
	/** Delegation id (also passed as the child's --name). */
	sessionId: string;
	task: string;
	agentPrompt: string | null;
	provider: string | null;
	model: string | null;
	/** Child tool allowlist (null = child default tools). */
	tools: string[] | null;
	/** Extension file paths loaded into the child via pi's --extension
	 * flag (explicit paths load even under the child's --no-extensions
	 * default). Null = none. */
	extensions: string[] | null;
	/** This process's delegation depth (0 = top-level pi; a child spawned
	 *  by rpc_delegate_task inherits RPC_DELEGATE_DEPTH = parent depth + 1). */
	depth: number;
	/** Ceiling granted to this call's child tree: per-call maxDepth param
	 *  (default 1 — the child cannot delegate further), clamped to the
	 *  ancestor-granted RPC_DELEGATE_MAX_DEPTH (a child can never raise it). */
	maxDepth: number;
	artifactPolicy: "stopReason" | "artifacts";
	timeoutSecs: number;
	workingDir: string;
	artifactPaths: string[];
}

export interface RpcContext extends RequestSpec {
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
	/** Success verdict computed once at `stopping` entry (outcome settled only)
	 *  — the route guards read it instead of re-running evaluateSuccess. */
	successVerdict: boolean | null;
	deadlineHit: boolean;
	/** Stall detection fired (silent child) — distinct from the hard-cap deadline. */
	stallHit: boolean;
	failureDetail: string | null;
	protoFatal: string | null;

	artifacts: ArtifactEntry[];
	collected: boolean;
	summary: string;

	// stopService output (best-effort)
	usage: SessionStatsData | null;

	// Timing evidence (machine clock, stamped by actions): beginAt (BEGIN
	// accepted), runStartedAt (prompt accepted — run arms), runEndedAt (first
	// outcome mark: settle / deadline / stall / abort / fatal / child death;
	// may predate run start on pre-run failures — runDuration guards), endedAt
	// (terminal entry — collect + stop ladders included). runDuration pairs
	// with cost (usage accrues while the agent runs); totalDuration is the
	// whole delegation, ladders included.
	beginAt: number | null;
	runStartedAt: number | null;
	runEndedAt: number | null;
	endedAt: number | null;
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
	/** Stall gap in ms (0 = disabled): the transport's liveness timer — any
	 *  protocol bytes reset it, suppressed while a child tool is open, fires
	 *  STALL_DETECTED on silence. Duration-agnostic hang detection. */
	stallGapMs: number;
	/** Heartbeat file path ({t, open} JSON) — the external watchdog enforces
	 *  the same stall policy if the extension process itself wedges. */
	heartbeatPath: string | null;
}

export type RpcEvent =
	| ({ type: "BEGIN"; launch: SpawnLaunch } & RequestSpec)
	| { type: "KILL" }
	| { type: "CHILD_DEAD"; code: number | null; signal: string | null }
	| { type: "PROTOCOL_FATAL"; reason: string }
	// Transport stall observer: silence beyond the gap with no child tool open.
	| { type: "STALL_DETECTED"; stallMs: number }
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

export interface SpawnInput extends Omit<RequestSpec, "artifactPolicy" | "artifactPaths"> {
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
}
export interface StopOutput {
	exitCode: number | null;
	usage: SessionStatsData | null;
}

// ---------------------------------------------------------------------------
// Pure helpers — shared by guards, actions, and the tool
// ---------------------------------------------------------------------------

export function isRec(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Artifact "collected" predicate — single source for the four consumers
 *  (success semantics, summary, telemetry artifactOk, render). */
export function isCollected(a: ArtifactEntry): boolean {
	return !a.missing && !a.readError;
}

export function initialContext(): RpcContext {
	return {
		sessionId: "",
		task: "",
		agentPrompt: null,
		provider: null,
		model: null,
		tools: null,
		extensions: null,
		depth: 0,
		maxDepth: 1,
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
		successVerdict: null,
		deadlineHit: false,
		stallHit: false,
		failureDetail: null,
		protoFatal: null,
		artifacts: [],
		collected: false,
		summary: "",
		usage: null,
		beginAt: null,
		runStartedAt: null,
		runEndedAt: null,
		endedAt: null,
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
	const collectedCount = c.artifacts.filter(isCollected).length;
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


/** Summary text for a snapshot. evaluateSuccess is a verdict about a
 *  COMPLETED run — "agent never settled" is true by definition on a live
 *  snapshot, so a non-final state gets a progress line, never a premature
 *  "run failed" (the TUI renders partial results through the expanded
 *  result view while the tool runs). Terminal states: failureDetail,
 *  collect summary, else the success semantics (assistant tail or reason). */
export function summaryForSnapshot(
	stateName: string,
	c: RpcContext,
	assistantTextTail: string,
): string {
	if (statusOf(stateName) === "running") {
		return `in progress (${stateName}) — no verdict until the run settles`;
	}
	const evalReason = evaluateSuccess(c);
	return (
		c.failureDetail ??
		(c.summary || (evalReason.ok ? assistantTextTail || "run completed" : `run failed: ${evalReason.reason}`))
	);
}

/** Depth gate — the recursion bound. depth = how many delegation hops
 *  produced THIS process (0 = top-level pi, inherited via
 *  RPC_DELEGATE_DEPTH); maxDepth = the ceiling granted to this call's
 *  child tree (per-call maxDepth param, default 1, clamped to the
 *  ancestor-granted RPC_DELEGATE_MAX_DEPTH — never raisable by a child).
 *  Allowed iff depth < maxDepth; the budget passes down as
 *  min(request, inherited) — monotone. The gate rides process env, so it
 *  holds through every load route: -e paths, copies, symlinks, wrappers,
 *  and bash sub-spawns — lineage, not path identity. */
export function depthViolation(depth: number, maxDepth: number): string | null {
	if (!Number.isInteger(depth) || depth < 0) {
		return `depth must be a non-negative integer (got ${depth})`;
	}
	if (!Number.isInteger(maxDepth) || maxDepth < 1) {
		return `maxDepth must be an integer >= 1 (got ${maxDepth})`;
	}
	if (depth >= maxDepth) {
		return `delegation depth exhausted: this process is a delegated child at depth ${depth} and the ceiling is ${maxDepth} (ancestor-granted, cannot be raised) — raise maxDepth in the top-level rpc_delegate_task call or delegate from a top-level pi`;
	}
	return null;
}

/** Trimmed keys appearing more than once in the list (artifact/extension
 *  paths — each declared item must be unique; the dupe-detection itself is
 *  single-sourced). */
function duplicateKeys(items: string[]): string[] {
	const seen = new Set<string>();
	const dupes: string[] = [];
	for (const item of items) {
		const key = item.trim();
		if (seen.has(key)) dupes.push(key);
		seen.add(key);
	}
	return dupes;
}

export function paramsViolation(
	task: string,
	timeoutSecs: number,
	artifactPaths: string[],
	provider: string | null,
	model: string | null,
	tools: string[] | null,
	artifactPolicy: string,
	extensions?: string[] | null,
	maxDepth?: number | null,
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
	const artifactDupes = duplicateKeys(artifactPaths);
	if (artifactDupes.length > 0) {
		return `duplicate artifact paths (each artifact is read once): ${artifactDupes.join(", ")}`;
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
	if (extensions) {
		if (extensions.length === 0) {
			return "extensions must be a non-empty list of paths or omitted";
		}
		if (extensions.length > 8) return `too many extension paths (${extensions.length} > 8)`;
		if (extensions.some((e) => !e.trim())) return "extension paths must be non-empty strings";
		const extDupes = duplicateKeys(extensions);
		if (extDupes.length > 0) {
			return `duplicate extension paths (each is loaded once): ${extDupes.join(", ")}`;
		}
	}
	if (maxDepth != null && (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4)) {
		return `maxDepth must be an integer in [1, 4] (got ${maxDepth})`;
	}
	if (artifactPolicy !== "stopReason" && artifactPolicy !== "artifacts") {
		return `artifactPolicy must be "stopReason" or "artifacts" (got ${artifactPolicy})`;
	}
	return null;
}

export function buildSummary(artifactPaths: string[], artifacts: ArtifactEntry[]): string {
	const collected = artifacts.filter(isCollected).length;
	const missing = artifacts.filter((a) => a.missing);
	const unreadable = artifacts.filter((a) => a.readError);
	let summary = `Collected ${collected}/${artifactPaths.length} artifacts.`;
	if (missing.length > 0) summary += ` Missing: ${missing.map((m) => m.path).join(", ")}.`;
	if (unreadable.length > 0) summary += ` Unreadable: ${unreadable.map((u) => u.path).join(", ")}.`;
	return summary;
}

/** Agent-run duration (prompt accepted → outcome decided) — pairs with cost:
 *  usage accrues while the agent runs. Null before run start or until the
 *  outcome is decided — honest evidence, never a guessed duration. */
export function runDurationMs(c: RpcContext): number | null {
	return c.runStartedAt !== null && c.runEndedAt !== null ? c.runEndedAt - c.runStartedAt : null;
}

/** Whole-delegation duration (BEGIN → terminal entry): spawn, handshake,
 *  collect, and stop ladders included. */
export function totalDurationMs(c: RpcContext): number | null {
	return c.beginAt !== null && c.endedAt !== null ? c.endedAt - c.beginAt : null;
}

/** Compact duration text: 42s / 2m 04s / 1h 03m 05s (floor, min 1s). */
export function formatDuration(ms: number): string {
	const s = Math.max(1, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
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

/** assign() factory: apply a context patch when the triggering event is
 *  `kind` ({} otherwise) — the event-type guard + narrowing lives here once,
 *  not in every action; apply() gets the narrowed event + current context.
 *  (event is annotated RpcEvent — the exact catalog type XState expects;
 *  synthetic done/error events never reach machine-event actions.) */
function on<K extends RpcEvent["type"]>(
	kind: K,
	apply: (ev: Extract<RpcEvent, { type: K }>, c: RpcContext) => Partial<RpcContext>,
) {
	return assign<RpcContext, RpcEvent, undefined, RpcEvent, never>(({ context, event }) =>
		event.type === kind ? apply(event as Extract<RpcEvent, { type: K }>, context) : {},
	);
}

/** assign() factory for invoke onDone events: apply(output) when the event
 *  carries one ({} otherwise) — the probe-then-cast boilerplate lives here
 *  once, not in every done action. (Runtime done events are not RpcEvents;
 *  the annotation matches the action catalog, the cast is local.) */
function onOutput<T>(apply: (output: T, c: RpcContext) => Partial<RpcContext>) {
	return assign<RpcContext, RpcEvent, undefined, RpcEvent, never>(({ context, event }) => {
		const out = (event as { output?: unknown }).output;
		return out !== undefined ? apply(out as T, context) : {};
	});
}

/** Identical handlers shared by prompting and running: evidence-only
 *  actions plus the identical lifecycle exits (KILL / CHILD_DEAD /
 *  PROTOCOL_FATAL). AGENT_SETTLED differs — evidence-only pre-acceptance vs
 *  routed to collecting — and stays state-local. Single source: the two
 *  `on` blocks cannot drift apart. */
const SHARED_RUN_ON = {
	AGENT_START: { actions: "seeAgentStart" },
	AGENT_END: { actions: "seeAgentEnd" },
	MESSAGE_END: { actions: "seeMessageEnd" },
	TOOL_START: { actions: "seeToolStart" },
	TOOL_END: { actions: "seeToolEnd" },
	EXT_UI_REQUEST: { actions: "seeUiRequest" },
	KILL: { target: "cancelling", actions: "markAborted" },
	CHILD_DEAD: { target: "collecting", actions: "markChildDead" },
	PROTOCOL_FATAL: { target: "cancelling", actions: "markFatal" },
} as const;

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
				event.extensions ?? null,
				event.maxDepth,
			) === null &&
			depthViolation(event.depth, event.maxDepth) === null &&
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
			(context.outcome === "settled" && context.successVerdict === false),
		routeSuccess: ({ context }) =>
			context.outcome === "settled" && context.successVerdict === true,
	},
	actions: {
		begin: assign(({ event }) => {
			if (event.type !== "BEGIN") return {};
			const { type: _type, launch: _launch, ...spec } = event;
			return { ...spec, beginAt: Date.now() };
		}),
		recordSpawn: onOutput<SpawnOutput>((out) => ({ childPid: out.pid, transport: out.transport })),
		recordSpawnError: assign(({ event }) => {
			if (!("error" in event)) return {};
			return { failureDetail: `Failed to spawn RPC child: ${errMsg(event)}` };
		}),
		recordHandshake: onOutput<HandshakeOutput>((out) => ({
			childSessionId: out.sessionId,
			childModelId: out.modelId,
		})),
		markHandshakeError: assign(({ event }) => ({
			outcome: "error" as const,
			failureDetail: `Handshake failed: ${errMsg(event)}`,
		})),
		markPromptAccepted: onOutput<PromptOutput>((out) => ({
			promptDisposition: out.disposition,
			runStartedSeen: true,
			runStartedAt: Date.now(),
		})),
		markHandled: assign(() => ({
			promptDisposition: "handled",
			outcome: "error" as const,
			runEndedAt: Date.now(),
			failureDetail:
				"prompt was consumed by an input handler or extension command (disposition 'handled') — no agent run for this task",
		})),
		markPromptError: assign(({ event }) => ({
			outcome: "error" as const,
			runEndedAt: Date.now(),
			failureDetail: `Prompt rejected or timed out: ${errMsg(event)}`,
		})),
		markDeadline: assign(({ context }) => ({
			outcome: "timeout" as const,
			deadlineHit: true,
			runEndedAt: Date.now(),
			failureDetail: `run hard cap exceeded (${context.timeoutSecs}s)`,
		})),
		markStalled: on("STALL_DETECTED", (ev) => ({
			outcome: "timeout" as const,
			stallHit: true,
			runEndedAt: Date.now(),
			failureDetail: `child stalled — no protocol activity for ${Math.round(ev.stallMs / 1000)}s (no child tool running); cancelled by stall detection`,
		})),
		markAborted: on("KILL", (ev, c) =>
			c.outcome === null ? { outcome: "aborted" as const, runEndedAt: Date.now() } : {},
		),
		markFatal: on("PROTOCOL_FATAL", (ev, c) =>
			c.outcome === null
				? { outcome: "error" as const, protoFatal: ev.reason, runEndedAt: Date.now(), failureDetail: `RPC protocol violation: ${ev.reason}` }
				: { protoFatal: ev.reason },
		),
		// Context-only, deliberately NOT on("AGENT_SETTLED"): fires from two
		// contexts — running.on.AGENT_SETTLED (real event) AND running's
		// `always` settledFast exit, whose triggering event is the prompt-service
		// onDone, not AGENT_SETTLED. The settledFast guard already proves the
		// settle was observed; the event guard would no-op here and strand
		// outcome=null → routeError.
		// Single evaluateSuccess call per delegation: computed at stopping entry
		// (after collect, so artifacts are final), read by both route guards.
		computeVerdict: assign(({ context }) => ({
			successVerdict: context.outcome === "settled" ? evaluateSuccess(context).ok : null,
		})),
		markSettled: assign(({ context }) =>
			context.outcome === null
				? { agentSettledSeen: true, outcome: "settled" as const, runEndedAt: Date.now() }
				: { agentSettledSeen: true },
		),
		markChildDead: on("CHILD_DEAD", (ev, c) => {
			const base = { childExit: ev.code, childExitSignal: ev.signal };
			if (c.outcome !== null) return base;
			return {
				...base,
				outcome: "error" as const,
				runEndedAt: Date.now(),
				failureDetail: `RPC child process died (exit ${ev.code ?? "?"}${ev.signal ? `, signal ${ev.signal}` : ""}) — run lost`,
			};
		}),
		// Evidence self-transition actions (no target — no state re-entry)
		seeAgentStart: on("AGENT_START", () => ({ runStartedSeen: true })),
		// Settled observed before the prompt response resolved its path —
		// evidence only; running's `always` (settledFast) routes once accepted.
		seeSettled: on("AGENT_SETTLED", () => ({ agentSettledSeen: true })),
		seeAgentEnd: on("AGENT_END", (ev, c) => ({
			agentEndWillRetry: c.agentEndWillRetry + (ev.willRetry ? 1 : 0),
		})),
		seeMessageEnd: on("MESSAGE_END", (ev) => ({
			lastAssistantStopReason: ev.stopReason,
			lastAssistantError: ev.errorMessage,
		})),
		seeToolStart: on("TOOL_START", (ev, c) => ({
			toolCalls: c.toolCalls + 1,
			lastToolNames: pushToolRing(c.lastToolNames, ev.toolName),
		})),
		// Tool END only enters the ring when it failed — starts carry the name.
		seeToolEnd: on("TOOL_END", (ev, c) =>
			ev.isError ? { lastToolNames: pushToolRing(c.lastToolNames, `${ev.toolName} (error)`) } : {},
		),
		seeUiRequest: on("EXT_UI_REQUEST", (ev, c) => ({ uiRequests: c.uiRequests + 1 })),
		steerSent: on("STEER", (ev) => ({ lastSteer: ev.message })),
		collect: onOutput<CollectOutput>((out, c) => ({
			artifacts: out.artifacts,
			summary: buildSummary(c.artifactPaths, out.artifacts),
			collected: true,
		})),
		collectFailed: assign(({ context, event }) => {
			if (!("error" in event)) return {};
			const msg = errMsg(event);
			return {
				artifacts: [],
				summary: `Collection failed: ${msg} (${context.artifactPaths.length} artifacts declared)`,
				collected: true,
			};
		}),
		recordStop: onOutput<StopOutput>((out, c) => ({
			childExit: out.exitCode ?? c.childExit,
			usage: out.usage ?? null,
		})),
		// Terminal entry stamp — whole-delegation duration (BEGIN → terminal)
		// includes the collect + stop ladders; guarded (finals entered once).
		markEnded: assign(({ context }) => (context.endedAt === null ? { endedAt: Date.now() } : {}))
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
					const { type: _type, artifactPolicy: _policy, artifactPaths: _paths, ...spawnInput } = event;
					return spawnInput;
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
				...SHARED_RUN_ON,
				AGENT_SETTLED: { actions: "seeSettled" },
			},
		},
		running: {
			// Run deadline = the HARD-CAP backstop (not expected duration — stall
			// detection owns hang detection); separate from every command
			// timeout; arms at run start.
			after: { runDeadline: { target: "cancelling", actions: "markDeadline" } },
			// Fast completion race: agent_settled observed during prompting.
			always: [{ guard: "settledFast", target: "collecting", actions: "markSettled" }],
			on: {
				...SHARED_RUN_ON,
				AGENT_SETTLED: { target: "collecting", actions: "markSettled" },
				STEER: { actions: "steerSent" },
				// Silent child (no protocol bytes, no open child tool) — the
				// transport's liveness timer fired. Pre-run states do NOT declare
				// this: their command timeouts (≤60s) beat the stall gap, so a
				// stall there is unreachable by construction.
				STALL_DETECTED: { target: "cancelling", actions: "markStalled" },
			},
		},
		// Cancellation ladder (clear_queue → abort → stdin close → TERM pg →
		// KILL), tolerant of dead/missing transport. Outcome was marked on entry.
		// Abort/deadline outcomes still collect (explicit policy).
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
				// The ladder service observes exit itself — outcome is already
				// marked, so markChildDead degrades to the exit evidence.
				CHILD_DEAD: { actions: "markChildDead" },
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
				CHILD_DEAD: { actions: "markChildDead" },
			},
		},
		stopping: {
			entry: ["computeVerdict"],
			invoke: {
				src: "stopService",
				input: ({ context }) => ({
					transport: context.transport,
					sessionId: context.sessionId,
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
				CHILD_DEAD: { actions: "markChildDead" },
			},
		},
		// Terminal states are final: late events are dropped (entry stamps
		// endedAt — totalDuration evidence).
		success: { entry: ["markEnded"] },
		error: { entry: ["markEnded"] },
		timeout: { entry: ["markEnded"] },
		aborted: { entry: ["markEnded"] },
	},
});
