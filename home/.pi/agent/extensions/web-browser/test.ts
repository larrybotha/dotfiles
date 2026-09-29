// machine tests — no LLM, no browser, no CDP. Synthetic probe evidence only.
// run: node test.ts
//
// The launch service slot is provided with a controllable stub
// (machine.provide) — no start.js runs. The stub records its input (mode +
// extraEnv parity), observes its AbortSignal (STOP-during-launch abort), and
// resolves/rejects on demand, so launch routing, wedged-start recovery, and
// STOP/PROBE-during-starting are testable deterministically.

import { createActor, type Actor, fromPromise, waitFor } from "xstate";
import {
  browserMachine,
  DEFAULT_DEVICES,
  emulateViolation,
  type BrowserInfo,
  type BrowserContext,
  type LaunchInput,
  type LaunchMode,
  type LaunchOutput,
  type BrowserMode,
  type ActiveTab,
  type EmulationPref,
  launchViolation,
  MAX_ERRORS,
  notRunningReason,
  resolveAuto,
  type DetectBuckets,
  type InstalledEntry,
} from "./machine.ts";

let passed = 0;
let failed = 0;

function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`ok   - ${name}`);
  } else {
    failed++;
    console.error(`FAIL - ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const settle = (a: A) => waitFor(a, (s) => s.matches("running") || s.matches("stopped"));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---- controllable launch-service stubs (slide-deck test pattern) ----

type StubState = {
  inputs: LaunchInput[];
  /** Set when the service's AbortSignal fired (STOP during launch). */
  aborted: boolean;
  next: (input: LaunchInput) => Promise<LaunchOutput>;
};

function browserInfo(over: Partial<BrowserInfo> = {}): BrowserInfo {
  return {
    mode: "fresh",
    port: 9222,
    pid: 4242,
    userDataDir: "/x",
    browser: "Chrome/126",
    startedAt: "t",
    ...over,
  };
}

function makeStubs(
  over: Partial<{ next: StubState["next"] }> = {},
): StubState {
  const stub: StubState = {
    inputs: [],
    aborted: false,
    next:
      over.next ??
      (async () => ({ browser: browserInfo(), text: "started" })),
  };
  return stub;
}

function makeMachine(stub: StubState) {
  return browserMachine.provide({
    actors: {
      launchService: fromPromise<LaunchOutput, LaunchInput>(
        async ({ input, signal }) => {
          stub.inputs.push(input);
          signal.addEventListener("abort", () => {
            stub.aborted = true;
          });
          return stub.next(input);
        },
      ),
    },
  });
}

type M = ReturnType<typeof makeMachine>;
type A = Actor<M>;

function freshActor(stub: StubState = makeStubs()): A {
  const a = createActor(makeMachine(stub), { input: undefined });
  a.start();
  return a;
}

function value(a: A): string {
  return String(a.getSnapshot().value);
}

function ctx(a: A): BrowserContext {
  return a.getSnapshot().context;
}

/** Drive one happy launch to `running` (default stub); returns the actor. */
async function launchOk(
  stub: StubState = makeStubs(),
  over: Partial<LaunchInput> = {},
): Promise<A> {
  const a = freshActor(stub);
  a.send({ type: "BEGIN_LAUNCH", mode: over.mode ?? "fresh", extraEnv: over.extraEnv });
  await settle(a);
  return a;
}

function probe(a: A, up: boolean, mode: BrowserMode = "fresh"): void {
  a.send({ type: "PROBE", up, port: 9222, browser: up ? "Chrome/126" : null, pid: up ? 4242 : null, mode, userDataDir: up ? "/x" : null, startedAt: up ? "t" : null });
}

// 1. initial state + defaults
{
  const a = freshActor();
  ok(value(a) === "stopped", "initial state is stopped");
  ok(ctx(a).browser === null, "no browser in context");
  ok(ctx(a).devices.length > 0, "default devices present");
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(DEFAULT_DEVICES), "default devices match skill presets");
}

// 2. launch lifecycle: stopped -> starting (invoke) -> running
{
  const stub = makeStubs({ next: async (input) => ({ browser: browserInfo({ mode: input.mode, pid: 99, userDataDir: "/profile-copy" }), text: "started" }) });
  const a = freshActor(stub);
  a.send({ type: "BEGIN_LAUNCH", mode: "profile", extraEnv: { BROWSER_BIN: "/x/Chrome" } });
  ok(value(a) === "starting", "BEGIN_LAUNCH moves to starting");
  await settle(a);
  ok(value(a) === "running", "launchService resolve moves to running");
  ok(ctx(a).browser?.mode === "profile", "browser mode recorded");
  ok(ctx(a).browser?.pid === 99, "browser pid recorded");
  ok(ctx(a).browser?.userDataDir === "/profile-copy", "userDataDir recorded");
  // input parity: mode + extraEnv flow into the service
  ok(stub.inputs.length === 1, "service invoked once");
  ok(stub.inputs[0]?.mode === "profile", "service input carries mode");
  ok(stub.inputs[0]?.extraEnv?.BROWSER_BIN === "/x/Chrome", "service input carries extraEnv");
}

// 3. launch failure: starting -> stopped, error recorded (never wedged)
{
  const stub = makeStubs({ next: async () => { throw new Error("port in use"); } });
  const a = freshActor(stub);
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  await settle(a);
  ok(value(a) === "stopped", "launchService reject returns to stopped");
  ok(ctx(a).browser === null, "no browser after failed launch");
  ok(ctx(a).errors.some((e) => e.includes("port in use")), "launch error recorded");
  ok(a.getSnapshot().can({ type: "BEGIN_LAUNCH", mode: "fresh" }), "retry legal after failed launch");
}

// 4. BEGIN_LAUNCH while running is rejected (structure backstop)
{
  const a = await launchOk();
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  ok(value(a) === "running", "BEGIN_LAUNCH in running is ignored");
  ok(ctx(a).browser?.pid === 4242, "browser untouched by illegal launch");
}

// 5. BEGIN_LAUNCH while starting is illegal at state level (can() gate)
{
  const stub = makeStubs({ next: () => new Promise<LaunchOutput>(() => {}) }); // never settles
  const a = freshActor(stub);
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  ok(value(a) === "starting", "BEGIN_LAUNCH enters starting");
  ok(a.getSnapshot().can({ type: "BEGIN_LAUNCH", mode: "fresh" }) === false, "BEGIN_LAUNCH illegal while starting (can gate)");
  ok(a.getSnapshot().can({ type: "PROBE", up: true, port: 1, browser: null, pid: null, mode: "fresh", userDataDir: null, startedAt: null }) === true, "PROBE legal while starting (adoption path)");
}

// 6. probe adoption: stopped + up -> running
{
  const a = freshActor();
  probe(a, true, "foreign");
  ok(value(a) === "running", "PROBE up adopts from stopped");
  ok(ctx(a).browser?.mode === "foreign", "adopted foreign mode recorded");
}

// 7. probe refresh in running updates evidence
{
  const a = await launchOk();
  probe(a, true, "attach");
  ok(value(a) === "running", "PROBE up in running stays running");
  ok(ctx(a).browser?.mode === "attach", "PROBE updates browser info");
}

// 8. probe drift: running + !up -> stopped, error recorded, caches cleared
{
  const a = await launchOk();
  a.send({ type: "NAV", url: "https://example.com", newTab: false });
  probe(a, false);
  ok(value(a) === "stopped", "PROBE down from running marks stopped");
  ok(ctx(a).browser === null, "browser cleared on drift");
  ok(ctx(a).activeTab === null, "active tab cleared on drift");
  ok(ctx(a).errors.some((e) => e.includes("browser gone")), "drift error recorded");
}

// 9. PROBE down in stopped (nothing to drift from) records nothing
{
  const a = freshActor();
  probe(a, false);
  ok(value(a) === "stopped", "PROBE down in stopped stays stopped");
  ok(ctx(a).errors.length === 0, "no spurious drift error in stopped");
}

// 10. NAV records active tab only in running
{
  const a = freshActor();
  a.send({ type: "NAV", url: "https://example.com", newTab: true });
  ok(ctx(a).activeTab === null, "NAV in stopped ignored");
  const b = await launchOk();
  b.send({ type: "NAV", url: "https://example.com", newTab: true });
  ok(ctx(b).activeTab?.url === "https://example.com", "NAV in running records active tab");
  ok(typeof ctx(b).activeTab?.at === "string", "NAV records timestamp");
}

// 11. TAB_SWITCH records targetId
{
  const a = await launchOk();
  a.send({ type: "TAB_SWITCH", targetId: "ABC123", url: "https://x.dev" });
  ok(ctx(a).activeTab?.targetId === "ABC123", "TAB_SWITCH records targetId");
  ok(ctx(a).activeTab?.url === "https://x.dev", "TAB_SWITCH records url");
}

// 12. EMULATE_SET: known device applies, unknown rejected
{
  const a = await launchOk();
  a.send({ type: "EMULATE_SET", device: "iphone-14", landscape: true });
  ok(ctx(a).emulation?.device === "iphone-14", "EMULATE_SET records preset");
  ok(ctx(a).emulation?.landscape === true, "EMULATE_SET records landscape");
  a.send({ type: "EMULATE_SET", device: "nokia-3310", landscape: false });
  ok(ctx(a).emulation?.device === "iphone-14", "unknown device rejected by guard");
  a.send({ type: "EMULATE_RESET" });
  ok(ctx(a).emulation === null, "EMULATE_RESET clears preference");
}

// 13. EMULATE_SET in stopped is ignored (needs a running browser to apply)
{
  const a = freshActor();
  a.send({ type: "EMULATE_SET", device: "pixel-7", landscape: false });
  ok(ctx(a).emulation === null, "EMULATE_SET in stopped ignored");
}

// 14. STOP clears browser + active tab, keeps emulation preference
{
  const a = await launchOk();
  a.send({ type: "EMULATE_SET", device: "pixel-7", landscape: false });
  a.send({ type: "NAV", url: "https://example.com", newTab: false });
  a.send({ type: "STOP", reason: "user stop" });
  ok(value(a) === "stopped", "STOP moves to stopped");
  ok(ctx(a).browser === null, "STOP clears browser");
  ok(ctx(a).activeTab === null, "STOP clears active tab");
  ok(ctx(a).emulation?.device === "pixel-7", "STOP keeps emulation preference");
  a.send({ type: "STOP", reason: "again" });
  ok(value(a) === "stopped", "STOP in stopped is a no-op");
}

// 15. STOP during launch: starting -> stopped, service aborted, ring entry
{
  const gate = { resolve: (_: LaunchOutput) => {} };
  const stub = makeStubs({
    next: () => new Promise<LaunchOutput>((res) => { gate.resolve = res; }),
  });
  const a = freshActor(stub);
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  ok(value(a) === "starting", "launch in flight");
  a.send({ type: "STOP", reason: "user abort" });
  ok(value(a) === "stopped", "STOP during launch moves to stopped");
  ok(ctx(a).browser === null, "STOP during launch clears browser");
  ok(ctx(a).errors.some((e) => e.includes("stopped during launch: user abort")), "STOP during launch recorded in ring");
  await tick();
  ok(stub.aborted, "service AbortSignal fired (executor kills spawned pid)");
  // late service result: no handler in stopped — dropped, never resurrected
  gate.resolve({ browser: browserInfo(), text: "late" });
  await tick();
  ok(value(a) === "stopped", "late launch result dropped after STOP");
  ok(ctx(a).browser === null, "late launch result never sets browser");
}

// 16. PROBE during launch: up adopts (drops the in-flight result); !up stays
{
  // up: fresh evidence wins over the in-flight launch
  const stub = makeStubs({ next: () => new Promise<LaunchOutput>(() => {}) });
  const a = freshActor(stub);
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  probe(a, true, "attach");
  ok(value(a) === "running", "PROBE up during starting adopts into running");
  ok(ctx(a).browser?.mode === "attach", "probe evidence recorded on adoption");
  ok(stub.aborted, "in-flight launch service aborted by adoption");

  // !up: proves nothing while a launch is in flight — stay, no drift record
  const stub2 = makeStubs({ next: () => new Promise<LaunchOutput>(() => {}) });
  const b = freshActor(stub2);
  b.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  probe(b, false);
  ok(value(b) === "starting", "PROBE down during starting stays starting");
  ok(!ctx(b).errors.some((e) => e.includes("browser gone")), "no drift record while launch in flight");
}

// 17. RESTORE fills caches, never the browser
{
  const a = freshActor();
  const activeTab: ActiveTab = { targetId: "T1", url: "https://old.dev", at: "t0" };
  const emulation: EmulationPref = { device: "iphone-se", landscape: false, at: "t0" };
  a.send({ type: "RESTORE", activeTab, emulation, devices: ["custom-1", "custom-2"] });
  ok(ctx(a).activeTab?.url === "https://old.dev", "RESTORE fills active tab");
  ok(ctx(a).emulation?.device === "iphone-se", "RESTORE fills emulation");
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(["custom-1", "custom-2"]), "RESTORE fills devices");
  ok(ctx(a).browser === null, "RESTORE never fills browser (probe owns it)");
  ok(value(a) === "stopped", "RESTORE keeps state stopped until a probe adopts");
  // probe after restore: adopt, caches survive
  probe(a, true, "attach");
  ok(value(a) === "running", "PROBE after RESTORE adopts");
  ok(ctx(a).activeTab?.url === "https://old.dev", "restored active tab survives adoption");
}

// 18. RESTORE with bad shape is rejected
{
  const a = freshActor();
  a.send({
    type: "RESTORE",
    activeTab: { targetId: null, url: 42 as unknown as string, at: "t" },
    emulation: null,
    devices: null,
  });
  ok(ctx(a).activeTab === null, "malformed RESTORE rejected by guard");

  // malformed devices list (non-strings) rejected; good one accepted
  a.send({ type: "RESTORE", activeTab: null, emulation: null, devices: [1, "x"] as unknown as string[] });
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(DEFAULT_DEVICES), "malformed RESTORE devices rejected by guard");
  a.send({ type: "RESTORE", activeTab: null, emulation: null, devices: ["ok-1"] });
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(["ok-1"]), "well-formed RESTORE devices accepted");

  // malformed activeTab.targetId rejected
  a.send({
    type: "RESTORE",
    activeTab: { targetId: 7 as unknown as string, url: "https://x.dev", at: "t" },
    emulation: null,
    devices: null,
  });
  ok(ctx(a).activeTab === null, "malformed RESTORE targetId rejected by guard");
}

// 19. DEVICES refresh works in every state
{
  const a = freshActor();
  a.send({ type: "DEVICES", ids: ["a", "b"] });
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(["a", "b"]), "DEVICES sets presets in stopped");
  const b = await launchOk();
  b.send({ type: "DEVICES", ids: ["c"] });
  ok(JSON.stringify(ctx(b).devices) === JSON.stringify(["c"]), "DEVICES sets presets in running");
  b.send({ type: "DEVICES", ids: [] });
  ok(JSON.stringify(ctx(b).devices) === JSON.stringify(["c"]), "empty DEVICES ignored");
}

// 20. validators: readable reasons
{
  const a = freshActor();
  ok(launchViolation(ctx(a)) === null, "launchViolation null when stopped");
  const b = await launchOk();
  const lv = launchViolation(ctx(b)) ?? "";
  ok(lv.includes("already running") && lv.includes("browser_stop"), "launchViolation names state + next step", lv);
  const ev = emulateViolation(ctx(b), "nokia-3310") ?? "";
  ok(ev.includes("unknown device preset") && ev.includes("iphone-14"), "emulateViolation names preset + known list", ev);
  ok(emulateViolation(ctx(b), "iphone-14") === null, "emulateViolation null for known preset");
  const nr = notRunningReason("stopped");
  ok(nr.includes("browser_start"), "notRunningReason names next step", nr);
  const nrs = notRunningReason("starting");
  ok(nrs.includes("starting"), "notRunningReason covers starting state", nrs);
}

// 21. attach semantics: launch without pid still runs
{
  const stub = makeStubs({
    next: async (input) => ({ browser: browserInfo({ mode: input.mode, pid: null, userDataDir: null, browser: "Arc/1.0" }), text: "attached" }),
  });
  const a = freshActor(stub);
  a.send({ type: "BEGIN_LAUNCH", mode: "attach" });
  await settle(a);
  ok(value(a) === "running", "attach launch reaches running without pid");
  ok(ctx(a).browser?.mode === "attach", "attach mode recorded");
}

// 22. unwired machine: entering starting lands in stopped, never wedged
{
  const a = createActor(browserMachine, { input: undefined });
  a.start();
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  await settle(a);
  ok(value(a) === "stopped", "unwired launchService rejects -> stopped");
  ok(ctx(a).errors.some((e) => e.includes("not wired")), "unwired stub error recorded in ring");
  ok(a.getSnapshot().can({ type: "BEGIN_LAUNCH", mode: "fresh" }), "retry legal after unwired failure");
}

// 23. resolveAuto: smart-start decision table (pure — no IO, no TUI)
{
  const chrome: InstalledEntry = { name: "Chrome", bin: "/x/Chrome", globalSingleton: false };
  const arc: InstalledEntry = { name: "Arc", bin: "/x/Arc", globalSingleton: true };
  const chromium: InstalledEntry = { name: "Chromium", bin: "/x/Chromium", globalSingleton: false };

  const buckets = (over: Partial<DetectBuckets> = {}): DetectBuckets => ({
    attachable: [],
    runningNoCdp: [],
    installed: [chrome, arc],
    default: null,
    ...over,
  });

  // 1 CDP-attachable -> attach, no ask
  {
    const r = resolveAuto(buckets({ attachable: [{ name: "Arc", port: 9223, browser: "Arc/1.0", pid: 42 }] }));
    ok(r.action.kind === "attach" && r.action.port === 9223, "1 attachable -> attach on its port", r);
    ok(r.note.includes("attaching, no ask"), "1 attachable note: no ask", r.note);
    ok(r.warnings.length === 0, "1 attachable: no warnings", r);
  }

  // n CDP-attachable -> prompt-attach
  {
    const r = resolveAuto(buckets({
      attachable: [
        { name: "Arc", port: 9223, browser: "Arc/1.0", pid: 1 },
        { name: "Chrome", port: 9333, browser: "Chrome/126.0", pid: 2 },
      ],
    }));
    ok(r.action.kind === "prompt-attach", "2 attachable -> prompt", r);
  }

  // 0 + default usable -> launch default, no ask
  {
    const r = resolveAuto(buckets({ default: { name: "Chrome", bin: "/x/Chrome", globalSingleton: false } }));
    ok(r.action.kind === "launch" && r.action.bin === "/x/Chrome", "0 attachable + default -> launch default", r);
    ok(r.note.includes("default browser (Chrome)"), "default note names browser", r.note);
  }

  // 0 + default blocked (Arc singleton running) -> demote; single candidate -> launch it
  {
    const r = resolveAuto(
      buckets({
        runningNoCdp: [{ name: "Arc", pid: 5 }],
        default: { name: "Arc", bin: "/x/Arc", globalSingleton: true },
      }),
    );
    ok(r.action.kind === "launch" && r.action.bin === "/x/Chrome", "blocked default demoted -> launch other candidate", r);
    ok(r.note.includes("demoted"), "demote note present", r.note);
    ok(r.warnings.some((w) => w.includes("singleton lock")), "singleton warning present", r.warnings);
  }

  // 0 + default blocked + multiple candidates -> prompt-launch
  {
    const r = resolveAuto(
      buckets({
        installed: [chrome, arc, chromium],
        runningNoCdp: [{ name: "Arc", pid: 5 }],
        default: { name: "Arc", bin: "/x/Arc", globalSingleton: true },
      }),
    );
    ok(r.action.kind === "prompt-launch", "blocked default + 2 candidates -> prompt", r);
    ok(r.note.includes("demoted"), "demote note present (prompt path)", r.note);
  }

  // 0 + no default + 1 candidate -> launch it, no ask
  {
    const r = resolveAuto(buckets({ installed: [chromium], default: null }));
    ok(r.action.kind === "launch" && r.action.bin === "/x/Chromium", "no default + 1 installed -> launch it", r);
    ok(r.note.includes("only usable browser"), "single-candidate note", r.note);
  }

  // 0 + no default + 2 candidates -> prompt-launch
  {
    const r = resolveAuto(buckets());
    ok(r.action.kind === "prompt-launch", "no default + 2 installed -> prompt", r);
  }

  // 0 installed -> error with BROWSER_BIN hint
  {
    const r = resolveAuto(buckets({ installed: [], default: null }));
    ok(r.action.kind === "error" && r.note.includes("BROWSER_BIN"), "nothing installed -> error + hint", r);
  }

  // everything blocked -> error naming the singleton
  {
    const r = resolveAuto(buckets({ installed: [arc], default: { name: "Arc", bin: "/x/Arc", globalSingleton: true }, runningNoCdp: [{ name: "Arc", pid: 9 }] }));
    ok(r.action.kind === "error" && r.note.includes("quit it or relaunch"), "all blocked -> error naming singleton", r);
  }

  // Chromium-class running without CDP: informational warning, NOT blocked
  {
    const r = resolveAuto(
      buckets({
        runningNoCdp: [{ name: "Chrome", pid: 7 }],
        default: { name: "Chrome", bin: "/x/Chrome", globalSingleton: false },
      }),
    );
    ok(r.action.kind === "launch" && r.action.bin === "/x/Chrome", "Chromium-class running: default NOT demoted", r);
    ok(r.warnings.some((w) => w.includes("isolated profile")), "isolated-instance warning present", r.warnings);
  }

  // attachable beats running default (attach wins over launch)
  {
    const r = resolveAuto(
      buckets({
      attachable: [{ name: "Chrome", port: 9222, browser: "Chrome/126.0", pid: 3 }],
        runningNoCdp: [{ name: "Arc", pid: 5 }],
        default: { name: "Arc", bin: "/x/Arc", globalSingleton: true },
      }),
    );
    ok(r.action.kind === "attach" && r.action.port === 9222, "attachable wins over blocked default", r);
  }
}

// 24. errors ring bounded: STOP spam cannot grow context without bound
{
  const a = freshActor();
  for (let i = 0; i < 80; i++) {
    a.send({ type: "STOP", reason: `spam ${i}` });
  }
  ok(ctx(a).errors.length === MAX_ERRORS, `errors capped at ${MAX_ERRORS}`, ctx(a).errors.length);
  ok(ctx(a).errors[MAX_ERRORS - 1] === "stopped: spam 79", "latest entry kept");
  ok(ctx(a).errors[0] === `stopped: spam ${80 - MAX_ERRORS}`, "oldest entries dropped");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
