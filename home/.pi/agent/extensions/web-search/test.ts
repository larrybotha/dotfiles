/**
 * Machine tests — run without an LLM:
 *   node test.ts
 */
import assert from "node:assert/strict";
import { createActor, type Actor } from "xstate";
import {
	fetchViolation,
	initialContext,
	researchMachine,
	searchViolation,
	type Limits,
	type SearchResult,
} from "./machine.ts";

const LIMITS: Limits = { maxSearches: 2, maxSearchAttempts: 3, maxFetches: 2 };

function makeActor(): Actor<typeof researchMachine> {
	const a = createActor(researchMachine, { input: { limits: LIMITS } });
	a.start();
	return a;
}

const searchEvt = (link: string) => ({
	type: "BEGIN_SEARCH" as const,
	query: "test",
	params: { num: 5, country: "US", freshness: null },
});

function doSearch(a: Actor<typeof researchMachine>, links: string[], error: string | null = null) {
	a.send({ type: "BEGIN_SEARCH", query: "test", params: { num: 5, country: "US", freshness: null } });
	const results: SearchResult[] = links.map((link) => ({ title: "t", link, snippet: "s", age: "" }));
	a.send({ type: "SEARCH_DONE", query: "test", params: { num: 5, country: "US", freshness: null }, results, error });
}

let passed = 0;
function ok(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`✓ ${name}`);
}

// --- idle state -------------------------------------------------------------
ok("idle: BEGIN_SEARCH allowed, BEGIN_FETCH and SATISFIED rejected", () => {
	const a = makeActor();
	assert.equal(a.getSnapshot().can(searchEvt("x")), true);
	assert.equal(a.getSnapshot().can({ type: "BEGIN_FETCH", links: ["https://x.com"] }), false);
	assert.equal(a.getSnapshot().can({ type: "SATISFIED" }), false);
});

// --- after a successful search ---------------------------------------------
ok("researching: SATISFIED and BEGIN_FETCH(known link) allowed", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com"]);
	assert.equal(a.getSnapshot().can({ type: "SATISFIED" }), true);
	assert.equal(a.getSnapshot().can({ type: "BEGIN_FETCH", links: ["https://a.com"] }), true);
});

ok("BEGIN_FETCH: unknown link rejected", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com"]);
	assert.equal(a.getSnapshot().can({ type: "BEGIN_FETCH", links: ["https://b.com"] }), false);
	assert.match(fetchViolation(a.getSnapshot().context, ["https://b.com"]) ?? "", /unknown link/);
});

ok("BEGIN_FETCH: duplicate fetch rejected after FETCH_DONE", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com", "https://b.com"]);
	a.send({ type: "BEGIN_FETCH", links: ["https://a.com"] });
	a.send({ type: "FETCH_DONE", contents: [{ link: "https://a.com", markdown: "md" }], failed: [] });
	assert.equal(a.getSnapshot().can({ type: "BEGIN_FETCH", links: ["https://a.com"] }), false);
	assert.match(fetchViolation(a.getSnapshot().context, ["https://a.com"]) ?? "", /already fetched/);
});

ok("BEGIN_FETCH: fetch budget (capacity) enforced", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com", "https://b.com", "https://c.com"]);
	a.send({ type: "BEGIN_FETCH", links: ["https://a.com"] });
	a.send({ type: "FETCH_DONE", contents: [{ link: "https://a.com", markdown: "md" }], failed: [] });
	// 1 fetched, requesting 2 more -> exceeds maxFetches=2
	assert.equal(a.getSnapshot().can({ type: "BEGIN_FETCH", links: ["https://b.com", "https://c.com"] }), false);
	assert.equal(a.getSnapshot().can({ type: "BEGIN_FETCH", links: ["https://b.com"] }), true);
});

ok("results deduped by link across queries", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com", "https://b.com"]);
	doSearch(a, ["https://b.com", "https://c.com"]);
	assert.equal(a.getSnapshot().context.results.length, 3);
	assert.equal(a.getSnapshot().context.searchCount, 2);
	assert.equal(a.getSnapshot().context.queries.length, 2);
});

// --- budgets ------------------------------------------------------------------
ok("search budget exhaustion rejects BEGIN_SEARCH", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com"]);
	doSearch(a, ["https://b.com"]);
	assert.equal(a.getSnapshot().can(searchEvt("x")), false);
	assert.match(searchViolation(a.getSnapshot().context) ?? "", /budget exhausted/);
});

ok("failed attempts capped separately from successes", () => {
	const a = makeActor();
	for (let i = 0; i < LIMITS.maxSearchAttempts; i++) {
		assert.equal(a.getSnapshot().can(searchEvt("x")), true, `attempt ${i} should be allowed`);
		doSearch(a, [], "boom");
	}
	assert.equal(a.getSnapshot().can(searchEvt("x")), false);
	assert.match(searchViolation(a.getSnapshot().context) ?? "", /failed search attempts/);
});

// --- completion and reset ------------------------------------------------------
ok("SATISFIED -> done: further searches rejected; RESET -> idle with cleared context", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com"]);
	a.send({ type: "SATISFIED" });
	assert.equal(a.getSnapshot().value, "done");
	assert.equal(a.getSnapshot().can(searchEvt("x")), false);
	assert.equal(a.getSnapshot().can({ type: "SATISFIED" }), false);

	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().value, "idle");
	const c = a.getSnapshot().context;
	assert.equal(c.searchCount, 0);
	assert.equal(c.results.length, 0);
	assert.equal(c.fetched.length, 0);
	assert.deepEqual(c.limits, LIMITS);
	assert.equal(a.getSnapshot().can(searchEvt("x")), true);
});

ok("SATISFIED rejected with zero successful searches", () => {
	const a = makeActor();
	doSearch(a, [], "no results");
	assert.equal(a.getSnapshot().can({ type: "SATISFIED" }), false);
});

// --- snapshot restore ---------------------------------------------------------
ok("persisted snapshot restores context and legality", () => {
	const a = makeActor();
	doSearch(a, ["https://a.com"]);
	a.send({ type: "BEGIN_FETCH", links: ["https://a.com"] });
	a.send({ type: "FETCH_DONE", contents: [{ link: "https://a.com", markdown: "md" }], failed: [] });
	const persisted = a.getPersistedSnapshot();

	const b = createActor(researchMachine, { input: { limits: LIMITS }, snapshot: persisted as never });
	b.start();
	assert.equal(b.getSnapshot().value, "researching");
	assert.equal(b.getSnapshot().context.searchCount, 1);
	assert.equal(b.getSnapshot().context.fetchCount, 1);
	assert.equal(b.getSnapshot().can({ type: "BEGIN_FETCH", links: ["https://a.com"] }), false);
	assert.equal(b.getSnapshot().can({ type: "BEGIN_FETCH", links: [] }), false); // empty links
	assert.equal(b.getSnapshot().can(searchEvt("x")), true);
});

console.log(`\n${passed} tests passed`);
