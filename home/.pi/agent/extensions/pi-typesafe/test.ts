/**
 * Pure seam tests — no LLM, no network, no real Pi runtime. Run from this directory:
 *   node test.ts
 *
 * The sources import each other with `.js` specifiers and use parameter properties, which plain node cannot load, so
 * this file registers jiti (bundled with pi) before importing the seams. Everything here runs against injected paths,
 * clocks, ledgers, and a fake model registry: nothing leaves the process.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// --- loader ---------------------------------------------------------------------
const jitiCandidates = (): string[] => {
  const list: string[] = [];
  if (process.env.PI_TYPESAFE_TEST_JITI?.trim()) list.push(process.env.PI_TYPESAFE_TEST_JITI.trim());
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (root) list.push(join(root, "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.mjs"));
  } catch { /* keep trying the remaining candidates */ }
  list.push("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs");
  return list;
};
let createJiti: ((base?: string | URL, options?: { moduleCache?: boolean }) => { import<T>(id: string): Promise<T> }) | undefined;
for (const candidate of jitiCandidates()) {
  try {
    ({ createJiti } = await import(pathToFileURL(candidate).href) as typeof import("jiti"));
    break;
  } catch { /* next candidate */ }
}
if (!createJiti) {
  try { ({ createJiti } = await import("jiti") as typeof import("jiti")); } catch { /* nothing resolvable */ }
}
if (!createJiti) {
  throw new Error("Could not load jiti. Install jiti (or set PI_TYPESAFE_TEST_JITI to its jiti.mjs) and run again.");
}
const jiti = createJiti(import.meta.url);

// --- imports (through jiti) -----------------------------------------------------
const { fanOut, chunkEvaluationRequest, evaluateAll, evaluateMany } = await jiti.import<typeof import("./batch.js")>("./batch.js");
const { createTypeSafe, DEFAULT_MAX_REQUESTS, DEFAULT_MODEL, resolveModelId, splitModelId } = await jiti.import<typeof import("./client.js")>("./client.js");
const { calibrate } = await jiti.import<typeof import("./calibrate.js")>("./calibrate.js");
const { safeError, TypeSafeIntegrationError } = await jiti.import<typeof import("./errors.js")>("./errors.js");
const { assertWithinByteLimit, DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_QUESTIONS, normalizeEvaluationRequest, parseEvaluationRequest, prepareEvaluationRequest } = await jiti.import<typeof import("./schema.js")>("./schema.js");
const { capsFromEnvironment, emptyTotals, estimateUsd, localDay, mergeCaps, openUsageLedger } = await jiti.import<typeof import("./usage.js")>("./usage.js");

// --- harness -------------------------------------------------------------------
const ENV_KEYS = ["TYPESAFE_API_KEY", "PI_TYPESAFE_MODEL", "PI_CODING_AGENT_DIR"];
const realEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const TEMP = mkdtempSync(join(tmpdir(), "pi-typesafe-test-"));

let passed = 0;
function ok(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}
async function okAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}
async function withEnv(patch: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const before = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

try {
  // --- schema -------------------------------------------------------------------
  ok("schema: valid minimal core request passes prepareEvaluationRequest", () => {
    const request = {
      state: { message: "hello" },
      questions: {
        urgent: { type: "bool", instructions: "Is it urgent?", criteria: { true: "yes", false: "no" } },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", other: "None of these" } },
        heat: { type: "score", instructions: "How hot?", criteria: ["cold", "warm", "hot"] },
      },
    };
    const prepared = prepareEvaluationRequest(request);
    assert.deepEqual(Object.keys(prepared.questions), ["urgent", "team", "heat"]);
  });

  ok("schema: legacy noul and aliases normalize to core shapes", () => {
    const normalized = normalizeEvaluationRequest({
      state: {},
      questions: {
        a: { type: "noul", instructions: "?", criteria: "counts as yes" },
        b: { type: "noul", instructions: "?" },
        c: { type: "choice", instructions: "?", options: { x: "one", y: null } },
        d: { type: "score", instructions: "?", levels: ["lo", "hi"] },
      },
    }) as { questions: Record<string, { type: string; criteria: unknown }> };
    assert.deepEqual(normalized.questions.a, { type: "bool", instructions: "?", criteria: { true: "counts as yes", false: "" } });
    assert.deepEqual(normalized.questions.b.criteria, { true: "", false: "" });
    assert.deepEqual(normalized.questions.c.criteria, { x: "one", y: "" });
    assert.deepEqual(normalized.questions.d.criteria, ["lo", "hi"]);
  });

  ok("schema: bool criteria are never invented; partial becomes empty strings", () => {
    const prepared = prepareEvaluationRequest({
      state: {},
      questions: { q: { type: "bool", instructions: "?", criteria: { true: "only yes" } } },
    });
    assert.deepEqual((prepared.questions.q as { criteria: unknown }).criteria, { true: "only yes", false: "" });
  });

  ok("schema: choice criteria as a label array becomes a map", () => {
    const prepared = prepareEvaluationRequest({
      state: {},
      questions: { pick: { type: "choice", instructions: "?", criteria: ["a", "b"] } },
    });
    assert.deepEqual((prepared.questions.pick as { criteria: unknown }).criteria, { a: "", b: "" });
  });

  ok("schema: string, null, and array state are rejected as not JSON objects", () => {
    for (const state of ["text", null, ["a"], 42]) {
      assert.throws(() => prepareEvaluationRequest({ state, questions: { q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } }), /Invalid evaluation request/);
    }
  });

  ok("schema: too many questions are rejected", () => {
    const questions: Record<string, unknown> = {};
    for (let index = 0; index <= DEFAULT_MAX_QUESTIONS; index++) questions[`q${index}`] = { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } };
    assert.throws(() => prepareEvaluationRequest({ state: {}, questions }), /Invalid evaluation request/);
  });

  ok("schema: validation errors carry paths, never submitted values", () => {
    try {
      prepareEvaluationRequest({ state: { secret: "SUPERSECRETVALUE" }, questions: { bad: { type: "maybe", instructions: "?" } } });
      assert.fail("expected a validation error");
    } catch (error) {
      assert.ok(error instanceof TypeSafeIntegrationError && error.code === "validation", "validation error");
      assert.match(error.message, /questions\.bad/);
      assert.doesNotMatch(error.message, /SUPERSECRETVALUE/);
    }
  });

  ok("schema: non-JSON state is rejected (cycles, symbols, getters, class instances)", () => {
    const cyclic: Record<string, unknown> = { state: {} };
    (cyclic.state as Record<string, unknown>).self = cyclic;
    const withSymbol: Record<string, unknown> = { state: {} };
    Reflect.set(withSymbol.state as object, Symbol("s"), 1);
    const withGetter = { state: Object.defineProperty({}, "x", { get() { return 1; }, enumerable: true }) };
    class Holder { value = 1; }
    for (const bad of [cyclic, withSymbol, withGetter, { state: new Holder() }] as Record<string, unknown>[]) {
      bad.questions = { q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } };
      assert.throws(() => parseEvaluationRequest(bad), /must be plain JSON/);
    }
  });

  ok("schema: byte budget names the limit; prepareEvaluationRequest enforces it", () => {
    assert.throws(() => assertWithinByteLimit("x".repeat(11), 10), /10-byte input limit/);
    assert.throws(
      () => prepareEvaluationRequest({ state: {}, questions: { q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } }, { maxInputBytes: 10 }),
      /10-byte input limit/,
    );
    assert.equal(DEFAULT_MAX_INPUT_BYTES, 65_536);
  });

  // --- errors -------------------------------------------------------------------
  ok("errors: safeError passes TypeSafe errors through and maps strays safely", () => {
    const error = new TypeSafeIntegrationError("budget", "cap reached");
    assert.equal(safeError(error), error);
    const abort = new Error("stopped");
    abort.name = "AbortError";
    assert.equal(safeError(abort).code, "aborted");
    assert.equal(safeError(new Error("anything")).code, "response");
    assert.equal(safeError(new Error("anything")).message.includes("anything"), false, "raw messages never surface");
  });

  // --- usage --------------------------------------------------------------------
  ok("usage: localDay and estimateUsd", () => {
    assert.equal(localDay(new Date(2025, 0, 2, 23, 59)), "2025-01-02");
    assert.equal(estimateUsd(1_000_000, 0.042), 0.042);
    assert.equal(estimateUsd(123, 0.042), 0.000005, "rounded to the micro-dollar");
    assert.deepEqual(emptyTotals(), { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0 });
  });

  ok("usage: capsFromEnvironment accepts numbers, floors floats, ignores garbage", () => {
    const caps = capsFromEnvironment({
      PI_TYPESAFE_MAX_REQUESTS_PER_DAY: " 7 ",
      PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY: "2.9",
      PI_TYPESAFE_MAX_USD_PER_DAY: "0.5",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(caps, { maxRequestsPerDay: 7, maxInputTokensPerDay: 2, maxUsdPerDay: 0.5 });
    assert.deepEqual(capsFromEnvironment({ PI_TYPESAFE_MAX_REQUESTS_PER_DAY: "nope", PI_TYPESAFE_MAX_USD_PER_DAY: "-1" } as NodeJS.ProcessEnv), {});
  });

  ok("usage: mergeCaps keeps the lowest cap; maxRequests comes only from the explicit set", () => {
    const merged = mergeCaps(
      { maxRequests: 5, maxRequestsPerDay: 10, maxInputTokensPerDay: 1000, maxUsdPerDay: 2 },
      { maxRequestsPerDay: 7, maxInputTokensPerDay: 800, maxUsdPerDay: 3 },
    );
    assert.deepEqual(merged, { maxRequests: 5, maxRequestsPerDay: 7, maxInputTokensPerDay: 800, maxUsdPerDay: 2 });
    assert.deepEqual(mergeCaps({}, {}), {});
  });

  ok("usage: a failed request still counts its billed tokens", () => {
    const path = join(TEMP, "ledger-failure-tokens.json");
    const ledger = openUsageLedger({ path, now: () => new Date(2025, 0, 2) });
    ledger.recordStart();
    ledger.recordFailure(321, 12);
    const today = ledger.today();
    assert.equal(today.requestsFailed, 1);
    assert.equal(today.requestsSucceeded, 0);
    assert.equal(today.inputTokens, 321);
    assert.equal(today.outputTokens, 12);
  });

  ok("usage: day rollover and persistence keep the last 31 days plus today", () => {
    let now = new Date(2025, 0, 2, 10, 0, 0);
    const path = join(TEMP, "ledger-rollover.json");
    const ledger = openUsageLedger({ path, now: () => now });
    ledger.recordStart();
    now = new Date(2025, 0, 3, 8, 0, 0);
    assert.equal(ledger.today().day, "2025-01-03");
    assert.equal(ledger.today().requestsStarted, 0);
    assert.equal(ledger.blocked({ maxRequestsPerDay: 1 }), undefined);
    const days: Record<string, ReturnType<typeof emptyTotals>> = {};
    for (let index = 0; index < 40; index++) days[localDay(new Date(2020, 0, 1 + index))] = emptyTotals();
    writeFileSync(path, JSON.stringify({ version: 1, days }));
    openUsageLedger({ path, now: () => new Date(2025, 0, 2) }).recordStart();
    const kept = JSON.parse(readFileSync(path, "utf8")) as { days: Record<string, unknown> };
    assert.equal(Object.keys(kept.days).length, 31);
    assert.ok(kept.days["2020-01-11"] && !kept.days["2020-01-10"], "the 31 most recent days are kept");
  });

  // --- batch ------------------------------------------------------------------------
  ok("batch: fanOut preserves input order, bounds concurrency, and settles failures", async () => {
    const ordered = await fanOut([0, 1, 2, 3, 4], async (item) => {
      await new Promise(resolve => setTimeout(resolve, (4 - item) * 5));
      return item * 2;
    });
    assert.deepEqual(ordered.map(result => result.ok ? result.value : undefined), [0, 2, 4, 6, 8]);
    let active = 0;
    let peak = 0;
    await fanOut([0, 1, 2, 3, 4, 5], async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    }, { concurrency: 3 });
    assert.ok(peak <= 3, `peak concurrency ${peak} stayed within 3`);
    const settled = await fanOut([0, 1, 2], async (item) => {
      if (item === 1) throw new Error("boom");
      return item;
    });
    assert.deepEqual(settled.map(result => result.ok), [true, false, true]);
  });

  ok("batch: a stop rule and an abort mark the unstarted work as skipped", async () => {
    const stopped = await fanOut([0, 1, 2], async (item) => {
      if (item === 0) throw new TypeSafeIntegrationError("budget", "cap");
      return item;
    }, { concurrency: 1, stopOn: error => error instanceof TypeSafeIntegrationError && error.code === "budget" });
    assert.equal(stopped.filter(result => !result.ok && result.skipped).length, 2);
    assert.match(String((stopped[1] as { error: Error }).error.message), /not submitted/);
    const cancelled = await fanOut([0, 1], async item => item, { signal: AbortSignal.abort() });
    assert.ok(cancelled.every(result => !result.ok && result.skipped));
  });

  ok("batch: chunkEvaluationRequest splits only question maps that exceed the limit", () => {
    const questions: Record<string, unknown> = {};
    for (let index = 0; index < DEFAULT_MAX_QUESTIONS + 8; index++) questions[`q${String(index).padStart(2, "0")}`] = { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } };
    const request = { state: {}, questions } as never;
    const chunks = chunkEvaluationRequest(request);
    assert.deepEqual(chunks.map(chunk => Object.keys(chunk.questions).length), [DEFAULT_MAX_QUESTIONS, 8]);
    assert.deepEqual(chunks.flatMap(chunk => Object.keys(chunk.questions)), Object.keys(questions), "question order is preserved across chunks");
  });

  /** A decision stub whose evaluate returns a core-shaped result; call count drives varied answers. */
  function fakeClient(behavior?: (call: number) => { answers?: Record<string, unknown>; usage?: { input: number; output: number }; stopReason?: string; errorMessage?: string }) {
    let call = 0;
    const evaluate = async (request: { questions: Record<string, unknown> }) => {
      call++;
      const next = behavior?.(call) ?? {};
      if (next.stopReason && next.stopReason !== "stop") {
        return { api: "typesafe-system-one", provider: "opencode", model: "jev-1.13", answers: {}, stopReason: next.stopReason, errorMessage: next.errorMessage, timestamp: Date.now() };
      }
      const answers = next.answers ?? Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "bool", probability: call === 1 ? 0.1 : 0.9 }]));
      return { api: "typesafe-system-one", provider: "opencode", model: "jev-1.13", answers, stopReason: "stop", usage: next.usage, timestamp: Date.now() };
    };
    return { client: { evaluate } as never, calls: () => call };
  }

  await okAsync("batch: evaluateMany merges in input order and sums input/output usage", async () => {
    const { client } = fakeClient(() => ({ usage: { input: 5, output: 3 } }));
    const request = { state: {}, questions: { a: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } } as never;
    const batch = await evaluateMany(client, [request, request]);
    assert.equal(batch.ok, true);
    assert.equal((batch.answers.a as { probability: number }).probability, 0.9, "a repeated question id keeps the last answer");
    assert.deepEqual(batch.usage, { input: 10, output: 6 });
    assert.equal(batch.model, "jev-1.13");
  });

  await okAsync("batch: a budget failure stops the batch; later requests are skipped", async () => {
    let call = 0;
    const client = {
      evaluate: async () => {
        call++;
        if (call === 1) throw new TypeSafeIntegrationError("budget", "cap reached");
        return { api: "typesafe-system-one", provider: "opencode", model: "jev-1.13", answers: {}, stopReason: "stop", timestamp: Date.now() };
      },
    } as never;
    const request = { state: {}, questions: { a: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } } as never;
    const batch = await evaluateMany(client, [request, request, request], { concurrency: 1 });
    assert.equal(call, 1, "only the first request was submitted");
    assert.equal(batch.failures, 3);
    assert.equal(batch.skipped, 2);
  });

  await okAsync("batch: evaluateAll chunks one state past the per-request limit and merges the answers", async () => {
    const questions: Record<string, unknown> = {};
    for (let index = 0; index < DEFAULT_MAX_QUESTIONS + 8; index++) questions[`q${index}`] = { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } };
    const client = {
      evaluate: async (request: { questions: Record<string, unknown> }) => ({
        api: "typesafe-system-one", provider: "opencode", model: "jev-1.13",
        answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "bool", probability: 0.5 }])),
        stopReason: "stop", usage: { input: 1, output: 1 }, timestamp: Date.now(),
      }),
    } as never;
    const batch = await evaluateAll(client, { state: {}, questions } as never);
    assert.equal(batch.ok, true);
    assert.equal(Object.keys(batch.answers).length, DEFAULT_MAX_QUESTIONS + 8);
    assert.deepEqual(batch.usage, { input: 2, output: 2 });
  });

  // --- calibrate --------------------------------------------------------------------
  ok("calibrate: ranks a clean separation with AUC 1 and a usable threshold", () => {
    const calibration = calibrate("demo", [
      { label: true, score: 0.9 }, { label: true, score: 0.8 }, { label: false, score: 0.2 }, { label: false, score: 0.1 },
    ], { minPrecision: 1, minRecall: 1 });
    assert.equal(calibration.auc, 1);
    assert.equal(calibration.recommended?.threshold, 0.8);
  });

  // --- client (offline: fake registry and injected ledger) ----------------------------
  const MODEL = { provider: "opencode", id: "jev-1.13", api: "typesafe-system-one" };
  function fakeContext(model: unknown, classify: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>) {
    return { modelRegistry: { findOfType: () => model, classify } } as never;
  }
  const REQUEST = { state: {}, questions: { urgent: { type: "bool", instructions: "Urgent?", criteria: { true: "y", false: "n" } } } } as never;
  const boom = () => { throw new Error("classified transport must not run for validation or budget failures"); };

  ok("client: model ids resolve from PI_TYPESAFE_MODEL with a fixed default", () => {
    assert.equal(resolveModelId({} as NodeJS.ProcessEnv), DEFAULT_MODEL);
    assert.equal(resolveModelId({ PI_TYPESAFE_MODEL: " openrouter/typesafe/jev-1.13 " } as NodeJS.ProcessEnv), "openrouter/typesafe/jev-1.13");
    assert.deepEqual(splitModelId(DEFAULT_MODEL), { provider: "opencode", id: "jev-1.13" });
    assert.deepEqual(splitModelId("openrouter/typesafe/jev-1.13"), { provider: "openrouter", id: "typesafe/jev-1.13" });
    assert.throws(() => splitModelId("nope"), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration");
  });

  await okAsync("client: an unknown model fails closed before any request", async () => {
    const ledger = openUsageLedger({ path: join(TEMP, "client-missing.json") });
    assert.throws(() => createTypeSafe(fakeContext(undefined, boom as never), { ledger }), (error: unknown) =>
      error instanceof TypeSafeIntegrationError && error.code === "configuration");
  });

  await okAsync("client: evaluate records a judgment and both usage counters", async () => {
    clearEnv();
    const ledger = openUsageLedger({ path: join(TEMP, "client-basic.json"), now: () => new Date(2025, 0, 2) });
    let seenOptions: { maxRetries?: number; timeoutMs?: number } | undefined;
    const client = createTypeSafe(fakeContext(MODEL, async (_model, _context, options) => {
      seenOptions = options as { maxRetries?: number; timeoutMs?: number };
      return { api: "typesafe-system-one", provider: "opencode", model: "jev-1.13", answers: { urgent: { type: "bool", probability: 0.6 } }, stopReason: "stop", usage: { input: 7, output: 2 }, timestamp: Date.now() };
    }), { ledger });
    const result = await client.evaluate(REQUEST);
    assert.equal((result.answers.urgent as { probability: number }).probability, 0.6);
    assert.ok(Number.isInteger(result.elapsedMs) && result.elapsedMs >= 0);
    assert.equal(seenOptions?.maxRetries, 0, "no automatic retries");
    assert.equal(seenOptions?.timeoutMs, 15_000);
    const session = client.getUsage();
    assert.equal(session.requestsStarted, 1);
    assert.equal(session.requestsSucceeded, 1);
    assert.equal(session.inputTokens, 7);
    assert.equal(client.getSpend().today.requestsSucceeded, 1);
  });

  await okAsync("client: a non-stop classifier result rejects, records failure, and counts billed tokens", async () => {
    clearEnv();
    const ledger = openUsageLedger({ path: join(TEMP, "client-error.json"), now: () => new Date(2025, 0, 2) });
    const client = createTypeSafe(fakeContext(MODEL, async () => ({
      api: "typesafe-system-one", provider: "opencode", model: "jev-1.13", answers: {}, stopReason: "error",
      errorMessage: "HTTP 401 {\"secret\":\"body\"}", usage: { input: 9, output: 0 }, timestamp: Date.now(),
    })), { ledger });
    await assert.rejects(client.evaluate(REQUEST), (error: unknown) => {
      assert.ok(error instanceof TypeSafeIntegrationError);
      assert.equal(error.code, "response");
      assert.doesNotMatch(error.message, /secret|body/, "raw provider bodies are never surfaced");
      return true;
    });
    const session = client.getUsage();
    assert.equal(session.requestsFailed, 1);
    assert.equal(session.inputTokens, 9, "a billed failure still counts input tokens");
    assert.equal(client.getSpend().today.requestsFailed, 1);
  });

  await okAsync("client: a malformed answer rejects as response, not as a judgment", async () => {
    clearEnv();
    const ledger = openUsageLedger({ path: join(TEMP, "client-malformed.json") });
    const client = createTypeSafe(fakeContext(MODEL, async () => ({
      api: "typesafe-system-one", provider: "opencode", model: "jev-1.13",
      answers: { urgent: { type: "bool", probability: 7 } }, stopReason: "stop", timestamp: Date.now(),
    })), { ledger });
    await assert.rejects(client.evaluate(REQUEST), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "response");
    assert.equal(client.getUsage().requestsFailed, 1);
  });

  await okAsync("client: session and daily caps stop the next request before it is submitted", async () => {
    clearEnv();
    let calls = 0;
    const counting = async () => {
      calls++;
      return { api: "typesafe-system-one", provider: "opencode", model: "jev-1.13", answers: { urgent: { type: "bool", probability: 0.5 } }, stopReason: "stop", timestamp: Date.now() };
    };
    const session = createTypeSafe(fakeContext(MODEL, counting as never), { maxRequests: 1, ledger: openUsageLedger({ path: join(TEMP, "client-session.json") }) });
    await session.evaluate(REQUEST);
    await assert.rejects(session.evaluate(REQUEST), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "budget" && /request limit reached/.test(error.message));
    assert.equal(calls, 1);

    const daily = createTypeSafe(fakeContext(MODEL, counting as never), { maxRequestsPerDay: 1, ledger: openUsageLedger({ path: join(TEMP, "client-daily.json"), now: () => new Date(2025, 0, 2) }) });
    await daily.evaluate(REQUEST);
    await assert.rejects(daily.evaluate(REQUEST), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "budget" && /daily request cap reached/.test(error.message));
    assert.equal(calls, 2);
  });

  await okAsync("client: invalid requests and an already-aborted signal never reach the transport", async () => {
    clearEnv();
    const client = createTypeSafe(fakeContext(MODEL, boom as never), { ledger: openUsageLedger({ path: join(TEMP, "client-validate.json") }) });
    await assert.rejects(client.evaluate({ state: {}, questions: { bad: { type: "maybe" } } } as never), (error: unknown) =>
      error instanceof TypeSafeIntegrationError && error.code === "validation");
    await assert.rejects(client.evaluate(REQUEST, { signal: AbortSignal.abort() }), (error: unknown) =>
      error instanceof TypeSafeIntegrationError && error.code === "aborted");
    assert.equal(client.getUsage().requestsStarted, 0, "neither case counts as an attempt");
  });

  ok("client: DEFAULT_MAX_REQUESTS matches the consent copy the extension quotes", () => {
    assert.equal(DEFAULT_MAX_REQUESTS, 20);
  });

  console.log(`\n${passed} tests passed`);
} finally {
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(TEMP, { recursive: true, force: true });
}

/** Clear the environment keys the client resolves at call time. */
function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}
