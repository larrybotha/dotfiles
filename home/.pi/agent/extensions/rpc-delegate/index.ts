/**
 * RPC-delegate extension — state-machine-enforced RPC supervision.
 *
 * Delegate a task to an ephemeral child pi (`pi --mode rpc --no-session`)
 * supervised through the raw JSONL RPC protocol: mid-flight evidence (tool
 * activity, final assistant text), honest outcomes from the event stream
 * (agent_settled ≠ success — the final assistant stopReason decides), and
 * artifact-contract results.
 *
 * Architecture (machine owns legality / services own IO / tool is thin):
 *
 * - machine.ts — the lifecycle: spawn → handshake → prompt → run → collect →
 *   stop → outcome. Receives a small typed event set from the transport.
 * - transport.ts — raw JSONL: LF-split byte reader, pending-ID map,
 *   record → event conversion, extension-UI auto-cancel, backpressure,
 *   PROTOCOL_FATAL on well-defined violations only. External watchdog
 *   (watchdog.mjs) guards against parent-SIGKILL orphans.
 * - collector.ts — artifact read (honest accounting).
 * - index.ts (this file) — registers rpc_delegate_task, wires the real
 *   services around the machine, builds results from the snapshot.
 *
 * One child per call — `--no-session` (in-memory, never resumable), so
 * `agent_settled` attribution is unambiguous. No monitor/attach: debugging
 * is the bounded evidence in the result + optional session HTML export.
 * Deadline/abort outcomes DO collect artifacts (explicit policy — partial
 * work is evidence).
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, Spacer } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createActor, fromPromise, waitFor, type Actor } from "xstate";
import { DELEGATION_PATTERNS } from "model-routing-classes";
import { collectArtifacts } from "./collector.ts";
import {
	depthViolation,
	evaluateSuccess,
	formatDuration,
	runDurationMs,
	totalDurationMs,
	type ArtifactEntry,
	type CancelInput,
	type CancelOutput,
	type DelegateStatus,
	type CollectInput,
	type CollectOutput,
	type HandshakeInput,
	type HandshakeOutput,
	type PromptInput,
	type PromptOutput,
	type RpcContext,
	type RpcEvent,
	type SessionStatsData,
	type SpawnInput,
	type SpawnOutput,
	type StopInput,
	type StopOutput,
	rpcMachine,
	paramsViolation,
	statusOf,
	summaryForSnapshot,
	type TransportHandle,
} from "./machine.ts";
import { RpcTransport } from "./transport.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Hard cap for the whole delegation — a backstop, NOT the expected
 *  duration: the call returns as soon as the child settles, and a silent
 *  (hung) child is cancelled by stall detection long before this. */
const DEFAULT_TIMEOUT = 1800;
/** Stall supervision: silence window with no child tool open. Any protocol
 *  bytes reset the transport's liveness timer — a healthy agent streams
 *  continuously, so the gap is duration-agnostic. */
const STALL_GAP_MS = 180_000;
const STATUS_UPDATE_MS = 5000;

/** Status → (theme color, glyph) — one entry per DelegateStatus; renderResult keys into it. */
const STATUS_ICONS: Record<DelegateStatus, readonly [ThemeColor, string]> = {
	success: ["success", "✓"],
	running: ["dim", "⟳"],
	timeout: ["warning", "⏱"],
	aborted: ["warning", "⊘"],
	error: ["error", "✗"],
};

const EXEC_DIR =
	process.env.RPC_DELEGATE_DIR ??
	path.join(os.homedir(), ".pi/agent/extensions/rpc-delegate");
const WATCHDOG = path.join(EXEC_DIR, "watchdog.mjs");

/** Env-parsed delegation lineage — set by an ancestor rpc_delegate_task in
 *  this process's spawn env (top-level pi: both unset). DEPTH = how many
 *  hops produced THIS process (0 = top-level); INHERITED_MAX_DEPTH = the
 *  ancestor-granted ceiling (null = no ancestor grant). */
function parseEnvInt(raw: string | undefined): number | null {
	if (raw == null || !/^\d+$/.test(raw.trim())) return null;
	const n = Number.parseInt(raw.trim(), 10);
	return Number.isSafeInteger(n) ? n : null;
}
const DEPTH = parseEnvInt(process.env.RPC_DELEGATE_DEPTH) ?? 0;
const INHERITED_MAX_DEPTH = parseEnvInt(process.env.RPC_DELEGATE_MAX_DEPTH);

// Command timeouts — each independent of the run deadline (plan: separate
// after/service timeouts per rung).
const SPAWN_TIMEOUT_MS = 15_000; // spawn + reader attach (service-internal)
const HANDSHAKE_TIMEOUT_MS = 30_000; // get_state response
const PROMPT_RESPONSE_TIMEOUT_MS = 60_000; // prompt acceptance response
const STEER_TIMEOUT_MS = 30_000;
const CLEAR_QUEUE_TIMEOUT_MS = 10_000;
const ABORT_TIMEOUT_MS = 15_000;
const STATS_TIMEOUT_MS = 5_000;
const STDIN_CLOSE_EXIT_MS = 10_000; // orderly shutdown after stdin close
const TERM_EXIT_MS = 5_000;
const KILL_EXIT_MS = 5_000;
/** Hard-deadline grace for the external watchdog: run timeout + this. */
const WATCHDOG_GRACE_MS = 120_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RpcDelegateDetails {
	status: DelegateStatus;
	sessionId: string;
	childSessionId: string | null;
	childModelId: string | null;
	/** Child provider as pinned by the caller (v2 telemetry). */
	provider: string | null;
	childPid: number | null;
	childExit: number | null;
	promptDisposition: string | null;
	stopReason: string | null;
	lastAssistantError: string | null;
	/** The prompt sent to the child — shown in the expanded result view (Ctrl+O). */
	task: string;
	agentPrompt: string | null;
	artifacts: ArtifactEntry[];
	summary: string;
	assistantTextTail: string;
	stderr: string;
	toolCalls: number;
	lastToolNames: string[];
	agentEndWillRetry: number;
	uiRequests: number;
	usage: SessionStatsData | null;
	/** Agent-run duration (prompt accepted → outcome decided) — pairs with
	 *  cost; null before run start / until the outcome is decided. */
	runDurationMs: number | null;
	/** Whole-delegation duration (BEGIN → terminal; ladders included). */
	totalDurationMs: number | null;
	deadlineHit: boolean;
	/** Stall detection fired (silent child) — distinct from the hard-cap deadline. */
	stallHit: boolean;
	failureDetail: string | null;
	/** v2 fact-typing (never used for routing): thinking-map-400 /
	 *  access-403 / endpoint-410 / free-tier-403 / param-400 /
	 *  unavailable-400 / other. Null when no failure. */
	failureClass: string | null;
	protoFatal: string | null;
	rejected?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the pi binary (must run inside
 *  the pi process — process.argv points at pi here). */
function resolvePiBinary(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}

function isRec(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** v2 (C-lite) fact-typing: classify a terminal failure from every
 *  textual surface we hold. Never used for routing. Patterns are
 *  single-sourced in model-routing-classes (skills/model-routing/
 *  scripts/classes.mjs) — keep this a thin iterator. */
function classifyFailure(d: {
	status: DelegateStatus;
	failureDetail: string | null;
	stderr: string;
	lastAssistantError: string | null;
}): string | null {
	if (!/^(error|timeout|aborted)$/.test(d.status)) return null;
	const hay = `${d.failureDetail ?? ""}\n${d.stderr}\n${d.lastAssistantError ?? ""}`;
	for (const { cls, pattern } of DELEGATION_PATTERNS) {
		if (pattern.test(hay)) return cls;
	}
	return "other";
}

function childArgs(input: {
	sessionId: string;
	provider: string | null;
	model: string | null;
	tools: string[] | null;
	extensions: string[] | null;
	agentPrompt: string | null;
}): string[] {
	// Security stance: --no-extensions disables extension DISCOVERY — rpc-
	// delegate does not auto-load in children, and project-local extension
	// surprises stay off. It is not a recursion capability block: a child with
	// bash can spawn a plain pi that rediscovers everything (unsupervised —
	// invisible to the watchdog/telemetry). Recursion is bounded by the depth
	// budget (RPC_DELEGATE_DEPTH/MAX_DEPTH env lineage — machine.ts
	// depthViolation), not by extension loading. An explicit `extensions` param
	// opts in to loading SPECIFIC extension files — pi loads explicit
	// --extension paths even under --no-extensions, so discovery stays off
	// while the listed files load; --no-session is the one-shot
	// lifecycle; --name tags the child for debugging. Provider/model are
	// pinned explicitly when given (never silently inherited env).
	const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--name", input.sessionId];
	if (input.provider && input.model) {
		args.push("--provider", input.provider, "--model", input.model);
	} else if (input.model) {
		args.push("--model", input.model);
	}
	if (input.tools) {
		args.push("--tools", input.tools.join(","));
	}
	// Explicit extension loads — must come as-is; pi keeps --no-extensions
	// semantics for discovery while honoring explicit paths. NOTE: a --tools
	// allowlist above disables extension tools unless their names are listed.
	if (input.extensions) {
		for (const ext of input.extensions) {
			args.push("--extension", ext);
		}
	}
	if (input.agentPrompt) {
		args.push("--append-system-prompt", input.agentPrompt);
	}
	return args;
}

/** Warn-not-block: an `extensions` entry that resolves to this very extension
 *  re-enables delegation in the child — a deliberate choice (the bash
 *  sub-spawn route was never blocked; the depth budget still bounds it).
 *  Catch the honest mistake; never reject. */
function selfLoadWarnings(extensions: string[], cwdForRelative: string): string[] {
	const resolve = (p: string): string | null => {
		try {
			return fs.realpathSync(path.isAbsolute(p) ? p : path.resolve(cwdForRelative, p));
		} catch {
			return null;
		}
	};
	const selfDir = resolve(EXEC_DIR);
	const selfIndex = resolve(path.join(EXEC_DIR, "index.ts"));
	const out: string[] = [];
	for (const e of extensions) {
		const r = resolve(e);
		if (r !== null && (r === selfDir || r === selfIndex)) {
			out.push(
				`⚠ extensions entry "${e}" is this rpc-delegate extension — the child gains rpc_delegate_task (its further delegation is still depth-bounded); deliberate recursion choice?`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Wired services — real IO around the machine (machine.ts ships typed
// stubs; test.ts wires controlled stubs).
// ---------------------------------------------------------------------------

async function runSpawnService(input: SpawnInput, signal: AbortSignal): Promise<SpawnOutput> {
	const transport = new RpcTransport({
		command: input.launch.pi.command,
		baseArgs: [...input.launch.pi.args, ...childArgs(input)],
		cwd: input.workingDir,
		env: {
			// Depth lineage — rides process env through every load route
			// (-e paths, copies, symlinks, bash sub-spawns): lineage, not identity.
			RPC_DELEGATE_DEPTH: String(input.depth + 1),
			RPC_DELEGATE_MAX_DEPTH: String(input.maxDepth),
		},
		sink: input.launch.sink,
		watchdog: {
			scriptPath: input.launch.watchdogPath,
			parentPid: input.launch.parentPid,
			graceMs: input.timeoutSecs * 1000 + WATCHDOG_GRACE_MS,
		},
		stall:
			input.launch.stallGapMs > 0
				? {
					gapMs: input.launch.stallGapMs,
					heartbeatPath: input.launch.heartbeatPath ?? undefined,
				}
				: undefined,
	});
	try {
		// spawn() resolves on the 'spawn' event (fast); the cap is insurance
		// against a wedged binary
		const deadline = new Promise<never>((_, reject) => {
			const t = setTimeout(
				() => reject(new Error(`spawn timed out after ${SPAWN_TIMEOUT_MS}ms`)),
				SPAWN_TIMEOUT_MS,
			);
			t.unref?.();
		});
		await Promise.race([transport.start(signal), deadline]);
	} catch (err) {
		transport.killHard(); // self-clean what was made (maybe nothing)
		throw err instanceof Error ? err : new Error(String(err));
	}
	if (signal.aborted) {
		transport.killHard();
		throw new Error("spawn aborted");
	}
	return { pid: transport.pid() ?? -1, transport };
}

async function runHandshakeService(input: HandshakeInput): Promise<HandshakeOutput> {
	const r = await input.transport.sendCommand({ type: "get_state" }, HANDSHAKE_TIMEOUT_MS);
	if (!r.success) throw new Error(`get_state rejected: ${r.error ?? "unknown error"}`);
	const data = isRec(r.data) ? r.data : {};
	const model = isRec(data.model) ? data.model : null;
	return {
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
		modelId: model && typeof model.id === "string" ? model.id : null,
	};
}

async function runPromptService(input: PromptInput): Promise<PromptOutput> {
	const r = await input.transport.sendCommand(
		{ type: "prompt", message: input.task },
		PROMPT_RESPONSE_TIMEOUT_MS,
	);
	if (!r.success) throw new Error(`prompt rejected: ${r.error ?? "unknown error"}`);
	const disposition = isRec(r.data) && typeof r.data.disposition === "string" ? r.data.disposition : "unknown";
	return { disposition };
}

async function runCancelService(input: CancelInput): Promise<CancelOutput> {
	const t = input.transport;
	if (!t || !t.alive()) return { exitCode: t ? t.exitCode() : null };
	// Ladder: clear_queue (abort alone leaves queued steering/follow-ups) →
	// abort → stdin close → TERM pg → KILL pg. Every rung tolerant of a dead
	// child — a rung failure is logged evidence, never a thrown error.
	try {
		await t.sendCommand({ type: "clear_queue" }, CLEAR_QUEUE_TIMEOUT_MS);
	} catch {
		/* child dead/fatal — escalate */
	}
	try {
		await t.sendCommand({ type: "abort" }, ABORT_TIMEOUT_MS);
	} catch {
		/* child dead/fatal — escalate */
	}
	t.closeStdin();
	if (await t.waitForExit(STDIN_CLOSE_EXIT_MS)) return { exitCode: t.exitCode() };
	t.killTerm();
	if (await t.waitForExit(TERM_EXIT_MS)) return { exitCode: t.exitCode() };
	t.killKill();
	await t.waitForExit(KILL_EXIT_MS);
	return { exitCode: t.exitCode() };
}

async function runStopService(input: StopInput): Promise<StopOutput> {
	const t = input.transport;
	const out = { exitCode: null as number | null, usage: null as SessionStatsData | null };
	if (!t) return out;
	if (t.alive()) {
		// Best-effort session stats (cost/usage evidence) before shutdown.
		// Note: export_html cannot export a --no-session child (in-memory
		// session) — no session export on any outcome, by protocol limitation.
		try {
			const r = await t.sendCommand({ type: "get_session_stats" }, STATS_TIMEOUT_MS);
			if (r.success && isRec(r.data)) out.usage = r.data as SessionStatsData;
		} catch {
			/* best-effort */
		}
		// Orderly shutdown: close stdin → wait → TERM pg → KILL pg.
		t.closeStdin();
		if (await t.waitForExit(STDIN_CLOSE_EXIT_MS)) {
			out.exitCode = t.exitCode();
			return out;
		}
		t.killTerm();
		if (await t.waitForExit(TERM_EXIT_MS)) {
			out.exitCode = t.exitCode();
			return out;
		}
		t.killKill();
		await t.waitForExit(KILL_EXIT_MS);
		out.exitCode = t.exitCode();
	} else {
		out.exitCode = t.exitCode();
	}
	return out;
}

export const wiredMachine = rpcMachine.provide({
	actors: {
		spawnService: fromPromise<SpawnOutput, SpawnInput>(({ input, signal }) =>
			runSpawnService(input, signal),
		),
		handshakeService: fromPromise<HandshakeOutput, HandshakeInput>(({ input }) =>
			runHandshakeService(input),
		),
		promptService: fromPromise<PromptOutput, PromptInput>(({ input }) =>
			runPromptService(input),
		),
		collectService: fromPromise<CollectOutput, CollectInput>(({ input }) =>
			Promise.resolve({ artifacts: collectArtifacts(input.artifactPaths, input.workingDir) }),
		),
		cancelService: fromPromise<CancelOutput, CancelInput>(({ input }) =>
			runCancelService(input),
		),
		stopService: fromPromise<StopOutput, StopInput>(({ input }) => runStopService(input)),
	},
});

// ---------------------------------------------------------------------------
// Tool result builders — machine snapshot + transport evidence only
// ---------------------------------------------------------------------------

function detailsFromSnapshot(a: Actor<typeof wiredMachine>, assistantTextTail: string, stderr: string): RpcDelegateDetails {
	const snap = a.getSnapshot();
	const c: RpcContext = snap.context;
	const stateName = String(snap.value);
	const summary = summaryForSnapshot(stateName, c, assistantTextTail);
	const d: RpcDelegateDetails = {
		status: statusOf(String(snap.value)),
		sessionId: c.sessionId,
		childSessionId: c.childSessionId,
		childModelId: c.childModelId,
		provider: c.provider,
		childPid: c.childPid,
		childExit: c.childExit,
		promptDisposition: c.promptDisposition,
		stopReason: c.lastAssistantStopReason,
		lastAssistantError: c.lastAssistantError,
		task: c.task,
		agentPrompt: c.agentPrompt,
		artifacts: c.artifacts,
		summary,
		assistantTextTail,
		stderr,
		toolCalls: c.toolCalls,
		lastToolNames: c.lastToolNames,
		agentEndWillRetry: c.agentEndWillRetry,
		uiRequests: c.uiRequests,
		usage: c.usage,
		runDurationMs: runDurationMs(c),
		totalDurationMs: totalDurationMs(c),
		deadlineHit: c.deadlineHit,
		stallHit: c.stallHit,
		failureDetail: c.failureDetail,
		protoFatal: c.protoFatal,
		failureClass: null, // set below from the full failure surfaces
	};
	d.failureClass = classifyFailure(d);
	return d;
}

function buildResultText(d: RpcDelegateDetails): string {
	let text = `## rpc_delegate_task — ${d.status}\n\n${d.summary}`;

	if (d.promptDisposition === "queued") {
		text += `\n\nNote: disposition was "queued" — unexpected on a one-shot child (no prior run).`;
	}
	if (d.promptDisposition) {
		text += `\n\nDisposition: ${d.promptDisposition}`;
	}
	if (d.stopReason) {
		text += `\nFinal assistant stopReason: ${d.stopReason}`;
	}
	if (d.failureClass) {
		text += `\nFailure class: ${d.failureClass}`;
	}
	if (d.stallHit) {
		text += `\nStall: the child produced no protocol activity for the stall window (${Math.round(STALL_GAP_MS / 1000)}s) while no child tool was open — treated as a hang and cancelled; the timeout hard cap was not the trigger.`;
	}
	if (d.status === "error" && d.childExit !== null && d.childExit !== 0) {
		text += `\nChild exit code: ${d.childExit}`;
	}

	if (d.artifacts.length > 0) {
		text += "\n\n### Artifacts\n";
		for (const a of d.artifacts) {
			if (a.missing) {
				text += `\n- ✗ \`${a.path}\` (missing)`;
			} else if (a.readError) {
				text += `\n- ✗ \`${a.path}\` (read error: ${a.readError})`;
			} else {
				const lines = a.content.split("\n").length;
				text += `\n- ✓ \`${a.path}\` (${lines} lines)`;
				if (a.truncated) text += " (truncated)";
			}
		}
	}

	const toolBits: string[] = [];
	if (d.toolCalls > 0) toolBits.push(`${d.toolCalls} tool call(s)`);
	if (d.lastToolNames.length > 0) toolBits.push(`last: ${d.lastToolNames.join(", ")}`);
	if (d.agentEndWillRetry > 0) toolBits.push(`${d.agentEndWillRetry} retry-continue agent end(s)`);
	if (d.uiRequests > 0) toolBits.push(`${d.uiRequests} extension UI request(s) (auto-handled)`);
	if (toolBits.length > 0) {
		text += `\n\n### Child activity\n\n${toolBits.join(" · ")}`;
	}

	const durBits: string[] = [];
	if (d.runDurationMs !== null) durBits.push(`run ${formatDuration(d.runDurationMs)}`);
	if (d.totalDurationMs !== null) durBits.push(`total ${formatDuration(d.totalDurationMs)}`);
	if (d.usage) {
		const cost = typeof d.usage.cost === "number" ? ` · $${d.usage.cost.toFixed(4)}` : "";
		const tokens = d.usage.tokens?.totalTokens ?? d.usage.tokens?.total;
		const dur = durBits.length > 0 ? ` · ${durBits.join(" · ")}` : "";
		text += `\n\n### Usage\n\n${tokens ? `${tokens.toLocaleString()} tokens` : "tokens unavailable"}${cost}${dur}`;
	} else if (durBits.length > 0) {
		text += `\n\n### Usage\n\n${durBits.join(" · ")}`;
	}

	if (d.stderr) {
		text += `\n\n### Stderr tail\n\n\`\`\`\n${d.stderr.slice(0, 1000)}\n\`\`\``;
	}

	return text;
}

const TELEMETRY_PATH = fileURLToPath(new URL("./telemetry.jsonl", import.meta.url));

/** v2 (C-lite): one JSONL row per rpc_delegate_task terminal return —
 *  settled, param-rejected, or still-in-flight. Fact capture only — never
 *  read for routing; no task text logged; best-effort. */
function appendTelemetryRow(
	d: RpcDelegateDetails,
	meta: {
		archetype: string | null;
		artifactPolicy: string;
		kind?: "rejected" | "inFlight";
		depth: number;
		parentSessionId: string | null;
	},
): void {
	const early = meta.kind != null; // rejected / in-flight: no run facts to log
	try {
		const row = {
			ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
			source: "rpc-delegate",
			depth: meta.depth,
			parentSessionId: meta.parentSessionId,
			archetype: meta.archetype,
			provider: d.provider,
			model: d.childModelId,
			stopReason: d.stopReason,
			stallHit: d.stallHit,
			failureClass: early ? null : d.failureClass,
			tokensIn: early ? null : (d.usage?.tokens?.input ?? null),
			tokensOut: early ? null : (d.usage?.tokens?.output ?? null),
			costUsd: early || typeof d.usage?.cost !== "number" ? null : d.usage.cost,
			runSecs: early || d.runDurationMs == null ? null : Math.round(d.runDurationMs / 1000),
			artifactOk: early
				? null
				: d.artifacts.length > 0
					? d.artifacts.every((a) => !a.missing && !a.readError)
					: null,
			artifactPolicy: meta.artifactPolicy,
			note:
				meta.kind === "rejected"
					? `rejected: ${(d.failureDetail ?? "").slice(0, 120).replace(/\n/g, " ")}`
					: meta.kind === "inFlight"
						? `tool return in flight (status ${d.status}) — no terminal row`
						: d.failureDetail
							? d.failureDetail.slice(0, 140).replace(/\n/g, " ")
							: "",
		};
		fs.appendFileSync(TELEMETRY_PATH, `${JSON.stringify(row)}\n`, "utf8");
	} catch {
		/* telemetry is best-effort — never fail a delegation for it */
	}
}

function resultFromSnapshot(
	a: Actor<typeof wiredMachine>,
	rejected?: string,
	warnings?: string[],
) {
	const ev = a.getSnapshot().context.transport?.getEvidence();
	const d = detailsFromSnapshot(a, ev?.assistantTextTail ?? "", ev?.stderrTail ?? "");
	if (rejected) d.rejected = rejected;
	const text =
		buildResultText(d) + (warnings && warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "");
	return {
		content: [{ type: "text" as const, text }],
		details: d,
		isError: d.status !== "success",
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rpc_delegate_task",
		label: "RPC Delegate",
		description: [
			"Delegate a task to an ephemeral child pi supervised through the raw RPC protocol.",
			"Streaming evidence (tool activity, final assistant text) and honest outcomes (agent_settled ≠ success — the final stopReason decides).",
			"Stall detection cancels a silent child (no protocol activity for 180s with no child tool open) — timeout is a hard-cap backstop, not the expected duration; the call returns as soon as the child settles.",
			"Results are read from declared artifact files; deadline/abort outcomes still collect partial artifacts.",
		].join(" "),
		parameters: Type.Object({
			task: Type.String({
				description: "Task description for the child pi. Be specific about expected output files.",
			}),
			cwd: Type.Optional(
				Type.String({ description: "Working directory (defaults to current session cwd)" }),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Hard cap in seconds for the whole delegation (default 1800) — a backstop, not the expected duration: the call returns as soon as the child settles, and a silent (hung) child is cancelled by stall detection well before this",
				}),
			),
			artifacts: Type.Optional(
				Type.Array(Type.String(), {
					description: "File paths to collect as results (relative to cwd or absolute)",
				}),
			),
			provider: Type.Optional(
				Type.String({ description: "Provider for the child pi (requires model)" }),
			),
			model: Type.Optional(
				Type.String({ description: "Model for the child pi (pinned explicitly, never silently inherited)" }),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Explicit tool allowlist for the child (default: child's default tools)",
				}),
			),
			extensions: Type.Optional(
				Type.Array(Type.String(), {
					description:
					"Extension file paths to load into the child (pi --extension). Explicit paths load even under the child's --no-extensions default, so auto-loading (including this extension) stays off — this is NOT a recursion block: a child with bash can spawn plain pi and rediscover everything. CAUTION: a `tools` allowlist disables extension tools unless their names are included (e.g. web_search, web_fetch)",
				}),
			),
			maxDepth: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 4,
					description:
					"Max delegation tree depth (default 1 — the child cannot delegate further; 2 = the child may spawn sub-agents, grandchildren may not). Monotone budget: clamped to the ancestor-granted ceiling and passed down — a delegated child can never raise it",
				}),
			),
			agentPrompt: Type.Optional(
				Type.String({ description: "Additional system prompt text appended for the child pi" }),
			),
			archetype: Type.Optional(
				Type.String({
					description:
					"Task archetype label for model-routing telemetry (e.g. 'Greenfield code / big feature') — recorded verbatim in the telemetry row; omit when not routing-aware",
				}),
			),
			artifactPolicy: Type.Optional(
				Type.Union([Type.Literal("stopReason"), Type.Literal("artifacts")], {
					description:
						'When artifacts trump a bad final stopReason: "stopReason" (default — stop reason decides) or "artifacts" (collected artifacts forgive it)',
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const {
				task,
				cwd: taskCwd,
				timeout = DEFAULT_TIMEOUT,
				artifacts = [],
				provider,
				model,
				tools,
				extensions,
				maxDepth,
				agentPrompt,
				archetype,
				artifactPolicy = "stopReason",
			} = params;

			const workingDir = taskCwd ?? ctx.cwd;

			// Precheck — machine validators, single source of truth (the guard
			// rejects the same event, so no actor spins up for an illegal call).
			// Depth budget is monotone: the per-call request is clamped to the
			// ancestor-granted ceiling (env lineage — survives -e paths, copies,
			// symlinks, bash sub-spawns; a delegated child can never raise it).
			const effectiveMaxDepth = Math.min(
				maxDepth ?? INHERITED_MAX_DEPTH ?? 1,
				INHERITED_MAX_DEPTH ?? Number.POSITIVE_INFINITY,
			);
			const violation =
				paramsViolation(
					task,
					timeout,
					artifacts,
					provider ?? null,
					model ?? null,
					tools ?? null,
					artifactPolicy,
					extensions ?? null,
					maxDepth ?? null,
			) ?? depthViolation(DEPTH, effectiveMaxDepth);
			if (violation) {
				const d: RpcDelegateDetails = {
					status: "error",
					sessionId: "",
					childSessionId: null,
					childModelId: null,
					provider: null,
					childPid: null,
					childExit: null,
					promptDisposition: null,
					stopReason: null,
					lastAssistantError: null,
					task,
					agentPrompt: agentPrompt ?? null,
					artifacts: [],
					summary: violation,
					assistantTextTail: "",
					stderr: "",
					toolCalls: 0,
					lastToolNames: [],
					agentEndWillRetry: 0,
					uiRequests: 0,
					usage: null,
					runDurationMs: null,
					totalDurationMs: null,
					deadlineHit: false,
					stallHit: false,
					failureDetail: violation,
					protoFatal: null,
					failureClass: null,
					rejected: violation,
				};
				appendTelemetryRow(d, {
					archetype: archetype ?? null,
					artifactPolicy,
					kind: "rejected",
					depth: DEPTH,
					parentSessionId: ctx.sessionManager?.getSessionId() ?? null,
				});
				return {
					content: [{ type: "text", text: `Rejected: ${violation}` }],
					details: d,
					isError: true,
				};
			}

			const a = createActor(wiredMachine);
			a.start();

			const sessionId = `rpc-delegate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const parentSessionId = ctx.sessionManager?.getSessionId() ?? null;
			// Warn-not-block: an extensions entry pointing back at this very
			// extension re-enables delegation in the child (deliberate choice —
			// the bash route was never blocked; the depth budget still bounds it).
			const selfWarnings = extensions == null ? [] : selfLoadWarnings(extensions, workingDir);
			// Watchdog heartbeat file — the external orphan watchdog enforces
			// the same stall policy if this process wedges; unlinked on settle
			// here and by the watchdog on every exit path.
			const heartbeatPath = path.join(os.tmpdir(), `rpc-delegate-hb-${sessionId}.json`);
			// Machine-event sink: the transport forwards typed events here.
			// (STEER would be intercepted tool-side — v1 sends none; the
			// machine + transport capability is tested and documented.)
			const sink = (ev: RpcEvent) => a.send(ev);

			// Abort always wins: the tool's signal → KILL (legal in every
			// non-final pre-collect state; late KILL after terminal is dropped).
			const startTime = Date.now();
			signal?.addEventListener("abort", () => a.send({ type: "KILL" }), { once: true });

			a.send({
				type: "BEGIN",
				sessionId,
				task,
				agentPrompt: agentPrompt ?? null,
				provider: provider ?? null,
				model: model ?? null,
				tools: tools ?? null,
				extensions: extensions ?? null,
				depth: DEPTH,
				maxDepth: effectiveMaxDepth,
				artifactPolicy,
				timeoutSecs: timeout,
				workingDir,
				artifactPaths: artifacts,
				launch: {
					pi: resolvePiBinary(),
					parentPid: process.pid,
					sink,
					watchdogPath: WATCHDOG,
					stallGapMs: STALL_GAP_MS,
					heartbeatPath,
				},
			});

			// Progress: tool-side UX from the machine snapshot (state, elapsed,
			// child tool activity) — no raw record content crosses to the parent.
			const progress = onUpdate
				? setInterval(() => {
						const elapsed = Math.round((Date.now() - startTime) / 1000);
						const c = a.getSnapshot().context;
						const bits = [`Running… (${elapsed}s / ${timeout}s hard cap)`];
						// Liveness UX: silence is visible (and distinguished from a
						// silently-running child tool) — no duration guessing.
						const ev = c.transport?.getEvidence();
						if (ev?.lastRecordAt != null) {
							const silent = Math.round((Date.now() - ev.lastRecordAt) / 1000);
							if (silent >= 30) {
								bits.push(
									ev.openTools > 0 ? `child tool running (${silent}s)` : `silent ${silent}s`,
								);
							}
						}
						if (c.toolCalls > 0) {
							bits.push(`${c.toolCalls} tool call(s)`);
							if (c.lastToolNames.length > 0) {
								bits.push(`last: ${c.lastToolNames[c.lastToolNames.length - 1]}`);
							}
						}
						if (c.agentEndWillRetry > 0) bits.push("retrying");
						onUpdate({
							content: [{ type: "text", text: bits.join(" · ") }],
							details: detailsFromSnapshot(a, "", ""),
						});
					}, STATUS_UPDATE_MS)
				: null;

			// Wait for the machine to drive itself out: spawn (≤15s) +
			// handshake (≤30s) + prompt response (≤60s) + run (≤ timeoutSecs
			// hard cap — stall detection usually ends a hung run far sooner) +
			// ladder (≤~30s) + collect (fast) + stop (≤~40s). Every path ends
			// in a final state (spawn-fail `error` included).
			let settled: boolean;
			try {
				await waitFor(
					a,
					(s) =>
						s.matches("success") || s.matches("error") || s.matches("timeout") || s.matches("aborted"),
					{ timeout: timeout * 1000 + 180_000 },
				);
				settled = true;
			} catch {
				settled = false;
			} finally {
				if (progress) clearInterval(progress);
			}
			if (!settled) {
				// honest state — the machine keeps driving in the background
				const transport = a.getSnapshot().context.transport;
				const d = detailsFromSnapshot(
					a,
					transport?.getEvidence().assistantTextTail ?? "",
					transport?.getEvidence().stderrTail ?? "",
				);
				appendTelemetryRow(d, {
					archetype: archetype ?? null,
					artifactPolicy,
					kind: "inFlight",
					depth: DEPTH,
					parentSessionId,
				});
				return {
					content: [
						{
							type: "text",
							text: `Delegation still in flight (${statusOf(String(a.getSnapshot().value))}) after ${Math.round((Date.now() - startTime) / 1000)}s — the machine continues in the background; the watchdog reaps the child at ${timeout + 120}s`,
						},
					],
					details: d,
					isError: true,
				};
			}

			// Hygiene: every completed path stopped the child (stop/cancel
			// ladders are idempotent); belt-and-suspenders for wedge cases.
			const transport = a.getSnapshot().context.transport;
			if (transport?.alive()) transport.killHard();
			a.stop();

			// Heartbeat cleanup — the settled path owns the file; the watchdog
			// unlinks it on the orphan/not-settled paths.
			try {
				fs.rmSync(heartbeatPath, { force: true });
			} catch {
				/* best-effort */
			}

			const result = resultFromSnapshot(a, undefined, selfWarnings);
			appendTelemetryRow(result.details, {
					archetype: archetype ?? null,
					artifactPolicy,
					depth: DEPTH,
					parentSessionId,
				});
			return result;
		},

		// --- Collapsed call rendering ---
		renderCall(args, theme) {
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}…`
					: args.task
				: "…";
			const cwdLabel = args.cwd ? ` in ${path.basename(args.cwd)}` : "";
			const timeoutLabel = args.timeout ? ` (${args.timeout}s)` : "";
			let text =
				theme.fg("toolTitle", theme.bold("rpc_delegate_task ")) +
				theme.fg("dim", preview + cwdLabel + timeoutLabel);
			if (args.model) text += theme.fg("dim", ` [${args.model}]`);
			return new Text(text, 0, 0);
		},

		// --- Result rendering ---
		renderResult(result, { expanded }, theme) {
			const d = result.details as RpcDelegateDetails | undefined;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}

			const [iconColor, iconGlyph] = STATUS_ICONS[d.status];
			const icon = theme.fg(iconColor, iconGlyph);

			if (expanded) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("rpc_delegate_task"))} — ${d.status}`,
						0,
						0,
					),
				);

				if (d.task) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Markdown(d.task, 0, 0, getMarkdownTheme()));
				}
				if (d.agentPrompt) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Agent prompt ───"), 0, 0));
					container.addChild(new Markdown(d.agentPrompt, 0, 0, getMarkdownTheme()));
				}

				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Summary ───"), 0, 0));
				container.addChild(new Markdown(d.summary, 0, 0, getMarkdownTheme()));

				if (d.assistantTextTail && d.assistantTextTail !== d.summary) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Final assistant text (tail) ───"), 0, 0));
					container.addChild(new Markdown(d.assistantTextTail.slice(0, 2000), 0, 0, getMarkdownTheme()));
				}

				if (d.artifacts.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Artifacts ───"), 0, 0));
					for (const art of d.artifacts) {
						if (art.missing) {
							container.addChild(
								new Text(theme.fg("warning", `✗ ${art.path} (missing)`), 0, 0),
							);
						} else if (art.readError) {
							container.addChild(
								new Text(theme.fg("warning", `✗ ${art.path} (read error: ${art.readError})`), 0, 0),
							);
						} else {
							const lines = art.content.split("\n").length;
							container.addChild(
								new Text(
									theme.fg("accent", `✓ ${art.path}`) +
										theme.fg("dim", ` (${lines} lines)`),
									0,
									0,
								),
							);
							container.addChild(new Markdown(art.content, 0, 0, getMarkdownTheme()));
						}
					}
				}

				const bits: string[] = [];
				if (d.promptDisposition) bits.push(`disposition: ${d.promptDisposition}`);
				if (d.stopReason) bits.push(`stopReason: ${d.stopReason}`);
				if (d.stallHit) bits.push("stall-cancelled");
				if (d.deadlineHit) bits.push("hard-cap");
				if (d.childExit !== null) bits.push(`child exit: ${d.childExit}`);
				if (d.childModelId) bits.push(`model: ${d.childModelId}`);
				if (d.provider) bits.push(`provider: ${d.provider}`);
				if (d.failureClass) bits.push(`failure: ${d.failureClass}`);
				if (bits.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", `─── Run (${bits.join(" · ")}) ───`), 0, 0),
					);
				}
				if (d.toolCalls > 0) {
					container.addChild(
						new Text(
							theme.fg("dim", `${d.toolCalls} tool call(s) · last: ${d.lastToolNames.join(", ")}`),
							0,
							0,
						),
					);
				}

				if (d.usage) {
					const cost = typeof d.usage.cost === "number" ? ` · $${d.usage.cost.toFixed(4)}` : "";
					container.addChild(
						new Text(
							theme.fg("dim", `usage: ${(d.usage.tokens?.totalTokens ?? d.usage.tokens?.total ?? 0).toLocaleString()} tokens${cost}`),
							0,
							0,
						),
					);
				}
				const durBits: string[] = [];
				if (d.runDurationMs !== null) durBits.push(`run: ${formatDuration(d.runDurationMs)}`);
				if (d.totalDurationMs !== null) durBits.push(`total: ${formatDuration(d.totalDurationMs)}`);
				if (durBits.length > 0) {
					container.addChild(new Text(theme.fg("dim", `duration: ${durBits.join(" · ")}`), 0, 0));
				}
				if (d.stderr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Stderr tail ───"), 0, 0));
					container.addChild(new Text(theme.fg("error", d.stderr.slice(0, 500)), 0, 0));
				}

				return container;
			}

			// Collapsed
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("rpc_delegate_task"))} — ${d.status}`;
			const collected = d.artifacts.filter((x) => !x.missing && !x.readError).length;
			if (collected > 0) text += ` · ${collected} artifact(s)`;
			if (d.runDurationMs !== null) {
				text += theme.fg("dim", ` · ${formatDuration(d.runDurationMs)}`);
			}
			const missingCount = d.artifacts.filter((x) => x.missing).length;
			if (missingCount > 0) text += theme.fg("warning", ` · ${missingCount} missing`);
			if (d.failureDetail) text += `\n${theme.fg("dim", d.failureDetail)}`;
			else if (d.assistantTextTail) {
				const tail =
					d.assistantTextTail.length > 120
						? `${d.assistantTextTail.slice(0, 120)}…`
						: d.assistantTextTail;
				text += `\n${theme.fg("dim", tail.replace(/\n/g, " "))}`;
			}
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
