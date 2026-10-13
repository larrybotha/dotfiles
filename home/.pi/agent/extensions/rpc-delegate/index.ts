/**
 * RPC-delegate extension — state-machine-enforced RPC supervision.
 *
 * Delegate a task to an ephemeral child pi (`pi --mode rpc --no-session`)
 * supervised through the raw JSONL RPC protocol: mid-flight evidence (tool
 * activity, final assistant text), honest outcomes from the event stream
 * (agent_settled ≠ success — the final assistant stopReason decides), and
 * artifact-contract results. Closes the gap between delegate_task
 * (watchdog + isolation, no streaming, tmux dependency) and the subagent
 * example (streaming subprocess, no external watchdog, no artifact
 * contract, no cancellation ladder).
 *
 * Architecture (tmux-delegate pattern, machine owns legality / services own
 * IO / tool is thin):
 *
 * - machine.ts — the lifecycle: spawn → handshake → prompt → run → collect →
 *   stop → outcome. Receives a small typed event set from the transport.
 * - transport.ts — raw JSONL: LF-split byte reader, pending-ID map,
 *   record → event conversion, extension-UI auto-cancel, backpressure,
 *   PROTOCOL_FATAL on well-defined violations only. External watchdog
 *   (watchdog.mjs) guards against parent-SIGKILL orphans.
 * - collector.ts — artifact read (tmux-delegate honest accounting).
 * - index.ts (this file) — registers rpc_delegate_task, wires the real
 *   services around the machine, builds results from the snapshot.
 *
 * One child per call — `--no-session` (in-memory, never resumable), so
 * `agent_settled` attribution is unambiguous. No monitor/attach: debugging
 * is the bounded evidence in the result + optional session HTML export.
 * Unlike tmux-delegate, deadline/abort outcomes DO collect artifacts
 * (explicit policy — partial work is evidence).
 */
import * as fs from "node:fs";
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
import { collectArtifacts } from "./collector.ts";
import {
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
	protoFatal: string | null;
	rejected?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the pi binary the same way tmux-delegate does (must run inside
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

function childArgs(input: {
	sessionId: string;
	provider: string | null;
	model: string | null;
	tools: string[] | null;
	agentPrompt: string | null;
}): string[] {
	// Security stance: --no-extensions prevents rpc-delegate recursion and
	// project-local extension surprises; --no-session is the one-shot
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
	if (input.agentPrompt) {
		args.push("--append-system-prompt", input.agentPrompt);
	}
	return args;
}

// ---------------------------------------------------------------------------
// Wired services — real IO around the machine (machine.ts ships typed
// stubs; test.ts wires controlled stubs — tmux-delegate pattern).
// ---------------------------------------------------------------------------

async function runSpawnService(input: SpawnInput, signal: AbortSignal): Promise<SpawnOutput> {
	const transport = new RpcTransport({
		command: input.launch.pi.command,
		baseArgs: [...input.launch.pi.args, ...childArgs(input)],
		cwd: input.workingDir,
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
	return {
		status: statusOf(String(snap.value)),
		sessionId: c.sessionId,
		childSessionId: c.childSessionId,
		childModelId: c.childModelId,
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
	};
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

function resultFromSnapshot(a: Actor<typeof wiredMachine>, rejected?: string) {
	const ev = a.getSnapshot().context.transport?.getEvidence();
	const d = detailsFromSnapshot(a, ev?.assistantTextTail ?? "", ev?.stderrTail ?? "");
	if (rejected) d.rejected = rejected;
	return {
		content: [{ type: "text" as const, text: buildResultText(d) }],
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
			agentPrompt: Type.Optional(
				Type.String({ description: "Additional system prompt text appended for the child pi" }),
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
				agentPrompt,
				artifactPolicy = "stopReason",
			} = params;

			const workingDir = taskCwd ?? ctx.cwd;

			// Precheck — machine validator, single source of truth (the guard
			// rejects the same event, so no actor spins up for an illegal call)
			const violation = paramsViolation(
				task,
				timeout,
				artifacts,
				provider ?? null,
				model ?? null,
				tools ?? null,
				artifactPolicy,
			);
			if (violation) {
				return {
					content: [{ type: "text", text: `Rejected: ${violation}` }],
					details: {
						status: "error",
						sessionId: "",
						childSessionId: null,
						childModelId: null,
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
						rejected: violation,
					},
					isError: true,
				};
			}

			const a = createActor(wiredMachine);
			a.start();

			const sessionId = `rpc-delegate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
				return {
					content: [
						{
							type: "text",
							text: `Delegation still in flight (${statusOf(String(a.getSnapshot().value))}) after ${Math.round((Date.now() - startTime) / 1000)}s — the machine continues in the background; the watchdog reaps the child at ${timeout + 120}s`,
						},
					],
					details: detailsFromSnapshot(a, transport?.getEvidence().assistantTextTail ?? "", transport?.getEvidence().stderrTail ?? ""),
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

			return resultFromSnapshot(a);
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
