/**
 * Mermaid extension — validate-gated diagram workflow.
 *
 * The workflow (validation-first rule, stale-source rule, fix loop, attempt
 * cap) lives in an XState machine; the model may only act via legal events,
 * selected through tools:
 *
 *   mermaid_validate — draft -> validated (Docker ascii.sh; ASCII preview returned)
 *   mermaid_render   — validated source only -> SVG (Docker svg.sh)
 *   mermaid_embed    — validated source only -> fenced block into Markdown
 *                      (idempotent: same source marker replaced, not duplicated)
 *   mermaid_reset    — clear state, start over
 *
 * Deterministic aspects (validation-first, path+hash freshness, attempt cap,
 * state order) are enforced in code, not requested in a prompt. Judgment
 * (diagram wording, where to embed, whether SVG is wanted) stays with the
 * model, constrained to legal events.
 *
 * The Docker render pipeline ships with this extension (executors/) — a
 * swappable implementation detail like web-search's backend: replace
 * ascii.sh / svg.sh (same contract) or point MERMAID_EXEC_DIR elsewhere;
 * machine and tools untouched.
 *
 * Tool-result `details` carries the machine snapshot, so diagram state follows
 * the conversation branch (rewind/branch-safe).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createActor, type Actor } from "xstate";
import { makeViz, type VizResult } from "../_viz/viz-kit.ts";
import {
	embedViolation,
	initialContext,
	mermaidMachine,
	renderViolation,
	validateViolation,
	type MermaidLimits,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LIMITS: MermaidLimits = {
	maxValidateAttempts: Number(process.env.MERMAID_MAX_VALIDATE_ATTEMPTS ?? 8),
};
const SCRIPT_TIMEOUT_MS = Number(process.env.MERMAID_SCRIPT_TIMEOUT_MS ?? 180_000);
const ASCII_TRUNCATE = Number(process.env.MERMAID_ASCII_TRUNCATE ?? 8000);
const INSPECT_PORT = (() => {
	const n = Number(process.env.MERMAID_INSPECT_PORT ?? 8082);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8082;
})();

// Docker render pipeline ships with this extension (executors/) — single
// owner, swappable like web-search's backend: point MERMAID_EXEC_DIR at a dir
// with ascii.sh + svg.sh honoring the same contract (exit 0 = valid,
// non-zero = invalid).
const EXEC_DIR = resolve(
	process.env.MERMAID_EXEC_DIR ?? join(homedir(), ".pi/agent/extensions/mermaid/executors"),
);
const ASCII_SCRIPT = join(EXEC_DIR, "ascii.sh");
const SVG_SCRIPT = join(EXEC_DIR, "svg.sh");

const LOG_DIR = process.env.MERMAID_LOG_DIR ?? join(homedir(), ".cache", "mermaid");

const THEMES = new Set(["default", "dark", "forest", "neutral"]);

/** Best-effort diagnostics log; never throws, never blocks a tool. */
function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(join(LOG_DIR, "mermaid.log"), `${new Date().toISOString()} [${level}] ${msg}\n`);
	} catch {
		/* logging must not break tools */
	}
}

const TOOL_NAMES = new Set(["mermaid_validate", "mermaid_render", "mermaid_embed", "mermaid_reset"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PersistedSnapshot = { context?: ReturnType<typeof initialContext>; value?: unknown; status?: unknown };

type MermaidDetails = {
	action: "validate" | "render" | "embed" | "reset";
	state: string;
	rejected?: string;
	error?: string;
	snapshot: unknown;
};

// ---------------------------------------------------------------------------
// Actor management (reconstructed from branch, like web-search)
// ---------------------------------------------------------------------------

let actor: Actor<typeof mermaidMachine> | null = null;
let unsubscribeActor: { unsubscribe: () => void } | null = null;
let uiCtx: { ui: { setStatus: (k: string, t: string | undefined) => void; theme?: { fg: (c: string, s: string) => string } } } | null = null;
/** Footer status is opt-in: toggle with '/mermaid footer'. */
let statusEnabled = false;

/**
 * Output prompt on validation success: ask the user (ASCII only, or build the
 * SVG and open it) instead of leaving the choice to the model. Opt-in:
 * MERMAID_ASK_OUTPUT=1 or '/mermaid ask'. Judgment moves from model to user —
 * tools stay available either way; the machine still gates everything.
 */
let askOutput = process.env.MERMAID_ASK_OUTPUT === "1";

// ---------------------------------------------------------------------------
// Inspector (opt-in live visualisation: /mermaid viz or MERMAID_INSPECT=1)
// Transport lives in ../_viz/viz-kit.ts (shared with web-search/tmux/web-browser):
// '::' port pre-check, clean-stop WS adapter, port auto-allocation.
// ---------------------------------------------------------------------------

const viz = makeViz({ name: "mermaid", preferredPort: INSPECT_PORT });

/** Attach mid-session: re-create the actor from its persisted snapshot with inspect wired. */
async function attachInspector(): Promise<VizResult> {
	const r = await viz.enable({ open: true });
	if (r.ok) createMermaidActor({ snapshot: getActor().getPersistedSnapshot() });
	return r;
}

/** Compact live status for the TUI footer. */
function statusText(c: ReturnType<typeof initialContext>): string {
	const src = c.validated ? basename(c.validated.path) : "no source";
	return `mermaid ${stateValue()} · ${src} · failed validations ${c.validateAttempts}/${c.limits.maxValidateAttempts} · renders ${c.renders.length} · embeds ${c.embeds.length}`;
}

function refreshStatus() {
	if (!uiCtx?.ui?.setStatus) return;
	if (!statusEnabled) {
		uiCtx.ui.setStatus("mermaid", undefined);
		return;
	}
	// getActor() lazily creates the actor so the footer works before any tool call
	const a = getActor();
	const theme = uiCtx.ui.theme;
	const text = statusText(a.getSnapshot().context);
	uiCtx.ui.setStatus("mermaid", theme ? theme.fg("dim", text) : text);
}

/** Set the active actor, wiring the live-status subscription. */
function setActor(a: Actor<typeof mermaidMachine>) {
	unsubscribeActor?.unsubscribe();
	unsubscribeActor = a.subscribe(() => refreshStatus());
	actor = a;
	refreshStatus();
}

/** Single actor-creation site — fresh input or persisted-snapshot restore. */
function createMermaidActor(
	opts: { input: { limits: MermaidLimits } } | { snapshot: unknown },
): Actor<typeof mermaidMachine> {
	const a = createActor(mermaidMachine, {
		...(opts as { input?: { limits: MermaidLimits }; snapshot?: unknown }),
		snapshot: "snapshot" in opts ? (opts.snapshot as never) : undefined,
		...viz.option(),
	} as never) as Actor<typeof mermaidMachine>;
	a.start();
	setActor(a);
	return a;
}

function freshActor(): Actor<typeof mermaidMachine> {
	return createMermaidActor({ input: { limits: LIMITS } });
}

function getActor(): Actor<typeof mermaidMachine> {
	if (!actor) freshActor();
	return actor!;
}

function stateValue(): string {
	const snap = getActor().getSnapshot() as unknown as PersistedSnapshot;
	return String(snap.value ?? snap.status);
}

/** Restore diagram state from the last mermaid tool result on this branch. */
function reconstructState(ctx: { sessionManager: { getBranch: () => Array<any> } }) {
	for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
		const entry = ctx.sessionManager.getBranch()[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || !TOOL_NAMES.has(msg.toolName)) continue;
		const details = msg.details as MermaidDetails | undefined;
		const snap = details?.snapshot as PersistedSnapshot | undefined;
		if (snap?.context) {
			// Restore from persisted snapshot (branch-correct)
			createMermaidActor({ snapshot: details!.snapshot });
			return;
		}
	}
	actor = null;
	unsubscribeActor?.unsubscribe();
	unsubscribeActor = null;
}

// ---------------------------------------------------------------------------
// IO executors (extension's Docker scripts + file IO; no network, no secrets)
// ---------------------------------------------------------------------------

function run(script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve_, reject) => {
		execFile(
			"bash",
			[script, ...args],
			{ timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					// bash exit != 0: for the validators this means "invalid diagram"
					// with parse errors on stderr — that is data, not a crash.
					reject(new Error(`${err.message}${stderr ? `\n${stderr.trim()}` : ""}`));
				} else {
					resolve_({ stdout, stderr });
				}
			},
		);
	});
}

/** Read a diagram + its content hash (evidence for machine guards). */
async function readSource(path: string): Promise<{ content: string; hash: string }> {
	const content = await readFile(path, "utf8");
	return { content, hash: createHash("sha256").update(content).digest("hex") };
}

/**
 * Shared render path (mermaid_render tool + output prompt): sends BEGIN_RENDER
 * (caller has prechecked renderViolation) -> runs the Docker executor ->
 * sends RENDER_DONE. Returns failure as data.
 */
async function runRender(
	path: string,
	hash: string,
	outPath: string,
	theme: string,
): Promise<{ ok: boolean; error: string | null }> {
	getActor().send({ type: "BEGIN_RENDER", path, hash, outPath });
	log("INFO", `render: ${path} -> ${outPath} (theme ${theme})`);
	try {
		await run(SVG_SCRIPT, ["-t", theme, path, outPath]);
		getActor().send({ type: "RENDER_DONE", ok: true, outPath, error: null });
		log("INFO", `render ok: ${outPath}`);
		return { ok: true, error: null };
	} catch (e) {
		const msg = String((e as Error).message ?? e);
		log("ERROR", `render failed: ${msg.split("\n")[0]}`);
		getActor().send({ type: "RENDER_DONE", ok: false, outPath, error: msg });
		return { ok: false, error: msg };
	}
}

/** Best-effort "open in browser" (executor) — never throws. */
function openInBrowser(outPath: string): Promise<{ ok: boolean; error: string | null }> {
	return new Promise((resolve_) => {
		const opener = process.platform === "darwin" ? "open" : "xdg-open";
		execFile(opener, [outPath], (err) => {
			if (err) {
				log("WARN", `open failed: ${err.message}`);
				resolve_({ ok: false, error: err.message });
			} else {
				resolve_({ ok: true, error: null });
			}
		});
	});
}

/** Default SVG output path for a diagram path: swap/append .svg. */
function svgPathFor(path: string): string {
	return /\.mmd$/i.test(path) ? path.replace(/\.mmd$/i, ".svg") : `${path}.svg`;
}

/**
 * Insert (or replace) the fenced mermaid block for `sourcePath` in `target`.
 * Idempotent: a block with the same `<!-- mermaid: ... -->` marker is replaced
 * in place, not duplicated. Without `after`, appends at end of file; with it,
 * inserts after the last line containing the anchor text.
 */
async function embedBlock(
	target: string,
	sourcePath: string,
	content: string,
	after?: string,
): Promise<{ action: "replaced" | "appended" | "inserted" }> {
	const raw = await readFile(target, "utf8");
	const lines = raw.split("\n");
	const marker = `<!-- mermaid: ${sourcePath} -->`;
	const block = [marker, "```mermaid", ...content.replace(/\n+$/, "").split("\n"), "```"];

	// Replace an existing block with the same marker (marker ... closing fence).
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() !== marker) continue;
		let j = i + 1;
		while (j < lines.length && lines[j].trim() === "") j++;
		if (j < lines.length && lines[j].trim() === "```mermaid") {
			let k = j + 1;
			while (k < lines.length && lines[k].trim() !== "```") k++;
			if (k < lines.length) {
				lines.splice(i, k - i + 1, ...block);
				await writeFile(target, lines.join("\n"));
				return { action: "replaced" };
			}
		}
		break; // stray marker without a following fence — treat as insert below
	}

	// Insert after the last line containing the anchor text.
	if (after) {
		let at = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(after)) at = i;
		}
		if (at === -1) {
			throw new Error(`anchor not found in target: no line contains "${after}"`);
		}
		lines.splice(at + 1, 0, "", ...block);
		await writeFile(target, lines.join("\n"));
		return { action: "inserted" };
	}

	// Append at end of file.
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	lines.push("", ...block, "");
	await writeFile(target, lines.join("\n"));
	return { action: "appended" };
}

// ---------------------------------------------------------------------------
// Formatting (model-facing content)
// ---------------------------------------------------------------------------

function statusLine(ctx: ReturnType<typeof initialContext>): string {
	return `Failed validations: ${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts}. Renders: ${ctx.renders.length}. Embeds: ${ctx.embeds.length}. Machine state: ${stateValue()}.`;
}

/**
 * Persisted snapshot for tool-result details, slimmed: error text is truncated
 * (transcript already holds the full tool output). Keeps session files small.
 */
function slimSnapshot(snapshot: unknown): unknown {
	const slim = JSON.parse(JSON.stringify(snapshot)) as PersistedSnapshot;
	const errors = slim?.context?.errors;
	if (Array.isArray(errors)) {
		slim.context!.errors = errors.slice(0, 10).map((e) => String(e).slice(0, 400));
	}
	return slim;
}

function detailsFor(action: MermaidDetails["action"], extra: Partial<MermaidDetails> = {}): MermaidDetails {
	return {
		action,
		state: stateValue(),
		snapshot: slimSnapshot(getActor().getPersistedSnapshot()),
		...extra,
	};
}

const text = (t: string) => [{ type: "text" as const, text: t }];

function absPath(p: string): string {
	return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const SUBCOMMANDS: { value: string; description: string }[] = [
	{ value: "status", description: "show diagram workflow state" },
	{ value: "reset", description: "clear diagram state" },
	{ value: "ask", description: "toggle output prompt on validation (ASCII vs SVG+open)" },
	{ value: "footer", description: "toggle live footer status line" },
	{ value: "viz", description: "attach the Stately inspector (live visualisation)" },
];

/** Tab completion for '/mermaid <subcommand>' (delegates to current provider otherwise). */
function createMermaidAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol);
			const m = /^\/mermaid ?([a-z]*)$/.exec(before);
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx as never;
		// MERMAID_INSPECT=1: start inspector infra BEFORE any actor exists.
		if (process.env.MERMAID_INSPECT) {
			const r = await viz.enable({ open: true });
			if (!r.ok) log("ERROR", `inspector not started: ${r.message}`);
		}
		reconstructState(ctx);
		if (ctx.mode === "tui" && typeof (ctx.ui as never as { addAutocompleteProvider?: unknown }).addAutocompleteProvider === "function") {
			ctx.ui.addAutocompleteProvider((current) => createMermaidAutocomplete(current));
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		uiCtx = ctx as never;
		reconstructState(ctx);
	});
	pi.on("session_shutdown", async () => {
		viz.stop();
	});

	pi.registerTool({
		name: "mermaid_validate",
		label: "Mermaid validate",
		description:
			"Validate a Mermaid diagram and move the workflow to `validated` (returns the ASCII preview). " +
			"Only a validated source (same path, unchanged content) can be rendered or embedded. " +
			`Failed validations are capped (${LIMITS.maxValidateAttempts}); mermaid_reset clears state. ` +
			"Validating an edited diagram re-establishes the pass.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .mmd diagram file" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
			const path = absPath(params.path);

			let content: string;
			let hash: string;
			try {
				({ content, hash } = await readSource(path));
			} catch (e) {
				log("WARN", `validate: unreadable source: ${path}`);
				return {
					content: text(`Cannot read diagram: ${path}\n${(e as Error).message}`),
					details: detailsFor("validate", { error: `unreadable source: ${(e as Error).message}` }),
				};
			}
			if (content.trim() === "") {
				return {
					content: text(`Diagram is empty: ${path}\nWrite the diagram first, then mermaid_validate.`),
					details: detailsFor("validate", { error: "empty diagram" }),
				};
			}

			const snap = getActor().getSnapshot();
			const violation = validateViolation(snap.context);
			if (violation) {
				log("WARN", `validate rejected: ${violation}`);
				return {
					content: text(`Validate rejected: ${violation}\n${statusLine(snap.context)}`),
					details: detailsFor("validate", { rejected: violation }),
				};
			}

			getActor().send({ type: "BEGIN_VALIDATE" });
			log("INFO", `validate: ${path}`);

			try {
				const { stdout } = await run(ASCII_SCRIPT, [path]);
				getActor().send({ type: "VALIDATE_DONE", path, hash, ok: true, errors: [] });
				log("INFO", `validate ok: ${path}`);
				const preview =
					stdout.length > ASCII_TRUNCATE
						? `${stdout.slice(0, ASCII_TRUNCATE)}\n… (truncated)`
						: stdout.trim();

				// Opt-in output prompt (user judgment replaces model judgment for
				// the output format): ASCII only, or build the SVG and open it.
				// Renders through the same machine-gated path as mermaid_render.
				let choiceNote = "";
				const uiAny = execCtx as
					| { mode?: string; ui?: { select?: (t: string, o: string[]) => Promise<string | null> } }
					| undefined;
				if (askOutput && uiAny?.mode === "tui" && typeof uiAny.ui?.select === "function") {
					const pick = await uiAny.ui.select(
						`Mermaid: ${basename(path)} validated — output?`,
						["ASCII preview only (shown above)", "Build SVG + open in browser"],
					);
					if (pick?.startsWith("Build SVG")) {
						const outPath = svgPathFor(path);
						let theme = process.env.MERMAID_THEME ?? "dark";
						if (!THEMES.has(theme)) theme = "dark";
						const violation = renderViolation(getActor().getSnapshot().context, path, hash);
						if (violation) {
								choiceNote = `\nUser picked SVG but render rejected: ${violation}`;
						} else {
								const r = await runRender(path, hash, outPath, theme);
								if (r.ok) {
										const opened = await openInBrowser(outPath);
									choiceNote = `\nUser picked SVG: rendered ${outPath}${opened.ok ? " and opened in browser" : ` (open failed: ${opened.error})`}.`;
								} else {
									choiceNote = `\nUser picked SVG: render failed — fix the diagram, mermaid_validate again, then mermaid_render ${outPath}.`;
							}
						}
						log("INFO", `output prompt: ${pick}`);
					} else if (pick) {
						choiceNote = "\nUser picked: ASCII preview only.";
					} else {
						choiceNote = "\nUser skipped the output prompt.";
					}
				}

				const next =
					choiceNote ||
					"Next: mermaid_embed into Markdown, or mermaid_render for an SVG.";
				return {
					content: text(
						`Diagram is valid (validated: ${basename(path)}).\n\n${preview}\n\n${statusLine(getActor().getSnapshot().context)}\n${next}`,
					),
					details: detailsFor("validate"),
				};
			} catch (e) {
				const msg = String((e as Error).message ?? e);
				const errors = msg
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.length > 0)
					.slice(0, 20);
				log("WARN", `validate failed: ${path}: ${errors[0] ?? "unknown"}`);
				getActor().send({ type: "VALIDATE_DONE", path, hash, ok: false, errors });
				return {
					content: text(
						`Diagram is invalid: ${basename(path)}\n\n${errors.join("\n")}\n\n${statusLine(getActor().getSnapshot().context)}\n` +
							"Fix the diagram, then mermaid_validate again (machine is in `fixing`).",
					),
					details: detailsFor("validate", { error: errors[0] ?? "invalid diagram" }),
				};
			}
		},

		renderCall(args) {
			return new Text(`mermaid_validate ${args.path ?? ""}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as MermaidDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
			return new Text(`✓ validated (${details?.state ?? ""})`, 0, 0);
		},
	});

	pi.registerTool({
		name: "mermaid_render",
		label: "Mermaid render SVG",
		description:
			"Render the validated diagram to SVG (Docker). Only legal for the source that last passed mermaid_validate, " +
			"with unchanged content — an edit invalidates the pass (re-validate). Optional theme: default|dark|forest|neutral.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the validated .mmd diagram file" }),
			outPath: Type.String({ description: "Output .svg path" }),
			theme: Type.Optional(Type.String({ description: "default|dark|forest|neutral (default dark)" })),
		}),

		async execute(_toolCallId, params) {
			const path = absPath(params.path);
			const outPath = absPath(params.outPath);
			const theme = params.theme ?? process.env.MERMAID_THEME ?? "dark";
			if (!THEMES.has(theme)) {
				return {
					content: text(`Unknown theme "${theme}" — use default, dark, forest, or neutral.`),
					details: detailsFor("render", { error: `unknown theme: ${theme}` }),
				};
			}

			let hash: string;
			try {
				({ hash } = await readSource(path));
			} catch (e) {
				return {
					content: text(`Cannot read diagram: ${path}\n${(e as Error).message}`),
					details: detailsFor("render", { error: `unreadable source: ${(e as Error).message}` }),
				};
			}

			const snap = getActor().getSnapshot();
			const violation = renderViolation(snap.context, path, hash);
			if (violation) {
				log("WARN", `render rejected: ${violation}`);
				return {
					content: text(
						`Render rejected: ${violation}\n${statusLine(snap.context)}\n` +
							"Allowed next steps: mermaid_validate (this source), mermaid_embed (the validated source), or mermaid_reset.",
					),
					details: detailsFor("render", { rejected: violation }),
				};
			}

			const r = await runRender(path, hash, outPath, theme);
			if (r.ok) {
				return {
					content: text(
						`Rendered SVG: ${outPath}\n${statusLine(getActor().getSnapshot().context)}`,
					),
					details: detailsFor("render"),
				};
			}
			return {
					content: text(
						`Render failed: ${outPath}\n${r.error}\n\n${statusLine(getActor().getSnapshot().context)}\n` +
							"Fix the diagram, mermaid_validate again, then retry the render.",
					),
					details: detailsFor("render", { error: r.error?.split("\n")[0] ?? "render failed" }),
				};
			},

		renderCall(args) {
			return new Text(`mermaid_render ${args.path ?? ""} -> ${args.outPath ?? ""}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as MermaidDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
			return new Text(`✓ rendered (${details?.state ?? ""})`, 0, 0);
		},
	});

	pi.registerTool({
		name: "mermaid_embed",
		label: "Mermaid embed",
		description:
			"Embed the validated diagram into a Markdown file as a fenced mermaid block. Only legal for the source " +
			"that last passed mermaid_validate, with unchanged content — an edit invalidates the pass (re-validate). " +
			"Idempotent: a block with the same source marker is replaced, not duplicated. " +
			"Optional `after`: insert after the last line containing that text (default: append at end of file).",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the validated .mmd diagram file" }),
			target: Type.String({ description: "Markdown file to embed into" }),
			after: Type.Optional(Type.String({ description: "Insert after the last line containing this text" })),
		}),

		async execute(_toolCallId, params) {
			const path = absPath(params.path);
			const target = absPath(params.target);

			let content: string;
			let hash: string;
			try {
				({ content, hash } = await readSource(path));
			} catch (e) {
				return {
					content: text(`Cannot read diagram: ${path}\n${(e as Error).message}`),
					details: detailsFor("embed", { error: `unreadable source: ${(e as Error).message}` }),
				};
			}

			const snap = getActor().getSnapshot();
			const violation = embedViolation(snap.context, path, hash, target);
			if (violation) {
				log("WARN", `embed rejected: ${violation}`);
				return {
					content: text(
						`Embed rejected: ${violation}\n${statusLine(snap.context)}\n` +
							"Allowed next steps: mermaid_validate (this source), mermaid_render / mermaid_embed (the validated source), or mermaid_reset.",
					),
					details: detailsFor("embed", { rejected: violation }),
				};
			}

			try {
				await readFile(target, "utf8"); // target must exist and be readable
			} catch (e) {
				return {
					content: text(
						`Cannot read embed target: ${target}\n${(e as Error).message}\nCreate the file first.`,
					),
					details: detailsFor("embed", { error: `unreadable target: ${(e as Error).message}` }),
				};
			}

			getActor().send({ type: "BEGIN_EMBED", path, hash, target });
			log("INFO", `embed: ${path} -> ${target}${params.after ? ` (after "${params.after}")` : ""}`);

			try {
				const r = await embedBlock(target, path, content, params.after);
				getActor().send({ type: "EMBED_DONE", ok: true, target, error: null });
				log("INFO", `embed ok: ${target} (${r.action})`);
				return {
					content: text(
						`Embedded ${basename(path)} into ${target} (${r.action}${params.after ? ` after "${params.after}"` : ""}).\n${statusLine(getActor().getSnapshot().context)}`,
					),
					details: detailsFor("embed"),
				};
			} catch (e) {
				const msg = String((e as Error).message ?? e);
				log("ERROR", `embed failed: ${msg.split("\n")[0]}`);
				getActor().send({ type: "EMBED_DONE", ok: false, target, error: msg });
				return {
					content: text(`Embed failed: ${target}\n${msg}\n\n${statusLine(getActor().getSnapshot().context)}`),
					details: detailsFor("embed", { error: msg.split("\n")[0] ?? "embed failed" }),
				};
			}
		},

		renderCall(args) {
			return new Text(`mermaid_embed ${args.path ?? ""} -> ${args.target ?? ""}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as MermaidDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
			return new Text(`✓ embedded (${details?.state ?? ""})`, 0, 0);
		},
	});

	pi.registerTool({
		name: "mermaid_reset",
		label: "Mermaid reset",
		description: "Clear the mermaid workflow state machine and start over.",
		parameters: Type.Object({}),

		async execute() {
			const ctx = getActor().getSnapshot().context;
			const prior = `validated: ${ctx.validated ? basename(ctx.validated.path) : "none"}, failed validations ${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts}, renders ${ctx.renders.length}, embeds ${ctx.embeds.length}, machine state ${stateValue()}`;
			getActor().send({ type: "RESET" });
			log("INFO", `reset (was: ${prior})`);
			return {
				content: text(`Diagram state cleared (was: ${prior}).\n${statusLine(getActor().getSnapshot().context)}`),
				details: detailsFor("reset"),
			};
		},

		renderCall() {
			return new Text("mermaid_reset", 0, 0);
		},

		renderResult() {
			return new Text("✓ reset", 0, 0);
		},
	});

	pi.registerCommand("mermaid", {
		description:
			"Mermaid workflow state machine: '/mermaid status' shows state, '/mermaid reset' clears it, '/mermaid ask' toggles the output prompt on validation (ASCII only, or build SVG + open — off by default), '/mermaid footer' toggles the live footer line (off by default), '/mermaid viz' live-visualises the machine",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			if (sub === "footer") {
				statusEnabled = !statusEnabled;
				refreshStatus();
				ctx.ui.notify(`Footer status ${statusEnabled ? "on" : "off"}`, "info");
				return;
			}
			if (sub === "ask") {
				askOutput = !askOutput;
				ctx.ui.notify(
					`Output prompt on validation ${askOutput ? "on" : "off"} — asks ASCII only vs build SVG + open after each successful mermaid_validate`,
					"info",
				);
				return;
			}
			if (sub === "reset") {
				getActor().send({ type: "RESET" });
				ctx.ui.notify("Mermaid state reset", "info");
				return;
			}
			if (sub === "viz") {
				const r = await attachInspector();
				ctx.ui.notify(r.message, r.ok ? "info" : "error");
				if (!r.ok) log("ERROR", `inspector attach failed: ${r.message}`);
				return;
			}
			if (sub !== "" && sub !== "status") {
				ctx.ui.notify(
					`Unknown subcommand '${sub}'. Use '/mermaid status', '/mermaid reset', '/mermaid ask', '/mermaid footer', or '/mermaid viz'.`,
					"error",
				);
				return;
			}
			const snap = getActor().getSnapshot();
			const c = snap.context;
			const lines = [
				`State: ${stateValue()}`,
				statusLine(c),
				`Validated source: ${c.validated ? `${c.validated.path} (hash ${c.validated.hash.slice(0, 12)}…)` : "(none)"}`,
				`Renders: ${c.renders.length ? c.renders.join(", ") : "(none)"}`,
				`Embeds: ${c.embeds.length ? c.embeds.join(", ") : "(none)"}`,
			];
			if (c.errors.length > 0) {
				lines.push(`Last errors:`, ...c.errors.slice(0, 10).map((e) => `- ${e.slice(0, 400)}`));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
