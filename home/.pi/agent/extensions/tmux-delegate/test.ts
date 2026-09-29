/**
 * Machine tests — run without an LLM, tmux, or Docker:
 *   node test.ts
 *
 * Service slots are provided with controllable stubs (machine.provide) —
 * no executor runs. The stubs record their inputs (evidence parity), observe
 * their AbortSignal (KILL aborts), and decide outcomes, so the full
 * machine-driven lifecycle — spawn → monitor → collect, exit/dead/deadline
 * routing, KILL-in-spawning/running, collect-on-three-transitions — is
 * testable deterministically. The old shape kept the poll loop in the tool:
 * untestable here. Now the lifecycle is machine-side and covered.
 */
import assert from "node:assert/strict";
import { createActor, type Actor, fromPromise, waitFor } from "xstate";
import {
	buildSummary,
	delegateMachine,
	initialContext,
	type ArtifactEntry,
	type CollectServiceInput,
	type CollectServiceOutput,
	type DelegateContext,
	type MonitorServiceInput,
	type MonitorServiceOutput,
	type SpawnServiceInput,
	type SpawnServiceOutput,
	type SpawnFiles,
	paramsViolation,
	statusOf,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Controllable stubs (slide-deck test pattern)
// ---------------------------------------------------------------------------

type StubState = {
	spawnInputs: SpawnServiceInput[];
	monitorInputs: MonitorServiceInput[];
	collectInputs: CollectServiceInput[];
	/** AbortSignals observed by each service (spawn, monitor). */
	aborted: { spawn: boolean; monitor: boolean };
	spawnNext: (input: SpawnServiceInput) => Promise<SpawnServiceOutput>;
	monitorNext: (input: MonitorServiceInput) => Promise<MonitorServiceOutput>;
	collectNext: (input: CollectServiceInput) => Promise<CollectServiceOutput>;
};

const FILES: SpawnFiles = {
	signalFile: "/tmp/delegate/signal",
	stderrFile: "/tmp/delegate/stderr",
	taskFile: "/tmp/delegate/task",
	scriptFile: "/tmp/delegate/script",
	promptFile: null,
};

function makeStubs(
	over: Partial<{
		spawn: StubState["spawnNext"];
		monitor: StubState["monitorNext"];
		collect: StubState["collectNext"];
	}> = {},
): StubState {
	const stub: StubState = {
		spawnInputs: [],
		monitorInputs: [],
		collectInputs: [],
		aborted: { spawn: false, monitor: false },
		spawnNext:
			over.spawn ??
			(async (input) => ({
				sessionId: input.sessionId,
				socketPath: input.socketPath,
				files: FILES,
			})),
		monitorNext: over.monitor ?? (async () => ({ kind: "exit", exitCode: 0 })),
		collectNext:
			over.collect ??
			(async (input) => ({
				artifacts: input.artifactPaths.map((path) => ({
					path,
					content: `content of ${path}`,
					missing: false,
				})),
				stderr: "",
			})),
	};
	return stub;
}

function makeMachine(stub: StubState) {
	return delegateMachine.provide({
		actors: {
			spawnService: fromPromise<SpawnServiceOutput, SpawnServiceInput>(
				async ({ input, signal }) => {
					stub.spawnInputs.push(input);
					signal.addEventListener("abort", () => {
						stub.aborted.spawn = true;
					});
					return stub.spawnNext(input);
				},
			),
			monitorService: fromPromise<MonitorServiceOutput, MonitorServiceInput>(
				async ({ input, signal }) => {
					stub.monitorInputs.push(input);
					signal.addEventListener("abort", () => {
						stub.aborted.monitor = true;
					});
					return stub.monitorNext(input);
				},
			),
			collectService: fromPromise<CollectServiceOutput, CollectServiceInput>(
				async ({ input }) => {
					stub.collectInputs.push(input);
					return stub.collectNext(input);
				},
			),
		},
	});
}

type M = ReturnType<typeof makeMachine>;
type A = Actor<M>;

function makeActor(stub: StubState = makeStubs()): A {
	const a = createActor(makeMachine(stub));
	a.start();
	return a;
}

function begin(a: A, overrides: Record<string, unknown> = {}) {
	a.send({
		type: "BEGIN_DELEGATION",
		sessionId: "delegate-1-abcd",
		socketPath: "/tmp/agent-tmux-sockets/agent.sock",
		task: "Write results to out.txt",
		monitor: false,
		timeoutSecs: 300,
		workingDir: "/tmp/work",
		artifactPaths: ["out.txt"],
		launch: { socketDir: "/tmp/agent-tmux-sockets", agentPrompt: null, parentPid: 42, pi: { command: "pi", args: [] } },
		...overrides,
	});
}

function beginBad(a: A, overrides: Record<string, unknown> = {}) {
	begin(a, { task: "t", timeoutSecs: 10, artifactPaths: ["a.txt"], ...overrides });
}

/** Settled: terminal + collected (spawn-fail error: no collect, settled at terminal). */
function settled(s: A extends never ? never : ReturnType<A["getSnapshot"]>): boolean {
	if (s.matches("aborted")) return true;
	if (!(s.matches("success") || s.matches("error") || s.matches("timeout"))) return false;
	return s.context.files === null || s.context.collected;
}

async function drive(stub: StubState = makeStubs()): Promise<A> {
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => settled(s));
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

// --- idle / begin ------------------------------------------------------------

await ok("idle: BEGIN legal; KILL illegal (nothing to abort)", () => {
	const a = makeActor();
	assert.equal(a.getSnapshot().can({ type: "KILL" }), false);
	begin(a);
	assert.equal(a.getSnapshot().value, "spawning");
});

await ok("idle: illegal BEGIN rejected (validator shared with tool precheck)", () => {
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
		launch: { socketDir: "/d", agentPrompt: null, parentPid: 1, pi: { command: "pi", args: [] } },
	});
	assert.equal(a.getSnapshot().value, "idle");
	assert.equal(a.getSnapshot().context.sessionId, "");
});

await ok("BEGIN stores delegation params in context (launch stays out of the snapshot)", () => {
	const a = makeActor();
	begin(a);
	const c = a.getSnapshot().context;
	assert.equal(a.getSnapshot().value, "spawning");
	assert.equal(c.sessionId, "delegate-1-abcd");
	assert.equal(c.task, "Write results to out.txt");
	assert.equal(c.timeoutSecs, 300);
	assert.deepEqual(c.artifactPaths, ["out.txt"]);
	assert.equal(c.monitor, false);
	assert.equal(c.workingDir, "/tmp/work");
	assert.equal(c.files, null); // spawn not done yet
	assert.deepEqual(Object.keys(initialContext()).includes("launch"), false);
});

await ok("second BEGIN rejected — one delegation per actor", () => {
	const a = makeActor();
	begin(a);
	beginBad(a, { sessionId: "delegate-2-efgh" });
	assert.equal(a.getSnapshot().value, "spawning");
	assert.equal(a.getSnapshot().context.sessionId, "delegate-1-abcd");
});

// --- paramsViolation (pure validator — unchanged) -----------------------------

await ok("paramsViolation: empty task / bad timeout / empty + dup + too many artifacts", () => {
	assert.match(paramsViolation("", 300, [])!, /task is empty/);
	assert.match(paramsViolation("  ", 300, [])!, /task is empty/);
	assert.equal(paramsViolation("do work", 300, []), null);
	assert.match(paramsViolation("t", 0, [])!, /timeout must be a positive number/);
	assert.match(paramsViolation("t", -5, [])!, /timeout must be a positive number/);
	assert.match(paramsViolation("t", 10, [""])!, /must be non-empty strings/);
	assert.match(paramsViolation("t", 10, new Array(65).fill("f").map((_, i) => `f${i}.txt`))!, /too many artifact paths/);
	assert.match(paramsViolation("t", 10, ["a", "a"])!, /duplicate artifact paths/);
	assert.equal(paramsViolation("t", 10, ["a", "b"]), null);
});

await ok("buildSummary: collected/missing/unreadable counts", () => {
	const arts: ArtifactEntry[] = [
		{ path: "a.txt", content: "x", missing: false },
		{ path: "b.txt", content: "", missing: true },
		{ path: "c.txt", content: "", missing: false, readError: "EISDIR" },
	];
	assert.equal(buildSummary(["a.txt", "b.txt", "c.txt"], arts), "Collected 1/3 artifacts. Missing: b.txt. Unreadable: c.txt.");
	assert.equal(buildSummary(["a.txt"], [{ path: "a.txt", content: "x", missing: false }]), "Collected 1/1 artifacts.");
});

await ok("statusOf: terminal names pass through; the rest collapse to running", () => {
	assert.equal(statusOf("success"), "success");
	assert.equal(statusOf("error"), "error");
	assert.equal(statusOf("timeout"), "timeout");
	assert.equal(statusOf("aborted"), "aborted");
	assert.equal(statusOf("idle"), "running");
	assert.equal(statusOf("spawning"), "running");
	assert.equal(statusOf("running"), "running");
});

// --- happy path: spawn → monitor → collect (machine-driven) --------------------

await ok("exit 0 → success; artifacts collected; summary built; evidence parity", async () => {
	const stub = makeStubs();
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "success");
	const c = a.getSnapshot().context;
	assert.equal(c.exitCode, 0);
	assert.equal(c.collected, true);
	assert.deepEqual(
		c.artifacts.map((x) => x.path),
		["out.txt"],
	);
	assert.equal(c.summary, "Collected 1/1 artifacts.");
	assert.equal(c.failureDetail, null);
	// spawn input parity: launch params flow through the event
	assert.equal(stub.spawnInputs.length, 1);
	assert.deepEqual(stub.spawnInputs[0]!.launch, {
		socketDir: "/tmp/agent-tmux-sockets",
		agentPrompt: null,
		parentPid: 42,
		pi: { command: "pi", args: [] },
	});
	assert.equal(stub.spawnInputs[0]!.sessionId, "delegate-1-abcd");
	// monitor input parity: context-derived (files recorded from spawn output)
	assert.equal(stub.monitorInputs.length, 1);
	assert.equal(stub.monitorInputs[0]!.files.signalFile, FILES.signalFile);
	assert.equal(stub.monitorInputs[0]!.sessionId, "delegate-1-abcd");
	assert.equal(stub.monitorInputs[0]!.timeoutSecs, 300);
	// collect input parity: artifacts/workingDir/stderrFile from context
	assert.equal(stub.collectInputs.length, 1);
	assert.deepEqual(stub.collectInputs[0]!.artifactPaths, ["out.txt"]);
	assert.equal(stub.collectInputs[0]!.workingDir, "/tmp/work");
	assert.equal(stub.collectInputs[0]!.stderrFile, FILES.stderrFile);
});

await ok("exit 0 → monitor input derives socketPath/sessionId from context", async () => {
	const stub = makeStubs();
	const a = await drive(stub);
	assert.equal(stub.monitorInputs[0]!.socketPath, "/tmp/agent-tmux-sockets/agent.sock");
	assert.equal(a.getSnapshot().context.files, FILES);
});

await ok("exit != 0 → error; exitCode recorded; artifacts collected", async () => {
	const stub = makeStubs({ monitor: async () => ({ kind: "exit", exitCode: 137 }) });
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "error");
	assert.equal(a.getSnapshot().context.exitCode, 137);
	assert.equal(a.getSnapshot().context.collected, true);
	assert.equal(a.getSnapshot().context.failureDetail, null);
});

await ok("session dead → error with readable failureDetail; collect still runs", async () => {
	const stub = makeStubs({ monitor: async () => ({ kind: "dead" }) });
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail ?? "", /died without writing an exit code/);
	assert.equal(a.getSnapshot().context.collected, true);
});

await ok("deadline → timeout; collect runs after the deadline kill", async () => {
	const stub = makeStubs({ monitor: async () => ({ kind: "deadline" }) });
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "timeout");
	assert.equal(a.getSnapshot().context.collected, true);
	assert.equal(a.getSnapshot().context.exitCode, null);
});

// --- spawn failure -------------------------------------------------------------

await ok("spawn fail → error with failureDetail; NO collect (task never ran)", async () => {
	const stub = makeStubs({
		spawn: async () => {
			throw new Error("tmux server not running");
		},
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => settled(s));
	assert.equal(a.getSnapshot().value, "error");
	const c = a.getSnapshot().context;
	assert.match(c.failureDetail ?? "", /Failed to create tmux session: tmux server not running/);
	assert.equal(c.collected, false);
	assert.equal(c.artifacts.length, 0);
	assert.equal(c.files, null);
	assert.equal(stub.collectInputs.length, 0); // collect never invoked
});

// --- abort (KILL) ---------------------------------------------------------------

await ok("KILL during running → aborted; NO collect; monitor AbortSignal fires", async () => {
	const gate = { resolve: (_: MonitorServiceOutput) => {} };
	const stub = makeStubs({
		monitor: () =>
			new Promise<MonitorServiceOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"));
	a.send({ type: "KILL" });
	assert.equal(a.getSnapshot().value, "aborted");
	assert.equal(a.getSnapshot().context.summary, "Aborted by user");
	assert.equal(a.getSnapshot().context.collected, false);
	assert.equal(stub.collectInputs.length, 0);
	// exiting `running` aborted the monitor service
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(stub.aborted.monitor, true);
	// late monitor result: no handler in aborted — dropped
	gate.resolve({ kind: "exit", exitCode: 0 });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(a.getSnapshot().value, "aborted");
	assert.equal(a.getSnapshot().context.exitCode, null);
});

await ok("KILL during spawning → aborted; spawn AbortSignal fires; late spawn dropped", async () => {
	const gate = { resolve: (_: SpawnServiceOutput) => {} };
	const stub = makeStubs({
		spawn: () =>
			new Promise<SpawnServiceOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	assert.equal(a.getSnapshot().value, "spawning");
	a.send({ type: "KILL" });
	assert.equal(a.getSnapshot().value, "aborted");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(stub.aborted.spawn, true);
	assert.equal(stub.collectInputs.length, 0);
	// late spawn result: dropped — no handler in aborted
	gate.resolve({ sessionId: "late", socketPath: "late", files: FILES });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(a.getSnapshot().value, "aborted");
	assert.equal(a.getSnapshot().context.files, null);
});

await ok("late KILL after terminal is dropped; terminal is final", async () => {
	const a = await drive();
	a.send({ type: "KILL" });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.summary, "Collected 1/1 artifacts.");
});

// --- collect failure -------------------------------------------------------------

await ok("collect fail → empty artifacts, error as stderr, collected still true", async () => {
	const stub = makeStubs({
		collect: async () => {
			throw new Error("EACCES on stderr file");
		},
	});
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "success"); // task succeeded; only collection failed
	const c = a.getSnapshot().context;
	assert.equal(c.collected, true);
	assert.equal(c.artifacts.length, 0);
	assert.match(c.stderr, /collection failed: EACCES/);
	assert.match(c.summary, /Collection failed: EACCES/);
});

await ok("collect with missing artifacts → summary names them", async () => {
	const stub = makeStubs({
		collect: async (input) => ({
			artifacts: input.artifactPaths.map((path) => ({ path, content: "", missing: true })),
			stderr: "",
		}),
	});
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "success");
	assert.match(a.getSnapshot().context.summary, /Collected 0\/1 artifacts\. Missing: out\.txt\./);
});

// --- unwired machine ---------------------------------------------------------------

await ok("unwired machine: entering spawning lands in error with a readable reason", async () => {
	const a = createActor(delegateMachine);
	a.start();
	begin(a);
	await waitFor(a, (s) => s.matches("error"));
	assert.match(a.getSnapshot().context.failureDetail ?? "", /spawnService not wired/);
	assert.equal(a.getSnapshot().context.collected, false);
});

// --- terminal stability --------------------------------------------------------------

await ok("terminal states are final: duplicate begin/kill events dropped", async () => {
	const a = await drive();
	beginBad(a, { sessionId: "again" });
	a.send({ type: "KILL" });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.sessionId, "delegate-1-abcd");
});

console.log(`\n${passed} tests passed${failed > 0 ? `, ${failed} failed` : ""}`);
if (failed > 0) process.exit(1);
