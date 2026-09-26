/**
 * tmux extension — remote-control tmux sessions for interactive CLIs.
 *
 * Machine owns legality (registry, caps, dead-marking); model owns judgment
 * (what to send, which regex, when output looks done). Executors own IO:
 * JSON out, exit 0, failure-as-data. Probe evidence rides events; guards
 * backstop. Extension owns one socket (pi.sock) + pi- prefix; foreign
 * sessions never touched.
 *
 * Tools: tmux_start, tmux_send, tmux_wait, tmux_capture, tmux_kill, tmux_status
 * Command: /tmux status | kill --all | footer | viz [off]
 * Env: TMUX_VIZ=1 auto-start inspector; TMUX_VIZ_PORT (default 8080, walks to
 * the first free port if busy — web-search viz defaults to 8080 too)
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createActor } from "xstate";
import type { Actor } from "xstate";
import { makeViz } from "../_viz/viz-kit.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	tmuxMachine,
	DEFAULT_LIMITS,
	driftReport,
	findSession,
	liveNames,
	validateKnown,
	validateRegister,
	validateSend,
	validateStart,
	validateWait,
	type RegistryContext,
	type SessionEntry,
	type TmuxEvent,
} from "./machine.ts";

// restore + reconcile (phase 4) — registry from branch, probe as truth

/** Last tmux_* tool-result registry on the active branch (todo.ts pattern). */
function lastRegistryFromBranch(ctx: ExtensionContext): RegistryContext | null {
	let found: RegistryContext | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || !msg.toolName?.startsWith("tmux_")) continue;
		const reg = (msg.details as TmuxDetails | undefined)?.registry;
		if (
			reg &&
			Array.isArray(reg.sessions) &&
			typeof reg.limits?.maxSessions === "number"
		) {
			found = reg;
		}
	}
	return found;
}

/** Fresh actor per session; RESTORE carries the branch registry (statuses
 *  exact, monitor kept). Viz survives restore: inspect re-wired if on. */
function restoreFromBranch(ctx: ExtensionContext): void {
	const reg = lastRegistryFromBranch(ctx);
	const old = actor;
	const options = {
		input: { limits: reg ? reg.limits : DEFAULT_LIMITS },
		...viz.option(),
	};
	actor = createActor(tmuxMachine, options);
	actor.start();
	if (reg) actor.send({ type: "RESTORE", registry: reg });
	old?.stop();
}

/** Probe pi.sock + RECONCILE: mark registered-but-dead (readable drift,
 *  never resurrected), adopt live pi-* strays (crash recovery). */
async function reconcileFromProbe(ctx: ExtensionContext): Promise<void> {
	const { names, error } = await probeLive();
	if (error) {
		if (ctx.hasUI) ctx.ui.notify(`tmux probe failed: ${error}`, "warning");
		return;
	}
	const before = registry().sessions;
	send({ type: "RECONCILE", live: ownSessions(names).map((name) => ({ name })) });
	const drift = driftReport(before, registry().sessions);
	if (drift.length > 0 && ctx.hasUI) {
		ctx.ui.notify(`tmux reconcile: ${drift.join("; ")}`, "info");
	}
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const EXECUTORS_DIR = fileURLToPath(new URL("./executors", import.meta.url));

// mirrors executors/lib.sh
const SOCKET_DIR =
	process.env.AGENT_TMUX_SOCKET_DIR ??
	path.join(process.env.TMPDIR ?? "/tmp", "agent-tmux-sockets");
const SOCKET_PATH = path.join(SOCKET_DIR, "pi.sock");
const PREFIX = "pi-";

function envNum(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const PROMPT_TIMEOUT = envNum("TMUX_PROMPT_TIMEOUT", 20);
const WAIT_TIMEOUT = envNum("TMUX_WAIT_TIMEOUT", 15);
const CAPTURE_LINES = envNum("TMUX_CAPTURE_LINES", 200);
const VIZ_PORT = envNum("TMUX_VIZ_PORT", 8080);
const FOOTER_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// executors
// ---------------------------------------------------------------------------

type ExecResult =
	| { sessions: string[] }
	| { socket: string; name: string }
	| { matched: boolean; lastPane: string }
	| { text: string }
	| { error: string };

const execFileP = promisify(execFile);

async function runExecutor(
	script: string,
	args: string[],
	timeoutMs: number,
): Promise<ExecResult> {
	try {
		const { stdout } = await execFileP(path.join(EXECUTORS_DIR, script), args, {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout.trim());
		if (parsed && typeof parsed === "object") return parsed as ExecResult;
		return {
			error: `executor ${script}: unexpected output: ${stdout.trim().slice(0, 200)}`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { error: `executor ${script}: ${msg}` };
	}
}

/** Probe live sessions on pi.sock. Names include everything on the socket —
 *  callers filter to the pi- prefix (own prefix, own socket only). */
async function probeLive(): Promise<{ names: string[]; error?: string }> {
	const r = await runExecutor("sessions.sh", [], 5000);
	if ("sessions" in r) return { names: r.sessions };
	return { names: [], error: r.error };
}

function ownSessions(names: string[]): string[] {
	return names.filter((n) => n.startsWith(PREFIX));
}

// ---------------------------------------------------------------------------
// actor (single flat machine; created lazily — factory must not start things)
// ---------------------------------------------------------------------------

let actor: Actor<typeof tmuxMachine> | null = null;

function getActor(): Actor<typeof tmuxMachine> {
	if (!actor) {
		actor = createActor(tmuxMachine, { input: { limits: DEFAULT_LIMITS } });
		actor.start();
	}
	return actor;
}

function registry(): RegistryContext {
	return actor ? actor.getSnapshot().context : { sessions: [], limits: DEFAULT_LIMITS };
}

function send(event: TmuxEvent): void {
	getActor().send(event);
}

// ---------------------------------------------------------------------------
// tool result helpers — every result carries the slim registry snapshot
// ---------------------------------------------------------------------------

interface TmuxDetails {
	action: string;
	registry: RegistryContext;
	error?: string;
}

type ToolResult = AgentToolResult<TmuxDetails>;

function ok(action: string, text: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		details: { action, registry: registry() },
	};
}

function rej(action: string, reason: string): ToolResult {
	return {
		content: [{ type: "text", text: reason }],
		details: { action, registry: registry(), error: reason },
	};
}

function monitorCmd(id: string): string {
	return `tmux -S ${SOCKET_PATH} attach -t ${id}`;
}

function lastLines(s: string, n = 15): string {
	const lines = s.replace(/\n+$/, "").split("\n");
	return lines.slice(-n).join("\n");
}

function sanitizeSlug(tool: string): string {
	const s = tool
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "session";
}

function nextId(slug: string, taken: string[]): string {
	const base = `${PREFIX}${slug}`;
	if (!taken.includes(base)) return base;
	for (let n = 2; ; n++) {
		const id = `${base}-${n}`;
		if (!taken.includes(id)) return id;
	}
}

// ---------------------------------------------------------------------------
// viz (Stately inspector) — transport in ../_viz/viz-kit.ts: `::` port
// pre-check, clean-stop WS adapter, port auto-allocation. Wiring is
// creation-time: attach/detach = re-create actor from persisted snapshot
// (pure data, registry carries).
// ---------------------------------------------------------------------------

const viz = makeViz({ name: "tmux", preferredPort: VIZ_PORT });

/** Re-create the actor from its snapshot with the current viz option. */
function rewireActor(): void {
	const snapshot = actor ? actor.getPersistedSnapshot() : undefined;
	const old = actor;
	actor = createActor(tmuxMachine, {
		...(snapshot ? { snapshot } : { input: { limits: DEFAULT_LIMITS } }),
		...viz.option(),
	} as never);
	actor.start();
	old?.stop();
}

async function enableViz(open: boolean): Promise<string> {
	const r = await viz.enable({ open });
	if (!r.ok) return r.message;
	rewireActor();
	return `${r.message} (registry: ${registry().sessions.length} session(s))`;
}

function disableViz(): string {
	const r = viz.disable();
	if (!r.ok) return r.message;
	rewireActor();
	return r.message;
}

// ---------------------------------------------------------------------------
// footer — read-only 5s probe, no mutation
// ---------------------------------------------------------------------------

let footerOn = false;
let footerTimer: ReturnType<typeof setInterval> | null = null;

async function updateFooter(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const { names } = await probeLive();
	const live = ownSessions(names);
	const reg = registry().sessions;
	if (live.length === 0) {
		ctx.ui.setStatus("tmux", undefined);
		return;
	}
	const parts = live.map((id) => {
		const s = reg.find((e) => e.id === id);
		return s ? `${id} ${s.status.replace("_", " ")}` : `${id} (unregistered)`;
	});
	ctx.ui.setStatus(
		"tmux",
		`tmux ${live.length}/${registry().limits.maxSessions}: ${parts.join(" · ")}`,
	);
}

function setFooter(on: boolean, ctx: ExtensionContext): string {
	if (on === footerOn) return on ? "footer already on" : "footer already off";
	footerOn = on;
	if (on) {
		footerTimer = setInterval(() => void updateFooter(ctx), FOOTER_INTERVAL_MS);
		void updateFooter(ctx);
		return `footer on (live status, ${FOOTER_INTERVAL_MS / 1000}s probe)`;
	}
	if (footerTimer) {
		clearInterval(footerTimer);
		footerTimer = null;
	}
	ctx.ui.setStatus("tmux", undefined);
	return "footer off";
}

// ---------------------------------------------------------------------------
// status report (shared by tmux_status tool + /tmux status)
// ---------------------------------------------------------------------------

function formatEntry(s: SessionEntry): string {
	const prompt = s.promptRegex ? `/${s.promptRegex}/` : "(no prompt)";
	const monitor = s.monitor ? " [monitor]" : "";
	return `  ${s.id.padEnd(20)} ${s.tool.padEnd(10)} ${s.status.padEnd(15)} ${prompt}${monitor}`;
}

async function buildStatus(): Promise<{ text: string; error?: string }> {
	const a = getActor();
	const { names, error: probeError } = await probeLive();
	if (probeError) {
		return { text: `probe failed: ${probeError}`, error: probeError };
	}
	const before = registry().sessions;
	send({ type: "RECONCILE", live: ownSessions(names).map((name) => ({ name })) });
	const after = registry().sessions;
	const drift = driftReport(before, after);

	const lines: string[] = [];
	lines.push(`registry (${after.length} registered, live cap ${registry().limits.maxSessions}):`);
	if (after.length === 0) {
		lines.push("  (no sessions)");
	}
	for (const s of after) lines.push(formatEntry(s));
	if (drift.length > 0) {
		lines.push("drift:");
		for (const d of drift) lines.push(`  ${d}`);
	}
	lines.push(`live on pi.sock: ${ownSessions(names).join(", ") || "none"}`);
	lines.push("monitor:");
	for (const s of after.filter((e) => e.status !== "dead")) {
		lines.push(`  ${s.id}: ${monitorCmd(s.id)}`);
	}
	return { text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function tmuxExtension(pi: ExtensionAPI) {
	// ---- tools ----

	pi.registerTool({
		name: "tmux_start",
		label: "tmux start",
		description:
			"Start an interactive CLI (python, gdb, node, ...) in a managed tmux session and wait for its prompt. " +
			`Omit prompt_regex for servers/novel TTY apps (ready immediately). Prompt wait: escalating attempts, max ${DEFAULT_LIMITS.maxPromptWaits}. ` +
			"Python: use cmd 'PYTHON_BASIC_REPL=1 python3 -q' with prompt_regex '^>>> ' — the default PyREPL auto-indents continuation lines and mangles multiline sends. " +
			"Use tmux_send / tmux_wait / tmux_capture to drive it.",
		parameters: Type.Object({
			tool: Type.String({
				description: "tool name for the session id, e.g. python, gdb (session: pi-<tool>-<n>)",
			}),
			cmd: Type.String({ description: "command line to run, e.g. python3 or gdb ./a.out" }),
			prompt_regex: Type.Optional(
				Type.String({
					description:
						"regex marking the tool ready, e.g. '^>>> ' (python) or '^\\(gdb\\) ' (gdb). Omit to skip the wait",
				}),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate): Promise<ToolResult> {
			const a = getActor();
			const { names, error: probeError } = await probeLive();
			if (probeError) return rej("tmux_start", `probe failed: ${probeError}`);
			const live = ownSessions(names);

			const start = validateStart(registry(), live.length);
			if (!start.ok) {
				// name the cap occupants — the model shouldn't need a separate
				// tmux_status to see what blocks the start
				return rej("tmux_start", `${start.reason}\nlive on pi.sock: ${live.join(", ") || "none"}`);
			}

			const promptRegex = params.prompt_regex ?? null;
			send({
				type: "SESSION_START",
				tool: params.tool,
				cmd: params.cmd,
				promptRegex,
				liveCount: live.length,
			});

			const id = nextId(
				sanitizeSlug(params.tool),
				live.concat(registry().sessions.map((s) => s.id)),
			);
			const r = await runExecutor("start.sh", [id, params.cmd], 15000);
			if ("error" in r) {
				return rej("tmux_start", `failed to start '${params.cmd}' as ${id}: ${r.error}`);
			}
			send({ type: "SESSION_STARTED", id, tool: params.tool, promptRegex });

			if (!promptRegex) {
				return ok(
					"tmux_start",
					`session ${id} ready (${params.tool}, no prompt wait)\nmonitor: ${monitorCmd(id)}`,
				);
			}

			const limits = registry().limits;
			let lastPane = "";
			for (let attempt = 1; attempt <= limits.maxPromptWaits; attempt++) {
				const t = PROMPT_TIMEOUT * 2 ** (attempt - 1);
				if (signal?.aborted) return rej("tmux_start", "aborted before prompt wait");
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `${id}: waiting for prompt /${promptRegex}/ (attempt ${attempt}/${limits.maxPromptWaits}, ${t}s)`,
						},
					],
					details: { action: "tmux_start", registry: registry() },
				});
				const w = await runExecutor("wait.sh", [id, promptRegex, String(t)], (t + 5) * 1000);
				if ("matched" in w) {
					lastPane = w.lastPane;
					if (w.matched) {
						send({ type: "PROMPT_SEEN", id });
						return ok(
							"tmux_start",
							`session ${id} ready — prompt matched (attempt ${attempt})\nlast pane:\n${lastLines(lastPane)}\nmonitor: ${monitorCmd(id)}`,
						);
					}
				} else {
					send({ type: "SESSION_DEAD", id });
					return rej(
						"tmux_start",
						`session ${id} died while waiting for prompt: ${w.error}\nlast pane:\n${lastLines(lastPane) || "(empty)"}`,
					);
				}
			}
			send({ type: "PROMPT_TIMEOUT", id });
			return rej(
				"tmux_start",
				`prompt /${promptRegex}/ not seen in ${limits.maxPromptWaits} attempt(s) — ${id} marked failed\nlast pane:\n${lastLines(lastPane) || "(empty)"}`,
			);
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("tmux_start ")) + theme.fg("muted", `${args.tool} '${args.cmd}'`);
			if (args.prompt_regex) text += theme.fg("dim", ` /${args.prompt_regex}/`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderRegistry(result.details, theme);
		},
	});

	pi.registerTool({
		name: "tmux_send",
		label: "tmux send",
		description:
			"Send text to a live session. Embedded \\n submit lines; no extra Enter is appended if text ends with \\n. " +
			"End REPL blocks (def/class/if) with a trailing blank line — e.g. send exactly 'def f():\\n    return 1\\n\\n' " +
			"(note the \\n\\n): without it the block stays open and the next send lands inside it as a SyntaxError. " +
			"After sending, tmux_wait for the prompt (^>>> ) before the next send.",
		parameters: Type.Object({
			target: Type.String({ description: "session id, e.g. pi-python-1 (see tmux_status)" }),
			text: Type.String({ description: "text to send" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const { names, error: probeError } = await probeLive();
			if (probeError) return rej("tmux_send", `probe failed: ${probeError}`);
			const isLive = ownSessions(names).includes(params.target);

			const v = validateSend(registry(), params.target, isLive);
			if (!v.ok) {
				const entry = findSession(registry(), params.target);
				if (entry && entry.status !== "dead" && !isLive) {
					send({ type: "SESSION_DEAD", id: params.target });
				}
				return rej("tmux_send", v.reason);
			}
			send({ type: "SEND", id: params.target, text: params.text, live: true });

			const r = await runExecutor("send.sh", [params.target, params.text], 10000);
			if ("error" in r) {
				return rej("tmux_send", `send to ${params.target} failed: ${r.error}`);
			}
			return ok("tmux_send", `sent to ${params.target}`);
		},

		renderCall(args, theme) {
			const text = theme.fg("toolTitle", theme.bold("tmux_send ")) +
				theme.fg("accent", args.target) + " " +
				theme.fg("dim", `"${truncatePreview(args.text)}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderRegistry(result.details, theme);
		},
	});

	pi.registerTool({
		name: "tmux_wait",
		label: "tmux wait",
		description:
			"Poll a session pane for a regex until it matches or timeout. Anchor the regex (^/$) to avoid matching source text you typed. " +
			`Default timeout ${WAIT_TIMEOUT}s. Timeout returns the last pane for diagnosis.`,
		parameters: Type.Object({
			target: Type.String({ description: "session id" }),
			regex: Type.String({ description: "regex to poll for, e.g. '^42$'" }),
			timeout: Type.Optional(
				Type.Number({ description: `seconds to wait (default ${WAIT_TIMEOUT})` }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const v = validateWait(registry(), params.target);
			if (!v.ok) return rej("tmux_wait", v.reason);

			const t = params.timeout ?? WAIT_TIMEOUT;
			const r = await runExecutor(
				"wait.sh",
				[params.target, params.regex, String(Math.max(1, Math.floor(t)))],
				(t + 5) * 1000,
			);
			if ("matched" in r) {
				if (r.matched) {
					send({ type: "WAIT_MATCHED", id: params.target, regex: params.regex });
					return ok(
						"tmux_wait",
						`matched /${params.regex}/ in ${params.target}\nlast pane:\n${lastLines(r.lastPane)}`,
					);
				}
				send({ type: "WAIT_TIMEOUT", id: params.target, regex: params.regex });
				const entry = findSession(registry(), params.target);
				return rej(
					"tmux_wait",
					`timeout (${t}s) waiting for /${params.regex}/ in ${params.target} — waitAttempts ${entry?.waitAttempts ?? "?"}/${registry().limits.maxWaitAttempts}\nlast pane:\n${r.lastPane}`,
				);
			}
			send({ type: "SESSION_DEAD", id: params.target });
			return rej("tmux_wait", `wait on ${params.target} failed: ${r.error}`);
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("tmux_wait ")) +
				theme.fg("accent", args.target) + " " +
				theme.fg("muted", `/${args.regex}/`);
			if (args.timeout !== undefined) text += theme.fg("dim", ` ${args.timeout}s`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderRegistry(result.details, theme);
		},
	});

	pi.registerTool({
		name: "tmux_capture",
		label: "tmux capture",
		description: `Capture a session's pane text, bounded (default ${CAPTURE_LINES} lines, max 2000).`,
		parameters: Type.Object({
			target: Type.String({ description: "session id" }),
			lines: Type.Optional(
				Type.Number({ description: `history window in lines (default ${CAPTURE_LINES})` }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const v = validateKnown(registry(), params.target);
			if (!v.ok) return rej("tmux_capture", v.reason);

			const lines = params.lines ?? CAPTURE_LINES;
			const r = await runExecutor(
				"capture.sh",
				[params.target, String(Math.max(1, Math.min(2000, Math.floor(lines))))],
				10000,
			);
			if ("text" in r) return ok("tmux_capture", r.text);
			send({ type: "SESSION_DEAD", id: params.target });
			return rej("tmux_capture", `capture of ${params.target} failed: ${r.error}`);
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("tmux_capture ")) + theme.fg("accent", args.target);
			if (args.lines !== undefined) text += theme.fg("dim", ` ${args.lines} lines`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderRegistry(result.details, theme);
		},
	});

	pi.registerTool({
		name: "tmux_kill",
		label: "tmux kill",
		description:
			"Kill a session and unregister it. Killing an already-dead entry just unregisters. Explicit kill overrides monitor.",
		parameters: Type.Object({
			target: Type.String({ description: "session id" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const v = validateKnown(registry(), params.target);
			if (!v.ok) return rej("tmux_kill", v.reason);

			const r = await runExecutor("kill.sh", [params.target], 10000);
			// unregister regardless — registry is always suspect; kill of a dead
			// session is registry hygiene, not an error
			send({ type: "KILL", id: params.target });
			if ("error" in r) {
				return ok(
					"tmux_kill",
					`unregistered ${params.target} (tmux: ${r.error})`,
				);
			}
			return ok("tmux_kill", `killed ${params.target}\nmonitor (was): ${monitorCmd(params.target)}`);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("tmux_kill ")) + theme.fg("accent", args.target),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderRegistry(result.details, theme);
		},
	});

	pi.registerTool({
		name: "tmux_status",
		label: "tmux status",
		description:
			"Probe pi.sock, reconcile the registry (mark dead, adopt stray pi-* sessions), and report session states + monitor commands.",
		parameters: Type.Object({}),
		executionMode: "sequential",

		async execute(): Promise<ToolResult> {
			const { text, error } = await buildStatus();
			if (error) return rej("tmux_status", text);
			return ok("tmux_status", text);
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("tmux_status")), 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderRegistry(result.details, theme);
		},
	});

	// ---- command ----

	pi.registerCommand("tmux", {
		description: "tmux sessions: status | kill --all | footer | viz [off]",

		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				const { text } = await buildStatus();
				if (ctx.hasUI) {
					await ctx.ui.select("tmux status", text.split("\n"));
				}
				return;
			}

			if (sub === "kill") {
				if (!parts.includes("--all")) {
					ctx.ui.notify("usage: /tmux kill --all (own pi-* sessions only)", "warning");
					return;
				}
				const { names, error: probeError } = await probeLive();
				if (probeError) {
					ctx.ui.notify(`probe failed: ${probeError}`, "error");
					return;
				}
				const monitored = registry().sessions.filter((s) => s.monitor).map((s) => s.id);
				const targets = ownSessions(names).filter((id) => !monitored.includes(id));
				const report: string[] = [];
				for (const id of targets) {
					const r = await runExecutor("kill.sh", [id], 10000);
					send({ type: "KILL", id });
					report.push(
						"error" in r ? `${id}: unregistered (${r.error})` : `${id}: killed`,
					);
				}
				// monitored: unregister from this registry, keep tmux session alive
				for (const id of monitored) {
					send({ type: "KILL", id });
				}
				// unregister registered-but-gone entries too
				for (const s of registry().sessions) {
					send({ type: "KILL", id: s.id });
				}
				if (monitored.length > 0) {
					report.push(`kept (monitor): ${monitored.join(", ")}`);
				}
				report.push(
					targets.length === 0 ? "no live pi-* sessions on pi.sock" : `killed ${targets.length}`,
				);
				if (ctx.hasUI) await ctx.ui.select("tmux kill --all", report);
				return;
			}

			if (sub === "monitor") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("usage: /tmux monitor <session-id> — keep alive across pi quit", "warning");
					return;
				}
				const v = validateKnown(registry(), id);
				if (!v.ok) {
					ctx.ui.notify(v.reason, "warning");
					return;
				}
				send({ type: "MONITOR_TOGGLE", id });
				const on = findSession(registry(), id)?.monitor === true;
				ctx.ui.notify(`${id}: monitor ${on ? "on — kept alive across pi quit" : "off"}`, "info");
				return;
			}

			if (sub === "footer") {
				const on = parts[1] === "on" || (parts[1] !== "off" && !footerOn);
				ctx.ui.notify(setFooter(on, ctx), "info");
				return;
			}

			if (sub === "viz") {
				if (parts[1] === "off") {
					ctx.ui.notify(disableViz(), "info");
				} else {
					ctx.ui.notify(await enableViz(true), "info");
				}
				return;
			}

			ctx.ui.notify(
				"usage: /tmux [status | kill --all | monitor <id> | footer [on|off] | viz [off]]",
				"warning",
			);
		},
	});

	// ---- lifecycle ----

	// restore registry from the branch, then reconcile against ground truth
	// (stray scan: crash recovery, adoption, dead-marking). Viz auto-start after
	// restore — enableViz re-creates the actor with inspect, registry carries.
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
		await reconcileFromProbe(ctx);
		if (process.env.TMUX_VIZ === "1") {
			const msg = await enableViz(true);
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		await reconcileFromProbe(ctx);
	});

	// kill registered non-monitor sessions + strays at pi quit only; session
	// switches (reload/new/resume/fork) leave sessions running — restore +
	// reconcile handles them on return. Foreign sockets never scanned.
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") {
			const { names } = await probeLive();
			const live = ownSessions(names);
			const entries = registry().sessions;
			for (const s of entries) {
				if (s.monitor) continue;
				await runExecutor("kill.sh", [s.id], 10000);
				send({ type: "KILL", id: s.id });
			}
			// strays: live pi-* not registered (crash leftovers) — never foreign
			const registered = new Set(entries.map((s) => s.id));
			for (const id of live) {
				if (registered.has(id)) continue;
				await runExecutor("kill.sh", [id], 10000);
			}
		}
		// idempotent teardown: footer timer, viz transport (WS client + relay)
		if (footerTimer) {
			clearInterval(footerTimer);
			footerTimer = null;
		}
		footerOn = false;
		viz.stop();
	});
}

// ---------------------------------------------------------------------------
// shared render helpers
// ---------------------------------------------------------------------------

function truncatePreview(s: string, n = 40): string {
	const one = s.replace(/\n/g, "\\n");
	return one.length > n ? `${one.slice(0, n)}…` : one;
}

// exported for testing (viz lifecycle without a pi session)
export { enableViz, disableViz };

function renderRegistry(details: unknown, theme: Theme): Text {
	const d = details as TmuxDetails | undefined;
	if (!d) return new Text("", 0, 0);
	if (d.error) {
		const head = d.error.split("\n")[0];
		return new Text(theme.fg("error", head), 0, 0);
	}
	const sessions = d.registry?.sessions ?? [];
	if (sessions.length === 0) return new Text(theme.fg("dim", "no sessions"), 0, 0);
	const summary = sessions
		.map((s: SessionEntry) => {
			const color =
				s.status === "ready" ? "success" : s.status === "dead" ? "error" : "accent";
			return theme.fg(color, `${s.id} ${s.status}`);
		})
		.join(theme.fg("dim", " · "));
	return new Text(summary, 0, 0);
}
