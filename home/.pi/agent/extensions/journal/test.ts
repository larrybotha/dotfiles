/**
 * Machine + db tests — run without an LLM or a pi instance:
 *   node test.ts
 *
 * Service slots are provided with stubs (machine.provide) — no db runs for
 * the machine tests. Controlled stubs capture inputs and decide outcomes,
 * so failure routing, the retry loop, and RESET-wins semantics are
 * testable deterministically. The db section uses a throwaway sqlite file
 * under tmp/ and exercises the real JournalDb.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createActor, type Actor, fromPromise, waitFor } from "xstate";
import { JournalDb } from "./db.ts";
import {
	approveViolation,
	composeContent,
	initialContext,
	type JournalEvent,
	journalMachine,
	normalizeTags,
	type PersistServiceInput,
	type PersistServiceOutput,
	startViolation,
	type TemplateRecord,
	templateDefaultTagsViolation,
	templateDescriptionViolation,
	templateNameViolation,
	templateStepsViolation,
	stepViolation,
	tagListViolation,
} from "./machine.ts";

const LIMITS = { maxPersistAttempts: 3 };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FREEFORM: TemplateRecord = {
	id: 1,
	name: "freeform",
	description: "Single free-form markdown entry",
	steps: [{ name: "content", prompt: "Journal entry" }],
	defaultTags: [],
	createdAt: "2026-01-01T00:00:00.000Z",
};

const DAILY: TemplateRecord = {
	id: 2,
	name: "daily",
	description: "",
	steps: [
		{ name: "wins", prompt: "What went well?" },
		{ name: "blockers", prompt: "What blocked you?" },
	],
	defaultTags: ["work", "daily"],
	createdAt: "2026-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Stub services (controllable: inputs recorded, outcomes scripted)
// ---------------------------------------------------------------------------

type Stubs = {
	persistInputs: PersistServiceInput[];
	persistNext: (input: PersistServiceInput) => Promise<PersistServiceOutput>;
};

function makeStubs(
	over: Partial<{ persist: Stubs["persistNext"] }> = {},
): Stubs {
	return {
		persistInputs: [],
		persistNext:
			over.persist ??
			(async () => ({ id: 7, createdAt: "2026-01-02T00:00:00.000Z" })),
	};
}

function makeMachine(stubs: Stubs) {
	return journalMachine.provide({
		actors: {
			persistService: fromPromise<PersistServiceOutput, PersistServiceInput>(
				async ({ input }) => {
					stubs.persistInputs.push(input);
					return stubs.persistNext(input);
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

/** Drive DAILY through both steps; returns the actor in phase tagging. */
function driveDaily(a: Actor<Machine>): Actor<Machine> {
	a.send({ type: "START", template: DAILY });
	a.send({ type: "STEP_DONE", stepName: "wins", content: "shipped machine" });
	a.send({
		type: "STEP_DONE",
		stepName: "blockers",
		content: "sqlite locking",
	});
	return a;
}

/** Drive to phase reviewing (steps + tags done); APPROVE-ready. */
function driveToReview(a: Actor<Machine>): Actor<Machine> {
	driveDaily(a);
	a.send({ type: "TAGS_DONE", tags: [" Work ", "work", "FOCUS"] });
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

await ok("authoring initial (phase null); only START is legal", () => {
	const a = makeActor(makeStubs());
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, null);
	assert.equal(a.getSnapshot().can({ type: "START", template: FREEFORM }), true);
	assert.equal(
		a.getSnapshot().can({
			type: "STEP_DONE",
			stepName: "content",
			content: "x",
		}),
		false,
	);
	assert.equal(a.getSnapshot().can({ type: "TAGS_DONE", tags: ["a"] }), false);
	assert.equal(a.getSnapshot().can({ type: "APPROVE" }), false);
});

// --- authoring phases ----------------------------------------------------------

await ok("START -> phase writing (template recorded); second START illegal", () => {
	const a = makeActor(makeStubs());
	a.send({ type: "START", template: DAILY });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "writing");
	assert.equal(a.getSnapshot().context.template?.name, "daily");
	assert.equal(a.getSnapshot().can({ type: "START", template: FREEFORM }), false);
	// writing ≡ STEP_DONE legal; TAGS_DONE not yet (steps pending)
	assert.equal(
		a.getSnapshot().can({
			type: "STEP_DONE",
			stepName: "wins",
			content: "x",
		}),
		true,
	);
	assert.equal(a.getSnapshot().can({ type: "TAGS_DONE", tags: [] }), false);
});

await ok("STEP_DONE: wrong step name rejected; out-of-order rejected", () => {
	const a = makeActor(makeStubs());
	a.send({ type: "START", template: DAILY });
	// blockers is step 2 — not next
	assert.equal(
		a.getSnapshot().can({
			type: "STEP_DONE",
			stepName: "blockers",
			content: "x",
		}),
		false,
	);
	assert.notEqual(
		stepViolation(
			a.getSnapshot().context,
			"blockers",
			"x",
		),
		null,
	);
	a.send({ type: "STEP_DONE", stepName: "wins", content: "w" });
	// wins already answered — repeat rejected
	assert.equal(
		a.getSnapshot().can({
			type: "STEP_DONE",
			stepName: "wins",
			content: "again",
		}),
		false,
	);
	assert.equal(a.getSnapshot().context.phase, "writing");
});

await ok("last STEP_DONE flips phase to tagging (targetless)", () => {
	const a = makeActor(makeStubs());
	driveDaily(a);
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "tagging");
	assert.deepEqual(a.getSnapshot().context.answers, {
		wins: "shipped machine",
		blockers: "sqlite locking",
	});
	assert.equal(a.getSnapshot().can({ type: "TAGS_DONE", tags: ["a"] }), true);
});

await ok("TAGS_DONE: normalized (trim/lowercase/dedupe) -> phase reviewing; empty = no tags", () => {
	const a = makeActor(makeStubs());
	driveDaily(a);
	a.send({ type: "TAGS_DONE", tags: [" Work ", "work", "FOCUS", ""] });
	assert.equal(a.getSnapshot().context.phase, "reviewing");
	assert.deepEqual(a.getSnapshot().context.tags, ["work", "focus"]);
	// re-tagging illegal; APPROVE now legal
	assert.equal(a.getSnapshot().can({ type: "TAGS_DONE", tags: ["x"] }), false);
	assert.equal(a.getSnapshot().can({ type: "APPROVE" }), true);

	const b = makeActor(makeStubs());
	driveDaily(b);
	b.send({ type: "TAGS_DONE", tags: [""] });
	assert.equal(b.getSnapshot().context.phase, "reviewing");
	assert.deepEqual(b.getSnapshot().context.tags, []);
	assert.equal(b.getSnapshot().can({ type: "APPROVE" }), true);
});

await ok("TAGS_DONE caps: too many unique tags rejected", () => {
	const a = makeActor(makeStubs());
	driveDaily(a);
	const many = Array.from({ length: 17 }, (_, i) => `tag-${i}`);
	assert.notEqual(tagListViolation(many), null);
	assert.equal(a.getSnapshot().can({ type: "TAGS_DONE", tags: many }), false);
});

// --- pipeline (invoke) ---------------------------------------------------------

await ok("happy path: APPROVE -> persisting -> done; service receives the composed input", async () => {
	const stubs = makeStubs();
	const a = driveToReview(makeActor(stubs));
	a.send({ type: "APPROVE" });
	await waitFor(a, (s) => s.matches("done") || s.matches("authoring"));
	assert.equal(a.getSnapshot().value, "done");
	// the service input carries template + ordered steps with answers + tags
	assert.equal(stubs.persistInputs.length, 1);
	const input = stubs.persistInputs[0];
	assert.equal(input.templateId, DAILY.id);
	assert.equal(input.templateName, "daily");
	assert.deepEqual(
		input.steps.map((s) => [s.name, s.answer]),
		[
			["wins", "shipped machine"],
			["blockers", "sqlite locking"],
		],
	);
	assert.deepEqual(input.tags, ["work", "focus"]);
	const c = a.getSnapshot().context;
	assert.deepEqual(c.lastEntry, { id: 7, createdAt: "2026-01-02T00:00:00.000Z" });
	assert.deepEqual(c.errors, []);
	assert.equal(c.persistAttempts, 0);
});

await ok("APPROVE with all-empty answers rejected (approveViolation)", () => {
	const a = makeActor(makeStubs());
	a.send({ type: "START", template: DAILY });
	a.send({ type: "STEP_DONE", stepName: "wins", content: "   " });
	a.send({ type: "STEP_DONE", stepName: "blockers", content: "" });
	a.send({ type: "TAGS_DONE", tags: [] });
	assert.equal(a.getSnapshot().context.phase, "reviewing");
	assert.notEqual(approveViolation(a.getSnapshot().context), null);
	assert.equal(a.getSnapshot().can({ type: "APPROVE" }), false);
	// one non-empty step is enough
	const b = makeActor(makeStubs());
	b.send({ type: "START", template: DAILY });
	b.send({ type: "STEP_DONE", stepName: "wins", content: "" });
	b.send({ type: "STEP_DONE", stepName: "blockers", content: "something" });
	b.send({ type: "TAGS_DONE", tags: [] });
	assert.equal(b.getSnapshot().can({ type: "APPROVE" }), true);
});

await ok("persist failure -> authoring/reviewing with errors + attempt; retry APPROVE -> done", async () => {
	let fail = true;
	const stubs = makeStubs({
		persist: async () => {
			if (fail) throw { errors: ["db locked"] };
			return { id: 8, createdAt: "2026-01-03T00:00:00.000Z" };
		},
	});
	const a = driveToReview(makeActor(stubs));
	a.send({ type: "APPROVE" });
	await waitFor(a, (s) => s.matches("done") || s.matches("authoring"));
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "reviewing");
	assert.deepEqual(a.getSnapshot().context.errors, ["db locked"]);
	assert.equal(a.getSnapshot().context.persistAttempts, 1);
	assert.equal(a.getSnapshot().can({ type: "APPROVE" }), true);
	// answers + tags survive the failure — retry persists the same entry
	fail = false;
	a.send({ type: "APPROVE" });
	await waitFor(a, (s) => s.matches("done") || s.matches("authoring"));
	assert.equal(a.getSnapshot().value, "done");
	assert.equal(stubs.persistInputs.length, 2);
	assert.deepEqual(
		stubs.persistInputs[1].steps.map((s) => [s.name, s.answer]),
		[
			["wins", "shipped machine"],
			["blockers", "sqlite locking"],
		],
	);
	assert.deepEqual(a.getSnapshot().context.lastEntry, {
		id: 8,
		createdAt: "2026-01-03T00:00:00.000Z",
	});
	assert.deepEqual(a.getSnapshot().context.errors, []);
});

await ok("persist attempts capped — APPROVE rejected after max failures", async () => {
	const stubs = makeStubs({
		persist: async () => {
			throw new Error("disk on fire");
		},
	});
	const a = driveToReview(makeActor(stubs));
	for (let i = 0; i < LIMITS.maxPersistAttempts; i++) {
		a.send({ type: "APPROVE" });
		await waitFor(a, (s) => s.matches("authoring"));
	}
	assert.equal(a.getSnapshot().context.persistAttempts, LIMITS.maxPersistAttempts);
	assert.notEqual(approveViolation(a.getSnapshot().context), null);
	assert.equal(a.getSnapshot().can({ type: "APPROVE" }), false);
	// RESET is the only way out
	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().context.phase, null);
	assert.equal(a.getSnapshot().context.persistAttempts, 0);
	assert.equal(a.getSnapshot().can({ type: "APPROVE" }), false);
});

await ok("RESET from persisting wins — service stopped, state cleared", async () => {
	const stubs = makeStubs({
		persist: () =>
			new Promise<PersistServiceOutput>((resolve_) =>
				setTimeout(() => resolve_({ id: 9, createdAt: "x" }), 100),
			),
	});
	const a = driveToReview(makeActor(stubs));
	a.send({ type: "APPROVE" });
	assert.equal(a.getSnapshot().value, "persisting");
	a.send({ type: "RESET" });
	await waitFor(a, (s) => s.matches("authoring"));
	assert.equal(a.getSnapshot().context.phase, null);
	// the late service result has no handler in authoring — dropped
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.lastEntry, null);
});

await ok("done -> START begins a new entry (lastEntry kept, gather cleared)", async () => {
	const stubs = makeStubs();
	const a = driveToReview(makeActor(stubs));
	a.send({ type: "APPROVE" });
	await waitFor(a, (s) => s.matches("done"));
	assert.equal(a.getSnapshot().can({ type: "START", template: FREEFORM }), true);
	a.send({ type: "START", template: FREEFORM });
	assert.equal(a.getSnapshot().value, "authoring");
	assert.equal(a.getSnapshot().context.phase, "writing");
	assert.deepEqual(a.getSnapshot().context.answers, {});
	assert.deepEqual(a.getSnapshot().context.tags, []);
	// history kept (≡ slide-deck builds)
	assert.deepEqual(a.getSnapshot().context.lastEntry, {
		id: 7,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
});

await ok("START rejects a template with an invalid steps schema (db revalidation)", () => {
	const a = makeActor(makeStubs());
	const bad: TemplateRecord = {
		...FREEFORM,
		steps: [{ name: "Bad Name", prompt: "" }],
	};
	assert.notEqual(startViolation(bad), null);
	assert.equal(a.getSnapshot().can({ type: "START", template: bad }), false);
});

// --- pure functions -------------------------------------------------------------

await ok("normalizeTags: trim, lowercase, drop empties, dedupe (order kept)", () => {
	assert.deepEqual(normalizeTags([" Work ", "", "work", "FOCUS", "focus"]), [
		"work",
		"focus",
	]);
	assert.deepEqual(normalizeTags([]), []);
});

await ok("tagListViolation: raw input caps", () => {
	assert.equal(tagListViolation(["a", "b"]), null);
	assert.notEqual(tagListViolation(Array.from({ length: 33 }, () => "x")), null);
	assert.notEqual(tagListViolation(["x".repeat(129)]), null);
});

await ok("templateStepsViolation: closed strict shape", () => {
	assert.equal(templateStepsViolation([{ name: "a", prompt: "p" }]), null);
	assert.notEqual(templateStepsViolation([]), null);
	assert.notEqual(templateStepsViolation("nope"), null);
	assert.notEqual(
		templateStepsViolation([{ name: "a", prompt: "p" }, { name: "a", prompt: "q" }]),
		null,
	);
	assert.notEqual(templateStepsViolation([{ name: "a" }]), null);
	assert.notEqual(templateStepsViolation([{ name: "A", prompt: "p" }]), null);
	assert.notEqual(templateStepsViolation([{ name: "a", prompt: "  " }]), null);
	assert.notEqual(
		templateStepsViolation(
			Array.from({ length: 17 }, (_, i) => ({
				name: `s-${i}`,
				prompt: "p",
			})),
		),
		null,
	);
});

await ok("templateDefaultTagsViolation: optional array of bounded strings", () => {
		assert.equal(templateDefaultTagsViolation(undefined), null);
		assert.equal(templateDefaultTagsViolation(["work", "daily"]), null);
		assert.notEqual(templateDefaultTagsViolation("work"), null);
		assert.notEqual(templateDefaultTagsViolation(["work", 42]), null);
		assert.notEqual(templateDefaultTagsViolation(["  "]), null);
		assert.notEqual(templateDefaultTagsViolation(["x".repeat(129)]), null);
		assert.notEqual(
			templateDefaultTagsViolation(Array.from({ length: 17 }, () => "t")),
			null,
		);
	});

await ok("templateNameViolation / templateDescriptionViolation", () => {
	assert.equal(templateNameViolation("daily-standup"), null);
	assert.notEqual(templateNameViolation(""), null);
	assert.notEqual(templateNameViolation("Daily"), null);
	assert.notEqual(templateNameViolation("a".repeat(65)), null);
	assert.equal(templateDescriptionViolation("short"), null);
	assert.notEqual(templateDescriptionViolation("x".repeat(201)), null);
});

await ok("composeContent: single step as-is; multi-step `## name` sections; empties skipped", () => {
	// single-step: answer as-is (the freeform contract)
	assert.equal(
		composeContent([{ name: "content", answer: "  just text  " }]),
		"just text",
	);
	// multi-step: sections, empty answer skipped
	assert.equal(
		composeContent([
			{ name: "wins", answer: "shipped" },
			{ name: "blockers", answer: "" },
			{ name: "mood", answer: "good" },
		]),
		"## wins\n\nshipped\n\n## mood\n\ngood",
	);
	// multi-step, single non-empty answer: still a section (multi contract)
	assert.equal(
		composeContent([
			{ name: "wins", answer: "only one" },
			{ name: "blockers", answer: "" },
		]),
		"## wins\n\nonly one",
	);
});

await ok("initialContext: fresh context shape", () => {
	const c = initialContext({ maxPersistAttempts: 2 });
	assert.equal(c.phase, null);
	assert.equal(c.template, null);
	assert.deepEqual(c.answers, {});
	assert.deepEqual(c.tags, []);
	assert.equal(c.lastEntry, null);
	assert.deepEqual(c.errors, []);
	assert.equal(c.persistAttempts, 0);
});

// --- db (real sqlite, throwaway file) -------------------------------------------

const DB_TEST_PATH = join(import.meta.dirname, "tmp", "test-journal.db");
rmSync(DB_TEST_PATH, { force: true });

await ok("db: init seeds freeform; createTemplate validates + dedupes names", () => {
	const db = new JournalDb(DB_TEST_PATH);
	const templates = db.listTemplates();
	assert.equal(templates.length, 1);
	assert.equal(templates[0].name, "freeform");
	assert.deepEqual(templates[0].steps, [
		{ name: "content", prompt: "Journal entry" },
	]);
	// create + list
	const t = db.createTemplate(
		"daily",
		"Two-step daily",
		[
			{ name: "wins", prompt: "What went well?" },
			{ name: "blockers", prompt: "What blocked you?" },
		],
	);
	assert.equal(t.name, "daily");
	assert.equal(db.listTemplates().length, 2);
	assert.ok(db.getTemplateByName("daily"));
	assert.equal(db.getTemplateByName("nope"), null);
	// duplicate name -> readable error (valid steps, so the UNIQUE hit decides)
	assert.throws(
		() => db.createTemplate("daily", "", [{ name: "x", prompt: "p" }]),
		/already exists/,
	);
	// invalid steps rejected at db layer too (defense in depth)
	assert.throws(
		() => db.createTemplate("bad", "", [{ name: "A B", prompt: "p" }]),
		/lowercase/,
	);
	db.close();
});

await ok("db: createTemplate defaultTags — normalized, roundtripped, validated", () => {
	const db = new JournalDb(DB_TEST_PATH);
	// normalized on write (trim/lowercase/dedupe) and stored in schema_json
	const t = db.createTemplate(
		"retro",
		"",
		[{ name: "notes", prompt: "Notes" }],
		[" Retro ", "retro", "Team"],
	);
	assert.deepEqual(t.defaultTags, ["retro", "team"]);
	// roundtrip through the db
	const read = db.getTemplateByName("retro")!;
	assert.deepEqual(read.defaultTags, ["retro", "team"]);
	// omitted defaults stay an empty array
	const plain = db.createTemplate("plain", "", [{ name: "x", prompt: "p" }]);
	assert.deepEqual(plain.defaultTags, []);
	assert.deepEqual(db.getTemplateByName("plain")!.defaultTags, []);
	// invalid defaultTags rejected at the db layer (defense in depth)
	assert.throws(
		() =>
			db.createTemplate(
				"bad-tags",
				"",
				[{ name: "x", prompt: "p" }],
				["ok", 42] as unknown as string[],
			),
		/strings/,
	);
	db.close();
});

await ok("db: insertEntry + tags; listEntries previews, tag filter, search", () => {
	const db = new JournalDb(DB_TEST_PATH);
	const daily = db.getTemplateByName("daily")!;
	const a = db.insertEntry({
		templateId: daily.id,
		content: "## wins\n\nshipped the journal extension",
		tags: ["Work", "work", "Extension"],
	});
	const b = db.insertEntry({
		templateId: daily.id,
		content: "## blockers\n\nsqlite locking confusion",
		tags: ["work"],
	});
	assert.equal(a.id, 1);
	assert.equal(b.id, 2);
	assert.ok(a.createdAt.endsWith("Z"));

	// normalized tags on insert
	assert.deepEqual(db.entryTags(a.id), ["extension", "work"]);

	// list newest-first with previews + tags
	const all = db.listEntries({});
	assert.equal(all.total, 2);
	assert.equal(all.entries[0].id, b.id);
	assert.ok(all.entries[0].preview.includes("sqlite locking"));

	// tag filter
	const work = db.listEntries({ tag: "WORK" });
	assert.equal(work.total, 2);
	const ext = db.listEntries({ tag: "extension" });
	assert.equal(ext.total, 1);
	assert.equal(ext.entries[0].id, a.id);

	// search (LIKE escaped)
	const hits = db.listEntries({ search: "journal extension" });
	assert.equal(hits.total, 1);
	assert.equal(hits.entries[0].id, a.id);
	assert.equal(db.listEntries({ search: "100% miss" }).total, 0);

	// tag counts
	assert.deepEqual(db.listTags().map((t) => [t.name, t.count]), [
		["work", 2],
		["extension", 1],
	]);
	db.close();
});

await ok("db: linkEntries m:n, symmetric-duplicate skip, missing + self skips", () => {
	const db = new JournalDb(DB_TEST_PATH);
	const r1 = db.linkEntries(1, [2, 3, 1]);
	assert.deepEqual(r1.created, [2]);
	assert.deepEqual(r1.missing, [3]);
	assert.deepEqual(r1.self, [1]);
	// links read symmetrically
	assert.deepEqual(db.entryLinks(1), [2]);
	assert.deepEqual(db.entryLinks(2), [1]);
	// either direction = duplicate
	const r2 = db.linkEntries(2, [1]);
	assert.deepEqual(r2.duplicates, [1]);
	assert.deepEqual(r2.created, []);
	// missing from -> nothing created
	const r3 = db.linkEntries(99, [1]);
	assert.deepEqual(r3.missing, [99]);
	// summaries carry links
	const all = db.listEntries({});
	assert.deepEqual(
		all.entries.find((e) => e.id === 1)?.linkedIds,
		[2],
	);
	db.close();
});

await ok("db: getEntry full content + entry read path", () => {
	const db = new JournalDb(DB_TEST_PATH);
	const e = db.getEntry(1);
	assert.ok(e);
	assert.ok(e!.content.includes("shipped the journal extension"));
	assert.equal(e!.templateId, db.getTemplateByName("daily")!.id);
	assert.equal(db.getEntry(999), null);
	db.close();
});

rmSync(DB_TEST_PATH, { force: true });

// --- summary ---------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
