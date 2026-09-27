/**
 * Machine tests — run without an LLM, Docker, or a browser:
 *   node test.ts
 */
import assert from "node:assert/strict";
import { createActor, type Actor } from "xstate";
import {
	embedViolation,
	initialContext,
	mermaidMachine,
	renderViolation,
	validateViolation,
	type MermaidLimits,
} from "./machine.ts";

const LIMITS: MermaidLimits = { maxValidateAttempts: 3 };

function makeActor(): Actor<typeof mermaidMachine> {
	const a = createActor(mermaidMachine, { input: { limits: LIMITS } });
	a.start();
	return a;
}

const PATH = "/tmp/diagram.mmd";
const HASH = "h1";
const HASH2 = "h2";

const beginRender = (path = PATH, hash = HASH, outPath = "/tmp/diagram.svg") => ({
	type: "BEGIN_RENDER" as const,
	path,
	hash,
	outPath,
});
const beginEmbed = (path = PATH, hash = HASH, target = "/tmp/notes.md") => ({
	type: "BEGIN_EMBED" as const,
	path,
	hash,
	target,
});

/** Drive to `validated` with PATH/HASH. */
function toValidated(a: Actor<typeof mermaidMachine>, path = PATH, hash = HASH) {
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path, hash, ok: true, errors: [] });
}

let passed = 0;
function ok(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`✓ ${name}`);
}

// --- drafting -----------------------------------------------------------------
ok("drafting: BEGIN_VALIDATE allowed; BEGIN_RENDER/BEGIN_EMBED rejected", () => {
	const a = makeActor();
	assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
	assert.equal(a.getSnapshot().can(beginRender()), false);
	assert.equal(a.getSnapshot().can(beginEmbed()), false);
});

// (The old "drafting: RESET" test was vacuous — drafting has no RESET handler
// and a fresh actor's context already equals initialContext, so it asserted
// nothing. Replaced by the real gap test below: reset wins over an in-flight
// validation.)
ok("RESET during validating wins; late VALIDATE_DONE is dropped, state not resurrected", () => {
	const a = makeActor();
	a.send({ type: "BEGIN_VALIDATE" });
	assert.equal(a.getSnapshot().value, "validating");
	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().value, "drafting");
	assert.deepEqual(a.getSnapshot().context, initialContext(LIMITS));
	// the in-flight result arrives after the reset: no handler in drafting,
	// dropped — the machine does not resurrect `validated`
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH, ok: true, errors: [] });
	assert.equal(a.getSnapshot().value, "drafting");
	assert.equal(a.getSnapshot().context.validated, null);
	assert.equal(a.getSnapshot().can(beginRender()), false);
});

// --- validation ---------------------------------------------------------------
ok("VALIDATE_DONE ok -> validated: source {path, hash} stored, errors cleared", () => {
	const a = makeActor();
	toValidated(a);
	assert.equal(a.getSnapshot().value, "validated");
	assert.deepEqual(a.getSnapshot().context.validated, { path: PATH, hash: HASH });
	assert.equal(a.getSnapshot().context.validateAttempts, 0);
});

ok("VALIDATE_DONE fail -> fixing: errors stored, attempts bumped, validated null", () => {
	const a = makeActor();
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH, ok: false, errors: ["Parse error on line 2"] });
	assert.equal(a.getSnapshot().value, "fixing");
	assert.equal(a.getSnapshot().context.validated, null);
	assert.deepEqual(a.getSnapshot().context.errors, ["Parse error on line 2"]);
	assert.equal(a.getSnapshot().context.validateAttempts, 1);
});

ok("fixing: BEGIN_VALIDATE allowed (fix loop)", () => {
	const a = makeActor();
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH, ok: false, errors: ["bad"] });
	assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH, ok: true, errors: [] });
	assert.equal(a.getSnapshot().value, "validated");
	assert.equal(a.getSnapshot().context.validateAttempts, 1);
});

ok("validate attempts capped with readable reason", () => {
	const a = makeActor();
	for (let i = 0; i < LIMITS.maxValidateAttempts; i++) {
		assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true, `attempt ${i} should be allowed`);
		a.send({ type: "BEGIN_VALIDATE" });
		a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH, ok: false, errors: ["bad"] });
	}
	assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), false);
	assert.match(validateViolation(a.getSnapshot().context) ?? "", /attempts exhausted/);
	// RESET always allowed from fixing
	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().value, "drafting");
	assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
});

// --- render gating ------------------------------------------------------------
ok("validated: BEGIN_RENDER allowed only for the exact validated source", () => {
	const a = makeActor();
	toValidated(a);
	assert.equal(a.getSnapshot().can(beginRender()), true);
	assert.equal(a.getSnapshot().can(beginRender(PATH, HASH2)), false);
	assert.match(renderViolation(a.getSnapshot().context, PATH, HASH2) ?? "", /source changed since validation/);
	assert.equal(a.getSnapshot().can(beginRender("/tmp/other.mmd", HASH)), false);
	assert.match(
		renderViolation(a.getSnapshot().context, "/tmp/other.mmd", HASH) ?? "",
		/validated source is .* not/,
	);
});

ok("renderViolation: no validated source -> readable reason", () => {
	const a = makeActor();
	assert.match(renderViolation(a.getSnapshot().context, PATH, HASH) ?? "", /no validated source/);
});

ok("RENDER_DONE ok -> validated (render recorded in context); re-render allowed", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginRender());
	a.send({ type: "RENDER_DONE", ok: true, outPath: "/tmp/diagram.svg", error: null });
	assert.equal(a.getSnapshot().value, "validated"); // no separate `rendered` state — renders[] is the history
	assert.deepEqual(a.getSnapshot().context.renders, ["/tmp/diagram.svg"]);
	a.send(beginRender(PATH, HASH, "/tmp/diagram2.svg"));
	assert.equal(a.getSnapshot().value, "rendering");
	a.send({ type: "RENDER_DONE", ok: true, outPath: "/tmp/diagram2.svg", error: null });
	assert.deepEqual(a.getSnapshot().context.renders, ["/tmp/diagram.svg", "/tmp/diagram2.svg"]);
});

ok("RENDER_DONE fail (diagram) -> fixing, pass cleared, retry render rejected", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginRender());
	a.send({ type: "RENDER_DONE", ok: false, outPath: "/tmp/diagram.svg", error: "mmdc rejected", cause: "diagram" });
	assert.equal(a.getSnapshot().value, "fixing");
	assert.equal(a.getSnapshot().context.validated, null); // fixing has no pass
	assert.deepEqual(a.getSnapshot().context.errors, ["mmdc rejected"]);
	assert.equal(a.getSnapshot().can(beginRender()), false); // must re-validate first
});

ok("RENDER_DONE fail (diagram, no cause) defaults to diagram", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginRender());
	a.send({ type: "RENDER_DONE", ok: false, outPath: "/tmp/diagram.svg", error: "mmdc crashed" });
	assert.equal(a.getSnapshot().value, "fixing");
	assert.equal(a.getSnapshot().context.validated, null);
});

ok("RENDER_DONE fail (infra) -> validated, pass kept, retry render legal immediately", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginRender());
	a.send({ type: "RENDER_DONE", ok: false, outPath: "/tmp/diagram.svg", error: "docker daemon down", cause: "infra" });
	assert.equal(a.getSnapshot().value, "validated");
	assert.deepEqual(a.getSnapshot().context.validated, { path: PATH, hash: HASH }); // pass untouched
	assert.deepEqual(a.getSnapshot().context.errors, ["docker daemon down"]);
	assert.equal(a.getSnapshot().can(beginRender()), true); // retry without re-validate
	assert.equal(a.getSnapshot().context.validateAttempts, 0); // infra never burns attempts
});

// --- embed gating ---------------------------------------------------------------
ok("validated: BEGIN_EMBED allowed; target === source rejected", () => {
	const a = makeActor();
	toValidated(a);
	assert.equal(a.getSnapshot().can(beginEmbed()), true);
	assert.equal(a.getSnapshot().can(beginEmbed(PATH, HASH, PATH)), false);
	assert.match(
		embedViolation(a.getSnapshot().context, PATH, HASH, PATH) ?? "",
		/target is the diagram source itself/,
	);
});

ok("BEGIN_EMBED stale hash rejected with readable reason", () => {
	const a = makeActor();
	toValidated(a);
	assert.match(embedViolation(a.getSnapshot().context, PATH, HASH2, "/tmp/notes.md") ?? "", /source changed/);
});

ok("EMBED_DONE ok records embed (no duplicate entries); stays validated", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginEmbed());
	a.send({ type: "EMBED_DONE", ok: true, target: "/tmp/notes.md", error: null });
	assert.equal(a.getSnapshot().value, "validated");
	assert.deepEqual(a.getSnapshot().context.embeds, ["/tmp/notes.md"]);
	a.send(beginEmbed());
	a.send({ type: "EMBED_DONE", ok: true, target: "/tmp/notes.md", error: null });
	assert.deepEqual(a.getSnapshot().context.embeds, ["/tmp/notes.md"]);
});

ok("EMBED_DONE fail records error; source stays validated (embedding is replace-safe)", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginEmbed());
	a.send({ type: "EMBED_DONE", ok: false, target: "/tmp/notes.md", error: "target not found" });
	assert.equal(a.getSnapshot().value, "validated");
	assert.deepEqual(a.getSnapshot().context.errors, ["target not found"]);
	// still legal to retry embed
	assert.equal(a.getSnapshot().can(beginEmbed()), true);
});

ok("embed legal after a render (multiple embeds, render optional)", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginRender());
	a.send({ type: "RENDER_DONE", ok: true, outPath: "/tmp/diagram.svg", error: null });
	assert.equal(a.getSnapshot().value, "validated");
	assert.equal(a.getSnapshot().can(beginEmbed()), true);
});

// --- re-validation ---------------------------------------------------------------
ok("re-validate changed source: new hash replaces old; old hash now rejected", () => {
	const a = makeActor();
	toValidated(a, PATH, HASH);
	toValidated(a, PATH, HASH2); // edited -> re-validate
	assert.deepEqual(a.getSnapshot().context.validated, { path: PATH, hash: HASH2 });
	assert.equal(a.getSnapshot().can(beginRender(PATH, HASH)), false);
	assert.equal(a.getSnapshot().can(beginRender(PATH, HASH2)), true);
});

ok("re-validating a different path switches the validated source", () => {
	const a = makeActor();
	toValidated(a, PATH, HASH);
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: "/tmp/other.mmd", hash: "x", ok: true, errors: [] });
	assert.deepEqual(a.getSnapshot().context.validated, { path: "/tmp/other.mmd", hash: "x" });
	assert.equal(a.getSnapshot().can(beginRender(PATH, HASH)), false);
});

ok("failed re-validation clears the previous pass", () => {
	const a = makeActor();
	toValidated(a);
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH2, ok: false, errors: ["broken again"] });
	assert.equal(a.getSnapshot().context.validated, null);
	assert.equal(a.getSnapshot().value, "fixing");
	assert.equal(a.getSnapshot().can(beginRender(PATH, HASH)), false);
});

// --- reset -----------------------------------------------------------------------
ok("VALIDATE_DONE fail (infra) with prior pass -> validated, pass kept, no attempt bump", () => {
	const a = makeActor();
	toValidated(a);
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH2, ok: false, errors: ["docker build failed"], cause: "infra" });
	assert.equal(a.getSnapshot().value, "validated");
	assert.deepEqual(a.getSnapshot().context.validated, { path: PATH, hash: HASH }); // prior pass kept
	assert.equal(a.getSnapshot().context.validateAttempts, 0); // infra never burns attempts
	assert.deepEqual(a.getSnapshot().context.errors, ["docker build failed"]);
});

ok("VALIDATE_DONE fail (infra) without prior pass -> drafting, no attempt bump", () => {
	const a = makeActor();
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH, ok: false, errors: ["docker daemon down"], cause: "infra" });
	assert.equal(a.getSnapshot().value, "drafting");
	assert.equal(a.getSnapshot().context.validated, null);
	assert.equal(a.getSnapshot().context.validateAttempts, 0);
	assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true); // retry legal immediately
});

ok("VALIDATE_DONE fail (diagram) still bumps attempts and clears pass", () => {
	const a = makeActor();
	toValidated(a);
	a.send({ type: "BEGIN_VALIDATE" });
	a.send({ type: "VALIDATE_DONE", path: PATH, hash: HASH2, ok: false, errors: ["Parse error"], cause: "diagram" });
	assert.equal(a.getSnapshot().value, "fixing");
	assert.equal(a.getSnapshot().context.validated, null);
	assert.equal(a.getSnapshot().context.validateAttempts, 1);
});

ok("RESET from validated with renders+embeds -> drafting, context cleared, limits kept", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginRender());
	a.send({ type: "RENDER_DONE", ok: true, outPath: "/tmp/diagram.svg", error: null });
	a.send(beginEmbed());
	a.send({ type: "EMBED_DONE", ok: true, target: "/tmp/notes.md", error: null });
	a.send({ type: "RESET" });
	assert.equal(a.getSnapshot().value, "drafting");
	const c = a.getSnapshot().context;
	assert.equal(c.validated, null);
	assert.equal(c.renders.length, 0);
	assert.equal(c.embeds.length, 0);
	assert.deepEqual(c.limits, LIMITS);
	assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
	assert.equal(a.getSnapshot().can(beginRender()), false);
});

// --- snapshot restore --------------------------------------------------------------
ok("persisted snapshot restores value, context, and legality", () => {
	const a = makeActor();
	toValidated(a);
	a.send(beginRender());
	a.send({ type: "RENDER_DONE", ok: true, outPath: "/tmp/diagram.svg", error: null });
	const persisted = a.getPersistedSnapshot();

	const b = createActor(mermaidMachine, { input: { limits: LIMITS }, snapshot: persisted as never });
	b.start();
	assert.equal(b.getSnapshot().value, "validated");
	assert.deepEqual(b.getSnapshot().context.validated, { path: PATH, hash: HASH });
	assert.deepEqual(b.getSnapshot().context.renders, ["/tmp/diagram.svg"]);
	assert.equal(b.getSnapshot().can(beginEmbed()), true);
	assert.equal(b.getSnapshot().can(beginRender(PATH, HASH2)), false);
	assert.equal(b.getSnapshot().can(beginRender(PATH, HASH)), true);
	assert.equal(b.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
});

console.log(`\n${passed} tests passed`);
