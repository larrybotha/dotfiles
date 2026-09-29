/**
 * slide-deck extension — machine-driven deck build pipeline.
 *
 * The workflow lives in an XState machine (machine.ts): one BEGIN_BUILD
 * event carries the deck content, then the machine runs the pipeline
 * autonomously via invoked services (template copy + injection, Docker
 * html5lib validation) — no per-step model round-trips. The model may only
 * act via legal events, selected through tools:
 *
 *   slide_deck_start    — records the topic; phase researching (fresh
 *                        authoring, or done — done starts a NEW deck)
 *   slide_deck_research — records sources; phase planning
 *   slide_deck_plan    — records planned slide ids; phase writing
 *                        (replan legal mid-writing and mid-fix)
 *   slide_deck_build   — one event, full content; machine drives
 *                        build -> validate -> done (opens the deck)
 *   slide_deck_status  — snapshot + allowed next steps
 *   slide_deck_reset   — clear state, start over
 *
 * The authoring ceremony (start -> research -> plan -> writing) is ONE
 * machine state with the phase tracked in context — optional
 * announcements (the fast path, one BEGIN_BUILD from fresh authoring, is
 * legal): what the machine enforces is the pipeline, not the ceremony. Editorial content rules live in the
 * slide_deck_build tool description (prompt-side); structural validation
 * (nav↔slide 1:1, slides inside main, no external deps) is machine-side via
 * the validate service. Same split as the skill had — now enforced.
 *
 * Executors ship with this extension (executors/) — a swappable
 * implementation detail like web-search's backend: point
 * SLIDE_DECK_EXEC_DIR at a dir with build.mjs + validate.sh honoring the
 * same contracts; machine and tools untouched.
 *
 * Tool-result `details` carries the machine snapshot, so deck state follows
 * the conversation branch (rewind/branch-safe).
 */
import { execFile } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createActor,
	fromPromise,
	type Actor,
	waitFor,
} from "xstate";
import { makeViz, type VizResult } from "../_viz/viz-kit.ts";
import {
	type BuildServiceInput,
	type BuildServiceOutput,
	buildViolation,
	countSlides,
	type DeckContent,
	initialContext,
	planViolation,
	researchViolation,
	type SlideDeckContext,
	type SlideDeckEvent,
	type SlideDeckLimits,
	slideDeckMachine,
	startViolation,
	type ValidateServiceFailure,
	type ValidateServiceInput,
	type ValidateServiceOutput,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Integer env var with fallback: missing/garbage -> default. */
function intEnv(name: string, def: number): number {
	const n = Number(process.env[name]);
	return Number.isInteger(n) && n > 0 ? n : def;
}

const LIMITS: SlideDeckLimits = {
	maxValidateAttempts: intEnv("SLIDE_DECK_MAX_VALIDATE_ATTEMPTS", 8),
};
/** Per-executor timeout (first Docker image build can take minutes). */
const SCRIPT_TIMEOUT_MS = intEnv("SLIDE_DECK_SCRIPT_TIMEOUT_MS", 300_000);
/** Whole-pipeline settle timeout (build + validate run sequentially). */
const SETTLE_TIMEOUT_MS = intEnv(
	"SLIDE_DECK_SETTLE_TIMEOUT_MS",
	SCRIPT_TIMEOUT_MS * 2 + 60_000,
);
const INSPECT_PORT = (() => {
	const n = intEnv("SLIDE_DECK_INSPECT_PORT", 8083);
	return n < 65536 ? n : 8083;
})();

// Extension root = this file's dir (index.ts lives in extensions/slide-deck/)
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const EXEC_DIR = resolve(
	process.env.SLIDE_DECK_EXEC_DIR ?? join(EXT_DIR, "executors"),
);
const BUILD_SCRIPT = join(EXEC_DIR, "build.mjs");
const VALIDATE_SCRIPT = join(EXEC_DIR, "validate.sh");
const DECKS_DIR = process.env.SLIDE_DECK_DECKS_DIR ?? join(EXT_DIR, "decks");

const LOG_DIR =
	process.env.SLIDE_DECK_LOG_DIR ?? join(homedir(), ".cache", "slide-deck");

/** Best-effort diagnostics log; never throws, never blocks a tool. */
function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(
			join(LOG_DIR, "slide-deck.log"),
			`${new Date().toISOString()} [${level}] ${msg}\n`,
		);
	} catch {
		/* logging must not break tools */
	}
}

const TOOL_NAMES = new Set([
	"slide_deck_start",
	"slide_deck_research",
	"slide_deck_plan",
	"slide_deck_build",
	"slide_deck_status",
	"slide_deck_reset",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PersistedSnapshot = {
	context?: SlideDeckContext;
	value?: unknown;
	status?: unknown;
};

type SlideDeckDetails = {
	action:
		| "start"
		| "research"
		| "plan"
		| "build"
		| "status"
		| "reset";
	state: string;
	/** Basename of the deck involved. */
	file?: string;
	rejected?: string;
	error?: string;
	snapshot: unknown;
};

// ---------------------------------------------------------------------------
// Actor management
// ---------------------------------------------------------------------------

let actor: Actor<typeof wiredMachine> | null = null;
let unsubscribeActor: { unsubscribe: () => void } | null = null;
let uiCtx: {
	ui: {
		setStatus: (k: string, t: string | undefined) => void;
		theme?: { fg: (c: string, s: string) => string };
	};
} | null = null;

/** Footer status is opt-in: toggle with '/slidedeck footer' (or SLIDE_DECK_FOOTER=1). */
let statusEnabled = process.env.SLIDE_DECK_FOOTER === "1";

/** Compact live status for the TUI footer. */
function statusText(c: SlideDeckContext): string {
	const deck = c.deck ? c.deck.title : "no deck";
	return `slide-deck ${stateLabel(c)} · ${deck} · failed validations ${c.validateAttempts}/${c.limits.maxValidateAttempts} · builds ${c.builds.length}`;
}

function refreshStatus() {
	if (!uiCtx?.ui?.setStatus) return;
	if (!statusEnabled) {
		uiCtx.ui.setStatus("slide-deck", undefined);
		return;
	}
	const a = getActor();
	const theme = uiCtx.ui.theme;
	const text = statusText(a.getSnapshot().context);
	uiCtx.ui.setStatus("slide-deck", theme ? theme.fg("dim", text) : text);
}

/** Set the active actor, wiring the live-status subscription. */
function setActor(a: Actor<typeof wiredMachine>) {
	unsubscribeActor?.unsubscribe();
	unsubscribeActor = a.subscribe(() => refreshStatus());
	actor = a;
	refreshStatus();
}

/** Single actor-creation site — fresh input or persisted-snapshot restore. */
function createSlideDeckActor(
	opts: { input: { limits: SlideDeckLimits } } | { snapshot: unknown },
): Actor<typeof wiredMachine> {
	// wiredMachine = slideDeckMachine with the service slots provided (the
	// unwired machine throws "not wired" if a build ever runs through it)
	const a = createActor(wiredMachine, {
		input: "input" in opts ? opts.input : undefined,
		// XState's persisted-snapshot type is internal; snapshots passed here
		// come from getPersistedSnapshot() of this same machine — one cast at
		// this boundary.
		snapshot: "snapshot" in opts ? (opts.snapshot as never) : undefined,
		...viz.option(),
	});
	a.start();
	setActor(a);
	return a;
}

function freshActor(): Actor<typeof wiredMachine> {
	return createSlideDeckActor({ input: { limits: LIMITS } });
}

function getActor(): Actor<typeof wiredMachine> {
	if (!actor) freshActor();
	return actor!;
}

function stateValue(): string {
	const snap = getActor().getSnapshot() as unknown as PersistedSnapshot;
	return String(snap.value ?? snap.status);
}

/**
 * State label for model/user-facing text: the collapsed authoring state
 * names its ceremony phase — `authoring (researching)` ≡ the old
 * researching state; bare `authoring` ≡ the old idle (fresh).
 */
function stateLabel(c: SlideDeckContext): string {
	const v = stateValue();
	return v === "authoring" && c.phase ? `authoring (${c.phase})` : v;
}

/**
 * Serialize slide-deck tool bodies (single machine, pipeline in flight):
 * without a lock, concurrent tool calls interleave events — the machine
 * drops the second caller's events while both tools report success.
 * Failures inside the lock are data (tool results), not lock errors.
 */
let toolChain: Promise<unknown> = Promise.resolve();
function withToolLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = toolChain.then(fn, fn);
	toolChain = next.catch(() => {});
	return next;
}

/** Restore deck state from the last slide-deck tool result on this branch. */
function reconstructState(ctx: {
	sessionManager: { getBranch: () => Array<any> };
}) {
	for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
		const entry = ctx.sessionManager.getBranch()[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || !TOOL_NAMES.has(msg.toolName)) continue;
		const details = msg.details as SlideDeckDetails | undefined;
		const snap = details?.snapshot as PersistedSnapshot | undefined;
		if (snap?.context) {
			createSlideDeckActor({ snapshot: details!.snapshot });
			return;
		}
	}
	actor = null;
	unsubscribeActor?.unsubscribe();
	unsubscribeActor = null;
}

// ---------------------------------------------------------------------------
// Inspector (opt-in live visualisation)
// ---------------------------------------------------------------------------

const viz = makeViz({ name: "slide-deck", preferredPort: INSPECT_PORT });

/** Attach mid-session: re-create the actor from its persisted snapshot with inspect wired. */
async function attachInspector(): Promise<VizResult> {
	const r = await viz.enable({ open: true });
	if (r.ok) createSlideDeckActor({ snapshot: getActor().getPersistedSnapshot() });
	return r;
}

// ---------------------------------------------------------------------------
// IO executors (failure-as-data; service rejections carry the fail cause)
// ---------------------------------------------------------------------------

type ExecOutcome = { code: number; stdout: string; stderr: string };

/** Stderr (or fallback) as non-empty lines, capped — model-facing error data. */
function errorLines(stderr: string, fallback: string): string[] {
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.slice(0, 20);
	return lines.length > 0 ? lines : [fallback];
}

/**
 * Run build.mjs (content over stdin — ARG_MAX-safe). Never rejects: exits
 * are data; the one-line JSON output decides ok/failure.
 */
function runBuildExecutor(
	content: DeckContent,
): Promise<{ ok: boolean; outPath: string; slideCount: number; error: string | null }> {
	return new Promise((resolve_) => {
		const child = execFile(
			"node",
			[BUILD_SCRIPT],
			{ timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(_err, stdout, stderr) => {
				let parsed: any;
				try {
					parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
				} catch {
					resolve_({
						ok: false,
						outPath: "",
						slideCount: 0,
						error: errorLines(stderr, `build.mjs produced no JSON (stdout: ${stdout.slice(0, 200)})`).join("\n"),
					});
					return;
				}
				if (parsed.ok) {
					resolve_({
						ok: true,
						outPath: String(parsed.outPath),
						slideCount: Number(parsed.slideCount) || 0,
						error: null,
					});
				} else {
					resolve_({
						ok: false,
						outPath: "",
						slideCount: 0,
						error: String(parsed.error ?? "build failed"),
					});
				}
			},
		);
		child.stdin?.on("error", () => {}); // EPIPE if build.mjs exits early — outcome arrives via callback
		child.stdin?.end(JSON.stringify(content));
	});
}

/**
 * Run validate.sh. Exit contract: 0 valid, 1 invalid deck, else infra.
 * Never rejects; rejections of the validate service carry cause.
 */
function runValidateExecutor(
	outPath: string,
): Promise<
	| { ok: true; message: string; slideCount: number }
	| { ok: false; errors: string[]; cause: ValidateServiceFailure["cause"] }
> {
	return new Promise((resolve_) => {
		execFile(
			"bash",
			[VALIDATE_SCRIPT, outPath],
			{ timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const code =
					err === null
						? 0
						: typeof (err as NodeJS.ErrnoException).code === "number"
							? (err as unknown as { code: number }).code
							: -1; // spawn/timeout/kill — infra
				if (code === 0) {
					const message = stdout.trim().split("\n").pop() ?? "valid";
					const m = /\((\d+) slides?\)/.exec(message);
					resolve_({
						ok: true,
						message,
						slideCount: m ? Number(m[1]) : 0,
					});
					return;
				}
				if (code === 1) {
					resolve_({
						ok: false,
						errors: errorLines(stdout || stderr, "deck failed validation"),
						cause: "deck",
					});
					return;
				}
				resolve_({
					ok: false,
					errors: errorLines(stderr, `validate.sh exited ${code} (infra)`),
					cause: "infra",
				});
			},
		);
	});
}

// Wire the machine's service slots to the executors (machine.ts ships typed
// stubs only — this is the one place they are provided). Exported so the
// live end-to-end harness drives the real wiring (build.mjs + Docker
// validate.sh) without a pi instance.
export const wiredMachine = slideDeckMachine.provide({
	actors: {
		buildService: fromPromise<BuildServiceOutput, BuildServiceInput>(
			async ({ input }) => {
				log(
					"INFO",
					`build: "${input.title}" -> ${input.outPath} (${countSlides(input.slidesHtml)} slides)`,
				);
				const r = await runBuildExecutor(input);
				if (!r.ok) {
					log("ERROR", `build failed (infra): ${r.error?.split("\n")[0]}`);
					throw { errors: [r.error ?? "build failed"], cause: "infra" } satisfies ValidateServiceFailure;
				}
				log("INFO", `build ok: ${r.outPath} (${r.slideCount} slides, template injected)`);
				return { outPath: r.outPath, slideCount: r.slideCount, bytes: 0 };
			},
		),
		validateService: fromPromise<ValidateServiceOutput, ValidateServiceInput>(
			async ({ input }) => {
				log("INFO", `validate: ${input.outPath} (Docker html5lib)`);
				const r = await runValidateExecutor(input.outPath);
				if (!r.ok) {
					log(
						"ERROR",
						`validate failed (${r.cause}): ${r.errors[0]?.split("\n")[0]}`,
					);
					throw { errors: r.errors, cause: r.cause } satisfies ValidateServiceFailure;
				}
				log("INFO", `validate ok: ${input.outPath} — ${r.message}`);
				return { slideCount: r.slideCount, message: r.message };
			},
		),
	},
});

// ---------------------------------------------------------------------------
// User-facing output
// ---------------------------------------------------------------------------

/** Best-effort "open in browser": never throws; failures are reported, not fatal. */
function openExternally(
	outPath: string,
): Promise<{ ok: boolean; error: string | null }> {
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

/** Default output path: {decks}/{yyyy-mm-dd}-{slug}.html — new decks land beside the retained ones. */
function defaultOutPath(title: string): string {
	const slug =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "deck";
	const d = new Date();
	const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return join(DECKS_DIR, `${date}-${slug}.html`);
}

// ---------------------------------------------------------------------------
// Formatting (model-facing content)
// ---------------------------------------------------------------------------

function statusLine(ctx: SlideDeckContext): string {
	const parts = [
		`Machine state: ${stateLabel(ctx)}.`,
	];
	if (ctx.topic) parts.push(`Topic: ${ctx.topic}.`);
	if (ctx.sources.length > 0) parts.push(`Sources: ${ctx.sources.length}.`);
	if (ctx.plannedSlides.length > 0)
		parts.push(`Planned slides: ${ctx.plannedSlides.length}.`);
	if (ctx.deck)
		parts.push(
			`Deck: "${ctx.deck.title}" (${ctx.deck.slideCount} slides) -> ${ctx.outPath ?? "?"}.`,
		);
	parts.push(
		`Failed validations: ${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts}. Builds: ${ctx.builds.length}${ctx.builds.length > 0 ? ` (last: ${ctx.builds[ctx.builds.length - 1]})` : ""}.`,
	);
	return parts.join(" ");
}

/**
 * Allowed next steps, derived from the CURRENT machine state + ceremony
 * phase — never a hardcoded template.
 */
function allowedNext(): string {
	const v = stateValue();
	// The collapsed authoring state: enumerate per phase (≡ the old
	// idle/researching/planning/writing cases)
	if (v === "authoring") {
		switch (getActor().getSnapshot().context.phase) {
			case null:
				return "Allowed next: slide_deck_start (topic), or slide_deck_build directly (one event carries the full content).";
			case "researching":
				return "Allowed next: slide_deck_research (sources), slide_deck_build (content), or slide_deck_reset.";
			case "planning":
				return "Allowed next: slide_deck_plan (slide ids), slide_deck_build (content), or slide_deck_reset.";
			case "writing":
				return "Allowed next: slide_deck_build (content), or slide_deck_reset.";
		}
	}
	switch (v) {
		case "building":
			return "Allowed next: none — the build service is in flight; wait for the tool result.";
		case "validating":
			return "Allowed next: none — the validate service is in flight; wait for the tool result.";
		case "fixing":
			return "Allowed next: slide_deck_build (fixed content — retry), or slide_deck_reset.";
		case "done":
			return "Allowed next: slide_deck_build (tweaked content — rebuild), slide_deck_start (new deck topic), or slide_deck_reset.";
		default:
			return `Allowed next (state ${v}): see /slidedeck status.`;
	}
}

/** Persisted snapshot for tool-result details, slimmed: sources/plans capped, errors truncated. */
function slimSnapshot(snapshot: unknown): unknown {
	const slim = JSON.parse(JSON.stringify(snapshot)) as PersistedSnapshot;
	const c = slim?.context;
	if (c) {
		c.sources = c.sources.slice(0, 16).map((s) => String(s).slice(0, 200));
		c.plannedSlides = c.plannedSlides.slice(0, 32).map((s) => String(s).slice(0, 100));
		c.errors = c.errors.slice(0, 10).map((e) => String(e).slice(0, 400));
		if (c.deck) {
			c.deck.title = String(c.deck.title).slice(0, 200);
			c.deck.subtitle = String(c.deck.subtitle).slice(0, 200);
		}
	}
	return slim;
}

function detailsFor(
	action: SlideDeckDetails["action"],
	extra: Partial<SlideDeckDetails> = {},
): SlideDeckDetails {
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
	{ value: "status", description: "show deck workflow state" },
	{ value: "reset", description: "clear deck state" },
	{ value: "footer", description: "toggle live footer status line" },
	{ value: "viz", description: "attach the Stately inspector (live visualisation)" },
];

/** Tab completion for '/slidedeck <subcommand>' (delegates to current provider otherwise). */
function createSlideDeckAutocomplete(
	current: AutocompleteProvider,
): AutocompleteProvider {
	return {
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol);
			const m = /^\/slidedeck ?([a-z]*)$/.exec(before);
			if (!m)
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const typed = m[1] ?? "";
			const items: AutocompleteItem[] = SUBCOMMANDS.filter((s) =>
				s.value.startsWith(typed),
			).map((s) => ({
				value: s.value,
				label: s.value,
				description: s.description,
			}));
			if (items.length === 0)
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: typed };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
};

/** Editorial content rules (prompt-side ownership — structural checks are machine-side). */
const CONTENT_RULES = `Content rules (editorial wording is yours; structure is machine-checked):
- Read ${join(EXT_DIR, "templates", "sidebar-deck.html")} first: every CSS class, layout, and JS hook is there — copy its nesting patterns exactly.
- One <div class="slide" id="slide-<slug>"> per topic; nav items use data-slide="<slug>" (bare slug; ids carry the slide- prefix) and onclick="goToSlide('<slug>')" matching data-slide — the validator rejects mismatches (dead clicks) and duplicates.
- Title-page slides (class="slide slide-title-page": hero-icon + subtitle + feature-grid) are exempt from the tag/description rules.
- Every other slide opens with <div class="description"> (what and why, before prompts/key-points/code-block) and carries <span class="ext-tag tag-<category>">.
- Tag categories are the template's curated set ONLY: safety, tool, command, ui, render, prompt, git, session, game, system, provider — any other tag-* renders unstyled and fails validation.
- Classes outside the template CSS render unstyled — the build reports them as notes; prefer the template's vocabulary.
- Actionable examples in <div class="prompts">; real runnable code in <div class="code-block"> (no ellipsis, escape < & in samples); 2-4 key takeaways in <div class="key-points">.
- <div class="sources"> with at least one <a href> link on EVERY slide (title slides included).
- No external dependencies of any kind (no CDN, @import, Google Fonts); no new CSS custom properties; strong highlights the noun, not the verb.`;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx as never;
		if (process.env.SLIDE_DECK_INSPECT) {
			const r = await viz.enable({ open: true });
			if (!r.ok) log("ERROR", `inspector not started: ${r.message}`);
		}
		reconstructState(ctx);
		if (
			ctx.mode === "tui" &&
			typeof (ctx.ui as never as { addAutocompleteProvider?: unknown })
				.addAutocompleteProvider === "function"
		) {
			ctx.ui.addAutocompleteProvider((current) =>
				createSlideDeckAutocomplete(current),
			);
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		uiCtx = ctx as never;
		reconstructState(ctx);
	});
	pi.on("session_shutdown", async () => {
		viz.stop();
	});

	// --- authoring-phase tools (thin: validate, send, report) ------------------

	pi.registerTool({
		name: "slide_deck_start",
		label: "Slide deck start",
		description:
			"Start a slide-deck workflow: records the topic and moves to `researching`. " +
			"Optional phase tracking — slide_deck_build is legal without it (the machine enforces the build pipeline, not the authoring ceremony).",
		parameters: Type.Object({
			topic: Type.String({ description: "Deck topic" }),
		}),

		async execute(_toolCallId, params) {
			return withToolLock(async () => {
				const snap = getActor().getSnapshot();
				const violation = startViolation(params.topic);
				const canStart = snap.can({ type: "START", topic: params.topic });
				if (violation || !canStart) {
					const reason =
						violation ??
						`not legal from state \`${stateLabel(snap.context)}\` (START starts a NEW deck — fresh authoring (phase null) or done)`;
					return {
						content: text(
							`Start rejected: ${reason}\n${statusLine(snap.context)}\n${allowedNext()}`,
						),
						details: detailsFor("start", { rejected: reason }),
					};
				}
				getActor().send({ type: "START", topic: params.topic });
				log("INFO", `start: "${params.topic}"`);
				return {
					content: text(
						`Deck workflow started (topic: ${params.topic}).\n${statusLine(getActor().getSnapshot().context)}\n${allowedNext()}`,
					),
					details: detailsFor("start"),
				};
			});
		},

		renderCall(args) {
			return new Text(`slide_deck_start ${args.topic ?? ""}`, 0, 0);
		},
		renderResult(result) {
			const details = result.details as SlideDeckDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text("✓ started", 0, 0);
		},
	});

	pi.registerTool({
		name: "slide_deck_research",
		label: "Slide deck research",
		description:
			"Record the research phase: the sources the deck is built from (URLs, file paths). Moves `researching` -> `planning`. Optional phase tracking.",
		parameters: Type.Object({
			sources: Type.Array(Type.String(), {
				description: "Source URLs / file paths the research came from",
			}),
		}),

		async execute(_toolCallId, params) {
			return withToolLock(async () => {
				const snap = getActor().getSnapshot();
				const violation = researchViolation(params.sources);
				const can = snap.can({ type: "RESEARCH_DONE", sources: params.sources });
				if (violation || !can) {
					const reason =
						violation ??
						`not legal from state \`${stateLabel(snap.context)}\` (RESEARCH_DONE is legal in the research phase — after slide_deck_start)`;
					return {
						content: text(
							`Research rejected: ${reason}\n${statusLine(snap.context)}\n${allowedNext()}`,
						),
						details: detailsFor("research", { rejected: reason }),
					};
				}
				getActor().send({ type: "RESEARCH_DONE", sources: params.sources });
				log("INFO", `research done: ${params.sources.length} sources`);
				return {
					content: text(
						`Research recorded (${params.sources.length} sources).\n${statusLine(getActor().getSnapshot().context)}\n${allowedNext()}`,
					),
					details: detailsFor("research"),
				};
			});
		},

		renderCall(args) {
			return new Text(
				`slide_deck_research (${args.sources?.length ?? 0} sources)`,
				0,
				0,
			);
		},
		renderResult(result) {
			const details = result.details as SlideDeckDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text("✓ research recorded", 0, 0);
		},
	});

	pi.registerTool({
		name: "slide_deck_plan",
		label: "Slide deck plan",
		description:
			"Record the slide plan: the planned slide ids (bare slugs, e.g. `intro`, `history`). Moves `planning` -> `writing`. Optional phase tracking.",
		parameters: Type.Object({
			slides: Type.Array(Type.String(), {
				description: "Planned slide ids (bare slugs, no slide- prefix)",
			}),
		}),

		async execute(_toolCallId, params) {
			return withToolLock(async () => {
				const snap = getActor().getSnapshot();
				const violation = planViolation(params.slides);
				const can = snap.can({ type: "PLAN_DONE", slides: params.slides });
				if (violation || !can) {
					const reason =
						violation ??
						`not legal from state \`${stateLabel(snap.context)}\` (slide_deck_plan is legal after slide_deck_research — replans mid-writing and mid-fix included)`;
					return {
						content: text(
							`Plan rejected: ${reason}\n${statusLine(snap.context)}\n${allowedNext()}`,
						),
						details: detailsFor("plan", { rejected: reason }),
					};
				}
				getActor().send({ type: "PLAN_DONE", slides: params.slides });
				log("INFO", `plan done: ${params.slides.length} slides`);
				return {
					content: text(
						`Plan recorded (${params.slides.length} slides: ${params.slides.join(", ")}).\n${statusLine(getActor().getSnapshot().context)}\n${allowedNext()}`,
					),
					details: detailsFor("plan"),
				};
			});
		},

		renderCall(args) {
			return new Text(
				`slide_deck_plan (${args.slides?.length ?? 0} slides)`,
				0,
				0,
			);
		},
		renderResult(result) {
			const details = result.details as SlideDeckDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text("✓ plan recorded", 0, 0);
		},
	});

	// --- the pipeline tool (one event; machine drives the rest) ---------------

	pi.registerTool({
		name: "slide_deck_build",
		label: "Slide deck build",
		description:
			"Build and validate a self-contained HTML slide deck — one event carries the full content, the machine drives the pipeline " +
			"(copy templates/sidebar-deck.html + inject -> Docker html5lib validation -> opens the deck in the browser on success). " +
			"navHtml and slidesHtml are hand-written HTML blocks following the template's classes. " +
			`${CONTENT_RULES} ` +
			"Out-of-date decks fail validation with readable errors — resubmit the fixed content with the same tool (retry loop, capped). " +
			"outPath defaults to the extension's decks/ dir (retained decks live there).",
		parameters: Type.Object({
			title: Type.String({ description: "Deck title (sidebar header + <title>)" }),
			subtitle: Type.String({
				description: "Deck subtitle (sidebar tagline under the title)",
			}),
			navHtml: Type.String({
				description:
					"Sidebar nav HTML: nav-category/nav-item blocks. Every nav-item carries data-slide=\"<bare-slug>\" matching a slide id slide-<bare-slug>.",
			}),
			slidesHtml: Type.String({
				description:
					"Slide HTML: one <div class=\"slide\" id=\"slide-<slug>\"> per topic, following the template's slide structure.",
			}),
			outPath: Type.Optional(
				Type.String({
					description:
					"Output .html path (default: decks/{date}-{slug}.html in the extension dir)",
				}),
			),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
					"Replace an existing output file. Default: a foreign existing file is rejected (readable error); a path this workflow itself built and validated is implicitly replaceable (rebuild-tweaks flow).",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate) {
			return withToolLock(async () => {
				const snap = getActor().getSnapshot();
				const outPath = absPath(params.outPath ?? defaultOutPath(params.title));
				// Silent-overwrite guard: explicit param, or a path this machine
				// itself built and validated (rebuild-tweaks flow stays free)
				const overwrite =
					params.overwrite === true || snap.context.builds.includes(outPath);
				const content: DeckContent = {
					title: params.title,
					subtitle: params.subtitle,
					navHtml: params.navHtml,
					slidesHtml: params.slidesHtml,
					outPath,
					overwrite,
				};
				const violation = buildViolation(snap.context, content);
				const canBuild = snap.can({
					type: "BEGIN_BUILD",
					...content,
				} as SlideDeckEvent);
				if (violation || !canBuild) {
					const reason =
						violation ??
						`not legal from state \`${stateLabel(snap.context)}\` — a build or validation is in flight`;
					log("WARN", `build rejected: ${reason}`);
					return {
						content: text(
							`Build rejected: ${reason}\n${statusLine(snap.context)}\n${allowedNext()}`,
						),
						details: detailsFor("build", {
							rejected: reason,
							file: basename(content.outPath),
						}),
					};
				}

				getActor().send({ type: "BEGIN_BUILD", ...content });
				log(
					"INFO",
					`build: "${content.title}" -> ${content.outPath} (${countSlides(content.slidesHtml)} slides)`,
				);
				onUpdate?.({
					content: text(
						`Building "${content.title}" — copying template + injecting ${countSlides(content.slidesHtml)} slides…`,
					),
					details: detailsFor("build", { file: basename(content.outPath) }),
				});

				let settled: string;
				try {
					await waitFor(
						getActor(),
						(s) => s.matches("done") || s.matches("fixing"),
						{ timeout: SETTLE_TIMEOUT_MS },
					);
					settled = stateValue();
				} catch {
					// Pipeline still in flight (first Docker image build can be
					// slow) — honest state, the machine keeps running
					return {
						content: text(
							`Pipeline still in flight (state: ${stateValue()}) after ${Math.round(SETTLE_TIMEOUT_MS / 1000)}s — the build continues in the background; check slide_deck_status.\n${statusLine(getActor().getSnapshot().context)}`,
						),
						details: detailsFor("build", {
							file: basename(content.outPath),
						}),
					};
				}

				const ctxNow = getActor().getSnapshot().context;

				if (settled === "done") {
					const outPath = ctxNow.outPath ?? content.outPath;
					const opened = await openExternally(outPath);
					log(
						"INFO",
						`deck done: ${outPath}${opened.ok ? " (opened in browser)" : ` (open failed: ${opened.error})`}`,
					);
					return {
						content: text(
							`Deck built and validated: ${outPath}\nValidated: ${ctxNow.deck?.slideCount ?? "?"} slides, nav 1:1, self-contained. Deck ${opened.ok ? "opened in the browser" : `NOT opened (${opened.error} — open it manually)`}.\n${statusLine(ctxNow)}\n${allowedNext()}`,
						),
						details: detailsFor("build", { file: basename(outPath) }),
					};
				}

				// fixing: validation errors (deck) or pipeline failure (infra)
				const errors = ctxNow.errors.length
					? ctxNow.errors.join("\n")
					: "unknown failure";
				return {
					content: text(
						`Deck failed validation — fix the content and resubmit via slide_deck_build (same tool, fixed navHtml/slidesHtml):\n${errors}\n${statusLine(ctxNow)}\n${allowedNext()}`,
					),
					details: detailsFor("build", {
						error: errors.split("\n")[0] ?? "validation failed",
						file: basename(content.outPath),
					}),
				};
			});
		},

		renderCall(args) {
			return new Text(`slide_deck_build "${args.title ?? ""}"`, 0, 0);
		},
		renderResult(result) {
			const details = result.details as SlideDeckDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
			return new Text(`✓ deck built ${details?.file ?? ""}`, 0, 0);
		},
	});

	// --- status / reset ---------------------------------------------------------

	pi.registerTool({
		name: "slide_deck_status",
		label: "Slide deck status",
		description: "Show the slide-deck workflow state (machine snapshot).",
		parameters: Type.Object({}),

		async execute() {
			return withToolLock(async () => {
				const ctx = getActor().getSnapshot().context;
				return {
					content: text(
						`${statusLine(ctx)}\n${ctx.errors.length > 0 ? `Last errors:\n${ctx.errors.join("\n")}\n` : ""}${allowedNext()}`,
					),
					details: detailsFor("status"),
				};
			});
		},

		renderCall() {
			return new Text("slide_deck_status", 0, 0);
		},
		renderResult() {
			return new Text(
				`✓ ${stateLabel(getActor().getSnapshot().context)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "slide_deck_reset",
		label: "Slide deck reset",
		description: "Clear the slide-deck workflow state machine and start over.",
		parameters: Type.Object({}),

		async execute() {
			return withToolLock(async () => {
				const ctx = getActor().getSnapshot().context;
				const prior = `topic ${ctx.topic ?? "none"}, deck ${ctx.deck ? `"${ctx.deck.title}"` : "none"}, failed validations ${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts}, builds ${ctx.builds.length}, machine state ${stateLabel(ctx)}`;
				getActor().send({ type: "RESET" });
				log("INFO", `reset (was: ${prior})`);
				return {
					content: text(
						`Deck state cleared (was: ${prior}).\n${statusLine(getActor().getSnapshot().context)}`,
					),
					details: detailsFor("reset"),
				};
			});
		},

		renderCall() {
			return new Text("slide_deck_reset", 0, 0);
		},
		renderResult() {
			return new Text("✓ reset", 0, 0);
		},
	});

	// --- command ----------------------------------------------------------------

	pi.registerCommand("slidedeck", {
		description:
			"Slide-deck workflow: status | reset | footer (live status line) | viz (live machine visualisation)",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			if (sub === "footer") {
				statusEnabled = !statusEnabled;
				refreshStatus();
				ctx.ui.notify(`Footer status ${statusEnabled ? "on" : "off"}`, "info");
				return;
			}
			if (sub === "reset") {
				getActor().send({ type: "RESET" });
				ctx.ui.notify("Deck state cleared", "info");
				return;
			}
			if (sub === "viz") {
				const r = await attachInspector();
				ctx.ui.notify(
					r.ok
						? `Inspector: http://localhost:${r.port}`
						: `Inspector not started: ${r.message}`,
					r.ok ? "info" : "error",
				);
				return;
			}
			// default: status
			const c = getActor().getSnapshot().context;
			ctx.ui.notify(
				`${statusText(c)}\n${allowedNext()}`,
				"info",
			);
		},
	});
}
