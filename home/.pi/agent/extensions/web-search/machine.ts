/**
 * Web research state machine.
 *
 * Deterministic control flow for web search + content extraction:
 * - machine owns legality (budgets, dedupe, known-link rules, state order)
 * - executors (Docker-wrapped Brave scripts) do IO
 * - the model may only send legal events via tools; illegal events are rejected
 *
 * Event flow (tool-driven, two-phase per action):
 *   BEGIN_SEARCH -> (IO) -> SEARCH_DONE  { results | error }
 *   BEGIN_FETCH  -> (IO) -> FETCH_DONE   { contents, failed }
 *   SATISFIED (guard: >=1 successful search) -> done
 *   RESET -> idle (context cleared)
 */
import { assign, setup } from "xstate";

export type SearchParams = {
	num: number;
	country: string;
	freshness: string | null;
};

export type SearchResult = {
	title: string;
	link: string;
	snippet: string;
	age: string;
};

export type FetchedContent = {
	link: string;
	markdown: string;
};

export type ResearchQuery = {
	query: string;
	params: SearchParams;
	resultCount: number;
};

export type Limits = {
	maxSearches: number;
	maxSearchAttempts: number;
	maxFetches: number;
};

export type ResearchContext = {
	queries: ResearchQuery[];
	results: SearchResult[];
	fetched: FetchedContent[];
	searchCount: number;
	searchAttempts: number;
	fetchCount: number;
	errors: string[];
	limits: Limits;
};

export type ResearchEvent =
	| { type: "BEGIN_SEARCH"; query: string; params: SearchParams }
	| {
			type: "SEARCH_DONE";
			query: string;
			params: SearchParams;
			results: SearchResult[];
			error: string | null;
	  }
	| { type: "BEGIN_FETCH"; links: string[] }
	| {
			type: "FETCH_DONE";
			contents: FetchedContent[];
			failed: { link: string; error: string }[];
	  }
	| { type: "SATISFIED" }
	| { type: "RESET" };

export function initialContext(limits: Limits): ResearchContext {
	return {
		queries: [],
		results: [],
		fetched: [],
		searchCount: 0,
		searchAttempts: 0,
		fetchCount: 0,
		errors: [],
		limits,
	};
}

/**
 * Shared pure validators. Guards use them; tools call them directly to
 * produce human/model-readable rejection reasons. Single source of truth.
 */
export function searchViolation(ctx: ResearchContext): string | null {
	if (ctx.searchCount >= ctx.limits.maxSearches) {
		return `search budget exhausted (${ctx.searchCount}/${ctx.limits.maxSearches} searches used)`;
	}
	if (ctx.searchAttempts >= ctx.limits.maxSearchAttempts) {
		return `too many failed search attempts (${ctx.searchAttempts}/${ctx.limits.maxSearchAttempts})`;
	}
	return null;
}

export function fetchViolation(ctx: ResearchContext, links: string[]): string | null {
	if (links.length === 0) return "no links provided";
	if (new Set(links).size !== links.length) return "duplicate links in request";
	if (ctx.fetchCount + links.length > ctx.limits.maxFetches) {
		return `fetch budget exceeded (${ctx.fetchCount}/${ctx.limits.maxFetches} fetched, ${links.length} requested)`;
	}
	const known = new Set(ctx.results.map((r) => r.link));
	const unknown = links.filter((l) => !known.has(l));
	if (unknown.length > 0) {
		return `unknown link(s) - only links returned by web_search can be fetched: ${unknown.join(", ")}`;
	}
	const alreadyFetched = new Set(ctx.fetched.map((f) => f.link));
	const dup = links.filter((l) => alreadyFetched.has(l));
	if (dup.length > 0) {
		return `already fetched (use web_report to finish, or web_reset to start over): ${dup.join(", ")}`;
	}
	return null;
}

export const researchMachine = setup({
	types: {
		context: {} as ResearchContext,
		events: {} as ResearchEvent,
		input: {} as { limits: Limits } | undefined,
	},
	guards: {
		searchLegal: ({ context }) => searchViolation(context) === null,
		fetchLegal: ({ context, event }) =>
			event.type === "BEGIN_FETCH" && fetchViolation(context, event.links) === null,
		hasResearch: ({ context }) => context.searchCount > 0,
	},
	actions: {
		applySearchDone: assign(({ context, event }) => {
			if (event.type !== "SEARCH_DONE") return {};
			if (event.error) {
				return {
					searchAttempts: context.searchAttempts + 1,
					errors: [...context.errors, `search "${event.query}" failed: ${event.error}`],
				};
			}
			// Merge results, deduped by link
			const merged = new Map(context.results.map((r) => [r.link, r]));
			for (const r of event.results) {
				if (!merged.has(r.link)) merged.set(r.link, r);
			}
			return {
				queries: [
					...context.queries,
					{ query: event.query, params: event.params, resultCount: event.results.length },
				],
				results: [...merged.values()],
				searchCount: context.searchCount + 1,
			};
		}),
		applyFetchDone: assign(({ context, event }) => {
			if (event.type !== "FETCH_DONE") return {};
			return {
				fetched: [...context.fetched, ...event.contents],
				fetchCount: context.fetchCount + event.contents.length,
				errors: [...context.errors, ...event.failed.map((f) => `fetch ${f.link}: ${f.error}`)],
			};
		}),
		resetContext: assign(({ context }) => initialContext(context.limits)),
	},
}).createMachine({
	id: "webResearch",
	context: ({ input }) => initialContext(input?.limits ?? { maxSearches: 5, maxSearchAttempts: 8, maxFetches: 10 }),
	initial: "idle",
	states: {
		idle: {
			on: {
				BEGIN_SEARCH: { guard: "searchLegal", target: "researching" },
			},
		},
		researching: {
			on: {
				BEGIN_SEARCH: { guard: "searchLegal", target: "researching" },
				BEGIN_FETCH: { guard: "fetchLegal", target: "researching" },
				SEARCH_DONE: { actions: "applySearchDone" },
				FETCH_DONE: { actions: "applyFetchDone" },
				SATISFIED: { guard: "hasResearch", target: "done" },
				RESET: { target: "idle", actions: "resetContext" },
			},
		},
		done: {
			on: {
				RESET: { target: "idle", actions: "resetContext" },
			},
		},
	},
});
