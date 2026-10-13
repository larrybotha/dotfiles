/**
 * Machine tests — run without an LLM, child process, or watchdog:
 *   node test.ts
 *
 * Controllable stubs: services record
 * their inputs (evidence parity), observe their AbortSignal, and decide
 * outcomes. The full matrix from the plan is covered deterministically:
 * spawn/handshake/prompt failures, handled/started/queued dispositions, fast
 * settled race, provider error after accepted prompt, auto-retry then settle,
 * CHILD_DEAD in every state, deadline ladder, KILL in every legal state,
 * stall detection (STALL_DETECTED → ladder → timeout), artifact-policy
 * routing, evidence rings, terminal stability, duration evidence
 * (begin/run-start/run-end/terminal stamps, ordering, pre-run nullity,
 * formatters).
 */
import assert from "node:assert/strict";
import { createActor, type Actor, fromPromise, waitFor } from "xstate";
import {
	buildSummary,
	evaluateSuccess,
	formatDuration,
	initialContext,
	paramsViolation,
	rpcMachine,
	runDurationMs,
	statusOf,
	totalDurationMs,
	stopReasonFails,
	summaryForSnapshot,
	type ArtifactEntry,
	type CancelInput,
	type CancelOutput,
	type CollectInput,
	type CollectOutput,
	type HandshakeInput,
	type HandshakeOutput,
	type PromptInput,
	type PromptOutput,
	type RpcContext,
	type RpcEvent,
	type SpawnInput,
	type SpawnOutput,
	type StopInput,
	type StopOutput,
	type TransportEvidence,
	type TransportHandle,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Controllable stubs
// ---------------------------------------------------------------------------

class FakeTransport implements TransportHandle {
	commands: { cmd: Record<string, unknown>; timeoutMs: number }[] = [];
	killed = false;
	private dead = false;
	private replies: Record<string, () => Record<string, unknown>>;
	constructor(replies: Record<string, () => Record<string, unknown>> = {}) {
		this.replies = replies;
	}
	async sendCommand(cmd: Record<string, unknown>, timeoutMs: number) {
		this.commands.push({ cmd, timeoutMs });
		const reply = this.replies[typeof cmd.type === "string" ? cmd.type : ""]?.() ?? {
			success: true,
			data: {},
		};
		return { ...reply } as { success: boolean; data?: Record<string, unknown>; error?: string };
	}
	alive() {
		return !this.dead;
	}
	closeStdin() {}
	killTerm() {
		this.killed = true;
	}
	killKill() {
		this.killed = true;
		this.dead = true;
	}
	killHard() {
		this.killed = true;
		this.dead = true;
	}
	childPid() {
		return 4242;
	}
	async waitForExit(ms: number): Promise<boolean> {
		return ms >= 0; // fake: exits immediately
	}
	exitCode() {
		return this.dead ? 137 : 0;
	}
	pid() {
		return 4242;
	}
	getEvidence(): TransportEvidence {
		return {
			stderrTail: "",
			assistantTextTail: "",
			lastUsage: null,
			uiAutoCancelled: 0,
			fatalReason: null,
			lastRecordAt: null,
			openTools: 0,
		};
	}
}

type StubState = {
	spawnInputs: SpawnInput[];
	handshakeInputs: HandshakeInput[];
	promptInputs: PromptInput[];
	collectInputs: CollectInput[];
	cancelInputs: CancelInput[];
	stopInputs: StopInput[];
	aborted: { spawn: boolean; handshake: boolean; prompt: boolean };
	transport: FakeTransport;
	spawnNext: (input: SpawnInput) => Promise<SpawnOutput>;
	handshakeNext: (input: HandshakeInput) => Promise<HandshakeOutput>;
	promptNext: (input: PromptInput) => Promise<PromptOutput>;
	collectNext: (input: CollectInput) => Promise<CollectOutput>;
	cancelNext: (input: CancelInput) => Promise<CancelOutput>;
	stopNext: (input: StopInput) => Promise<StopOutput>;
};

function makeStubs(
	over: Partial<{
		spawn: StubState["spawnNext"];
		handshake: StubState["handshakeNext"];
		prompt: StubState["promptNext"];
		collect: StubState["collectNext"];
		cancel: StubState["cancelNext"];
		stop: StubState["stopNext"];
		transport: FakeTransport;
	}> = {},
): StubState {
	const transport = over.transport ?? new FakeTransport();
	return {
		spawnInputs: [],
		handshakeInputs: [],
		promptInputs: [],
		collectInputs: [],
		cancelInputs: [],
		stopInputs: [],
		aborted: { spawn: false, handshake: false, prompt: false },
		transport,
		spawnNext:
			over.spawn ??
			(async () => ({ pid: 4242, transport })),
		handshakeNext:
			over.handshake ??
			(async () => ({ sessionId: "child-session-1", modelId: "fake/model" })),
		promptNext: over.prompt ?? (async () => ({ disposition: "started" })),
		collectNext:
			over.collect ??
			(async (input) => ({
				artifacts: input.artifactPaths.map((p) => ({
					path: p,
					content: `content of ${p}`,
					missing: false,
				})) as ArtifactEntry[],
			})),
		cancelNext: over.cancel ?? (async () => ({ exitCode: 137 })),
		stopNext: over.stop ?? (async () => ({ exitCode: 0, usage: null })),
	};
}

function makeMachine(stub: StubState) {
	return rpcMachine.provide({
		actors: {
			spawnService: fromPromise<SpawnOutput, SpawnInput>(async ({ input, signal }) => {
				stub.spawnInputs.push(input);
				signal.addEventListener("abort", () => {
					stub.aborted.spawn = true;
				});
				return stub.spawnNext(input);
			}),
			handshakeService: fromPromise<HandshakeOutput, HandshakeInput>(async ({ input, signal }) => {
				stub.handshakeInputs.push(input);
				signal.addEventListener("abort", () => {
					stub.aborted.handshake = true;
				});
				return stub.handshakeNext(input);
			}),
			promptService: fromPromise<PromptOutput, PromptInput>(async ({ input, signal }) => {
				stub.promptInputs.push(input);
				signal.addEventListener("abort", () => {
					stub.aborted.prompt = true;
				});
				return stub.promptNext(input);
			}),
			collectService: fromPromise<CollectOutput, CollectInput>(async ({ input }) => {
				stub.collectInputs.push(input);
				return stub.collectNext(input);
			}),
			cancelService: fromPromise<CancelOutput, CancelInput>(async ({ input }) => {
				stub.cancelInputs.push(input);
				return stub.cancelNext(input);
			}),
			stopService: fromPromise<StopOutput, StopInput>(async ({ input }) => {
				stub.stopInputs.push(input);
				return stub.stopNext(input);
			}),
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

function sinkFor(a: A): (ev: RpcEvent) => void {
	return (ev) => a.send(ev);
}

function begin(a: A, overrides: Record<string, unknown> = {}) {
	a.send({
		type: "BEGIN",
		sessionId: "rpc-delegate-1-abcd",
		task: "Write results to out.txt",
		agentPrompt: null,
		provider: null,
		model: null,
		tools: null,
		artifactPolicy: "stopReason",
		timeoutSecs: 300,
		workingDir: "/tmp/work",
		artifactPaths: ["out.txt"],
		launch: {
			pi: { command: "pi", args: [] },
			parentPid: 42,
			sink: sinkFor(a),
			watchdogPath: "/tmp/watchdog.mjs",
			stallGapMs: 180_000,
			heartbeatPath: null,
		},
		...overrides,
	} as never);
}

/** Settled: any final state (every path — spawn-fail included — ends in one).
 *  Drives the full happy-path event sequence so the run-deadline timer is
 *  cleared on state exit (lingering 300s timers would hang the process). */
async function drive(stub: StubState = makeStubs()): Promise<A> {
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_START" });
	a.send({ type: "MESSAGE_END", stopReason: "stop", errorMessage: null });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	return a;
}

function isFinal(s: ReturnType<A["getSnapshot"]>): boolean {
	return s.matches("success") || s.matches("error") || s.matches("timeout") || s.matches("aborted");
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

// --- idle / begin -----------------------------------------------------------

await ok("idle: BEGIN legal; KILL illegal (nothing to abort)", () => {
	const a = makeActor();
	assert.equal(a.getSnapshot().can({ type: "KILL" }), false);
	begin(a);
	assert.equal(a.getSnapshot().value, "spawning");
	a.stop(); // abandoned actors would hold the loop with their deadline timers
});

await ok("idle: illegal BEGIN rejected (validator shared with the tool precheck)", () => {
	const a = makeActor();
	a.send({
		type: "BEGIN",
		sessionId: "s",
		task: "   ",
		agentPrompt: null,
		provider: null,
		model: null,
		tools: null,
		artifactPolicy: "stopReason",
		timeoutSecs: 300,
		workingDir: "w",
		artifactPaths: [],
		launch: { pi: { command: "pi", args: [] }, parentPid: 1, sink: sinkFor(a), watchdogPath: "/w", stallGapMs: 180_000, heartbeatPath: null },
	} as never);
	assert.equal(a.getSnapshot().value, "idle");
	assert.equal(a.getSnapshot().context.sessionId, "");
});

await ok("BEGIN stores params in context (launch stays out of the snapshot)", () => {
	const a = makeActor();
	begin(a);
	const c = a.getSnapshot().context;
	assert.equal(c.sessionId, "rpc-delegate-1-abcd");
	assert.equal(c.task, "Write results to out.txt");
	assert.equal(c.timeoutSecs, 300);
	assert.deepEqual(c.artifactPaths, ["out.txt"]);
	assert.equal(c.workingDir, "/tmp/work");
	assert.equal(c.artifactPolicy, "stopReason");
	assert.deepEqual(Object.keys(initialContext()).includes("launch"), false);
	a.stop(); // abandoned actors would hold the loop with their deadline timers
});

await ok("duration evidence: happy path stamps begin/run-start/run-end/ended in order (run ≤ total)", async () => {
	const a = await drive();
	const c = a.getSnapshot().context;
	assert.notEqual(c.beginAt, null);
	assert.notEqual(c.runStartedAt, null);
	assert.notEqual(c.runEndedAt, null);
	assert.notEqual(c.endedAt, null);
	assert.ok(c.beginAt! <= c.runStartedAt!, "begin ≤ run start");
	assert.ok(c.runStartedAt! <= c.runEndedAt!, "run start ≤ run end");
	assert.ok(c.runEndedAt! <= c.endedAt!, "run end ≤ terminal");
	assert.ok(runDurationMs(c)! <= totalDurationMs(c)!, "run ≤ total");
});

await ok("duration evidence: pre-run abort leaves runDuration null, total stamped", async () => {
	const a = makeActor();
	begin(a);
	a.send({ type: "KILL" }); // spawning → cancelling (aborted before any run)
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	const c = a.getSnapshot().context;
	assert.equal(c.outcome, "aborted");
	assert.equal(c.runStartedAt, null);
	assert.equal(runDurationMs(c), null);
	assert.notEqual(totalDurationMs(c), null);
});

await ok("duration helpers: formatDuration boundaries", () => {
	assert.equal(formatDuration(0), "1s");
	assert.equal(formatDuration(42_400), "42s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(61_000), "1m 01s");
	assert.equal(formatDuration(3_725_000), "1h 02m 05s");
});

await ok("second BEGIN rejected — one delegation per actor", () => {
	const a = makeActor();
	begin(a);
	begin(a, { sessionId: "rpc-delegate-2-efgh" });
	assert.equal(a.getSnapshot().context.sessionId, "rpc-delegate-1-abcd");
	a.stop(); // abandoned actors would hold the loop with their deadline timers
});

await ok("agentPrompt travels at the event top level — context evidence + spawn input parity", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a, { agentPrompt: "Prefer terse output" });
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_START" });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.agentPrompt, "Prefer terse output");
	assert.equal(stub.spawnInputs[0]!.agentPrompt, "Prefer terse output");
	assert.equal("agentPrompt" in stub.spawnInputs[0]!.launch, false);
});

// --- pure helpers -------------------------------------------------------------

await ok("paramsViolation: task/timeout/artifacts/provider-model/tools/policy", () => {
	assert.match(paramsViolation("", 300, [], null, null, null, "stopReason")!, /task is empty/);
	assert.equal(paramsViolation("do work", 300, [], null, null, null, "stopReason"), null);
	assert.match(paramsViolation("t", 0, [], null, null, null, "stopReason")!, /positive number of seconds/);
	assert.match(paramsViolation("t", 10, ["", "a"], null, null, null, "stopReason")!, /non-empty strings/);
	assert.match(
		paramsViolation("t", 10, new Array(65).fill("f").map((_, i) => `f${i}`), null, null, null, "stopReason")!,
		/too many artifact paths/,
	);
	assert.match(paramsViolation("t", 10, ["a", "a"], null, null, null, "stopReason")!, /duplicate/);
	assert.match(paramsViolation("t", 10, [], "anthropic", null, null, "stopReason")!, /provider requires model/);
	assert.match(paramsViolation("t", 10, [], null, null, ["", "x"], "stopReason")!, /non-empty strings/);
	assert.match(paramsViolation("t", 10, [], null, null, new Array(33).fill("t"), "stopReason")!, /too many tools/);
	assert.match(paramsViolation("t", 10, [], null, null, null, "bogus")!, /artifactPolicy/);
	assert.equal(paramsViolation("t", 10, ["a"], "anthropic", "claude-x", ["read", "bash"], "artifacts"), null);
});

const A_OK: ArtifactEntry = { path: "out.txt", content: "x", missing: false };

await ok("evaluateSuccess + stopReasonFails: settled semantics (not settled ≠ success)", () => {
	const base = initialContext();
	// happy
	assert.equal(
		evaluateSuccess({
			...base,
			promptDisposition: "started",
			runStartedSeen: true,
			agentSettledSeen: true,
			lastAssistantStopReason: "stop",
		}).ok,
		true,
	);
	// no run started
	assert.match(
		evaluateSuccess({ ...base, promptDisposition: "started", agentSettledSeen: true }).reason!,
		/no agent run started/,
	);
	// not settled
	assert.match(
		evaluateSuccess({ ...base, promptDisposition: "started", runStartedSeen: true }).reason!,
		/never settled/,
	);
	// provider error after accepted prompt → error, not success
	const errored = {
		...base,
		promptDisposition: "started",
		runStartedSeen: true,
		agentSettledSeen: true,
		lastAssistantStopReason: "error",
		lastAssistantError: "529 overloaded",
	};
	assert.equal(evaluateSuccess(errored).ok, false);
	assert.match(evaluateSuccess(errored).reason!, /529 overloaded/);
	// artifact policy trumps the bad stopReason only when artifacts collected
	assert.equal(evaluateSuccess({ ...errored, artifactPolicy: "artifacts", artifacts: [A_OK] }).ok, true);
	assert.equal(evaluateSuccess({ ...errored, artifacts: [A_OK] }).ok, false); // default stopReason wins
	// handled → never success
	assert.match(evaluateSuccess({ ...base, promptDisposition: "handled" }).reason!, /input handler/);
	// "length"/"deferred" are surfaced notes, not failures (plan: error/abort only)
	assert.equal(stopReasonFails("length"), false);
	assert.equal(stopReasonFails("error"), true);
	assert.equal(stopReasonFails("aborted"), true);
	assert.equal(stopReasonFails("pending"), true);
});


await ok("statusOf: terminal names pass through; the rest collapse to running", () => {
	assert.equal(statusOf("success"), "success");
	assert.equal(statusOf("error"), "error");
	assert.equal(statusOf("timeout"), "timeout");
	assert.equal(statusOf("aborted"), "aborted");
	for (const s of ["idle", "spawning", "handshaking", "prompting", "running", "collecting", "cancelling", "stopping"]) {
		assert.equal(statusOf(s), "running");
	}
});

await ok("summaryForSnapshot: non-final states get a progress line, never a premature 'run failed'", () => {
	const c = { ...initialContext(), promptDisposition: "started", runStartedSeen: true };
	for (const state of ["handshaking", "prompting", "running", "cancelling", "collecting", "stopping"]) {
		const summary = summaryForSnapshot(state, c, "");
		assert.match(summary, new RegExp(`^in progress \\(${state}\\)`), `state ${state}: ${summary}`);
		assert.doesNotMatch(summary, /run failed/);
	}
});

await ok("summaryForSnapshot: terminal states — failureDetail, collect summary, tail, reason", () => {
	// failureDetail wins on every terminal
	assert.equal(summaryForSnapshot("timeout", { ...initialContext(), failureDetail: "boom" }, "x"), "boom");
	// collect summary (abort/deadline still collect — buildSummary text)
	assert.equal(
		summaryForSnapshot("aborted", { ...initialContext(), summary: "Collected 1/1 artifacts." }, ""),
		"Collected 1/1 artifacts.",
	);
	// settled success → assistant tail, else "run completed"
	const settledOk = {
		...initialContext(),
		promptDisposition: "started",
		runStartedSeen: true,
		agentSettledSeen: true,
		lastAssistantStopReason: "stop",
	};
	assert.equal(summaryForSnapshot("success", settledOk, "PONG."), "PONG.");
	assert.equal(summaryForSnapshot("success", settledOk, ""), "run completed");
	// settled-but-failed semantics → run failed: reason
	assert.match(
		summaryForSnapshot("error", { ...settledOk, lastAssistantStopReason: "error" }, ""),
		/run failed: final assistant stopReason 'error'/,
	);
});

// --- happy path ---------------------------------------------------------------

await ok("settled run → success; evidence parity across all service inputs", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("prompting"), { timeout: 2000 });
	a.send({ type: "AGENT_START" });
	a.send({ type: "MESSAGE_END", stopReason: "stop", errorMessage: null });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	const c = a.getSnapshot().context;
	assert.equal(c.childSessionId, "child-session-1");
	assert.equal(c.childModelId, "fake/model");
	assert.equal(c.promptDisposition, "started");
	assert.equal(c.lastAssistantStopReason, "stop");
	assert.equal(c.artifacts.length, 1);
	assert.equal(c.summary, "Collected 1/1 artifacts.");
	assert.equal(c.failureDetail, null);
	// parity: launch flows through the event into spawn input only
	assert.equal(stub.spawnInputs.length, 1);
	assert.equal(stub.spawnInputs[0]!.launch.parentPid, 42);
	assert.equal(stub.spawnInputs[0]!.launch.pi.command, "pi");
	// handshake input: the transport handle from spawn output via context
	assert.equal(stub.handshakeInputs.length, 1);
	assert.equal(stub.handshakeInputs[0]!.transport, stub.transport);
	// prompt input: task from context
	assert.equal(stub.promptInputs.length, 1);
	assert.equal(stub.promptInputs[0]!.task, "Write results to out.txt");
	// collect input: artifact paths + working dir
	assert.equal(stub.collectInputs.length, 1);
	assert.deepEqual(stub.collectInputs[0]!.artifactPaths, ["out.txt"]);
	assert.equal(stub.collectInputs[0]!.workingDir, "/tmp/work");
	// stop input: usage best-effort (no session export — protocol limitation)
	assert.equal(stub.stopInputs.length, 1);
	assert.equal(c.usage, null);
});

await ok("queued disposition → run path (logged suspicious, still runs)", async () => {
	const stub = makeStubs({ prompt: async () => ({ disposition: "queued" }) });
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_START" });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.promptDisposition, "queued");
});

await ok("auto-retry then settle → success; willRetry counted", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_START" });
	a.send({ type: "AGENT_END", willRetry: true });
	a.send({ type: "AGENT_START" });
	a.send({ type: "AGENT_END", willRetry: false });
	a.send({ type: "MESSAGE_END", stopReason: "stop", errorMessage: null });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.agentEndWillRetry, 1);
});

await ok("tool + UI evidence rings: counts and last-N tool names", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	for (let i = 0; i < 12; i++) {
		a.send({ type: "TOOL_START", toolName: `tool-${i}` });
		a.send({ type: "TOOL_END", toolName: `tool-${i}`, isError: false });
	}
	a.send({ type: "EXT_UI_REQUEST", method: "confirm", title: "Proceed?" });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	const c = a.getSnapshot().context;
	assert.equal(c.toolCalls, 12);
	assert.equal(c.uiRequests, 1);
	assert.deepEqual(c.lastToolNames, ["tool-4", "tool-5", "tool-6", "tool-7", "tool-8", "tool-9", "tool-10", "tool-11"]);
});

// --- fast completion race -------------------------------------------------------

await ok("agent_settled arrives during prompting → running's always routes to collecting", async () => {
	const gate = { resolve: (_: PromptOutput) => {} };
	const stub = makeStubs({
		prompt: () =>
			new Promise<PromptOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("prompting"), { timeout: 2000 });
	// settled BEFORE the prompt response resolves — buffered evidence path
	a.send({ type: "AGENT_START" });
	a.send({ type: "MESSAGE_END", stopReason: "stop", errorMessage: null });
	a.send({ type: "AGENT_SETTLED" });
	gate.resolve({ disposition: "started" });
	// running is transient here (always fires in the same macrostep — snapshot
	// skips it): straight to final, no deadline burn
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.agentSettledSeen, true);
});

// --- provider error after accepted prompt -----------------------------------------

await ok("LLM error + settled → error, not false success (stopReason decides)", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_START" });
	a.send({ type: "MESSAGE_END", stopReason: "error", errorMessage: "529 overloaded, gave up" });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	const c = a.getSnapshot().context;
	assert.equal(c.lastAssistantStopReason, "error");
	assert.equal(c.lastAssistantError, "529 overloaded, gave up");
});

await ok("artifactPolicy=artifacts + collected artifacts forgive the bad stopReason", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a, { artifactPolicy: "artifacts" });
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_START" });
	a.send({ type: "MESSAGE_END", stopReason: "error", errorMessage: "boom" });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.artifactPolicy, "artifacts");
});

// --- handled / prompt failures -----------------------------------------------------

await ok("disposition handled → collecting immediately (error, no-run); no settle wait", async () => {
	const stub = makeStubs({
		prompt: async () => ({ disposition: "handled" }),
		collect: async (input) => ({
			artifacts: input.artifactPaths.map((p) => ({ path: p, content: "", missing: true })) as ArtifactEntry[],
		}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	const c = a.getSnapshot().context;
	assert.equal(c.promptDisposition, "handled");
	assert.match(c.failureDetail!, /input handler/);
	assert.equal(c.collected, true); // collect ran (missing artifacts)
	assert.match(c.summary, /Collected 0\/1 artifacts\. Missing: out\.txt\./);
});

await ok("prompt rejected → cancelling ladder → collect → error", async () => {
	const stub = makeStubs({
		prompt: async () => {
			throw new Error("no model available");
		},
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail!, /Prompt rejected or timed out: no model available/);
	assert.equal(stub.cancelInputs.length, 1); // the ladder ran
	assert.equal(stub.collectInputs.length, 1); // policy: cancel path collects
});

await ok("handshake fail → cancelling → collect → error (readable failureDetail)", async () => {
	const stub = makeStubs({
		handshake: async () => {
			throw new Error("get_state timed out");
		},
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("cancelling"), { timeout: 2000 });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail!, /Handshake failed/);
});

await ok("spawn fail → error directly; NO collect, NO stop (nothing ran, self-cleaned)", async () => {
	const stub = makeStubs({
		spawn: async () => {
			throw new Error("ENOENT: pi binary missing");
		},
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	const c = a.getSnapshot().context;
	assert.match(c.failureDetail!, /Failed to spawn RPC child: ENOENT/);
	assert.equal(c.transport, null);
	assert.equal(c.collected, false);
	assert.equal(stub.collectInputs.length, 0);
	assert.equal(stub.stopInputs.length, 0);
});

// --- CHILD_DEAD in every non-final state ----------------------------------------

await ok("CHILD_DEAD during spawning → error directly (no collect)", async () => {
	const gate = { resolve: (_: SpawnOutput) => {} };
	const stub = makeStubs({
		spawn: () =>
			new Promise<SpawnOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	a.send({ type: "CHILD_DEAD", code: 3, signal: null });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail!, /child process died/);
	assert.equal(a.getSnapshot().context.collected, false);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(stub.aborted.spawn, true); // exiting spawning aborted the service
	gate.resolve({ pid: 99, transport: stub.transport }); // late spawn result dropped
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(a.getSnapshot().value, "error");
	assert.equal(a.getSnapshot().context.transport, null);
});

await ok("CHILD_DEAD during handshaking → collecting (error); collect runs", async () => {
	const gate = { resolve: (_: HandshakeOutput) => {} };
	const stub = makeStubs({
		handshake: () =>
			new Promise<HandshakeOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("handshaking"), { timeout: 2000 });
	a.send({ type: "CHILD_DEAD", code: 1, signal: "SIGKILL" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	const c = a.getSnapshot().context;
	assert.match(c.failureDetail!, /child process died/);
	assert.equal(c.childExitSignal, "SIGKILL");
	assert.equal(c.collected, true);
	gate.resolve({ sessionId: null, modelId: null }); // dropped
});

await ok("CHILD_DEAD during prompting → collecting (error)", async () => {
	const gate = { resolve: (_: PromptOutput) => {} };
	const stub = makeStubs({
		prompt: () =>
			new Promise<PromptOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("prompting"), { timeout: 2000 });
	a.send({ type: "CHILD_DEAD", code: 2, signal: null });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail!, /child process died/);
});

await ok("CHILD_DEAD during running → collecting (error)", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "CHILD_DEAD", code: 9, signal: null });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "error");
	assert.match(a.getSnapshot().context.failureDetail!, /child process died/);
	assert.equal(a.getSnapshot().context.collected, true);
});

await ok("CHILD_DEAD during collecting → collect finishes, exit recorded, routes by outcome", async () => {
	const gate = { resolve: (_: CollectOutput) => {} };
	const stub = makeStubs({
		collect: () =>
			new Promise<CollectOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_SETTLED" }); // outcome settled on the way into collecting
	await waitFor(a, (s) => s.matches("collecting"), { timeout: 2000 });
	a.send({ type: "CHILD_DEAD", code: 0, signal: null }); // ignored for outcome
	gate.resolve({ artifacts: [A_OK] });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success"); // settled outcome kept
	assert.equal(a.getSnapshot().context.childExit, 0);
});

await ok("CHILD_DEAD during stopping → exit recorded; stopService output routes the final", async () => {
	const gate = { resolve: (_: StopOutput) => {} };
	const stub = makeStubs({
		stop: () =>
			new Promise<StopOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => s.matches("stopping"), { timeout: 2000 });
	// exit usually beats stopService's bounded wait: evidence recorded, no
	// routing — stopService's onDone carries usage + export
	a.send({ type: "CHILD_DEAD", code: 0, signal: null });
	assert.equal(a.getSnapshot().value, "stopping");
	assert.equal(a.getSnapshot().context.childExit, 0);
	gate.resolve({ exitCode: 0, usage: { tokens: { totalTokens: 7 }, cost: 0.001 } });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.usage?.tokens?.totalTokens, 7);
});

// --- deadline ------------------------------------------------------------------

await ok("deadline → cancelling (ladder) → timeout; deadlineHit + failureDetail", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a, { timeoutSecs: 0.05 });
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	await waitFor(a, (s) => s.matches("cancelling"), { timeout: 2000 });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "timeout");
	const c = a.getSnapshot().context;
	assert.equal(c.deadlineHit, true);
	assert.match(c.failureDetail!, /run hard cap exceeded/);
	assert.equal(stub.cancelInputs.length, 1); // ladder ran before collect
	assert.equal(stub.collectInputs.length, 1); // deadline collects (explicit policy)
});

// --- stall detection (transport liveness timer; machine receives STALL_DETECTED) ---

await ok("stall during running → cancelling (ladder) → timeout; stallHit + readable failureDetail", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "STALL_DETECTED", stallMs: 180_000 });
	await waitFor(a, (s) => s.matches("cancelling"), { timeout: 2000 });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "timeout");
	const c = a.getSnapshot().context;
	assert.equal(c.stallHit, true);
	assert.equal(c.deadlineHit, false); // stall, not the hard cap
	assert.match(c.failureDetail!, /stalled/);
	assert.match(c.failureDetail!, /no child tool running/);
	assert.equal(stub.cancelInputs.length, 1); // ladder ran before collect
	assert.equal(stub.collectInputs.length, 1); // stall outcome collects (explicit policy)
});

await ok("STALL_DETECTED during prompting → ignored (command timeouts own pre-run silence)", async () => {
	const gate = { resolve: (_: PromptOutput) => {} };
	const stub = makeStubs({
		prompt: () =>
			new Promise<PromptOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("prompting"), { timeout: 2000 });
	a.send({ type: "STALL_DETECTED", stallMs: 180_000 });
	assert.equal(a.getSnapshot().value, "prompting"); // dropped, no cancellation
	gate.resolve({ disposition: "started" });
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.stallHit, false);
});

await ok("late STALL_DETECTED after terminal is dropped", async () => {
	const a = await drive();
	a.send({ type: "STALL_DETECTED", stallMs: 180_000 });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.stallHit, false);
});

// --- KILL (user abort) ------------------------------------------------------------

await ok("KILL during running → cancelled: ladder → collect (policy difference) → stop → aborted", async () => {
	const gate = { resolve: (_: PromptOutput) => {} };
	const stub = makeStubs({
		prompt: () =>
			new Promise<PromptOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("prompting"), { timeout: 2000 });
	gate.resolve({ disposition: "started" });
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "KILL" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "aborted");
	// abort/deadline DO collect
	assert.equal(stub.collectInputs.length, 1);
	assert.equal(stub.stopInputs.length, 1);
});

await ok("KILL during spawning → aborted; null transport tolerated by ladder", async () => {
	const gate = { resolve: (_: SpawnOutput) => {} };
	const stub = makeStubs({
		spawn: () =>
			new Promise<SpawnOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	a.send({ type: "KILL" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "aborted");
	assert.equal(stub.cancelInputs.length, 1);
	assert.equal(stub.cancelInputs[0]!.transport, null); // spawn never resolved
	gate.resolve({ pid: 99, transport: stub.transport }); // dropped
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(a.getSnapshot().value, "aborted");
});

await ok("KILL during handshaking → aborted; handshake aborted", async () => {
	const gate = { resolve: (_: HandshakeOutput) => {} };
	const stub = makeStubs({
		handshake: () =>
			new Promise<HandshakeOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("handshaking"), { timeout: 2000 });
	a.send({ type: "KILL" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "aborted");
	assert.equal(stub.aborted.handshake, true);
});

await ok("KILL during prompting → aborted; prompt aborted, late response dropped", async () => {
	const gate = { resolve: (_: PromptOutput) => {} };
	const stub = makeStubs({
		prompt: () =>
			new Promise<PromptOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("prompting"), { timeout: 2000 });
	a.send({ type: "KILL" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "aborted");
	assert.equal(stub.aborted.prompt, true);
	gate.resolve({ disposition: "started" });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(a.getSnapshot().value, "aborted");
});

await ok("KILL during collecting (post-settle) → success; late abort dropped, artifacts kept", async () => {
	const gate = { resolve: (_: CollectOutput) => {} };
	const stub = makeStubs({
		collect: () =>
			new Promise<CollectOutput>((res) => {
				gate.resolve = res;
			}),
	});
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "AGENT_SETTLED" }); // outcome settled on entering collecting
	await waitFor(a, (s) => s.matches("collecting"), { timeout: 2000 });
	a.send({ type: "KILL" }); // late abort during collect — run already settled
	gate.resolve({ artifacts: [A_OK] });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	// policy: a post-settle abort does not retro-flip
	// a completed run; the artifacts are kept and the run reports success
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.artifacts.length, 1);
});

await ok("late KILL after terminal is dropped; terminal is final", async () => {
	const a = await drive();
	a.send({ type: "KILL" });
	assert.equal(a.getSnapshot().value, "success");
});

// --- STEER capability (machine + transport tested; no tool wiring yet) -----------

await ok("STEER in running → self-transition, tracked (capability for future wiring)", async () => {
	const stub = makeStubs();
	const a = makeActor(stub);
	begin(a);
	await waitFor(a, (s) => s.matches("running"), { timeout: 2000 });
	a.send({ type: "STEER", message: "Focus on tests only" });
	assert.equal(a.getSnapshot().value, "running");
	assert.equal(a.getSnapshot().context.lastSteer, "Focus on tests only");
	a.send({ type: "AGENT_SETTLED" });
	await waitFor(a, (s) => isFinal(s), { timeout: 2000 });
	assert.equal(a.getSnapshot().value, "success");
});

// --- collect failure ------------------------------------------------------------

await ok("collect fail → empty artifacts + failure summary; outcome routes (settled → success)", async () => {
	const stub = makeStubs({
		collect: async () => {
			throw new Error("EACCES on working dir");
		},
	});
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "success"); // the run succeeded; only collection failed
	const c = a.getSnapshot().context;
	assert.equal(c.collected, true);
	assert.equal(c.artifacts.length, 0);
	assert.match(c.summary, /Collection failed: EACCES/);
});

await ok("collect with missing artifacts → summary names them (honest accounting)", async () => {
	const stub = makeStubs({
		collect: async (input) => ({
			artifacts: input.artifactPaths.map((p) => ({ path: p, content: "", missing: true })) as ArtifactEntry[],
		}),
	});
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "success");
	assert.match(a.getSnapshot().context.summary, /Collected 0\/1 artifacts\. Missing: out\.txt\./);
});

// --- stop output ------------------------------------------------------------------

await ok("stopService output recorded: usage (best-effort stop output)", async () => {
	const stub = makeStubs({
		stop: async () => ({
			exitCode: 0,
			usage: { tokens: { totalTokens: 1234 }, cost: 0.05 },
	}),
	});
	const a = await drive(stub);
	assert.equal(a.getSnapshot().value, "success");
	const c = a.getSnapshot().context;
	assert.equal(c.usage?.tokens?.totalTokens, 1234);
});

await ok("buildSummary: collected/missing/unreadable counts", () => {
	const arts: ArtifactEntry[] = [
		{ path: "a.txt", content: "x", missing: false },
		{ path: "b.txt", content: "", missing: true },
		{ path: "c.txt", content: "", missing: false, readError: "EISDIR" },
	];
	assert.equal(buildSummary(["a.txt", "b.txt", "c.txt"], arts), "Collected 1/3 artifacts. Missing: b.txt. Unreadable: c.txt.");
});

// --- unwired machine ---------------------------------------------------------------

await ok("unwired machine: entering spawning lands in error with a readable reason", async () => {
	const a = createActor(rpcMachine);
	a.start();
	begin(a);
	await waitFor(a, (s) => s.matches("error"), { timeout: 2000 });
	assert.match(a.getSnapshot().context.failureDetail ?? "", /spawnService not wired/);
});

// --- terminal stability --------------------------------------------------------------

await ok("terminal states are final: begin/kill/lifecycle events dropped", async () => {
	const a = await drive();
	begin(a, { sessionId: "again" });
	a.send({ type: "KILL" });
	a.send({ type: "AGENT_SETTLED" });
	a.send({ type: "CHILD_DEAD", code: 1, signal: null });
	assert.equal(a.getSnapshot().value, "success");
	assert.equal(a.getSnapshot().context.sessionId, "rpc-delegate-1-abcd");
	assert.equal(a.getSnapshot().context.outcome, "settled");
});

console.log(`\n${passed} tests passed${failed > 0 ? `, ${failed} failed` : ""}`);
if (failed > 0) process.exit(1);
