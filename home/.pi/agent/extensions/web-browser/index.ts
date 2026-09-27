/**
 * web-browser extension — machine-backed browser control (CDP).
 *
 * Machine owns legality: page ops are only legal in `running`, launch only
 * from `stopped`, emulation presets validated against known devices.
 * Executors own IO, all local to executors/: extension probes (probe.mjs /
 * stop.mjs, JSON out, failure-as-data) + the browser action scripts
 * (start/nav/eval/screenshot/pick/switch-tab/emulate, moved from the
 * web-browser skill). Machine context is a cache; ground truth for "is the
 * browser up" is always a probe — PROBE adopts a live browser from `stopped`
 * (kept open across a pi restart) and marks drift from `running`.
 *
 * Launch modes fresh | profile | reset-profile launch an isolated instance
 * we own and may kill. `attach` (and probed `foreign` instances) are the
 * user's browser — never killed.
 *
 * Tools: browser_start, browser_navigate, browser_eval, browser_screenshot,
 *        browser_pick, browser_tabs, browser_switch_tab, browser_emulate,
 *        browser_status, browser_stop
 * Command: /browser status | stop | footer [on|off] | viz [off]
 * Env: BROWSER_DEBUG_PORT (default 9222), BROWSER_BIN, BROWSER_VIZ=1,
 *      BROWSER_VIZ_PORT (default 8081 — tmux/web-search viz own 8080)
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { readActiveTab } from "./executors/active-tab.js";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createActor } from "xstate";
import type { Actor } from "xstate";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { makeViz } from "../_viz/viz-kit.ts";
import {
	browserMachine,
	emulateViolation,
	launchViolation,
	notRunningReason,
	resolveAuto,
	type AutoResolution,
	type BrowserContext,
	type BrowserEvent,
	type BrowserMode,
	type DetectBuckets,
	type EmulationPref,
	type ActiveTab,
	type LaunchMode,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const EXECUTORS_DIR = fileURLToPath(new URL("./executors", import.meta.url));

function envNum(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const DEBUG_PORT = envNum("BROWSER_DEBUG_PORT", 9222);
const FOOTER_INTERVAL_MS = 5000;
// tmux/web-search viz default to 8080; makeViz walks if busy regardless
const VIZ_PORT = envNum("BROWSER_VIZ_PORT", 8081);

const T_START = 120_000; // launch + profile rsync + endpoint poll
const T_NAV = 50_000;
const T_EVAL = 55_000;
const T_SCREENSHOT = 40_000;
const T_PICK = 320_000; // interactive: 5m script budget + pad
const T_TABS = 30_000;
const T_SWITCH = 30_000;
const T_EMULATE = 25_000;
const T_PROBE = 10_000;
const T_DETECT = 15_000; // auto start: ps + plutil + per-port CDP probes
const T_STOP = 15_000;

// ---------------------------------------------------------------------------
// executors — extension probes (JSON out) + action scripts (text out), all local
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);

/** Extension executor: JSON out, exit 0, failure-as-data. */
async function runExecutor<T>(script: string, args: string[], timeoutMs: number): Promise<T | { error: string }> {
	try {
		const { stdout } = await execFileP(process.execPath, [path.join(EXECUTORS_DIR, script), ...args], {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout.trim());
		if (parsed && typeof parsed === "object") return parsed as T;
		return { error: `executor ${script}: unexpected output: ${stdout.trim().slice(0, 200)}` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { error: `executor ${script}: ${msg}` };
	}
}

/** Executor script (node CLI, ex-skill): never throws — code/stdout/stderr as data. */
async function runSkill(
	script: string,
	args: string[],
	timeoutMs: number,
	extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env, BROWSER_DEBUG_PORT: String(DEBUG_PORT), ...extraEnv };
	try {
		const { stdout, stderr } = await execFileP(process.execPath, [path.join(EXECUTORS_DIR, script), ...args], {
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			env,
		});
		return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: (e.stdout ?? "").toString().trim(),
			stderr: ((e.stderr ?? "").toString().trim() || e.message || "failed").trim(),
		};
	}
}

interface ProbeOut {
	up: boolean;
	port: number;
	browser: string | null;
	pid: number | null;
	mode: BrowserMode;
	userDataDir: string | null;
	startedAt: string | null;
}

async function probeOnce(port: number = DEBUG_PORT): Promise<ProbeOut | null> {
	const r = await runExecutor<ProbeOut>("probe.mjs", [String(port)], T_PROBE);
	if ("error" in r || typeof r.up !== "boolean") return null;
	return r;
}

/** Auto-start detection (detect.mjs): attachable / runningNoCdp / installed / default. */
async function detectOnce(): Promise<DetectBuckets | { error: string }> {
	const r = await runExecutor<DetectBuckets>("detect.mjs", [], T_DETECT);
	if ("error" in r) return r;
	if (
		!Array.isArray(r.attachable) ||
		!Array.isArray(r.runningNoCdp) ||
		!Array.isArray(r.installed) ||
		(r.default !== null && typeof r.default !== "object")
	) {
		return { error: `unexpected detect output: ${JSON.stringify(r).slice(0, 200)}` };
	}
	return r;
}

// ---------------------------------------------------------------------------
// actor — single machine, lazily created; viz spread at creation time
// ---------------------------------------------------------------------------

let actor: Actor<typeof browserMachine> | null = null;
const viz = makeViz({ name: "browser", preferredPort: VIZ_PORT });

function getActor(): Actor<typeof browserMachine> {
	if (!actor) {
		actor = createActor(browserMachine, { ...viz.option() } as never) as Actor<typeof browserMachine>;
		actor.start();
	}
	return actor;
}

/** Re-create the actor from its persisted snapshot (viz attach/detach). */
function reCreateActor(): void {
	const snapshot = actor?.getPersistedSnapshot();
	const old = actor;
	actor = createActor(
		browserMachine,
		{
			...(snapshot ? { snapshot } : {}),
			...viz.option(),
		} as never,
	) as Actor<typeof browserMachine>;
	actor.start();
	old?.stop();
}

function ctx(): BrowserContext {
	return actor ? actor.getSnapshot().context : { browser: null, activeTab: null, emulation: null, errors: [], devices: [] };
}

function stateValue(): string {
	return actor ? String(actor.getSnapshot().value) : "stopped";
}

function send(event: BrowserEvent): void {
	getActor().send(event);
}

/** Known device presets — ground truth is executors/devices.js. */
async function loadDevices(): Promise<void> {
	try {
		const mod = (await import(pathToFileURL(path.join(EXECUTORS_DIR, "devices.js")).href)) as {
			listDevicePresets?: () => { id: string }[];
		};
		const ids = mod.listDevicePresets?.().map((p) => p.id) ?? [];
		if (ids.length > 0) send({ type: "DEVICES", ids });
	} catch {
		// defaults from machine.ts stay
	}
}

// ---------------------------------------------------------------------------
// restore + probe — branch caches + ground truth
// ---------------------------------------------------------------------------

/** Last browser_* tool-result context on the active branch (todo.ts pattern). */
function lastContextFromBranch(extCtx: ExtensionContext): Partial<BrowserContext> | null {
	let found: Partial<BrowserContext> | null = null;
	for (const entry of extCtx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || !msg.toolName?.startsWith("browser_")) continue;
		const c = (msg.details as BrowserDetails | undefined)?.context;
		if (c && typeof c === "object") found = c;
	}
	return found;
}

/** RESTORE fills caches only — browser info is always re-probed. */
function restoreFromBranch(extCtx: ExtensionContext): void {
	const c = lastContextFromBranch(extCtx);
	if (!c) return;
	send({
		type: "RESTORE",
		activeTab: (c.activeTab as ActiveTab | null) ?? null,
		emulation: (c.emulation as EmulationPref | null) ?? null,
		devices: Array.isArray(c.devices) ? c.devices : null,
	});
}

/** Probe + PROBE event: adopt a live browser from stopped, mark drift from running. */
async function probeAndReconcile(extCtx: ExtensionContext): Promise<void> {
	const before = stateValue();
	const p = await probeOnce(ctx().browser?.port ?? DEBUG_PORT);
	if (!p) {
		if (extCtx.hasUI) extCtx.ui.notify("browser probe failed (executor error)", "warning");
		return;
	}
	send({
		type: "PROBE",
		up: p.up,
		port: p.port,
		browser: p.browser,
		pid: p.pid,
		mode: p.mode,
		userDataDir: p.userDataDir,
		startedAt: p.startedAt,
	});
	if (extCtx.hasUI) {
		if (before === "stopped" && stateValue() === "running") {
			extCtx.ui.notify(
				`browser: adopted live browser (${p.mode} on :${p.port}) — pi never kills it; page ops need browser_navigate first`,
				"info",
			);
		} else if (before === "running" && stateValue() === "stopped") {
			extCtx.ui.notify("browser: gone since last probe (marked stopped)", "warning");
		}
	}
}

// ---------------------------------------------------------------------------
// tool result helpers — every result carries the slim context snapshot
// ---------------------------------------------------------------------------

interface BrowserDetails {
	action: string;
	context: BrowserContext;
	error?: string;
}

type ToolResult = AgentToolResult<BrowserDetails>;

function slimContext(): BrowserContext {
	const c = ctx();
	return { ...c, errors: c.errors.slice(-5) };
}

function ok(action: string, text: string): ToolResult {
	return { content: [{ type: "text", text }], details: { action, context: slimContext() } };
}

function rej(action: string, reason: string): ToolResult {
	return {
		content: [{ type: "text", text: reason }],
		details: { action, context: slimContext(), error: reason },
	};
}

/** Precheck for page ops: machine must be in `running`. */
function requireRunning(action: string): ToolResult | null {
	if (stateValue() === "running") return null;
	return rej(action, notRunningReason(stateValue()));
}

/** Precheck for read/interact ops: an extension-recorded active tab must
 *  exist (same truth the executors read — the active-tab state file). Without
 *  it, eval/screenshot/pick would silently target whatever tab the human user
 *  last focused on an adopted foreign browser — never acceptable. */
function requireActiveTab(action: string): ToolResult | null {
	if (readActiveTab()) return null;
	return rej(
		action,
		"no active tab recorded — browser_navigate or browser_switch_tab first " +
			"(this tool never auto-targets a tab pi did not choose, especially on an adopted foreign browser)",
	);
}

function truncatePreview(s: string, n = 48): string {
	const one = s.replace(/\n/g, "\\n");
	return one.length > n ? `${one.slice(0, n)}…` : one;
}

// ---------------------------------------------------------------------------
// auto start — resolution → prompt → launch plan (executor-side UX; the
// machine is untouched: prompts never gate legality, and the resolved mode
// flows through the same BEGIN_LAUNCH → LAUNCH_DONE path as explicit modes)
// ---------------------------------------------------------------------------

/** TUI select when available: pick string | null (Esc/skip) | undefined (no TUI). */
async function autoSelect(
	extCtx: unknown,
	title: string,
	options: string[],
): Promise<string | null | undefined> {
	const uiAny = extCtx as
		| { mode?: string; ui?: { select?: (t: string, o: string[]) => Promise<string | null> } }
		| undefined;
	if (uiAny?.mode === "tui" && typeof uiAny.ui?.select === "function") {
		return uiAny.ui.select(title, options);
	}
	return undefined; // non-TUI — caller picks the first option
}

interface LaunchPlan {
	mode: LaunchMode;
	env: Record<string, string>;
	note: string;
}

/** Prompt intent → concrete launch plan, or a readable rejection string. */
async function resolveAutoAction(
	res: AutoResolution,
	d: DetectBuckets,
	extCtx: unknown,
): Promise<LaunchPlan | string> {
	if (res.action.kind === "error") {
		return `auto: ${res.note}${res.warnings.length > 0 ? `\n${res.warnings.join("\n")}` : ""}`;
	}
	if (res.action.kind === "attach") {
		return {
			mode: "attach",
			env: { BROWSER_DEBUG_PORT: String(res.action.port) },
			note: `auto: ${res.note}`,
		};
	}
	if (res.action.kind === "launch") {
		return { mode: "fresh", env: { BROWSER_BIN: res.action.bin }, note: `auto: ${res.note}` };
	}
	if (res.action.kind === "prompt-attach") {
		const options = d.attachable.map((a) => `${a.name} (:${a.port})`);
		const pick = await autoSelect(
			extCtx,
			"browser auto-start — several browsers with CDP, attach which?",
			options,
		);
		if (pick === undefined) {
			const first = d.attachable[0]!;
			return {
				mode: "attach",
				env: { BROWSER_DEBUG_PORT: String(first.port) },
				note: `auto: ${res.note} — no TUI prompt, picked ${first.name} (:${first.port})`,
			};
		}
		if (pick === null) {
			return `auto: ${res.note}\nskipped the prompt — browser_start again or pass an explicit mode`;
		}
		const a = d.attachable.find((x) => `${x.name} (:${x.port})` === pick);
		if (!a) return `auto: unrecognized prompt choice "${pick}"`;
		return {
			mode: "attach",
			env: { BROWSER_DEBUG_PORT: String(a.port) },
			note: `auto: attached to ${a.name} (:${a.port})`,
		};
	}

	// prompt-launch: default preselected (first) when usable; blocked browsers
	// stay in the options with a warning suffix — the user may want to quit one
	const singletonRunning = new Set(
		d.runningNoCdp
			.filter((r) => d.installed.some((i) => i.name === r.name && i.globalSingleton))
			.map((r) => r.name),
	);
	const ordered = [
		...(d.default && !singletonRunning.has(d.default.name) ? [d.default] : []),
		...d.installed.filter((i) => !(d.default && i.name === d.default.name)),
	];
	const options = ordered.map(
		(i) =>
			`${i.name}${singletonRunning.has(i.name) ? " — running without CDP, quit it first or attach" : ""}`,
	);
	const pick = await autoSelect(extCtx, "browser auto-start — no browser with CDP, launch which?", options);
	if (pick === null) {
		return `auto: ${res.note}\nskipped the prompt — browser_start again or pass an explicit mode`;
	}
	const firstCandidate = ordered.find((i) => !singletonRunning.has(i.name)) ?? ordered[0]!;
	const chosen =
		pick === undefined
			? firstCandidate
			: ordered.find((x) => pick === x.name || pick.startsWith(`${x.name} —`));
	if (!chosen) return `auto: unrecognized prompt choice "${pick}"`;
	return {
		mode: "fresh",
		env: { BROWSER_BIN: chosen.bin },
		note: `auto: ${res.note}${pick === undefined ? ` — no TUI prompt, picked ${chosen.name}` : ""}`,
	};
}

/** Single launch/attach path shared by auto + explicit modes. */
async function runLaunch(
	mode: LaunchMode,
	extraEnv: Record<string, string>,
	note: string,
	warnings: string[],
): Promise<ToolResult> {
	send({ type: "BEGIN_LAUNCH", mode });

	const flags =
		mode === "profile"
			? ["--profile"]
			: mode === "reset-profile"
				? ["--reset-profile"]
				: mode === "attach"
					? ["--attach"]
				: [];
	const port = extraEnv.BROWSER_DEBUG_PORT ? Number(extraEnv.BROWSER_DEBUG_PORT) : DEBUG_PORT;

	const r = await runSkill("start.js", flags, T_START, extraEnv);
	if (r.code !== 0) {
		const error = r.stderr || r.stdout || "start.js failed";
		send({
			type: "LAUNCH_DONE",
			mode,
			port,
			pid: null,
			userDataDir: null,
			browser: null,
			error,
		});
		return rej(
			"browser_start",
			`failed to start browser (${mode}):${note ? `\n${note}` : ""}\n${error}`,
		);
	}

	// fresh evidence — probe fills pid / mode / product string
	const p = await probeOnce(port);
	if (!p || !p.up) {
		send({
			type: "LAUNCH_DONE",
			mode,
			port,
			pid: null,
			userDataDir: null,
			browser: null,
			error: "started but the debug endpoint did not answer the follow-up probe",
		});
		return rej(
			"browser_start",
			`${r.stdout}\nprobe could not confirm the debug endpoint on :${port} — try browser_status`,
		);
	}
	send({
		type: "LAUNCH_DONE",
		mode: p.mode === "foreign" ? mode : (p.mode as typeof mode),
		port: p.port,
		pid: p.pid,
		userDataDir: p.userDataDir,
		browser: p.browser,
		error: null,
	});
	const c = ctx();
	const warnText = warnings.length > 0 ? `\n${warnings.join("\n")}` : "";
	return ok(
		"browser_start",
		`${note ? `${note}\n` : ""}${r.stdout}\nbrowser running (${c.browser?.mode} on :${c.browser?.port}${c.browser?.pid ? `, pid ${c.browser.pid}` : ""})${warnText}`,
	);
}

// ---------------------------------------------------------------------------
// footer — read-only probe, no machine events
// ---------------------------------------------------------------------------

let footerOn = false;
let footerTimer: ReturnType<typeof setInterval> | null = null;

async function updateFooter(extCtx: ExtensionContext): Promise<void> {
	if (!extCtx.hasUI) return;
	const p = await probeOnce(ctx().browser?.port ?? DEBUG_PORT);
	if (!p || !p.up) {
		extCtx.ui.setStatus("browser", undefined);
		return;
	}
	const c = ctx();
	const url = c.activeTab?.url;
	const short = url ? ` · ${url.replace(/^https?:\/\//, "").slice(0, 40)}` : "";
	extCtx.ui.setStatus("browser", `browser ${p.mode} :${p.port}${short}`);
}

function setFooter(on: boolean, extCtx: ExtensionContext): string {
	if (on === footerOn) return on ? "footer already on" : "footer already off";
	footerOn = on;
	if (on) {
		footerTimer = setInterval(() => void updateFooter(extCtx), FOOTER_INTERVAL_MS);
		void updateFooter(extCtx);
		return `footer on (live probe every ${FOOTER_INTERVAL_MS / 1000}s)`;
	}
	if (footerTimer) {
		clearInterval(footerTimer);
		footerTimer = null;
	}
	extCtx.ui.setStatus("browser", undefined);
	return "footer off";
}

// ---------------------------------------------------------------------------
// status report (shared by browser_status tool + /browser status)
// ---------------------------------------------------------------------------

interface TabInfo {
	targetId: string;
	title: string;
	url: string;
	visible: boolean;
	spaceTitle: string | null;
	folder: string | null;
}

/** switch-tab.js --json out (switch mode): structured switch evidence. */
interface SwitchJson {
	switched: boolean;
	targetId: string | null;
	url: string;
	title: string;
	spaceTitle: string | null;
	restoredWindow: boolean;
}

async function listTabs(visibleOnly: boolean): Promise<TabInfo[] | null> {
	const args = ["--list", "--json", ...(visibleOnly ? ["--visible"] : [])];
	const r = await runSkill("switch-tab.js", args, T_TABS);
	if (r.code !== 0 || !r.stdout) return null;
	try {
		const parsed = JSON.parse(r.stdout);
		if (Array.isArray(parsed)) return parsed as TabInfo[];
	} catch {
		// fall through
	}
	return null;
}

function emulationLine(c: BrowserContext): string {
	if (!c.emulation) return "emulation: none (desktop)";
	const e = c.emulation;
	return `emulation: ${e.device}${e.landscape ? " (landscape)" : ""} — set ${e.at}`;
}

async function buildStatus(): Promise<{ text: string; error?: string }> {
	const p = await probeOnce(ctx().browser?.port ?? DEBUG_PORT);
	if (!p) return { text: "browser probe failed (executor error)", error: "probe failed" };
	send({
		type: "PROBE",
		up: p.up,
		port: p.port,
		browser: p.browser,
		pid: p.pid,
		mode: p.mode,
		userDataDir: p.userDataDir,
		startedAt: p.startedAt,
	});

	const c = ctx();
	const lines: string[] = [];
	lines.push(`state: ${stateValue()}`);
	if (!p.up) {
		lines.push(`debug endpoint :${p.port} is down — browser_start to launch (auto | fresh | profile | reset_profile | attach)`);
	} else {
		lines.push(`browser: ${p.mode} on :${p.port}${p.browser ? ` (${p.browser})` : ""}`);
		if (p.pid) lines.push(`pid: ${p.pid}`);
		lines.push(`active tab: ${c.activeTab ? `${c.activeTab.url}${c.activeTab.targetId ? ` (${c.activeTab.targetId})` : ""}` : "(none recorded — browser_navigate or browser_switch_tab)"}`);
		const tabs = await listTabs(false);
		if (tabs === null) {
			lines.push("tabs: (could not list)");
		} else {
			const visible = tabs.filter((t) => t.visible).length;
			lines.push(`tabs: ${tabs.length} (${visible} visible)`);
			for (const t of tabs.slice(0, 8)) {
				const dot = t.visible ? "●" : "○";
				const title = t.title.length > 60 ? `${t.title.slice(0, 57)}...` : t.title;
				lines.push(`  ${dot} ${title} — ${t.url}`);
			}
			if (tabs.length > 8) lines.push(`  … ${tabs.length - 8} more`);
		}
	}
	lines.push(emulationLine(c));
	if (c.errors.length > 0) {
		lines.push("recent events:");
		for (const e of c.errors.slice(-3)) lines.push(`  ${e}`);
	}
	return { text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// autocomplete — '/browser <subcommand>' (delegates to current provider)
// ---------------------------------------------------------------------------

const SUBCOMMANDS: { value: string; description: string }[] = [
	{ value: "status", description: "probe the debug endpoint + report state" },
	{ value: "stop", description: "stop owned browser, clear state files" },
	{ value: "footer", description: "toggle live footer status line" },
	{ value: "viz", description: "attach the Stately inspector (live visualisation)" },
];

function createBrowserAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol);
			const m = /^\/browser ?([a-z]*)$/.exec(before);
			if (!m) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const typed = m[1] ?? "";
			const items: AutocompleteItem[] = SUBCOMMANDS.filter((s) => s.value.startsWith(typed)).map((s) => ({
				value: s.value,
				label: s.value,
				description: s.description,
			}));
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: typed };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function webBrowserExtension(pi: ExtensionAPI) {
	// ---- tools ----

	pi.registerTool({
		name: "browser_start",
		label: "browser start",
		description:
			"Launch or attach a browser with CDP and wait for the debug endpoint. Modes: auto (default — evaluates running " +
			"browsers: attach the single CDP browser, prompt to choose between several, launch your default browser when none " +
			"runs — demoting a running global-singleton browser like Arc without CDP; an attached browser is never auto-navigated " +
			"in existing tabs), fresh (isolated reusable profile), profile (copy your Chrome profile into an isolated cache), " +
			"reset_profile (clear the cached profile first), attach (connect to an already-running browser with remote " +
			"debugging — never killed by this extension). " +
			"Refuses to reuse an unknown instance on the port. Use browser_navigate / browser_eval / browser_screenshot / browser_pick once running.",
		parameters: Type.Object({
			mode: Type.Optional(
				Type.Union(
					[
						Type.Literal("auto"),
						Type.Literal("fresh"),
						Type.Literal("profile"),
						Type.Literal("reset_profile"),
						Type.Literal("attach"),
					],
					{ description: "auto (default) | fresh | profile | reset_profile | attach" },
				),
			),
			bin: Type.Optional(
					Type.String({ description: "browser binary path (default: auto-detected / your default browser in auto mode)" }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, extCtx): Promise<ToolResult> {
			const v = launchViolation(ctx());
			if (v) return rej("browser_start", v);

			// auto (default): detect → resolveAuto (pure, machine.ts) → prompt
			// (executor-side UX; machine untouched) → runLaunch. The machine sees
			// only the resolved attach/fresh mode — the same path as explicit modes.
			if (!params.mode || params.mode === "auto") {
				const d = await detectOnce();
				if ("error" in d) return rej("browser_start", `auto detect failed: ${d.error}`);
				const res = resolveAuto(d);
				const plan = await resolveAutoAction(res, d, extCtx);
				if (typeof plan === "string") return rej("browser_start", plan);
				return runLaunch(plan.mode, plan.env, plan.note, res.warnings);
			}

			// pi param style is reset_profile; the skill flag is --reset-profile
			const mode: LaunchMode = params.mode === "reset_profile" ? "reset-profile" : params.mode;
			return runLaunch(mode, params.bin ? { BROWSER_BIN: params.bin } : {}, "", []);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_start ")) + theme.fg("muted", args.mode ?? "auto"),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_navigate",
		label: "browser navigate",
		description:
			"Navigate the active tab, or open a new tab. Applies the active emulation preset if one is set. " +
			"Warnings about stale active-tab state come through in the output.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to" }),
			new_tab: Type.Optional(Type.Boolean({ description: "open in a new tab (default: current)" })),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const pre = requireRunning("browser_navigate");
			if (pre) return pre;

			// foreign attach policy: never overwrite a tab in the user's browser —
			// navigate always opens a new one, then verify it landed in a visible
			// window (Arc Spaces: a new tab may land in a hidden-Space window)
			const c = ctx();
			const foreign = c.browser?.mode === "attach" || c.browser?.mode === "foreign";
			const newTab = params.new_tab === true || foreign;
			const notes: string[] = [];
			if (foreign && params.new_tab !== true) {
				notes.push("auto: attached browser — opened a new tab (never overwrites existing tabs)");
			}

			const r = await runSkill("nav.js", [params.url, ...(newTab ? ["--new"] : [])], T_NAV);
			if (r.code !== 0) return rej("browser_navigate", r.stderr || r.stdout);
			send({ type: "NAV", url: params.url, newTab });

			if (foreign) {
				const tabs = await listTabs(false);
				const t = tabs?.filter((x) => x.url === params.url).at(-1);
				if (t && !t.visible) {
					notes.push(
						"warning: the new tab landed in a hidden window (Arc Space?) — browser_switch_tab can target/restore it, or browser_tabs visible to see the visible set",
					);
				}
			}
			const text = r.stdout || `navigated to ${params.url}`;
			return ok("browser_navigate", notes.length > 0 ? `${text}\n${notes.join("\n")}` : text);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_navigate ")) +
					theme.fg("accent", truncatePreview(args.url, 60)) +
					(args.new_tab ? theme.fg("dim", " --new") : ""),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_eval",
		label: "browser eval",
		description:
			"Evaluate JavaScript in the active tab (async context, returnByValue). Requires an extension-recorded " +
			"active tab (browser_navigate / browser_switch_tab first — never auto-targets an unchosen tab). " +
			"Applies the active emulation preset. Best with single quotes around the code.",
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript expression to evaluate" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const pre = requireRunning("browser_eval") ?? requireActiveTab("browser_eval");
			if (pre) return pre;

			const r = await runSkill("eval.js", [params.code], T_EVAL);
			if (r.code !== 0) return rej("browser_eval", r.stderr || r.stdout);
			return ok("browser_eval", r.stdout || "(no output)");
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_eval ")) +
					theme.fg("muted", truncatePreview(args.code)),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "browser screenshot",
		description:
			"Screenshot the active tab — requires an extension-recorded active tab (browser_navigate / " +
			"browser_switch_tab first — never auto-targets an unchosen tab). Default: current viewport. full_page captures the whole document; " +
			"device emulates a preset for this screenshot only; selector clips to a CSS-matched element. " +
			"Returns the screenshot file path.",
		parameters: Type.Object({
			full_page: Type.Optional(Type.Boolean({ description: "capture the full document height" })),
			device: Type.Optional(
				Type.String({ description: "device preset for this screenshot only, e.g. iphone-14 (see browser_emulate)" }),
			),
			landscape: Type.Optional(
				Type.Boolean({ description: "landscape orientation (requires device)" }),
			),
			selector: Type.Optional(
				Type.String({ description: "CSS selector — clip the screenshot to that element" }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const pre = requireRunning("browser_screenshot") ?? requireActiveTab("browser_screenshot");
			if (pre) return pre;
			if (params.landscape && !params.device) {
				return rej("browser_screenshot", "landscape requires device (a device preset)");
			}

			const args: string[] = [];
			if (params.full_page) args.push("--full-page");
			if (params.device) args.push("--device", params.device);
			if (params.landscape) args.push("--landscape");
			if (params.selector) args.push("--selector", params.selector);

			const r = await runSkill("screenshot.js", args, T_SCREENSHOT);
			if (r.code !== 0) return rej("browser_screenshot", r.stderr || r.stdout);
			const filepath = r.stdout.split("\n").filter(Boolean).pop() ?? "";
			if (!filepath) return rej("browser_screenshot", "screenshot produced no file path");
			return ok("browser_screenshot", `screenshot: ${filepath}`);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("browser_screenshot"));
			if (args.full_page) text += theme.fg("dim", " full-page");
			if (args.device) text += theme.fg("muted", ` ${args.device}`);
			if (args.selector) text += theme.fg("muted", ` ${truncatePreview(args.selector, 24)}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_pick",
		label: "browser pick",
		description:
			"Interactive element picker in the active tab: the user clicks elements (Cmd/Ctrl+click for multi-select, Enter to finish, Esc to cancel) " +
			"and gets tag/id/class/text/parents for each. Use when the user points at UI elements.",
		parameters: Type.Object({
			message: Type.String({ description: "instruction shown to the user while picking, e.g. 'Click the submit button'" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			const pre = requireRunning("browser_pick") ?? requireActiveTab("browser_pick");
			if (pre) return pre;

			if (signal?.aborted) return rej("browser_pick", "aborted before pick");
			const r = await runSkill("pick.js", [params.message], T_PICK);
			if (r.code !== 0) return rej("browser_pick", r.stderr || r.stdout);
			return ok("browser_pick", r.stdout || "(no selection)");
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_pick ")) +
					theme.fg("muted", truncatePreview(args.message)),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_tabs",
		label: "browser tabs",
		description:
			"List open tabs (title, URL, visibility, Arc space/folder). visible filters to tabs in visible windows.",
		parameters: Type.Object({
			visible: Type.Optional(Type.Boolean({ description: "only tabs in visible windows" })),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const pre = requireRunning("browser_tabs");
			if (pre) return pre;

			const tabs = await listTabs(params.visible === true);
			if (tabs === null) return rej("browser_tabs", "could not list tabs (switch-tab.js failed)");
			if (tabs.length === 0) return ok("browser_tabs", "(no tabs)");
			const lines = tabs.map((t) => {
				const dot = t.visible ? "●" : "○";
				const title = t.title.length > 60 ? `${t.title.slice(0, 57)}...` : t.title;
				const space = t.spaceTitle ? ` [${t.spaceTitle}]` : "";
				return `${dot} ${title} — ${t.url}${space}`;
			});
			return ok("browser_tabs", lines.join("\n"));
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_tabs")) +
					(args.visible ? theme.fg("dim", " visible") : ""),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_switch_tab",
		label: "browser switch tab",
		description:
			"Switch the active tab. query matches by title/URL/Arc space (best score wins; ties report alternatives), " +
			"target_id switches by exact targetId. Restores hidden windows. See browser_tabs for targetIds.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "title/URL substring to match" })),
			target_id: Type.Optional(Type.String({ description: "exact targetId (takes precedence over query)" })),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const pre = requireRunning("browser_switch_tab");
			if (pre) return pre;
			if (!params.query && !params.target_id) {
				return rej("browser_switch_tab", "provide query or target_id (browser_tabs lists targetIds)");
			}

			const args = params.target_id
				? ["--id", params.target_id, "--json"]
				: params.query
					? [params.query, "--json"]
					: [];
			const r = await runSkill("switch-tab.js", args, T_SWITCH);
			if (r.code !== 0) return rej("browser_switch_tab", r.stderr || r.stdout);

			// evidence: the script's --json out (sturdier than parsing human text)
			let ev: SwitchJson | null = null;
			try {
				ev = JSON.parse(r.stdout) as SwitchJson;
			} catch {
				ev = null;
			}
			if (ev && typeof ev.url === "string") {
				send({ type: "TAB_SWITCH", targetId: ev.targetId ?? params.target_id ?? null, url: ev.url });
				const lines = [`Switched to: ${ev.title}`, `  ${ev.url}`];
				if (ev.spaceTitle) lines.push(`  Space: ${ev.spaceTitle}`);
				if (ev.restoredWindow) lines.push("  (restored hidden window)");
				// exit 0 with stderr = tie ambiguity guidance — surface it, don't swallow
				if (r.stderr) lines.push(`note: ${r.stderr.split("\n").join(" ")}`);
				return ok("browser_switch_tab", lines.join("\n"));
			}
			return ok("browser_switch_tab", r.stdout);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_switch_tab ")) +
					theme.fg("muted", truncatePreview(args.query ?? args.target_id ?? "")),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_emulate",
		label: "browser emulate",
		description:
			"Set a device emulation preference (viewport/DPR/touch/UA) applied by navigate/eval/screenshot/pick, " +
			"or reset it. The preference persists across browser restarts (until reset). reload pages for UA-dependent responses.",
		parameters: Type.Object({
			device: Type.Optional(
				Type.String({ description: "device preset, e.g. iphone-14, pixel-7 (see browser_emulate list via status)" }),
			),
			landscape: Type.Optional(Type.Boolean({ description: "landscape orientation" })),
			reset: Type.Optional(Type.Boolean({ description: "clear the emulation preference" })),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params): Promise<ToolResult> {
			const pre = requireRunning("browser_emulate");
			if (pre) return pre;

			if (params.reset) {
				const r = await runSkill("emulate.js", ["--reset"], T_EMULATE);
				if (r.code !== 0) return rej("browser_emulate", r.stderr || r.stdout);
				send({ type: "EMULATE_RESET" });
				return ok("browser_emulate", r.stdout || "emulation cleared");
			}

			const device = params.device ?? "";
			const v = emulateViolation(ctx(), device);
			if (v) return rej("browser_emulate", v);

			const r = await runSkill("emulate.js", [device, ...(params.landscape ? ["--landscape"] : [])], T_EMULATE);
			if (r.code !== 0) return rej("browser_emulate", r.stderr || r.stdout);
			send({ type: "EMULATE_SET", device, landscape: params.landscape === true });
			return ok("browser_emulate", r.stdout);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("browser_emulate "));
			if (args.reset) text += theme.fg("muted", "reset");
			else if (args.device) text += theme.fg("accent", args.device) + (args.landscape ? theme.fg("dim", " landscape") : "");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_status",
		label: "browser status",
		description:
			"Probe the debug endpoint, reconcile the machine (adopt a live browser / mark drift), and report: state, browser info, active tab, tabs, emulation preference, recent events.",
		parameters: Type.Object({}),
		executionMode: "sequential",

		async execute(): Promise<ToolResult> {
			const { text, error } = await buildStatus();
			if (error) return rej("browser_status", text);
			return ok("browser_status", text);
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_status")), 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	pi.registerTool({
		name: "browser_stop",
		label: "browser stop",
		description:
			"Stop a browser this extension launched (fresh/profile/reset_profile) and clear its state files. " +
			"attach/foreign instances are never killed — only the machine is marked stopped. Idempotent.",
		parameters: Type.Object({}),
		executionMode: "sequential",

		async execute(_toolCallId): Promise<ToolResult> {
			// Always run the executor — idempotent, failure-as-data — so drifted
			// state (machine says stopped, state files linger) still gets cleaned.
			// STOP on a stopped machine is legal (records the reason, no-op).
			const r = await runExecutor<
				{ stopped: boolean; killed?: boolean; mode?: string; pid?: number; reason?: string; endpointDown?: boolean }
			>("stop.mjs", [String(DEBUG_PORT)], T_STOP);
			if ("error" in r) {
				return rej("browser_stop", `stop executor failed: ${r.error}`);
			}

			const reason = r.killed
				? `killed pid ${r.pid}${r.endpointDown === false ? " (endpoint still up — possible foreign instance on the port)" : ""}`
				: r.reason ?? "cleared";
			send({ type: "STOP", reason });
			return ok("browser_stop", `browser stopped (${reason}) — attach/foreign instances are never killed`);
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_stop")), 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderContext(result.details, theme);
		},
	});

	// ---- command ----

	pi.registerCommand("browser", {
		description: "browser: status | stop | footer [on|off] | viz [off]",

		handler: async (args, extCtx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				const { text } = await buildStatus();
				if (extCtx.hasUI) await extCtx.ui.select("browser status", text.split("\n"));
				return;
			}

			if (sub === "stop") {
				const r = await runExecutor<
					{ stopped: boolean; killed?: boolean; mode?: string; pid?: number; reason?: string }
				>("stop.mjs", [String(DEBUG_PORT)], T_STOP);
				if ("error" in r) {
					extCtx.ui.notify(`stop executor failed: ${r.error}`, "error");
					return;
				}
				const reason = r.killed ? `killed pid ${r.pid}` : r.reason ?? "cleared";
				send({ type: "STOP", reason });
				extCtx.ui.notify(`browser stopped (${reason})`, "info");
				return;
			}

			if (sub === "footer") {
				const on = parts[1] === "on" || (parts[1] !== "off" && !footerOn);
				extCtx.ui.notify(setFooter(on, extCtx), "info");
				return;
			}

			if (sub === "viz") {
				if (parts[1] === "off") {
					const r = viz.disable();
					if (r.ok) reCreateActor();
					extCtx.ui.notify(r.message, "info");
				} else {
					const r = await viz.enable({ open: true });
					if (r.ok) reCreateActor();
					extCtx.ui.notify(r.message, r.ok ? "info" : "error");
				}
				return;
			}

			extCtx.ui.notify(
				"usage: /browser [status | stop | footer [on|off] | viz [off]]",
				"warning",
			);
		},
	});

	// ---- lifecycle ----

	// restore caches from the branch, then reconcile against ground truth
	// (probe: adopt a live browser, mark drift). Devices refresh, viz opt-in.
	pi.on("session_start", async (_event, extCtx) => {
		getActor();
		await loadDevices();
		restoreFromBranch(extCtx);
		await probeAndReconcile(extCtx);
		if (extCtx.mode === "tui" && typeof (extCtx.ui as never as { addAutocompleteProvider?: unknown }).addAutocompleteProvider === "function") {
			extCtx.ui.addAutocompleteProvider((current) => createBrowserAutocomplete(current));
		}
		if (process.env.BROWSER_VIZ === "1") {
			const r = await viz.enable({ open: true });
			if (r.ok) reCreateActor();
			if (extCtx.hasUI) extCtx.ui.notify(r.message, "info");
		}
	});

	pi.on("session_tree", async (_event, extCtx) => {
		restoreFromBranch(extCtx);
		await probeAndReconcile(extCtx);
	});

	// The browser is a GUI app the user may still be using — never killed at
	// pi exit. state.json + the watch daemon persist; the next session's
	// probe adopts the live browser. Teardown is idempotent (footer, viz).
	pi.on("session_shutdown", async () => {
		if (footerTimer) {
			clearInterval(footerTimer);
			footerTimer = null;
		}
		footerOn = false;
		viz.stop();
	});
}

// ---------------------------------------------------------------------------
// shared render helper
// ---------------------------------------------------------------------------

function renderContext(details: unknown, theme: Theme): Text {
	const d = details as BrowserDetails | undefined;
	if (!d) return new Text("", 0, 0);
	if (d.error) {
		const head = d.error.split("\n")[0];
		return new Text(theme.fg("error", head), 0, 0);
	}
	const c = d.context;
	const b = c?.browser;
	if (b) {
		const url = c.activeTab?.url ? ` · ${truncatePreview(c.activeTab.url, 40)}` : "";
		const emu = c.emulation ? ` · ${c.emulation.device}` : "";
		return new Text(
			theme.fg("success", `running ${b.mode} :${b.port}`) +
				theme.fg("dim", url + emu),
			0,
			0,
		);
	}
	const emu = c?.emulation ? theme.fg("dim", ` · ${c.emulation.device}`) : "";
	return new Text(theme.fg("dim", `stopped`) + emu, 0, 0);
}
