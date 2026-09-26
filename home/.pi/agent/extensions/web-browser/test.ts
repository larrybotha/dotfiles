// machine tests — no LLM, no browser, no CDP. Synthetic probe evidence only.
// run: node test.ts

import { createActor, type Actor } from "xstate";
import {
  browserMachine,
  DEFAULT_DEVICES,
  emulateViolation,
  launchViolation,
  notRunningReason,
  type ActiveTab,
  type BrowserContext,
  type BrowserMode,
  type EmulationPref,
  type LaunchMode,
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

type A = Actor<typeof browserMachine>;

function freshActor(devices?: string[]): A {
  const a = createActor(browserMachine, { input: devices ? { devices } : undefined });
  a.start();
  return a;
}

function value(a: A): string {
  return String(a.getSnapshot().value);
}

function ctx(a: A): BrowserContext {
  return a.getSnapshot().context;
}

function launchOk(a: A, mode: LaunchMode = "fresh", pid = 4242): void {
  a.send({ type: "BEGIN_LAUNCH", mode });
  a.send({ type: "LAUNCH_DONE", mode, port: 9222, pid, userDataDir: "/x", browser: "Chrome/126", error: null });
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

// 2. launch lifecycle: stopped -> starting -> running
{
  const a = freshActor();
  a.send({ type: "BEGIN_LAUNCH", mode: "profile" });
  ok(value(a) === "starting", "BEGIN_LAUNCH moves to starting");
  a.send({
    type: "LAUNCH_DONE",
    mode: "profile",
    port: 9222,
    pid: 99,
    userDataDir: "/profile-copy",
    browser: "Chrome/126",
    error: null,
  });
  ok(value(a) === "running", "LAUNCH_DONE (no error) moves to running");
  ok(ctx(a).browser?.mode === "profile", "browser mode recorded");
  ok(ctx(a).browser?.pid === 99, "browser pid recorded");
  ok(ctx(a).browser?.userDataDir === "/profile-copy", "userDataDir recorded");
}

// 3. launch failure: starting -> stopped, error recorded
{
  const a = freshActor();
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  a.send({ type: "LAUNCH_DONE", mode: "fresh", port: 9222, pid: null, userDataDir: null, browser: null, error: "port in use" });
  ok(value(a) === "stopped", "LAUNCH_DONE error returns to stopped");
  ok(ctx(a).browser === null, "no browser after failed launch");
  ok(ctx(a).errors.some((e) => e.includes("port in use")), "launch error recorded");
}

// 4. BEGIN_LAUNCH while running is rejected (structure backstop)
{
  const a = freshActor();
  launchOk(a);
  a.send({ type: "BEGIN_LAUNCH", mode: "fresh" });
  ok(value(a) === "running", "BEGIN_LAUNCH in running is ignored");
  ok(ctx(a).browser?.pid === 4242, "browser untouched by illegal launch");
}

// 5. LAUNCH_DONE in running (illegal) is ignored
{
  const a = freshActor();
  launchOk(a);
  a.send({ type: "LAUNCH_DONE", mode: "fresh", port: 9333, pid: 1, userDataDir: null, browser: null, error: null });
  ok(ctx(a).browser?.port === 9222, "LAUNCH_DONE in running ignored");
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
  const a = freshActor();
  launchOk(a);
  probe(a, true, "attach");
  ok(value(a) === "running", "PROBE up in running stays running");
  ok(ctx(a).browser?.mode === "attach", "PROBE updates browser info");
}

// 8. probe drift: running + !up -> stopped, error recorded, caches cleared
{
  const a = freshActor();
  launchOk(a);
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
  launchOk(a);
  a.send({ type: "NAV", url: "https://example.com", newTab: true });
  ok(ctx(a).activeTab?.url === "https://example.com", "NAV in running records active tab");
  ok(typeof ctx(a).activeTab?.at === "string", "NAV records timestamp");
}

// 11. TAB_SWITCH records targetId
{
  const a = freshActor();
  launchOk(a);
  a.send({ type: "TAB_SWITCH", targetId: "ABC123", url: "https://x.dev" });
  ok(ctx(a).activeTab?.targetId === "ABC123", "TAB_SWITCH records targetId");
  ok(ctx(a).activeTab?.url === "https://x.dev", "TAB_SWITCH records url");
}

// 12. EMULATE_SET: known device applies, unknown rejected
{
  const a = freshActor();
  launchOk(a);
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
  const a = freshActor();
  launchOk(a);
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

// 15. RESTORE fills caches, never the browser
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

// 16. RESTORE with bad shape is rejected
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

// 17. DEVICES refresh works in every state
{
  const a = freshActor();
  a.send({ type: "DEVICES", ids: ["a", "b"] });
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(["a", "b"]), "DEVICES sets presets in stopped");
  launchOk(a);
  a.send({ type: "DEVICES", ids: ["c"] });
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(["c"]), "DEVICES sets presets in running");
  a.send({ type: "DEVICES", ids: [] });
  ok(JSON.stringify(ctx(a).devices) === JSON.stringify(["c"]), "empty DEVICES ignored");
}

// 18. validators: readable reasons
{
  const a = freshActor();
  ok(launchViolation(ctx(a)) === null, "launchViolation null when stopped");
  launchOk(a);
  const lv = launchViolation(ctx(a)) ?? "";
  ok(lv.includes("already running") && lv.includes("browser_stop"), "launchViolation names state + next step", lv);
  const ev = emulateViolation(ctx(a), "nokia-3310") ?? "";
  ok(ev.includes("unknown device preset") && ev.includes("iphone-14"), "emulateViolation names preset + known list", ev);
  ok(emulateViolation(ctx(a), "iphone-14") === null, "emulateViolation null for known preset");
  const nr = notRunningReason("stopped");
  ok(nr.includes("browser_start"), "notRunningReason names next step", nr);
  const nrs = notRunningReason("starting");
  ok(nrs.includes("starting"), "notRunningReason covers starting state", nrs);
}

// 19. attach semantics: launch without pid still runs
{
  const a = freshActor();
  a.send({ type: "BEGIN_LAUNCH", mode: "attach" });
  a.send({ type: "LAUNCH_DONE", mode: "attach", port: 9222, pid: null, userDataDir: null, browser: "Arc/1.0", error: null });
  ok(value(a) === "running", "attach launch reaches running without pid");
  ok(ctx(a).browser?.mode === "attach", "attach mode recorded");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
