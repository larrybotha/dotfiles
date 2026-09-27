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
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  Component,
  type Focusable,
  Image,
  matchesKey,
  ScrollView,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Actor, createActor } from "xstate";
import { makeViz, type VizResult } from "../_viz/viz-kit.ts";
import { embedBlock, svgPathFor } from "./embed.ts";
import {
  embedViolation,
  initialContext,
  type MermaidLimits,
  mermaidMachine,
  renderViolation,
  validateViolation,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Integer env var with fallback: missing/garbage -> default (never NaN, never disables a cap by accident). */
function intEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : def;
}

const LIMITS: MermaidLimits = {
  maxValidateAttempts: intEnv("MERMAID_MAX_VALIDATE_ATTEMPTS", 8),
};
const SCRIPT_TIMEOUT_MS = intEnv("MERMAID_SCRIPT_TIMEOUT_MS", 180_000);
const ASCII_TRUNCATE = intEnv("MERMAID_ASCII_TRUNCATE", 8000);
const INSPECT_PORT = (() => {
  const n = intEnv("MERMAID_INSPECT_PORT", 8082);
  return n < 65536 ? n : 8082;
})();

// Docker render pipeline ships with this extension (executors/) — single
// owner, swappable like web-search's backend: point MERMAID_EXEC_DIR at a dir
// with ascii.sh + svg.sh honoring the same contract (exit 0 = valid,
// non-zero = invalid).
const EXEC_DIR = resolve(
  process.env.MERMAID_EXEC_DIR ??
    join(homedir(), ".pi/agent/extensions/mermaid/executors"),
);
const ASCII_SCRIPT = join(EXEC_DIR, "ascii.sh");
const SVG_SCRIPT = join(EXEC_DIR, "svg.sh");

const LOG_DIR =
  process.env.MERMAID_LOG_DIR ?? join(homedir(), ".cache", "mermaid");

const THEMES = new Set(["default", "dark", "forest", "neutral"]);

/** Best-effort diagnostics log; never throws, never blocks a tool. */
function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      join(LOG_DIR, "mermaid.log"),
      `${new Date().toISOString()} [${level}] ${msg}\n`,
    );
  } catch {
    /* logging must not break tools */
  }
}

const TOOL_NAMES = new Set([
  "mermaid_validate",
  "mermaid_render",
  "mermaid_embed",
  "mermaid_reset",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PersistedSnapshot = {
  context?: ReturnType<typeof initialContext>;
  value?: unknown;
  status?: unknown;
};

type MermaidDetails = {
  action: "validate" | "render" | "embed" | "reset";
  state: string;
  /** Basename of the diagram involved — lets renderResult name the file. */
  file?: string;
  rejected?: string;
  error?: string;
  snapshot: unknown;
};

// ---------------------------------------------------------------------------
// Actor management (reconstructed from branch, like web-search)
// ---------------------------------------------------------------------------

let actor: Actor<typeof mermaidMachine> | null = null;
let unsubscribeActor: { unsubscribe: () => void } | null = null;
let uiCtx: {
  ui: {
    setStatus: (k: string, t: string | undefined) => void;
    theme?: { fg: (c: string, s: string) => string };
  };
} | null = null;

// ---------------------------------------------------------------------------
// Output mode (extension-driven output: what the user sees after validation)
// ---------------------------------------------------------------------------

type OutputMode = "ascii" | "png-tui" | "svg" | "png" | "none";
const OUTPUT_MODES: ReadonlyMap<OutputMode, string> = new Map([
  ["ascii", "ASCII preview in TUI (no render)"],
  ["png-tui", "render PNG, show inline in TUI (kitty/iTerm2 images)"],
  ["svg", "render SVG, reveal in Finder/file manager"],
  ["png", "render PNG, reveal in Finder/file manager"],
  ["none", "no auto-output"],
]);
const OUTPUT_MODE_FILE = join(LOG_DIR, "output-mode");

/** MERMAID_OUTPUT env beats the persisted mode; garbage falls back to default. */
function loadOutputMode(): OutputMode {
  const env = process.env.MERMAID_OUTPUT;
  if (env && OUTPUT_MODES.has(env as OutputMode)) return env as OutputMode;
  try {
    const saved = readFileSync(OUTPUT_MODE_FILE, "utf8").trim() as OutputMode;
    if (OUTPUT_MODES.has(saved)) return saved;
  } catch {
    /* first run: default below */
  }
  return "ascii";
}

/**
 * What the user sees after a successful validate ('/mermaid output'; last
 * selection persists and is the default). The model never picks the output
 * format — output is extension-driven.
 */
let outputMode = loadOutputMode();

function setOutputMode(mode: OutputMode) {
  outputMode = mode;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(OUTPUT_MODE_FILE, `${mode}\n`);
  } catch (e) {
    log(
      "WARN",
      `persist output mode failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  log("INFO", `output mode: ${mode}`);
}

/** PNG preview cache path (content-hashed: revalidating the same diagram reuses the file). */
function pngPreviewPath(path: string, hash: string): string {
  return join(
    LOG_DIR,
    "previews",
    `${basename(path, ".mmd")}-${hash.slice(0, 12)}.png`,
  );
}
/** Footer status is opt-in: toggle with '/mermaid footer' (or MERMAID_FOOTER=1). */
let statusEnabled = process.env.MERMAID_FOOTER === "1";

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
    input: "input" in opts ? opts.input : undefined,
    // XState's persisted-snapshot type is internal; snapshots passed here
    // come from getPersistedSnapshot() of this same machine — one cast at
    // this boundary instead of casting the whole options object.
    snapshot: "snapshot" in opts ? (opts.snapshot as never) : undefined,
    ...viz.option(),
  });
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

/**
 * Serialize mermaid tool bodies (single machine, two-phase events): without a
 * lock, concurrent tool calls interleave BEGIN/DONE events — the machine
 * silently drops the second caller's events while both tools report success.
 * Failures inside the lock are data (tool results), not lock errors.
 */
let toolChain: Promise<unknown> = Promise.resolve();
function withToolLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = toolChain.then(fn, fn);
  toolChain = next.catch(() => {});
  return next;
}

/** Restore diagram state from the last mermaid tool result on this branch. */
function reconstructState(ctx: {
  sessionManager: { getBranch: () => Array<any> };
}) {
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

/** Executor contract exit codes (see executors/): 0 success, 1 diagram, else infra. */
const EXIT_OK = 0;
const EXIT_INVALID = 1;

type ExecOutcome = { code: number; stdout: string; stderr: string };

/** Executor exit code -> failure cause. Callers handle 0 (ok) separately. */
function causeFor(code: number): "diagram" | "infra" {
  return code === EXIT_INVALID ? "diagram" : "infra";
}

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
 * Run an executor script. Never rejects: non-zero exits are data (exit code +
 * stderr), resolved — the caller decides diagram-vs-infra. Spawn/timeout
 * failures resolve with code -1 (infra).
 */
function run(script: string, args: string[]): Promise<ExecOutcome> {
  return new Promise((resolve_) => {
    execFile(
      "bash",
      [script, ...args],
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err === null
            ? 0
            : typeof (err as NodeJS.ErrnoException).code === "number"
              ? (err as unknown as { code: number }).code
              : -1; // spawn/timeout/kill — infra
        resolve_({ code, stdout, stderr });
      },
    );
  });
}

/** Read a diagram + its content hash (evidence for machine guards). */
async function readSource(
  path: string,
): Promise<{ content: string; hash: string }> {
  const content = await readFile(path, "utf8");
  return { content, hash: createHash("sha256").update(content).digest("hex") };
}

/** Render outcome: ok, or failure tagged diagram-vs-infra (drives machine cause). */
type RenderOutcome =
  | { ok: true; error: null }
  | { ok: false; error: string; cause: "diagram" | "infra" };

/**
 * Shared render path (mermaid_render tool + auto-output): sends BEGIN_RENDER
 * (caller has prechecked renderViolation + can()) -> runs the Docker executor
 * -> sends RENDER_DONE with a cause. Returns failure as data.
 */
async function runRender(
  path: string,
  hash: string,
  outPath: string,
  theme: string,
  onUpdate?: AgentToolUpdateCallback<MermaidDetails>,
): Promise<RenderOutcome> {
  getActor().send({ type: "BEGIN_RENDER", path, hash, outPath });
  log("INFO", `render: ${path} -> ${outPath} (theme ${theme})`);
  onUpdate?.({
    content: text(
      `Rendering ${basename(path)} -> ${basename(outPath)} via Docker…`,
    ),
    details: detailsFor("render"),
  });
  const { code, stderr } = await run(SVG_SCRIPT, ["-t", theme, path, outPath]);
  if (code === EXIT_OK) {
    getActor().send({ type: "RENDER_DONE", ok: true, outPath, error: null });
    log("INFO", `render ok: ${outPath}`);
    return { ok: true, error: null };
  }
  const cause = causeFor(code);
  const msg = errorLines(stderr, `svg.sh exited ${code}`).join("\n");
  log("ERROR", `render failed (${cause}): ${msg.split("\n")[0]}`);
  getActor().send({
    type: "RENDER_DONE",
    ok: false,
    outPath,
    error: msg,
    cause,
  });
  return { ok: false, error: msg, cause };
}

// ---------------------------------------------------------------------------
// User-facing output (extension-driven, not model-mediated)
// ---------------------------------------------------------------------------

/**
 * Preview overlay: the validated diagram shown directly in the TUI (ASCII
 * art, or a rendered PNG via kitty/iTerm2 images with a text fallback).
 * Esc/q/Enter closes; j/k/arrows/PgUp/PgDn/g/G scroll. Wheel events the
 * component does not handle scroll the nearest ScrollView (this one).
 */
class PreviewOverlay implements Focusable {
  focused = false; // set by the TUI; no cursor to place
  private readonly scroll: ScrollView;

  constructor(
    private readonly theme: Theme,
    private readonly title: string,
    body: Component,
    private readonly close: () => void,
  ) {
    this.scroll = new ScrollView(body, { scrollbar: "always" });
  }

  handleInput(data: string) {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "enter") ||
      data === "q"
    ) {
      this.close();
      return;
    }
    if (matchesKey(data, "up") || data === "k") this.scroll.scrollBy(-1);
    else if (matchesKey(data, "down") || data === "j") this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp"))
      this.scroll.scrollBy(-this.scroll.viewportHeight + 1);
    else if (matchesKey(data, "pageDown"))
      this.scroll.scrollBy(this.scroll.viewportHeight - 1);
    else if (data === "g") this.scroll.scrollToStart();
    else if (data === "G") this.scroll.scrollToEnd();
  }

  render(width: number): string[] {
    const header =
      this.theme.fg("accent", ` mermaid · ${this.title} `) +
      this.theme.fg("dim", " j/k/arrows scroll · Esc closes ");
    return [header, ...this.scroll.render(width)];
  }
}

/**
 * Fire-and-forget preview overlay — never blocks the tool result (the agent
 * turn continues while the user reads). No-ops in non-interactive modes.
 */
function showPreview(
  execCtx: unknown,
  title: string,
  body: (theme: Theme) => Component,
) {
  const uiAny = execCtx as
    | {
        mode?: string;
        ui?: {
          custom?: <T>(
            factory: (
              tui: never,
              theme: Theme,
              kb: never,
              done: (r: T) => void,
            ) => unknown,
            options?: {
              overlay?: boolean;
              overlayOptions?: Record<string, unknown>;
            },
          ) => Promise<T>;
        };
      }
    | undefined;
  if (uiAny?.mode !== "tui" || typeof uiAny.ui?.custom !== "function") return;
  void uiAny.ui
    .custom<void>(
      (_tui, theme, _kb, done) =>
        new PreviewOverlay(theme, title, body(theme), () => done(undefined)),
      { overlay: true, overlayOptions: { width: "70%", maxHeight: "80%" } },
    )
    .catch(() => {});
}

/** ASCII preview (ascii.sh stdout) in a TUI overlay. */
function showAsciiPreview(execCtx: unknown, title: string, art: string) {
  showPreview(execCtx, title, () => new Text(art, 1, 1));
}

/** Rendered PNG in a TUI overlay (kitty/iTerm2 images; dim filename fallback otherwise). */
function showImagePreview(execCtx: unknown, title: string, pngPath: string) {
  let base64: string;
  try {
    base64 = readFileSync(pngPath).toString("base64");
  } catch (e) {
    log(
      "WARN",
      `png preview read failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  showPreview(
    execCtx,
    title,
    (theme) =>
      new Image(
        base64,
        "image/png",
        { fallbackColor: (s) => theme.fg("muted", s) },
        { maxWidthCells: 60, filename: title },
      ),
  );
}

/**
 * Best-effort "open externally" (executor): system viewer for the file, or a
 * Finder/file-manager reveal (open -R / xdg-open on the parent dir). Never throws.
 */
function openExternally(
  outPath: string,
  reveal = false,
): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve_) => {
    const darwin = process.platform === "darwin";
    const opener = darwin ? "open" : "xdg-open";
    const args = darwin
      ? reveal
        ? ["-R", outPath]
        : [outPath]
      : [reveal ? dirname(outPath) : outPath];
    execFile(opener, args, (err) => {
      if (err) {
        log("WARN", `open failed: ${err.message}`);
        resolve_({ ok: false, error: err.message });
      } else {
        resolve_({ ok: true, error: null });
      }
    });
  });
}

/**
 * Deliver the mode's output side effect for a validated source (validate
 * success + '/mermaid output' selection demo). Render modes go through the
 * machine-gated path (fresh pass required); the overlay is fire-and-forget.
 * `ascii` is the validate stdout when available; null re-runs ascii.sh
 * display-only (no machine events) for a demo. Returns a note for the
 * caller (tool result text or log). Never throws.
 */
async function deliverOutput(
  mode: OutputMode,
  path: string,
  hash: string,
  ascii: string | null,
  execCtx: unknown,
  onUpdate?: AgentToolUpdateCallback<MermaidDetails>,
): Promise<string> {
  if (mode === "none") return "";
  if (mode === "ascii") {
    if (ascii === null) {
      const { stdout } = await run(ASCII_SCRIPT, [
        "-t",
        process.env.MERMAID_THEME ?? "dark",
        path,
      ]);
      ascii = stdout.trim() === "" ? null : stdout;
    }
    if (ascii !== null && ascii.trim() !== "") {
      showAsciiPreview(execCtx, basename(path), ascii);
      return "\nOutput (ascii): ASCII preview shown in TUI";
    }
    return "\nOutput (ascii): preview unavailable (mmdc passed; the preview renderer failed)";
  }
  const outPath =
    mode === "svg" ? svgPathFor(path) : pngPreviewPath(path, hash);
  const violation = renderViolation(
    getActor().getSnapshot().context,
    path,
    hash,
  );
  if (violation) return `\nOutput skipped: ${violation}`;
  const r = await runRender(
    path,
    hash,
    outPath,
    process.env.MERMAID_THEME ?? "dark",
    onUpdate,
  );
  if (!r.ok) {
    return `\nOutput render failed — the diagram stays validated; mermaid_render ${outPath} can retry.`;
  }
  let shown = "shown in TUI";
  if (mode === "png-tui") {
    showImagePreview(execCtx, basename(outPath), outPath);
  } else {
    // svg / png: reveal the rendered file where it was written
    const revealed = await openExternally(outPath, true);
    shown = revealed.ok
      ? "revealed in Finder/file manager"
      : `reveal failed (${revealed.error})`;
  }
  log("INFO", `auto-output ${mode}: ${outPath}`);
  return `\nOutput (${mode}): ${outPath} — ${shown}`;
}

// ---------------------------------------------------------------------------
// Formatting (model-facing content)
// ---------------------------------------------------------------------------

function statusLine(ctx: ReturnType<typeof initialContext>): string {
  return `Failed validations: ${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts}. Renders: ${ctx.renders.length}. Embeds: ${ctx.embeds.length}. Machine state: ${stateValue()}.`;
}

/**
 * Allowed next steps, derived from the CURRENT machine state — never a
 * hardcoded template (a stale template can advise actions the state forbids).
 */
function allowedNext(): string {
  switch (stateValue()) {
    case "drafting":
      return "Allowed next: mermaid_validate (a diagram).";
    case "validating":
      return "Allowed next: none — a validation is in flight; wait for its result.";
    case "rendering":
      return "Allowed next: none — a render is in flight; wait for its result.";
    case "fixing":
      return "Allowed next: mermaid_validate (re-validate this or another diagram), or mermaid_reset.";
    case "validated":
      return "Allowed next: mermaid_render, mermaid_embed, mermaid_validate (edited/new diagram), or mermaid_reset.";
    default:
      return `Allowed next (state ${stateValue()}): see /mermaid status.`;
  }
}

/**
 * Persisted snapshot for tool-result details, slimmed: error text is truncated
 * (transcript already holds the full tool output). Keeps session files small.
 */
function slimSnapshot(snapshot: unknown): unknown {
  const slim = JSON.parse(JSON.stringify(snapshot)) as PersistedSnapshot;
  const errors = slim?.context?.errors;
  if (Array.isArray(errors)) {
    slim.context!.errors = errors
      .slice(0, 10)
      .map((e) => String(e).slice(0, 400));
  }
  return slim;
}

function detailsFor(
  action: MermaidDetails["action"],
  extra: Partial<MermaidDetails> = {},
): MermaidDetails {
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
  {
    value: "output",
    description:
      "set output on validation: ascii | png-tui | svg | png | none (persisted; picker with no argument)",
  },
  { value: "footer", description: "toggle live footer status line" },
  {
    value: "viz",
    description: "attach the Stately inspector (live visualisation)",
  },
];

/** Tab completion for '/mermaid <subcommand>' (delegates to current provider otherwise). */
function createMermaidAutocomplete(
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
      const m = /^\/mermaid ?([a-z]*)$/.exec(before);
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
    if (
      ctx.mode === "tui" &&
      typeof (ctx.ui as never as { addAutocompleteProvider?: unknown })
        .addAutocompleteProvider === "function"
    ) {
      ctx.ui.addAutocompleteProvider((current) =>
        createMermaidAutocomplete(current),
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

  pi.registerTool({
    name: "mermaid_validate",
    label: "Mermaid validate",
    description:
      "Validate a Mermaid diagram and move the workflow to `validated` (returns the ASCII preview). " +
      "Only a validated source (same path, unchanged content) can be rendered or embedded. " +
      "The workflow tracks one diagram at a time — validating another diagram switches the tracked source. " +
      `Failed validations are capped (${LIMITS.maxValidateAttempts}); mermaid_reset clears state. ` +
      "Validating an edited diagram re-establishes the pass. Optional theme for the ASCII preview: default|dark|forest|neutral.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the .mmd diagram file" }),
      theme: Type.Optional(
        Type.String({
          description:
            "default|dark|forest|neutral (default dark) — theme for the ASCII preview",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
      // withToolLock serializes tool bodies against the single machine (body
      // kept at this indentation to keep the diff small).
      return withToolLock(async () => {
        const path = absPath(params.path);
        const theme = params.theme ?? process.env.MERMAID_THEME ?? "dark";
        if (!THEMES.has(theme)) {
          return {
            content: text(
              `Unknown theme "${theme}" — use default, dark, forest, or neutral.`,
            ),
            details: detailsFor("validate", {
              error: `unknown theme: ${theme}`,
            }),
          };
        }

        let content: string;
        let hash: string;
        try {
          ({ content, hash } = await readSource(path));
        } catch (e) {
          log("WARN", `validate: unreadable source: ${path}`);
          return {
            content: text(
              `Cannot read diagram: ${path}\n${(e as Error).message}`,
            ),
            details: detailsFor("validate", {
              error: `unreadable source: ${(e as Error).message}`,
            }),
          };
        }
        if (content.trim() === "") {
          return {
            content: text(
              `Diagram is empty: ${path}\nWrite the diagram first, then mermaid_validate.`,
            ),
            details: detailsFor("validate", { error: "empty diagram" }),
          };
        }

        const snap = getActor().getSnapshot();
        const violation = validateViolation(snap.context);
        // can(): state-level legality — same pattern as render/embed (a
        // validation or render already in flight makes BEGIN_VALIDATE illegal).
        const canValidate = snap.can({ type: "BEGIN_VALIDATE" });
        if (violation || !canValidate) {
          const reason =
            violation ??
            `not legal from state \`${stateValue()}\` — a validation or render is in flight`;
          log("WARN", `validate rejected: ${reason}`);
          return {
            content: text(
              `Validate rejected: ${reason}\n${statusLine(snap.context)}\n${allowedNext()}`,
            ),
            details: detailsFor("validate", { rejected: reason }),
          };
        }

        getActor().send({ type: "BEGIN_VALIDATE" });
        log("INFO", `validate: ${path} (theme ${theme})`);
        // Progress: first Docker run builds the image (minutes); without this
        // the tool looks stuck to the user.
        _onUpdate?.({
          content: text(
            `Validating ${basename(path)} via Docker (first run builds the image)…`,
          ),
          details: detailsFor("validate"),
        });
        const { code, stdout, stderr } = await run(ASCII_SCRIPT, [
          "-t",
          theme,
          path,
        ]);

        if (code !== EXIT_OK) {
          const cause = causeFor(code);
          const errors = errorLines(stderr, `ascii.sh exited ${code}`);
          log(
            "WARN",
            `validate failed (${cause}): ${path}: ${errors[0] ?? "unknown"}`,
          );
          getActor().send({
            type: "VALIDATE_DONE",
            path,
            hash,
            ok: false,
            errors,
            cause,
          });
          if (cause === "infra") {
            return {
              content: text(
                `Validation pipeline failed (infra) — the diagram was NOT checked: ${basename(path)}\n\n${errors.join("\n")}\n\n` +
                  `The validation pass (if any) is kept and no attempt was consumed — nothing is wrong with the diagram.\n` +
                  `Check Docker, then retry mermaid_validate.\n\n${statusLine(getActor().getSnapshot().context)}`,
              ),
              details: detailsFor("validate", {
                error: `infra: ${errors[0] ?? "validation pipeline failed"}`,
              }),
            };
          }
          return {
            content: text(
              `Diagram is invalid: ${basename(path)}\n\n${errors.join("\n")}\n\n${statusLine(getActor().getSnapshot().context)}\n` +
                "Fix the diagram, then mermaid_validate again (machine is in `fixing`).",
            ),
            details: detailsFor("validate", {
              error: errors[0] ?? "invalid diagram",
            }),
          };
        }

        getActor().send({
          type: "VALIDATE_DONE",
          path,
          hash,
          ok: true,
          errors: [],
        });
        log("INFO", `validate ok: ${path}`);
        const preview =
          stdout.trim() === ""
            ? "(ASCII preview unavailable — mmdc passed; the preview renderer failed)"
            : stdout.length > ASCII_TRUNCATE
              ? `${stdout.slice(0, ASCII_TRUNCATE)}\n… (truncated)`
              : stdout.trim();

        // Output comes from the extension, not the model: what the user
        // sees after validation is set by '/mermaid output' (persisted;
        // default ASCII overlay). Auto-renders go through the same
        // machine-gated path as mermaid_render (fresh pass, BEGIN/RENDER
        // DONE) and are recorded in the result text, so the model stays
        // in sync. Interactive modes only — print/JSON sessions are
        // background; a failed preview renderer falls back to text.
        let outputNote = "";
        if (
          (execCtx as { mode?: string } | undefined)?.mode === "tui" &&
          outputMode !== "none"
        ) {
          outputNote = await deliverOutput(
            outputMode,
            path,
            hash,
            stdout,
            execCtx,
            _onUpdate,
          );
        }

        const next = allowedNext();
        return {
          content: text(
            `Diagram is valid (validated: ${basename(path)}).\n\n${preview}${outputNote}\n\n${statusLine(getActor().getSnapshot().context)}\n${next}`,
          ),
          details: detailsFor("validate", { file: basename(path) }),
        };
      });
    },

    renderCall(args) {
      return new Text(`mermaid_validate ${args.path ?? ""}`, 0, 0);
    },

    renderResult(result) {
      const details = result.details as MermaidDetails | undefined;
      if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
      if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
      return new Text(
        `✓ validated ${details?.file ?? ""} (${details?.state ?? ""})`.replace(
          "  ",
          " ",
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "mermaid_render",
    label: "Mermaid render",
    description:
      "Render the validated diagram to SVG or PNG (Docker; format follows the outPath extension). Only legal for the source " +
      "that last passed mermaid_validate, with unchanged content — an edit invalidates the pass (re-validate). " +
      "Optional theme: default|dark|forest|neutral.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the validated .mmd diagram file",
      }),
      outPath: Type.String({ description: "Output .svg or .png path" }),
      theme: Type.Optional(
        Type.String({
          description: "default|dark|forest|neutral (default dark)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, execCtx) {
      return withToolLock(async () => {
        const path = absPath(params.path);
        const outPath = absPath(params.outPath);
        const theme = params.theme ?? process.env.MERMAID_THEME ?? "dark";
        if (!THEMES.has(theme)) {
          return {
            content: text(
              `Unknown theme "${theme}" — use default, dark, forest, or neutral.`,
            ),
            details: detailsFor("render", { error: `unknown theme: ${theme}` }),
          };
        }

        let hash: string;
        try {
          ({ hash } = await readSource(path));
        } catch (e) {
          return {
            content: text(
              `Cannot read diagram: ${path}\n${(e as Error).message}`,
            ),
            details: detailsFor("render", {
              error: `unreadable source: ${(e as Error).message}`,
            }),
          };
        }

        const snap = getActor().getSnapshot();
        const violation = renderViolation(snap.context, path, hash);
        // can() closes the state-level hole a context-only check leaves: after
        // a diagram-failed render the machine is in `fixing` while context may
        // still hold the pass — without can(), the machine would silently drop
        // BEGIN_RENDER while the tool reported success.
        const canRender = snap.can({
          type: "BEGIN_RENDER",
          path,
          hash,
          outPath,
        });
        if (violation || !canRender) {
          const reason =
            violation ??
            `not legal from state \`${stateValue()}\` — an action is in flight or the workflow is mid-fix`;
          log("WARN", `render rejected: ${reason}`);
          return {
            content: text(
              `Render rejected: ${reason}\n${statusLine(snap.context)}\n${allowedNext()}`,
            ),
            details: detailsFor("render", { rejected: reason }),
          };
        }

        const r = await runRender(path, hash, outPath, theme, onUpdate);
        if (r.ok) {
          // Output comes from the extension: open the rendered file in the
          // system viewer (browser/Preview/…) right away — no need to ask.
          // Interactive only: print/JSON/RPC sessions are background —
          // launching a viewer from them would be a surprise.
          let openedNote = "";
          if (
            outputMode !== "none" &&
            (execCtx as { mode?: string } | undefined)?.mode === "tui"
          ) {
            const opened = await openExternally(outPath);
            openedNote = opened.ok
              ? `\nOpened in system viewer: ${outPath}`
              : `\nOpen failed (${opened.error}) — open it manually: ${outPath}`;
            log(
              opened.ok ? "INFO" : "WARN",
              `open ${outPath}: ${opened.ok ? "ok" : opened.error}`,
            );
          }
          return {
            content: text(
              `Rendered: ${outPath}${openedNote}\n${statusLine(getActor().getSnapshot().context)}`,
            ),
            details: detailsFor("render", { file: basename(path) }),
          };
        }
        if (r.cause === "infra") {
          return {
            content: text(
              `Render failed (infra — the diagram is not at fault, the pass is kept): ${outPath}\n${r.error}\n\n${statusLine(getActor().getSnapshot().context)}\n` +
                "Check Docker, then retry mermaid_render — no re-validation needed.",
            ),
            details: detailsFor("render", {
              error: `infra: ${r.error.split("\n")[0]}`,
            }),
          };
        }
        return {
          content: text(
            `Render failed: ${outPath}\n${r.error}\n\n${statusLine(getActor().getSnapshot().context)}\n` +
              "Fix the diagram, mermaid_validate again, then retry the render.",
          ),
          details: detailsFor("render", {
            error: r.error.split("\n")[0] ?? "render failed",
          }),
        };
      });
    },

    renderCall(args) {
      return new Text(
        `mermaid_render ${args.path ?? ""} -> ${args.outPath ?? ""}`,
        0,
        0,
      );
    },

    renderResult(result) {
      const details = result.details as MermaidDetails | undefined;
      if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
      if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
      return new Text(
        `✓ rendered ${details?.file ?? ""} (${details?.state ?? ""})`.replace(
          "  ",
          " ",
        ),
        0,
        0,
      );
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
      path: Type.String({
        description: "Path to the validated .mmd diagram file",
      }),
      target: Type.String({ description: "Markdown file to embed into" }),
      after: Type.Optional(
        Type.String({
          description: "Insert after the last line containing this text",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      return withToolLock(async () => {
        const path = absPath(params.path);
        const target = absPath(params.target);

        let content: string;
        let hash: string;
        try {
          ({ content, hash } = await readSource(path));
        } catch (e) {
          return {
            content: text(
              `Cannot read diagram: ${path}\n${(e as Error).message}`,
            ),
            details: detailsFor("embed", {
              error: `unreadable source: ${(e as Error).message}`,
            }),
          };
        }

        const snap = getActor().getSnapshot();
        const violation = embedViolation(snap.context, path, hash, target);
        // can(): state-level legality — same rationale as mermaid_render.
        const canEmbed = snap.can({ type: "BEGIN_EMBED", path, hash, target });
        if (violation || !canEmbed) {
          const reason =
            violation ??
            `not legal from state \`${stateValue()}\` — an action is in flight or the workflow is mid-fix`;
          log("WARN", `embed rejected: ${reason}`);
          return {
            content: text(
              `Embed rejected: ${reason}\n${statusLine(snap.context)}\n${allowedNext()}`,
            ),
            details: detailsFor("embed", { rejected: reason }),
          };
        }

        try {
          await readFile(target, "utf8"); // target must exist and be readable
        } catch (e) {
          return {
            content: text(
              `Cannot read embed target: ${target}\n${(e as Error).message}\nCreate the file first.`,
            ),
            details: detailsFor("embed", {
              error: `unreadable target: ${(e as Error).message}`,
            }),
          };
        }

        getActor().send({ type: "BEGIN_EMBED", path, hash, target });
        log(
          "INFO",
          `embed: ${path} -> ${target}${params.after ? ` (after "${params.after}")` : ""}`,
        );

        try {
          const r = await embedBlock(target, path, content, params.after);
          getActor().send({
            type: "EMBED_DONE",
            ok: true,
            target,
            error: null,
          });
          log("INFO", `embed ok: ${target} (${r.action})`);
          return {
            content: text(
              `Embedded ${basename(path)} into ${target} (${r.action}${params.after ? ` after "${params.after}"` : ""}).\n${statusLine(getActor().getSnapshot().context)}`,
            ),
            details: detailsFor("embed", { file: basename(path) }),
          };
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          log("ERROR", `embed failed: ${msg.split("\n")[0]}`);
          getActor().send({
            type: "EMBED_DONE",
            ok: false,
            target,
            error: msg,
          });
          return {
            content: text(
              `Embed failed: ${target}\n${msg}\n\n${statusLine(getActor().getSnapshot().context)}`,
            ),
            details: detailsFor("embed", {
              error: msg.split("\n")[0] ?? "embed failed",
            }),
          };
        }
      });
    },

    renderCall(args) {
      return new Text(
        `mermaid_embed ${args.path ?? ""} -> ${args.target ?? ""}`,
        0,
        0,
      );
    },

    renderResult(result) {
      const details = result.details as MermaidDetails | undefined;
      if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
      if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
      return new Text(
        `✓ embedded ${details?.file ?? ""} (${details?.state ?? ""})`.replace(
          "  ",
          " ",
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "mermaid_reset",
    label: "Mermaid reset",
    description: "Clear the mermaid workflow state machine and start over.",
    parameters: Type.Object({}),

    async execute() {
      return withToolLock(async () => {
        const ctx = getActor().getSnapshot().context;
        const prior = `validated: ${ctx.validated ? basename(ctx.validated.path) : "none"}, failed validations ${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts}, renders ${ctx.renders.length}, embeds ${ctx.embeds.length}, machine state ${stateValue()}`;
        getActor().send({ type: "RESET" });
        log("INFO", `reset (was: ${prior})`);
        return {
          content: text(
            `Diagram state cleared (was: ${prior}).\n${statusLine(getActor().getSnapshot().context)}`,
          ),
          details: detailsFor("reset"),
        };
      });
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
      "Mermaid diagram workflow: status | reset | output (what the user sees on validation) | footer (live status line) | viz (live machine visualisation)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "footer") {
        statusEnabled = !statusEnabled;
        refreshStatus();
        ctx.ui.notify(`Footer status ${statusEnabled ? "on" : "off"}`, "info");
        return;
      }
      if (sub === "output") {
        // '/mermaid output <mode>' sets directly; no argument opens a
        // picker. The choice persists — the last selection is the default.
        const arg = args.trim().split(/\s+/).slice(1).join(" ").toLowerCase();
        let mode: OutputMode | undefined = OUTPUT_MODES.has(arg as OutputMode)
          ? (arg as OutputMode)
          : undefined;
        if (arg && arg !== "?" && !mode) {
          ctx.ui.notify(
            `Unknown output mode '${arg}'. Modes: ${[...OUTPUT_MODES.keys()].join(", ")}`,
            "error",
          );
          return;
        }
        if (!mode) {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              `Output mode: ${outputMode} — ${OUTPUT_MODES.get(outputMode)}. Modes: ${[...OUTPUT_MODES.keys()].join(", ")}`,
              "info",
            );
            return;
          }
          const pick = await ctx.ui.select(
            "Mermaid output on validation (persisted)",
            [...OUTPUT_MODES].map(([m, d]) => `${m} — ${d}`),
          );
          mode = pick?.split(" — ")[0] as OutputMode | undefined;
          if (!mode || !OUTPUT_MODES.has(mode)) return; // dismissed
        }
        setOutputMode(mode);
        ctx.ui.notify(
          `Output on validation: ${mode} — ${OUTPUT_MODES.get(mode)}`,
          "info",
        );
        // Selection previews the side effect on the last validated diagram
        // (machine-gated + lock-serialized like mermaid_render). Nothing to
        // demo without a validated source — the mode applies from the next
        // mermaid_validate on.
        const v = getActor().getSnapshot().context.validated;
        if (mode !== "none" && v) {
          await withToolLock(async () => {
            const note = await deliverOutput(mode, v.path, v.hash, null, ctx);
            log("INFO", `output demo (${mode})${note}`);
            if (/failed|skipped|unavailable/.test(note)) {
              ctx.ui.notify(`Output demo: ${note.trim()}`, "warning");
            }
          });
        }
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
          `Unknown subcommand '${sub}'. Use '/mermaid status', '/mermaid reset', '/mermaid output', '/mermaid footer', or '/mermaid viz'.`,
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
        lines.push(
          `Last errors:`,
          ...c.errors.slice(0, 10).map((e) => `- ${e.slice(0, 400)}`),
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
