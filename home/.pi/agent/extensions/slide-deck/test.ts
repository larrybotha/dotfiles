/**
 * Machine tests — run without an LLM, Docker, or a browser:
 *   node test.ts
 *
 * Service slots are provided with stubs (machine.provide) — no executor
 * runs. Controlled stubs capture inputs and decide outcomes, so failure
 * routing (deck vs infra), the fix loop, and RESET-wins semantics are
 * testable deterministically.
 */
import assert from "node:assert/strict";
import { createActor, type Actor, fromPromise, waitFor } from "xstate";
import {
	buildViolation,
	type BuildServiceInput,
	type BuildServiceOutput,
	countSlides,
	extractNavTargets,
	extractSlideIds,
	initialContext,
	navSlideViolation,
	planViolation,
	researchViolation,
	type SlideDeckContext,
	slideDeckMachine,
	startViolation,
	type ValidateServiceInput,
	type ValidateServiceOutput,
} from "./machine.ts";

const LIMITS = { maxValidateAttempts: 3 };

// ---------------------------------------------------------------------------
// Stub services (controllable: inputs recorded, outcomes scripted)
// ---------------------------------------------------------------------------

type Stubs = {
	buildInputs: BuildServiceInput[];
	validateInputs: ValidateServiceInput[];
	buildNext: (input: BuildServiceInput) => Promise<BuildServiceOutput>;
	validateNext: (input: ValidateServiceInput) => Promise<ValidateServiceOutput>;
};

function makeStubs(
	over: Partial<{
		build: Stubs["buildNext"];
		validate: Stubs["validateNext"];
	}> = {},
): Stubs {
	const stubs: Stubs = {
		buildInputs: [],
		validateInputs: [],
		buildNext: over.build ?? (async () => ({ outPath: OUT, slideCount: 1, bytes: 1 })),
		validateNext:
			over.validate ??
			(async () => ({ slideCount: 1, message: "All checks passed (1 slides)" })),
	};
	return stubs;
}

function makeMachine(stubs: Stubs) {
	return slideDeckMachine.provide({
		actors: {
			buildService: fromPromise<BuildServiceOutput, BuildServiceInput>(
				async ({ input }) => {
					stubs.buildInputs.push(input);
					return stubs.buildNext(input);
				},
			),
			validateService: fromPromise<ValidateServiceOutput, ValidateServiceInput>(
				async ({ input }) => {
					stubs.validateInputs.push(input);
					return stubs.validateNext(input);
				},
			),
		},
	});
}

type Machine = ReturnType<typeof makeMachine>;

function makeActor(stubs: Stubs): Actor<Machine> {
	const a = createActor(makeMachine(stubs), { input: { limits: LIMITS } });
	a.start();
	return a;
}

const OUT = "/tmp/decks/test.html";
const OUT2 = "/tmp/decks/other.html";

const CONTENT = {
	title: "Test Deck",
	subtitle: "a subtitle",
	navHtml: '<a class="nav-item" data-slide="a">A</a>',
	slidesHtml: '<div class="slide" id="slide-a"><p>x</p></div>',
	outPath: OUT,
};

const beginBuild = (over: Partial<typeof CONTENT> = {}) => ({
	type: "BEGIN_BUILD" as const,
	...CONTENT,
	...over,
});

/** Drive one full happy-path pipeline; returns the actor after `done`. */
async function buildOnce(stubs: Stubs, over: Partial<typeof CONTENT> = {}) {
	const a = makeActor(stubs);
	a.send(beginBuild(over));
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	return a;
}

let passed = 0;
let failed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		passed++;
		console.log(`✓ ${name}`);
	} catch (e) {
		failed++;
		console.error(`✗ ${name}\n${e instanceof Error ? e.stack : String(e)}`);
	}
}

// --- initial state -----------------------------------------------------------

await ok("authoring initial (phase null); phases and fast-path build are legal events", () => {
	const a = makeActor(makeStubs());
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, null);
	assert.equal(a.getSnapshot().can({ type: "START", topic: "x" }), true);
	// fresh (phase null ≡ old idle): ceremony events beyond START not yet legal
	assert.equal(a.getSnapshot().can({ type: "RESEARCH_DONE", sources: ["s"] }), false);
	assert.equal(a.getSnapshot().can({ type: "PLAN_DONE", slides: ["a"] }), false);
	assert.equal(a.getSnapshot().can(beginBuild()), true);
});

// --- authoring phases --------------------------------------------------------

await ok("START -> authoring/phase researching (topic recorded); empty topic rejected", () => {
	const a = makeActor(makeStubs());
	assert.notEqual(startViolation(""), null);
	a.send({ type: "START", topic: "Telescopes" });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "researching");
	assert.equal(a.getSnapshot().context.topic, "Telescopes");
	assert.equal(a.getSnapshot().can({ type: "START", topic: "again" }), false);
	// phase researching ≡ old researching state: PLAN_DONE not yet legal
	assert.equal(a.getSnapshot().can({ type: "PLAN_DONE", slides: ["a"] }), false);
});

await ok("RESEARCH_DONE -> authoring/phase planning; empty sources rejected", () => {
	const a = makeActor(makeStubs());
	a.send({ type: "START", topic: "t" });
	assert.notEqual(researchViolation([]), null);
	assert.equal(a.getSnapshot().can({ type: "RESEARCH_DONE", sources: [] }), false);
	a.send({ type: "RESEARCH_DONE", sources: ["https://a", "file.md"] });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "planning");
	assert.deepEqual(a.getSnapshot().context.sources, ["https://a", "file.md"]);
	// phase planning ≡ old planning state: re-announcing research done is illegal
	assert.equal(a.getSnapshot().can({ type: "RESEARCH_DONE", sources: ["x"] }), false);
});

await ok("PLAN_DONE -> authoring/phase writing; empty/duplicate slides rejected", () => {
	const a = makeActor(makeStubs());
	a.send({ type: "START", topic: "t" });
	a.send({ type: "RESEARCH_DONE", sources: ["s"] });
	assert.notEqual(planViolation([]), null);
	assert.notEqual(planViolation(["a", "a"]), null);
	assert.equal(a.getSnapshot().can({ type: "PLAN_DONE", slides: [] }), false);
	a.send({ type: "PLAN_DONE", slides: ["intro", "history"] });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "writing");
	assert.deepEqual(a.getSnapshot().context.plannedSlides, ["intro", "history"]);
});

// --- pipeline (invoke) ---------------------------------------------------------

await ok("happy path: BEGIN_BUILD -> building -> validating -> done; services receive evidence", async () => {
	const stubs = makeStubs();
	const a = await buildOnce(stubs);
	assert.equal(a.getSnapshot().value, "done");
	// build service got the full content from the triggering event
	assert.equal(stubs.buildInputs.length, 1);
	assert.equal(stubs.buildInputs[0].title, CONTENT.title);
	assert.equal(stubs.buildInputs[0].slidesHtml, CONTENT.slidesHtml);
	// validate service got the outPath from the BUILD output
	assert.equal(stubs.validateInputs.length, 1);
	assert.equal(stubs.validateInputs[0].outPath, OUT);
	const ctx = a.getSnapshot().context;
	assert.deepEqual(ctx.builds, [OUT]);
	assert.deepEqual(ctx.errors, []);
	assert.equal(ctx.validateAttempts, 0);
	assert.equal(ctx.deck?.slideCount, 1);
	assert.equal(countSlides(CONTENT.slidesHtml), 1);
});

await ok("fast path: BEGIN_BUILD legal from fresh authoring (no ceremony needed)", async () => {
	const stubs = makeStubs();
	const a = makeActor(stubs);
	a.send(beginBuild());
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "done");
	// the pipeline never touches the ceremony phase
	assert.equal(a.getSnapshot().context.phase, null);
});

await ok("build output carries the outPath evidence (different from submitted)", async () => {
	const stubs = makeStubs({
		build: async () => ({ outPath: OUT2, slideCount: 5, bytes: 2 }),
	});
	const a = await buildOnce(stubs);
	// validating receives the BUILD's outPath, not the event's
	assert.equal(stubs.validateInputs[0].outPath, OUT2);
	assert.equal(a.getSnapshot().context.outPath, OUT2);
	assert.deepEqual(a.getSnapshot().context.builds, [OUT2]);
});

await ok("validation failure (deck) -> fixing: errors recorded, attempt bumped, retry loop closes", async () => {
	let calls = 0;
	const stubs = makeStubs({
		validate: async () => {
			calls++;
			if (calls === 1) {
				throw { errors: ["✗ Nav data-slide with no matching slide id: ['x']"], cause: "deck" };
			}
			return { slideCount: 1, message: "All checks passed (1 slides)" };
		},
	});
	const a = await buildOnce(stubs);
	assert.equal(a.getSnapshot().value, "fixing");
	const ctx = a.getSnapshot().context;
	assert.deepEqual(ctx.errors, ["✗ Nav data-slide with no matching slide id: ['x']"]);
	assert.equal(ctx.validateAttempts, 1);
	// fast-path fixing (phase null): replan stays legal — phase-agnostic (≡ old fixing)
	assert.equal(ctx.phase, null);
	assert.equal(a.getSnapshot().can({ type: "PLAN_DONE", slides: ["a"] }), true);
	// retry with fixed content: builds history records both, attempts kept
	a.send(beginBuild());
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "done");
	assert.equal(a.getSnapshot().context.validateAttempts, 1);
	assert.deepEqual(a.getSnapshot().context.builds, [OUT]);
});

await ok("validation infra failure -> fixing: attempt NOT bumped, retry legal", async () => {
	let calls = 0;
	const stubs = makeStubs({
		validate: async () => {
			calls++;
			if (calls === 1) {
				throw { errors: ["docker run exited 127 (infra)"], cause: "infra" };
			}
			return { slideCount: 1, message: "All checks passed (1 slides)" };
		},
	});
	const a = await buildOnce(stubs);
	assert.equal(a.getSnapshot().value, "fixing");
	assert.equal(a.getSnapshot().context.validateAttempts, 0);
	a.send(beginBuild());
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "done");
	assert.equal(a.getSnapshot().context.validateAttempts, 0);
});

await ok("build failure (always infra) -> fixing: attempt NOT bumped, retry legal", async () => {
	let calls = 0;
	const stubs = makeStubs({
		build: async () => {
			calls++;
			if (calls === 1) {
				throw new Error("cannot read template");
			}
			return { outPath: OUT, slideCount: 1, bytes: 1 };
		},
	});
	const a = await buildOnce(stubs);
	assert.equal(a.getSnapshot().value, "fixing");
	assert.equal(a.getSnapshot().context.validateAttempts, 0);
	assert.equal(stubs.validateInputs.length, 0); // validate never ran
	assert.deepEqual(a.getSnapshot().context.errors, ["cannot read template"]);
	a.send(beginBuild());
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "done");
});

await ok("attempt cap: exhausted deck validations block BEGIN_BUILD until RESET", async () => {
	let calls = 0;
	const stubs = makeStubs({
		validate: async () => {
			calls++;
			throw { errors: ["✗ broken"], cause: "deck" };
		},
	});
	const a = await buildOnce(stubs);
	await a.send(beginBuild());
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	await a.send(beginBuild());
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().context.validateAttempts, LIMITS.maxValidateAttempts);
	// cap reached: further builds rejected with a readable reason
	const reason = buildViolation(a.getSnapshot().context, CONTENT);
	assert.match(String(reason), /validation attempts exhausted/);
	assert.equal(a.getSnapshot().can(beginBuild()), false);
	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.deepEqual(a.getSnapshot().context, initialContext(LIMITS));
	assert.equal(a.getSnapshot().can(beginBuild()), true);
	assert.equal(calls, LIMITS.maxValidateAttempts);
});

await ok("BEGIN_BUILD illegal while building/validating (in-flight pipeline)", async () => {
	// build service that waits for manual release — pipeline parks in building
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	const stubs = makeStubs({
		build: async () => {
			await gate;
			return { outPath: OUT, slideCount: 1, bytes: 1 };
		},
	});
	const a = makeActor(stubs);
	a.send(beginBuild());
	await waitFor(a, (s) => s.matches("building"));
	assert.equal(a.getSnapshot().can(beginBuild()), false);
	assert.equal(a.getSnapshot().can({ type: "START", topic: "x" }), false);
	release();
	await waitFor(a, (s) => s.matches("validating"));
	assert.equal(a.getSnapshot().can(beginBuild()), false);
	await waitFor(a, (s) => s.matches("done"));
});

await ok("RESET during validating wins; late validate result is dropped, done not resurrected", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	const stubs = makeStubs({
		build: async (input) => {
			await gate;
			return { outPath: input.outPath, slideCount: 1, bytes: 1 };
		},
	});
	const a = makeActor(stubs);
	a.send(beginBuild());
	await waitFor(a, (s) => s.matches("building"));
	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.deepEqual(a.getSnapshot().context, initialContext(LIMITS));
	// the in-flight service resolves late — authoring has no handler, dropped
	release();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.deck, null);
	assert.equal(stubs.validateInputs.length, 0); // exited before validating
});

// --- done: rebuild / new deck ---------------------------------------------------

await ok("done: BEGIN_BUILD rebuilds (tweaked content); builds history deduped", async () => {
	const stubs = makeStubs();
	const a = await buildOnce(stubs);
	a.send(beginBuild({ title: "Tweaked" }));
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "done");
	assert.equal(a.getSnapshot().context.deck?.title, "Tweaked");
	assert.deepEqual(a.getSnapshot().context.builds, [OUT]); // same path, no dupe
});

await ok("done: START begins a new deck — authoring cleared, history kept", async () => {
	const stubs = makeStubs();
	const a = await buildOnce(stubs);
	a.send({ type: "START", topic: "New Topic" });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "researching");
	const ctx = a.getSnapshot().context;
	assert.equal(ctx.topic, "New Topic");
	assert.deepEqual(ctx.sources, []);
	assert.deepEqual(ctx.plannedSlides, []);
	assert.equal(ctx.deck, null);
	assert.deepEqual(ctx.builds, [OUT]); // history survives a new deck
});

await ok("RESET from done clears everything (builds history included)", async () => {
	const stubs = makeStubs();
	const a = await buildOnce(stubs);
	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.deepEqual(a.getSnapshot().context, initialContext(LIMITS));
});

// --- validators (shared with tool prechecks) ------------------------------------

await ok("buildViolation: readable reasons for every rejected shape", () => {
	const ctx = initialContext(LIMITS);
	assert.match(String(buildViolation(ctx, { ...CONTENT, title: "" })), /title is empty/);
	assert.match(String(buildViolation(ctx, { ...CONTENT, subtitle: "" })), /subtitle is empty/);
	assert.match(String(buildViolation(ctx, { ...CONTENT, navHtml: "" })), /navHtml is empty/);
	assert.match(String(buildViolation(ctx, { ...CONTENT, navHtml: "<nav/>" })), /no data-slide/);
	assert.match(String(buildViolation(ctx, { ...CONTENT, slidesHtml: "<p>no slides</p>" })), /no <div class='slide'>/);
	assert.match(String(buildViolation(ctx, { ...CONTENT, outPath: "/tmp/deck.txt" })), /\.html/);
	assert.match(
		String(buildViolation(ctx, { ...CONTENT, slidesHtml: "<div>".repeat(600_000) })),
		/too large/,
	);
	const capped: SlideDeckContext = { ...ctx, validateAttempts: LIMITS.maxValidateAttempts };
	assert.match(String(buildViolation(capped, CONTENT)), /attempts exhausted/);
	assert.equal(buildViolation(ctx, CONTENT), null);
});

await ok("unwired machine: entering building lands in fixing with a readable error", async () => {
	// no provide() — the typed stubs throw "not wired"
	const a = createActor(slideDeckMachine, { input: { limits: LIMITS } });
	a.start();
	a.send(beginBuild());
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "fixing");
	assert.match(a.getSnapshot().context.errors[0], /not wired/);
});

// --- prebuild fast-fail (nav↔slide 1:1, duplicates, plan conformance) ----------

await ok("extract helpers: ids/targets via regex; single-quoted attrs missed (validate owns those)", () => {
	assert.deepEqual(extractSlideIds(CONTENT.slidesHtml), ["a"]);
	assert.deepEqual(extractNavTargets(CONTENT.navHtml), ["a"]);
	// single-quoted attrs: precheck-lenient (missed), validate.py authoritative
	assert.deepEqual(extractNavTargets("<a data-slide='b'>x</a>"), []);
});

await ok("navSlideViolation: duplicates, missing, orphan — readable reasons", () => {
	assert.match(String(navSlideViolation('<a data-slide="a">x</a>', '<div id="slide-a"></div><div id="slide-a"></div>')), /duplicate slide ids/);
	assert.match(String(navSlideViolation('<a data-slide="a"></a><a data-slide="a"></a>', '<div id="slide-a"></div>')), /duplicate nav data-slide/);
	assert.match(String(navSlideViolation('<a data-slide="ghost">x</a>', CONTENT.slidesHtml)), /no matching slide id/);
	assert.match(String(navSlideViolation(CONTENT.navHtml, '<div id="slide-a"></div><div id="slide-b"></div>')), /no matching nav item/);
	assert.equal(navSlideViolation(CONTENT.navHtml, CONTENT.slidesHtml), null);
});

await ok("buildViolation: nav↔slide mismatch rejected BEFORE the Docker roundtrip", () => {
	const ctx = initialContext(LIMITS);
	const reason = buildViolation(ctx, {
		...CONTENT,
		navHtml: '<a class="nav-item" data-slide="ghost">Ghost</a>',
	});
	assert.match(String(reason), /no matching slide id/);
	assert.match(String(reason), /fix navHtml\/slidesHtml before building/);
});

await ok("plan conformance: unplanned slide rejected; trimming (subset) allowed", () => {
	const ctx: SlideDeckContext = { ...initialContext(LIMITS), plannedSlides: ["a", "b"] };
	const reason = buildViolation(ctx, {
		...CONTENT,
		navHtml:
			'<a class="nav-item" data-slide="a">A</a><a class="nav-item" data-slide="c">C</a>',
		slidesHtml:
			'<div class="slide" id="slide-a"><p>x</p></div><div class="slide" id="slide-c"><p>y</p></div>',
	});
	assert.match(String(reason), /not in the recorded plan/);
	assert.match(String(reason), /plan: c —/);
	// planned a+b, built only a: trimming is legal drift
	const trimmed = buildViolation(ctx, CONTENT);
	assert.equal(trimmed, null);
	// no plan recorded (fast path): no conformance check
	assert.equal(buildViolation(initialContext(LIMITS), CONTENT), null);
});

await ok("PLAN_DONE replans from writing and fixing (plan is load-bearing)", async () => {
	const stubs = makeStubs({
		validate: async () => {
			throw { errors: ["✗ broken"], cause: "deck" };
		},
	});
	const a = makeActor(stubs);
	a.send({ type: "START", topic: "t" });
	a.send({ type: "RESEARCH_DONE", sources: ["s"] });
	a.send({ type: "PLAN_DONE", slides: ["a"] });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "writing");
	// replan mid-authoring: adds "b"
	a.send({ type: "PLAN_DONE", slides: ["a", "b"] });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "writing");
	assert.deepEqual(a.getSnapshot().context.plannedSlides, ["a", "b"]);
	a.send(beginBuild({
		slidesHtml:
			'<div class="slide" id="slide-a"><p>x</p></div><div class="slide" id="slide-b"><p>y</p></div>',
		navHtml:
			'<a class="nav-item" data-slide="a">A</a><a class="nav-item" data-slide="b">B</a>',
	}));
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "fixing");
	// replan mid-fix
	a.send({ type: "PLAN_DONE", slides: ["a"] });
	assert.equal(a.getSnapshot().value, "fixing");
	assert.deepEqual(a.getSnapshot().context.plannedSlides, ["a"]);
});

await ok("overwrite flows through the event into the build service input", async () => {
	const stubs = makeStubs();
	const a = makeActor(stubs);
	a.send({ ...beginBuild(), overwrite: true });
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(a.getSnapshot().value, "done");
	assert.equal(stubs.buildInputs[0].overwrite, true);
	// absent by default
	a.send(beginBuild({ title: "Second" }));
	await waitFor(a, (s) => s.matches("done") || s.matches("fixing"));
	assert.equal(stubs.buildInputs[1].overwrite, undefined);
});

// -------------------------------------------------------------------------------

console.log(
	`\n${passed} passed, ${failed} failed${failed > 0 ? " — FAILURES" : ""}`,
);
if (failed > 0) process.exit(1);
