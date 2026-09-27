/**
 * Machine tests — run without an LLM or tmux:
 *   node test.ts
 */
import assert from "node:assert/strict";
import { createActor, type Actor } from "xstate";
import {
	buildSummary,
	delegateMachine,
	initialContext,
	paramsViolation,
	statusOf,
	type ArtifactEntry,
} from "./machine.ts";

function makeActor(): Actor<typeof delegateMachine> {
	const a = createActor(delegateMachine);
	a.start();
	return a;
}

function begin(a: Actor<typeof delegateMachine>, overrides: Record<string, unknown> = {}) {
	a.send({
		type: "BEGIN_DELEGATION",
		sessionId: "delegate-1-abcd",
		socketPath: "/tmp/agent-tmux-sockets/agent.sock",
		task: "Write results to out.txt",
		monitor: false,
		timeoutSecs: 300,
		workingDir: "/tmp/work",
		artifactPaths: ["out.txt"],
		...overrides,
	});
}

function beginBad(a: Actor<typeof delegateMachine>, overrides: Record<string, unknown> = {}) {
	begin(a, { task: "t", timeoutSecs: 10, artifactPaths: ["a.txt"], ...overrides });
}

function spawnOk(a: Actor<typeof delegateMachine>) {
	begin(a);
	a.send({ type: "SPAWN_OK" });
}

function collect(a: Actor<typeof delegateMachine>, artifacts: ArtifactEntry[]) {
	a.send({ type: "COLLECT_DONE", artifacts, stderr: "" });
}

let passed = 0;
function ok(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`✓ ${name}`);
}

// --- idle / event order ----------------------------------------------------
ok("idle: BEGIN legal, everything else rejected", () => {
	const a = makeActor();
	assert.equal(
		a.getSnapshot().can({
			type: "BEGIN_DELEGATION",
			sessionId: "s",
			socketPath: "p",
			task: "t",
			monitor: false,
			timeoutSecs: 10,
			workingDir: "w",
			artifactPaths: [],
		}),
		true,
	);
	assert.equal(a.getSnapshot().can({ type: "SPAWN_OK" }), false);
	assert.equal(a.getSnapshot().can({ type: "EXIT_SEEN", exitCode: 0 }), false);
	assert.equal(a.getSnapshot().can({ type: "DEADLINE_HIT" }), false);
	assert.equal(a.getSnapshot().can({ type: "KILL" }), false);
	assert.equal(a.getSnapshot().can({ type: "COLLECT_DONE", artifacts: [], stderr: "" }), false);
});

ok("idle: illegal BEGIN rejected (validator shared with tool precheck)", () => {
	const a = makeActor();
	a.send({
		type: "BEGIN_DELEGATION",
		sessionId: "s",
		socketPath: "p",
		task: "   ",
		monitor: false,
		timeoutSecs: 300,
		workingDir: "w",
		artifactPaths: [],
	});
	assert.equal(a.getSnapshot().value, "idle");
	assert.equal(a.getSnapshot().context.sessionId, "");
});

ok("BEGIN stores delegation params in context", () => {
	const a = makeActor();
	begin(a);
	assert.equal(a.getSnapshot().value, "spawning");
	const c = a.getSnapshot().context;
	assert.equal(c.sessionId, "delegate-1-abcd");
	assert.equal(c.task, "Write results to out.txt");
	assert.equal(c.timeoutSecs, 300);
	assert.deepEqual(c.artifactPaths, ["out.txt"]);
	assert.equal(c.monitor, false);
	assert.equal(c.workingDir, "/tmp/work");
});

ok("second BEGIN rejected — one delegation per actor", () => {
	const a = makeActor();
	begin(a);
	beginBad(a, { sessionId: "delegate-2-efgh" });
	assert.equal(a.getSnapshot().value, "spawning");
	assert.equal(a.getSnapshot().context.sessionId, "delegate-1-abcd");
});

// --- paramsViolation (pure validator) ----------------------------------------
ok("paramsViolation: empty task", () => {
	assert.match(paramsViolation("", 300, [])!, /task is empty/);
	assert.match(paramsViolation("  ", 300, [])!, /task is empty/);
	assert.equal(paramsViolation("do work", 300, []), null);
});

ok("paramsViolation: bad timeout", () => {
	assert.match(paramsViolation("t", 0, [])!, /timeout must be a positive/);
	assert.match(paramsViolation("t", -5, [])!, /timeout must be a positive/);
	assert.match(paramsViolation("t", Number.NaN, [])!, /timeout must be a positive/);
});

ok("paramsViolation: empty + duplicate artifact paths", () => {
	assert.match(paramsViolation("t", 10, [""])!, /non-empty strings/);
	assert.match(paramsViolation("t", 10, ["a.txt", "b.txt", "a.txt"])!, /duplicate artifact paths/);
	assert.equal(paramsViolation("t", 10, ["a.txt", "b.txt"]), null);
});

ok("paramsViolation: artifact count capped (collect payload is bounded)", () => {
	const many = Array.from({ length: 65 }, (_, i) => `f${i}.txt`);
	assert.match(paramsViolation("t", 10, many)!, /too many artifact paths/);
	assert.equal(paramsViolation("t", 10, many.slice(0, 64)), null);
});

ok("buildSummary: unreadable artifacts counted like missing, never as collected", () => {
	const artifacts = [
		{ path: "ok.txt", content: "x", missing: false },
		{ path: "gone.txt", content: "", missing: true },
		{ path: "dir", content: "", missing: false, readError: "EISDIR: illegal operation on a directory, read" },
	];
	const s = buildSummary(["ok.txt", "gone.txt", "dir"], artifacts);
	assert.match(s, /Collected 1\/3 artifacts\./);
	assert.match(s, /Missing: gone\.txt\./);
	assert.match(s, /Unreadable: dir\./);
});

// --- spawning ----------------------------------------------------------------
ok("SPAWN_FAIL → error with readable failure detail", () => {
	const a = makeActor();
	begin(a);
	a.send({ type: "SPAWN_FAIL", error: "no tmux binary" });
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail!, /Failed to create tmux session: no tmux binary/);
	assert.equal(a.getSnapshot().context.exitCode, null);
	assert.equal(a.getSnapshot().can({ type: "COLLECT_DONE", artifacts: [], stderr: "" }), true);
});

ok("spawning: EXIT_SEEN / DEADLINE_HIT / KILL rejected", () => {
	const a = makeActor();
	begin(a);
	assert.equal(a.getSnapshot().can({ type: "EXIT_SEEN", exitCode: 0 }), false);
	assert.equal(a.getSnapshot().can({ type: "DEADLINE_HIT" }), false);
	assert.equal(a.getSnapshot().can({ type: "KILL" }), false);
});

// --- running → terminal -----------------------------------------------------
ok("EXIT_SEEN 0 → success, exit code recorded", () => {
	const a = makeActor();
	spawnOk(a);
	a.send({ type: "EXIT_SEEN", exitCode: 0 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.exitCode, 0);
});

ok("EXIT_SEEN nonzero → error, exit code recorded", () => {
	const a = makeActor();
	spawnOk(a);
	a.send({ type: "EXIT_SEEN", exitCode: 2 });
	assert.equal(a.getSnapshot().value, "error");
	assert.equal(a.getSnapshot().context.exitCode, 2);
});

ok("SESSION_DEAD → error with died-without-signal detail, no exit code", () => {
	const a = makeActor();
	spawnOk(a);
	a.send({ type: "SESSION_DEAD" });
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail!, /died without writing an exit code/);
	assert.equal(a.getSnapshot().context.exitCode, null);
});

ok("DEADLINE_HIT → timeout", () => {
	const a = makeActor();
	spawnOk(a);
	a.send({ type: "DEADLINE_HIT" });
	assert.equal(a.getSnapshot().value, "timeout");
	assert.equal(a.getSnapshot().context.exitCode, null);
});

ok("KILL → aborted with summary", () => {
	const a = makeActor();
	spawnOk(a);
	a.send({ type: "KILL" });
	assert.equal(a.getSnapshot().value, "aborted");
	assert.equal(a.getSnapshot().context.summary, "Aborted by user");
});

ok("running: COLLECT_DONE rejected (collect only after terminal)", () => {
	const a = makeActor();
	spawnOk(a);
	assert.equal(a.getSnapshot().can({ type: "COLLECT_DONE", artifacts: [], stderr: "" }), false);
});

// --- collect ------------------------------------------------------------------
ok("COLLECT_DONE stores artifacts, stderr, summary; recorded once", () => {
	const a = makeActor();
	begin(a, { artifactPaths: ["out.txt", "gone.txt"] });
	a.send({ type: "SPAWN_OK" });
	a.send({ type: "EXIT_SEEN", exitCode: 0 });
	const artifacts: ArtifactEntry[] = [
		{ path: "out.txt", content: "line1\nline2", missing: false },
		{ path: "gone.txt", content: "", missing: true },
	];
	collect(a, artifacts);
	const c = a.getSnapshot().context;
	assert.deepEqual(c.artifacts, artifacts);
	assert.equal(c.collected, true);
	assert.match(c.summary, /Collected 1\/2 artifacts/);
	assert.match(c.summary, /Missing: gone\.txt/);
	// second collect rejected
	assert.equal(a.getSnapshot().can({ type: "COLLECT_DONE", artifacts: [], stderr: "" }), false);
});

ok("collect builds summary from declared paths, not just entries", () => {
	const a = makeActor();
	begin(a, { artifactPaths: ["a.txt", "b.txt", "c.txt"] });
	a.send({ type: "SPAWN_OK" });
	a.send({ type: "EXIT_SEEN", exitCode: 0 });
	collect(a, [{ path: "a.txt", content: "x", missing: false }]);
	assert.match(a.getSnapshot().context.summary, /Collected 1\/3 artifacts/);
});

// --- buildSummary (pure) -------------------------------------------------------
ok("buildSummary: all, some missing, none declared", () => {
	assert.equal(
		buildSummary(["a.txt"], [{ path: "a.txt", content: "x", missing: false }]),
		"Collected 1/1 artifacts.",
	);
	assert.equal(
		buildSummary([], []),
		"Collected 0/0 artifacts.",
	);
	assert.match(
		buildSummary(["a.txt", "b.txt"], [
			{ path: "a.txt", content: "", missing: true },
			{ path: "b.txt", content: "", missing: true },
		]),
		/Missing: a\.txt, b\.txt/,
	);
});

// --- statusOf -------------------------------------------------------------------
ok("statusOf: terminal states pass through, others collapse to running", () => {
	assert.equal(statusOf("success"), "success");
	assert.equal(statusOf("error"), "error");
	assert.equal(statusOf("timeout"), "timeout");
	assert.equal(statusOf("aborted"), "aborted");
	assert.equal(statusOf("idle"), "running");
	assert.equal(statusOf("spawning"), "running");
	assert.equal(statusOf("running"), "running");
});

// --- snapshot restore -------------------------------------------------------------
ok("persisted snapshot restores terminal state + collected context", () => {
	const a = makeActor();
	spawnOk(a);
	a.send({ type: "EXIT_SEEN", exitCode: 0 });
	collect(a, [{ path: "out.txt", content: "done", missing: false }]);
	const persisted = a.getPersistedSnapshot();

	const b = createActor(delegateMachine, { snapshot: persisted as never });
	b.start();
	assert.equal(b.getSnapshot().value, "success");
	const c = b.getSnapshot().context;
	assert.equal(c.exitCode, 0);
	assert.equal(c.sessionId, "delegate-1-abcd");
	assert.equal(c.collected, true);
	assert.equal(c.artifacts.length, 1);
	assert.match(c.summary, /Collected 1\/1/);
	// collect-once rule survives restore
	assert.equal(b.getSnapshot().can({ type: "COLLECT_DONE", artifacts: [], stderr: "" }), false);
	// terminal: no new lifecycle events
	assert.equal(b.getSnapshot().can({ type: "EXIT_SEEN", exitCode: 0 }), false);
	assert.equal(b.getSnapshot().can({ type: "KILL" }), false);
});

ok("persisted snapshot restores running state with live transitions", () => {
	const a = makeActor();
	spawnOk(a);
	const persisted = a.getPersistedSnapshot();

	const b = createActor(delegateMachine, { snapshot: persisted as never });
	b.start();
	assert.equal(b.getSnapshot().value, "running");
	assert.equal(b.getSnapshot().can({ type: "EXIT_SEEN", exitCode: 0 }), true);
	assert.equal(b.getSnapshot().can({ type: "DEADLINE_HIT" }), true);
	b.send({ type: "DEADLINE_HIT" });
	assert.equal(b.getSnapshot().value, "timeout");
	assert.equal(b.getSnapshot().can({ type: "COLLECT_DONE", artifacts: [], stderr: "" }), true);
});

ok("initialContext is a clean slate", () => {
	assert.deepEqual(initialContext().artifactPaths, []);
	assert.equal(initialContext().exitCode, null);
	assert.equal(initialContext().collected, false);
	assert.equal(initialContext().failureDetail, null);
});

console.log(`\n${passed} tests passed`);
