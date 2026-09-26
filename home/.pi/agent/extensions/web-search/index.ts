/**
 * Web search extension — state-machine-enforced web search workflow.
 *
 * Docker-isolated search backend (Brave API + Readability extraction) is an
 * implementation detail: executors/ ships with this extension and is swapped
 * by replacing scripts with the same --json contract. The model may only perform legal
 * transitions, selected via tools:
 *
 *   web_search  — run a Brave search (budget: WEB_RESEARCH_MAX_SEARCHES)
 *   web_fetch   — extract markdown for links returned by web_search
 *                 (only known, unfetched links; budget: WEB_RESEARCH_MAX_FETCHES)
 *   web_report  — end research (requires >=1 successful search)
 *   web_reset   — clear research state and start over
 *
 * Deterministic aspects (budgets, dedupe, known-link rules, state order,
 * retry caps) live in the machine — enforced in code, not requested in a
 * prompt. Judgment (query formulation, which links to fetch, when results
 * are sufficient) stays with the model, constrained to legal events.
 *
 * Tool-result `details` carries the machine snapshot, so research state
 * follows the conversation branch (rewind/branch-safe).
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
	fetchViolation,
	initialContext,
	researchMachine,
	searchViolation,
	type FetchedContent,
	type Limits,
	type SearchParams,
	type SearchResult,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LIMITS: Limits = {
	maxSearches: Number(process.env.WEB_SEARCH_MAX_SEARCHES ?? 5),
	maxSearchAttempts: Number(process.env.WEB_SEARCH_MAX_SEARCH_ATTEMPTS ?? 8),
	maxFetches: Number(process.env.WEB_SEARCH_MAX_FETCHES ?? 10),
};
const CONTENT_TRUNCATE = Number(process.env.WEB_SEARCH_CONTENT_TRUNCATE ?? 5000);
const SCRIPT_TIMEOUT_MS = Number(process.env.WEB_SEARCH_SCRIPT_TIMEOUT_MS ?? 120_000);
const INSPECT_PORT = (() => {
	const n = Number(process.env.WEB_SEARCH_INSPECT_PORT ?? 8080);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8080;
})();

// Search backend is an implementation detail: Docker-wrapped executors that
// ship with this extension. Swap backend by changing these two scripts (same
// --json contract) — machine and tools untouched.
const EXEC_DIR = process.env.WEB_SEARCH_EXEC_DIR ?? join(homedir(), ".pi/agent/extensions/web-search/executors");
const SEARCH_SCRIPT = join(EXEC_DIR, "search.sh");
const CONTENT_SCRIPT = join(EXEC_DIR, "content.sh");

const LOG_DIR = process.env.WEB_SEARCH_LOG_DIR ?? join(homedir(), ".cache", "web-search");

/** Best-effort diagnostics log; never throws, never blocks a tool. */
function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(join(LOG_DIR, "web-search.log"), `${new Date().toISOString()} [${level}] ${msg}\n`);
	} catch {
		/* logging must not break tools */
	}
}

const TOOL_NAMES = new Set(["web_search", "web_fetch", "web_report", "web_reset"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PersistedSnapshot = { context?: ReturnType<typeof initialContext>; value?: unknown; status?: unknown };

type WebDetails = {
	action: "search" | "fetch" | "report" | "reset";
	state: string;
	rejected?: string;
	error?: string;
	snapshot: unknown;
};
// ---------------------------------------------------------------------------
// Actor management (reconstructed from branch, like todo.ts)
// ---------------------------------------------------------------------------

let actor: Actor<typeof researchMachine> | null = null;
let unsubscribeActor: { unsubscribe: () => void } | null = null;
let uiCtx: { ui: { setStatus: (k: string, t: string | undefined) => void; theme?: { fg: (c: string, s: string) => string } } } | null = null;
/** Footer status is opt-in: toggle with '/websearch footer'. */
let statusEnabled = false;

// ---------------------------------------------------------------------------
// Inspector (opt-in live visualisation: /websearch viz or WEB_SEARCH_INSPECT=1)
// Transport lives in ../_viz/viz-kit.ts: `::` port pre-check (a listen failure
// inside createInspectorServer surfaces as an unhandled 'error' event and
// kills the pi process), clean-stop WS adapter (the stock createWebSocket
// inspector retries forever, leaking timers past shutdown), and port
// auto-allocation (tmux viz defaults to 8080 too).
// ---------------------------------------------------------------------------

const viz = makeViz({ name: "web-search", preferredPort: INSPECT_PORT });

/**
 * Attach mid-session: XState `inspect` is a creation-time option, so attach =
 * re-create the actor from its persisted snapshot with inspect wired. State is
 * pure data — budgets, results, fetched links carry over exactly.
 */
async function attachInspector(): Promise<VizResult> {
	const r = await viz.enable({ open: true });
	if (r.ok) createResearchActor({ snapshot: getActor().getPersistedSnapshot() });
	return r;
}

/** Compact live status for the TUI footer. */
function statusText(c: ReturnType<typeof initialContext>): string {
	return `web-search ${stateValue()} · searches ${c.searchCount}/${c.limits.maxSearches} · fetches ${c.fetchCount}/${c.limits.maxFetches} · ${c.results.length} results`;
}

function refreshStatus() {
	if (!uiCtx?.ui?.setStatus) return;
	if (!statusEnabled) {
		uiCtx.ui.setStatus("web-search", undefined);
		return;
	}
	// getActor() lazily creates the actor so the footer works before any tool call
	const a = getActor();
	const theme = uiCtx.ui.theme;
	const text = statusText(a.getSnapshot().context);
	uiCtx.ui.setStatus("web-search", theme ? theme.fg("dim", text) : text);
}

/** Set the active actor, wiring the live-status subscription. */
function setActor(a: Actor<typeof researchMachine>) {
	unsubscribeActor?.unsubscribe();
	unsubscribeActor = a.subscribe(() => refreshStatus());
	actor = a;
	refreshStatus();
}

/**
 * Single actor-creation site — fresh input or persisted-snapshot restore —
 * with the opt-in inspector wired when running. The `as never` cast for the
 * persisted snapshot is centralised here.
 */
function createResearchActor(
	opts: { input: { limits: Limits } } | { snapshot: unknown },
): Actor<typeof researchMachine> {
	const a = createActor(researchMachine, {
		...(opts as { input?: { limits: Limits }; snapshot?: unknown }),
		snapshot: "snapshot" in opts ? (opts.snapshot as never) : undefined,
		...viz.option(),
	} as never) as Actor<typeof researchMachine>;
	a.start();
	setActor(a);
	return a;
}

function freshActor(): Actor<typeof researchMachine> {
	return createResearchActor({ input: { limits: LIMITS } });
}

function getActor(): Actor<typeof researchMachine> {
	if (!actor) freshActor();
	return actor!;
}

/** Restore research state from the last web-research tool result on this branch. */
function reconstructState(ctx: { sessionManager: { getBranch: () => Array<any> } }) {
	for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
		const entry = ctx.sessionManager.getBranch()[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || !TOOL_NAMES.has(msg.toolName)) continue;
		const details = msg.details as WebDetails | undefined;
		const snap = details?.snapshot as PersistedSnapshot | undefined;
		if (snap?.context) {
			// Restore from persisted snapshot (branch-correct)
			createResearchActor({ snapshot: details!.snapshot });
			return;
		}
	}
	actor = null;
	unsubscribeActor?.unsubscribe();
	unsubscribeActor = null;
}

// ---------------------------------------------------------------------------
// IO executors (Docker; API key stays inside pass/Docker, never in this process)
// ---------------------------------------------------------------------------

function run(script: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"bash",
			[script, ...args],
			{ timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) reject(new Error(`${err.message}${stderr ? `\n${stderr.trim()}` : ""}`));
				else resolve(stdout);
			},
		);
	});
}

async function fetchPage(url: string): Promise<string> {
	// content.sh --json: {link,title,markdown} or {link,error} (exit 0)
	const out = await run(CONTENT_SCRIPT, [url, "--json"]);
	let parsed: { markdown?: string; error?: string };
	try {
		parsed = JSON.parse(out) as typeof parsed;
	} catch {
		throw new Error(`unparseable content output: ${out.slice(0, 200)}`);
	}
	if (parsed.error || !parsed.markdown) {
		throw new Error(parsed.error ?? "no content extracted");
	}
	return parsed.markdown;
}

// ---------------------------------------------------------------------------
// Formatting (model-facing content)
// ---------------------------------------------------------------------------

function formatResults(results: SearchResult[]): string {
	const lines: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`--- Result ${i + 1} ---`);
		lines.push(`Title: ${r.title}`);
		lines.push(`Link: ${r.link}`);
		if (r.age) lines.push(`Age: ${r.age}`);
		lines.push(`Snippet: ${r.snippet}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

function budgetLine(ctx: ReturnType<typeof initialContext>): string {
	return `Budget: searches ${ctx.searchCount}/${ctx.limits.maxSearches}, failed attempts ${ctx.searchAttempts}/${ctx.limits.maxSearchAttempts}, fetches ${ctx.fetchCount}/${ctx.limits.maxFetches}. Machine state: ${stateValue()}.`;
}

function stateValue(): string {
	const snap = getActor().getSnapshot() as unknown as PersistedSnapshot;
	return String(snap.value ?? snap.status);
}

/**
 * Persisted snapshot for tool-result details, slimmed: fetched markdown bodies
 * are stripped (transcript already holds the content; machine logic only needs
 * the link keys). Keeps session files small.
 */
function slimSnapshot(snapshot: unknown): unknown {
	const slim = JSON.parse(JSON.stringify(snapshot)) as PersistedSnapshot;
	for (const f of slim?.context?.fetched ?? []) f.markdown = "";
	return slim;
}

function detailsFor(action: WebDetails["action"], extra: Partial<WebDetails> = {}): WebDetails {
	return {
		action,
		state: stateValue(),
		snapshot: slimSnapshot(getActor().getPersistedSnapshot()),
		...extra,
	};
}

const text = (t: string) => [{ type: "text" as const, text: t }];

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const SUBCOMMANDS: { value: string; description: string }[] = [
	{ value: "status", description: "show research state and budgets" },
	{ value: "reset", description: "clear research state" },
	{ value: "footer", description: "toggle live footer status line" },
	{ value: "viz", description: "attach the Stately inspector (live visualisation)" },
];

/** Tab completion for '/websearch <subcommand>' (delegates to current provider otherwise). */
function createWebsearchAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol);
			const m = /^\/websearch ?([a-z]*)$/.exec(before);
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
		// WEB_SEARCH_INSPECT=1: start inspector infra BEFORE any actor exists, so
		// fresh/restored actors get inspect wired at creation. Never call
		// attachInspector() here — it would recurse through getActor() when no
		// actor exists yet.
		if (process.env.WEB_SEARCH_INSPECT) {
			const r = await viz.enable({ open: true });
			if (!r.ok) log("ERROR", `inspector not started: ${r.message}`);
		}
		reconstructState(ctx);
		if (ctx.mode === "tui" && typeof (ctx.ui as never as { addAutocompleteProvider?: unknown }).addAutocompleteProvider === "function") {
			ctx.ui.addAutocompleteProvider((current) => createWebsearchAutocomplete(current));
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		uiCtx = ctx as never;
		reconstructState(ctx);
	});
	pi.on("session_shutdown", async () => {
		// Idempotent teardown: WS client + relay server (clean-stop adapter —
		// the stock one retries forever, leaking timers past shutdown).
		viz.stop();
	});

	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Run a Brave web search as part of a research workflow. Results are tracked by a state machine: " +
			`budgets are enforced (${LIMITS.maxSearches} searches, ${LIMITS.maxFetches} page fetches per research run). ` +
			"After searching, use web_fetch on interesting links, then web_report when done. " +
			"Options: num (1-20, default 5), country (2-letter code), freshness (pd|pw|pm|py or YYYY-MM-DDtoYYYY-MM-DD).",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			num: Type.Optional(Type.Number({ description: "Number of results (default 5, max 20)" })),
			country: Type.Optional(Type.String({ description: "Two-letter country code (default US)" })),
			freshness: Type.Optional(
				Type.String({ description: "pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD" }),
			),
		}),

		async execute(_toolCallId, params) {
			const snap = getActor().getSnapshot();

			const violation = searchViolation(snap.context);
			if (violation) {
				log("WARN", `search rejected: ${violation}`);
				return {
					content: text(
						`Search rejected: ${violation}\n${budgetLine(snap.context)}\n` +
							"Allowed next steps: web_report (if you have results) or web_reset.",
					),
					details: detailsFor("search", { rejected: violation }),
				};
			}

			const searchParams: SearchParams = {
				num: Math.min(Math.max(Math.trunc(params.num ?? 5), 1), 20),
				country: (params.country ?? "US").toUpperCase(),
				freshness: params.freshness ?? null,
			};
			log(
				"INFO",
				`search request: ${JSON.stringify({ query: params.query, ...searchParams })}`,
			);

			const args = [params.query, "-n", String(searchParams.num), "--json"];
			if (params.country) args.push("--country", searchParams.country);
			if (searchParams.freshness) args.push("--freshness", searchParams.freshness);

			getActor().send({ type: "BEGIN_SEARCH", query: params.query, params: searchParams });

			try {
				const out = await run(SEARCH_SCRIPT, args);
				let results: SearchResult[];
				try {
					results = JSON.parse(out) as SearchResult[];
				} catch {
					throw new Error(`unparseable search output: ${out.slice(0, 200)}`);
				}
				log("INFO", `search ok: ${results.length} result(s)`);
				if (results.length === 0) {
					getActor().send({
						type: "SEARCH_DONE",
						query: params.query,
						params: searchParams,
						results: [],
						error: "no results",
					});
					return {
						content: text(
							`No results found for: ${params.query}\n${budgetLine(getActor().getSnapshot().context)}\n` +
								"Refine the query (different terms, site: operator, or drop restrictive freshness filter).",
						),
						details: detailsFor("search", { error: "no results" }),
					};
				}
				getActor().send({
					type: "SEARCH_DONE",
					query: params.query,
					params: searchParams,
					results,
					error: null,
				});
				return {
					content: text(
						`${formatResults(results)}\n\n${budgetLine(getActor().getSnapshot().context)}\n` +
							"Use web_fetch on links worth reading in full, or web_report to finish.",
					),
					details: detailsFor("search"),
				};
			} catch (e) {
				log("ERROR", `search failed: ${(e as Error).message?.split("\n")[0]}`);
				getActor().send({
					type: "SEARCH_DONE",
					query: params.query,
					params: searchParams,
					results: [],
					error: String((e as Error).message ?? e),
				});
				throw new Error(`Brave search failed: ${(e as Error).message}`);
			}
		},

		renderCall(args) {
			return new Text(`web_search "${args.query}"`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as WebDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
			return new Text(`✓ searched (${details?.state ?? ""})`, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Extract readable page content as markdown for links returned by web_search. " +
			"Only known, not-yet-fetched links are allowed; duplicates and unknown URLs are rejected. " +
			"Budget enforced by the state machine.",
		parameters: Type.Object({
			links: Type.Array(Type.String(), { description: "Links previously returned by web_search" }),
		}),

		async execute(_toolCallId, params) {
			const snap = getActor().getSnapshot();
			const links = params.links;

			const violation = fetchViolation(snap.context, links);
			if (violation) {
				log("WARN", `fetch rejected: ${violation}`);
				return {
					content: text(
						`Fetch rejected: ${violation}\n${budgetLine(snap.context)}\n` +
							"Allowed next steps: web_fetch (other known links), web_search (more results), or web_report.",
					),
					details: detailsFor("fetch", { rejected: violation }),
				};
			}

			getActor().send({ type: "BEGIN_FETCH", links });

			log("INFO", `fetch request: ${links.length} link(s)`);

			const contents: FetchedContent[] = [];
			const failed: { link: string; error: string }[] = [];
			for (const link of links) {
				try {
					const markdown = (await fetchPage(link)).slice(0, CONTENT_TRUNCATE);
					contents.push({ link, markdown });
					log("INFO", `fetch ok: ${link} (${markdown.length} chars)`);
				} catch (e) {
					failed.push({ link, error: (e as Error).message });
					log("WARN", `fetch failed: ${link}: ${(e as Error).message?.split("\n")[0]}`);
				}
			}

			getActor().send({ type: "FETCH_DONE", contents, failed });

			if (contents.length === 0) {
				throw new Error(`All fetches failed: ${failed.map((f) => `${f.link} (${f.error})`).join("; ")}`);
			}

			const parts: string[] = [];
			for (const c of contents) {
				parts.push(`=== ${c.link} ===\n${c.markdown}`);
			}
			for (const f of failed) {
				parts.push(`=== ${f.link} ===\n(fetch failed: ${f.error})`);
			}
			parts.push(budgetLine(getActor().getSnapshot().context));
			parts.push("Use web_report when you have enough material.");
			return { content: text(parts.join("\n\n")), details: detailsFor("fetch") };
		},

		renderCall(args) {
			return new Text(`web_fetch ${Array.isArray(args.links) ? args.links.length : 0} link(s)`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as WebDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text(`✓ fetched (${details?.state ?? ""})`, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_report",
		label: "Web report",
		description:
			"End the research workflow and report what was gathered (requires at least one successful web_search). " +
			"After reporting, further searches are rejected until web_reset. " +
			"Synthesize your answer from the search results and fetched content already in the conversation.",
		parameters: Type.Object({}),

		async execute() {
			const snap = getActor().getSnapshot();
			if (!snap.can({ type: "SATISFIED" })) {
				log("WARN", "report rejected: no successful searches");
				return {
					content: text(
						"Report rejected: no successful searches yet — run web_search first.\n" +
							budgetLine(snap.context),
					),
					details: detailsFor("report", { rejected: "no successful searches" }),
				};
			}

			getActor().send({ type: "SATISFIED" });
			log(
				"INFO",
				`report: ${getActor().getSnapshot().context.queries.length} query(ies), ${getActor().getSnapshot().context.results.length} result(s), ${getActor().getSnapshot().context.fetchCount} fetched`,
			);
			const ctx = getActor().getSnapshot().context;

			const lines = ["Research complete. Synthesize your answer from the material above.", ""];
			lines.push("Queries:");
			for (const q of ctx.queries) {
				lines.push(`- "${q.query}" (${q.resultCount} result(s))`);
			}
			lines.push("", `Results collected: ${ctx.results.length}`);
			lines.push("Pages fetched:");
			for (const f of ctx.fetched) {
				const r = ctx.results.find((r) => r.link === f.link);
				lines.push(`- ${r?.title ?? f.link} — ${f.link}`);
			}
			if (ctx.errors.length > 0) {
				lines.push("", "Errors encountered:");
				for (const e of ctx.errors) lines.push(`- ${e}`);
			}
			lines.push("", `Machine state: ${stateValue()}. Further searches require web_reset.`);
			return { content: text(lines.join("\n")), details: detailsFor("report") };
		},

		renderCall() {
			return new Text("web_report", 0, 0);
		},

		renderResult(result) {
			const details = result.details as WebDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text("✓ research done", 0, 0);
		},
	});

	pi.registerTool({
		name: "web_reset",
		label: "Web research reset",
		description: "Clear the web research state machine and start a fresh research run.",
		parameters: Type.Object({}),

		async execute() {
			const ctx = getActor().getSnapshot().context;
			const prior = `Queries: ${ctx.searchCount} searches, ${ctx.fetchCount} fetches, ${ctx.results.length} results, machine state ${stateValue()}`;
			getActor().send({ type: "RESET" });
			return {
				content: text(`Research state cleared (was: ${prior}).\n${budgetLine(getActor().getSnapshot().context)}`),
				details: detailsFor("reset"),
			};
		},

		renderCall() {
			return new Text("web_reset", 0, 0);
		},

		renderResult() {
			return new Text("✓ reset", 0, 0);
		},
	});

	pi.registerCommand("websearch", {
		description:
			"Web search state machine: '/websearch status' shows state, '/websearch reset' clears it, '/websearch footer' toggles the live footer line (off by default), '/websearch viz' live-visualises the machine",
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
				ctx.ui.notify("Web research state reset", "info");
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
					`Unknown subcommand '${sub}'. Use '/websearch status', '/websearch reset', '/websearch footer', or '/websearch viz'.`,
					"error",
				);
				return;
			}
			const snap = getActor().getSnapshot();
			const c = snap.context;
			const lines = [
				`State: ${stateValue()}`,
				budgetLine(c),
				`Queries: ${c.queries.length ? c.queries.map((q) => `"${q.query}"`).join(", ") : "(none)"}`,
				`Results: ${c.results.length} | Fetched: ${c.fetchCount} | Errors: ${c.errors.length}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
