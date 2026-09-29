// machine tests — no LLM, no tmux. Synthetic probe evidence only.
// run: node test.ts

import { createActor, type Actor } from "xstate";
import {
  tmuxMachine,
  DEFAULT_LIMITS,
  findSession,
  liveNames,
  validateStart,
  validateSend,
  validateWait,
  validateRegister,
  validateKill,
  driftReport,
  type RegistryContext,
  type RegistryLimits,
  type SessionEntry,
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

const limits: RegistryLimits = { maxSessions: 3, maxPromptWaits: 2, maxWaitAttempts: 3 };

type A = Actor<typeof tmuxMachine>;

function freshActor(): A {
  const a = createActor(tmuxMachine, { input: { limits } });
  a.start();
  return a;
}

function ctx(a: A): RegistryContext {
  return a.getSnapshot().context;
}

function register(a: A, id: string, tool = "python", promptRegex: string | null = "^>>> "): void {
  a.send({ type: "SESSION_STARTED", id, tool, promptRegex });
}

function status(a: A, id: string): string | undefined {
  return findSession(ctx(a), id)?.status;
}

// 1. initial state + defaults
{
  const a = freshActor();
  ok(a.getSnapshot().value === "registry", "initial state is registry");
  ok(ctx(a).sessions.length === 0, "initial registry empty");
  ok(ctx(a).limits.maxSessions === 3, "explicit limits respected");
}

// 2. register: promptRegex gates initial status
{
  const a = freshActor();
  register(a, "pi-python-1", "python", "^>>> ");
  ok(a.getSnapshot().value === "registry", "register records session (registry state)");
  ok(status(a, "pi-python-1") === "waiting_prompt", "with promptRegex -> waiting_prompt");
  register(a, "pi-server-1", "server", null);
  ok(status(a, "pi-server-1") === "ready", "without promptRegex -> ready immediately");
}

// 3. prompt seen / timeout
{
  const a = freshActor();
  register(a, "pi-python-1");
  a.send({ type: "PROMPT_SEEN", id: "pi-python-1" });
  ok(status(a, "pi-python-1") === "ready", "PROMPT_SEEN -> ready");
  register(a, "pi-python-2");
  a.send({ type: "PROMPT_TIMEOUT", id: "pi-python-2" });
  ok(status(a, "pi-python-2") === "failed", "PROMPT_TIMEOUT (internal retries exhausted) -> failed");
}

// 4. unknown target: readable reason names live peers
{
  const a = freshActor();
  register(a, "pi-gdb-1", "gdb");
  const v = validateSend(ctx(a), "pi-py", true);
  ok(!v.ok && v.reason.includes('unknown session "pi-py"'), "validateSend unknown -> readable reason");
  ok(v.ok === false && v.reason.includes("pi-gdb-1"), "reason names live peer");
  const empty = freshActor();
  const v2 = validateSend(ctx(empty), "pi-py", true);
  ok(!v2.ok && v2.reason.includes("live on pi.sock: none"), "empty registry -> peers 'none'");
  // machine guard backstop: SEND unknown consumed without mutation
  empty.send({ type: "SEND", id: "pi-py", text: "x", live: false });
  ok(ctx(empty).sessions.length === 0, "SEND unknown -> no mutation");
}

// 5. send-to-dead: SESSION_DEAD keeps entry, validateSend rejects
{
  const a = freshActor();
  register(a, "pi-python-1");
  a.send({ type: "PROMPT_SEEN", id: "pi-python-1" });
  a.send({ type: "SESSION_DEAD", id: "pi-python-1" });
  ok(status(a, "pi-python-1") === "dead", "SESSION_DEAD -> status dead");
  ok(!!findSession(ctx(a), "pi-python-1"), "SESSION_DEAD keeps entry (readable, not unregistered)");
  const v = validateSend(ctx(a), "pi-python-1", false);
  ok(!v.ok && v.reason.includes("not live"), "send to dead -> readable rejection");
  a.send({ type: "SEND", id: "pi-python-1", text: "x", live: false });
  ok(status(a, "pi-python-1") === "dead", "machine SEND live=false backstops without mutation");
  const vLive = validateSend(ctx(a), "pi-python-1", true);
  ok(!vLive.ok && vLive.reason.includes("not live"), "registry-dead wins over stale live evidence");
}

// 6. cap: evidence-based liveCount, not registry
{
  const a = freshActor();
  ok(!validateStart(ctx(a), 3).ok, "liveCount at cap -> reject");
  ok(validateStart(ctx(a), 2).ok, "liveCount under cap -> ok");
  // registry holds 2 dead + 1 live; liveCount evidence = 1 (dead not counted)
  register(a, "pi-a", "x", null);
  register(a, "pi-b", "x", null);
  register(a, "pi-c", "x", null);
  a.send({ type: "SESSION_DEAD", id: "pi-a" });
  a.send({ type: "SESSION_DEAD", id: "pi-b" });
  ok(ctx(a).sessions.length === 3 && validateStart(ctx(a), 1).ok, "cap counts live evidence, not registry size");
  // adopted strays over cap: liveCount evidence includes strays
  ok(!validateStart(ctx(a), 4).ok, "adopted strays over cap -> next start blocked");
  // SESSION_START never mutates
  a.send({ type: "SESSION_START", tool: "t", cmd: "c", promptRegex: null, liveCount: 9 });
  ok(ctx(a).sessions.length === 3, "SESSION_START is precheck only, no mutation");
}

// 7. waitAttempts: bump, reset, cap at precheck
{
  const a = freshActor();
  register(a, "pi-python-1");
  a.send({ type: "WAIT_TIMEOUT", id: "pi-python-1", regex: "x" });
  a.send({ type: "WAIT_TIMEOUT", id: "pi-python-1", regex: "x" });
  ok(findSession(ctx(a), "pi-python-1")?.waitAttempts === 2, "WAIT_TIMEOUT bumps attempts");
  a.send({ type: "WAIT_MATCHED", id: "pi-python-1", regex: "x" });
  ok(findSession(ctx(a), "pi-python-1")?.waitAttempts === 0, "WAIT_MATCHED resets attempts");
  a.send({ type: "WAIT_TIMEOUT", id: "pi-python-1", regex: "x" });
  a.send({ type: "WAIT_TIMEOUT", id: "pi-python-1", regex: "x" });
  a.send({ type: "WAIT_TIMEOUT", id: "pi-python-1", regex: "x" });
  const v = validateWait(ctx(a), "pi-python-1");
  ok(!v.ok && v.reason.includes("wait attempts exhausted"), "attempts at cap -> readable rejection");
  ok(validateWait(ctx(a), "pi-other").ok === false, "wait on unknown -> readable rejection");
}

// 8. kill: unregister, silent on dead, last kill -> empty
{
  const a = freshActor();
  register(a, "pi-a", "x", null);
  register(a, "pi-b", "x", null);
  a.send({ type: "SESSION_DEAD", id: "pi-a" });
  a.send({ type: "KILL", id: "pi-a" });
  ok(!findSession(ctx(a), "pi-a"), "KILL dead entry unregisters silently");
  a.send({ type: "KILL", id: "pi-b" });
  ok(!findSession(ctx(a), "pi-b") && ctx(a).sessions.length === 0, "last KILL -> registry empty");
  a.send({ type: "KILL", id: "pi-b" });
  ok(true, "KILL unknown consumed without crash");
}

// 9. reconcile: marks dead, adopts strays, drift report
{
  const a = freshActor();
  register(a, "pi-a", "x", null);
  register(a, "pi-b", "x", null);
  const before = ctx(a).sessions;
  a.send({ type: "RECONCILE", live: [{ name: "pi-a" }, { name: "pi-stray-1" }] });
  ok(status(a, "pi-b") === "dead", "reconcile marks registered-but-dead");
  ok(!!findSession(ctx(a), "pi-b"), "marked dead stays (never resurrected, never dropped)");
  const stray = findSession(ctx(a), "pi-stray-1");
  ok(
    stray?.tool === "?" && stray?.promptRegex === null && stray?.status === "ready",
    "stray adopted: tool '?', promptRegex null, status ready",
  );
  const report = driftReport(before, ctx(a).sessions);
  ok(report.some((l) => l.includes('"pi-b" found dead')), "drift report: found dead");
  ok(report.some((l) => l.includes('"pi-stray-1" adopted')), "drift report: adopted stray");
  ok(!report.some((l) => l.includes('"pi-a"')), "drift report: clean session not mentioned");
  a.send({ type: "RECONCILE", live: [{ name: "pi-a" }] });
  ok(status(a, "pi-stray-1") === "dead", "reconcile marks adopted stray dead when it disappears");
  // probe is ground truth both ways: dead-marked-but-live recovers to ready
  const before2 = ctx(a).sessions;
  a.send({ type: "RECONCILE", live: [{ name: "pi-stray-1" }] });
  ok(status(a, "pi-stray-1") === "ready", "reconcile recovers dead-marked-but-live to ready");
  const report2 = driftReport(before2, ctx(a).sessions);
  ok(
    report2.some((l) => l.includes('"pi-stray-1" recovered (probe live, was dead)')),
    "drift report: recovered entry noted",
  );
}

// 10. reconcile in empty adopts stray -> active
{
  const a = freshActor();
  a.send({ type: "RECONCILE", live: [{ name: "pi-orphan-1" }] });
  ok(status(a, "pi-orphan-1") === "ready" && ctx(a).sessions.length === 1, "reconcile adopts strays from empty registry (recorded)");
  ok(a.getSnapshot().value === "registry", "reconcile adopting -> registry state");
  const none = freshActor();
  none.send({ type: "RECONCILE", live: [] });
  ok(none.getSnapshot().value === "registry" && ctx(none).sessions.length === 0, "reconcile with nothing records nothing");
}

// 11. id uniqueness: suffix collision rejected
{
  const a = freshActor();
  register(a, "pi-python-1");
  const before = ctx(a).sessions;
  register(a, "pi-python-1");
  ok(ctx(a).sessions.length === 1, "duplicate SESSION_STARTED rejected by guard");
  ok(JSON.stringify(before) === JSON.stringify(ctx(a).sessions), "no mutation on duplicate");
  ok(!validateRegister(ctx(a), "pi-python-1").ok, "validateRegister duplicate -> readable rejection");
  ok(validateRegister(ctx(a), "pi-python-2").ok, "validateRegister next suffix ok");
}

// 12. snapshot round-trip: registry survives persisted snapshot
{
  const a1 = freshActor();
  register(a1, "pi-python-1");
  a1.send({ type: "PROMPT_SEEN", id: "pi-python-1" });
  register(a1, "pi-gdb-1", "gdb", "^\\(gdb\\) ");
  a1.send({ type: "WAIT_TIMEOUT", id: "pi-gdb-1", regex: "x" });
  const snapshot = a1.getPersistedSnapshot();
  const a2 = createActor(tmuxMachine, {
    input: { limits: DEFAULT_LIMITS },
    snapshot: snapshot as never,
  });
  a2.start();
  ok(
    JSON.stringify(ctx(a2)) === JSON.stringify(ctx(a1)),
    "persisted snapshot restores registry exactly",
  );
  ok(a2.getSnapshot().value === "registry", "restored actor in registry state");
  a2.send({ type: "PROMPT_SEEN", id: "pi-gdb-1" });
  ok(status(a2, "pi-gdb-1") === "ready", "restored actor accepts further events");
}

// 13. interleaved 2+ sessions: statuses independent
{
  const a = freshActor();
  register(a, "pi-python-1", "python");
  register(a, "pi-gdb-1", "gdb");
  register(a, "pi-py-2", "python");
  a.send({ type: "PROMPT_SEEN", id: "pi-gdb-1" });
  a.send({ type: "PROMPT_TIMEOUT", id: "pi-py-2" });
  a.send({ type: "SESSION_DEAD", id: "pi-py-2" });
  ok(status(a, "pi-python-1") === "waiting_prompt", "s1 untouched");
  ok(status(a, "pi-gdb-1") === "ready", "s2 ready");
  ok(status(a, "pi-py-2") === "dead", "s3 dead");
  a.send({ type: "SEND", id: "pi-gdb-1", text: "run", live: true });
  ok(status(a, "pi-gdb-1") === "ready", "SEND on legal session: no mutation, no status change");
  ok(liveNames(ctx(a)).join(",") === "pi-python-1,pi-gdb-1", "liveNames excludes dead");
}

// 14. monitor flag defaults; adopted strays never monitor
{
  const a = freshActor();
  register(a, "pi-python-1");
  ok(findSession(ctx(a), "pi-python-1")?.monitor === false, "register: monitor defaults false");
  a.send({ type: "RECONCILE", live: [{ name: "pi-stray-1" }] });
  ok(findSession(ctx(a), "pi-stray-1")?.monitor === false, "adopted stray: monitor false");
}

// 15. RESTORE: registry carries over exactly (statuses preserved)
{
  const a = freshActor();
  register(a, "pi-python-1", "python", "^>>> ");
  a.send({ type: "PROMPT_SEEN", id: "pi-python-1" });
  register(a, "pi-gdb-1", "gdb", "^\\(gdb\\) ");
  register(a, "pi-dead-1", "x", null);
  a.send({ type: "SESSION_DEAD", id: "pi-dead-1" });
  a.send({ type: "WAIT_TIMEOUT", id: "pi-gdb-1", regex: "x" });
  a.send({ type: "KILL", id: "pi-dead-1" });
  a.send({ type: "KILL", id: "pi-gdb-1" });
  // registry now: pi-python-1 ready(+monitor via RESTORE), pi-python-2-like ready
  const snap: RegistryContext = {
    sessions: [
      { id: "pi-python-1", socket: "pi.sock", tool: "python", promptRegex: "^>>> ", status: "ready", waitAttempts: 2, monitor: true, owner: null },
      { id: "pi-failed-1", socket: "pi.sock", tool: "x", promptRegex: null, status: "failed", waitAttempts: 3, monitor: false, owner: null },
      { id: "pi-dead-1", socket: "pi.sock", tool: "x", promptRegex: null, status: "dead", waitAttempts: 0, monitor: false, owner: null },
      { id: "pi-wait-1", socket: "pi.sock", tool: "x", promptRegex: "^> ", status: "waiting_prompt", waitAttempts: 0, monitor: false, owner: null },
    ],
    limits,
    owner: "",
  };
  const b = freshActor();
  b.send({ type: "RESTORE", registry: snap });
  ok(b.getSnapshot().value === "registry", "RESTORE applied (registry state)");
  const restored = ctx(b).sessions;
  ok(restored.length === 4, "RESTORE restores all sessions");
  ok(restored.every((s, i) => JSON.stringify(s) === JSON.stringify(snap.sessions[i])), "RESTORE carries sessions over exactly (status/waitAttempts/monitor)");
  ok(JSON.stringify(ctx(b).limits) === JSON.stringify(limits), "RESTORE restores limits");
  // blocked when non-empty
  b.send({ type: "RESTORE", registry: { sessions: [], limits } });
  ok(ctx(b).sessions.length === 4, "RESTORE on non-empty registry rejected");
  // post-restore events work (viz survives restore); sticky statuses hold
  b.send({ type: "PROMPT_SEEN", id: "pi-failed-1" });
  ok(status(b, "pi-failed-1") === "failed", "PROMPT_SEEN on restored failed entry: stays failed");
  b.send({ type: "PROMPT_SEEN", id: "pi-wait-1" });
  ok(status(b, "pi-wait-1") === "ready", "restored waiting_prompt entry accepts PROMPT_SEEN");
  // malformed entries filtered
  const c = freshActor();
  c.send({
    type: "RESTORE",
    registry: { sessions: [{ id: "ok-1", status: "ready" }, { broken: true }, null], limits },
  } as never);
  const cs = ctx(c).sessions;
  ok(
    cs.length === 1 && cs[0].id === "ok-1" && cs[0].monitor === false && cs[0].owner === null,
    "RESTORE filters malformed entries, fills defaults (incl. owner)",
  );
  // empty restore: no sessions recorded (former always-flip removed)
  const d = freshActor();
  d.send({ type: "RESTORE", registry: { sessions: [], limits } });
  ok(ctx(d).sessions.length === 0, "RESTORE with no sessions records none");
}

// 16. MONITOR_TOGGLE
{
  const a = freshActor();
  register(a, "pi-python-1", "x", null);
  a.send({ type: "MONITOR_TOGGLE", id: "pi-python-1" });
  ok(findSession(ctx(a), "pi-python-1")?.monitor === true, "MONITOR_TOGGLE -> monitor true");
  a.send({ type: "MONITOR_TOGGLE", id: "pi-python-1" });
  ok(findSession(ctx(a), "pi-python-1")?.monitor === false, "MONITOR_TOGGLE again -> false");
  a.send({ type: "MONITOR_TOGGLE", id: "pi-nope" });
  ok(true, "MONITOR_TOGGLE unknown consumed without crash");
}

// 17. sticky dead/failed: PROMPT_SEEN/PROMPT_TIMEOUT only from waiting_prompt
{
  const a = freshActor();
  register(a, "pi-dead-1", "x", "^> ");
  a.send({ type: "SESSION_DEAD", id: "pi-dead-1" });
  a.send({ type: "PROMPT_SEEN", id: "pi-dead-1" });
  ok(status(a, "pi-dead-1") === "dead", "PROMPT_SEEN cannot resurrect dead");
  a.send({ type: "PROMPT_TIMEOUT", id: "pi-dead-1" });
  ok(status(a, "pi-dead-1") === "dead", "PROMPT_TIMEOUT cannot resurrect dead");
  register(a, "pi-failed-1", "x", "^> ");
  a.send({ type: "PROMPT_TIMEOUT", id: "pi-failed-1" });
  a.send({ type: "PROMPT_SEEN", id: "pi-failed-1" });
  ok(status(a, "pi-failed-1") === "failed", "PROMPT_SEEN cannot resurrect failed");
  register(a, "pi-ready-1", "x", null);
  a.send({ type: "PROMPT_SEEN", id: "pi-ready-1" });
  ok(status(a, "pi-ready-1") === "ready", "PROMPT_SEEN on ready: no-op, stays ready");
  register(a, "pi-live-1", "x", "^> ");
  a.send({ type: "PROMPT_SEEN", id: "pi-live-1" });
  ok(status(a, "pi-live-1") === "ready", "PROMPT_SEEN from waiting_prompt -> ready (the one legal path)");
}

// 18. owner isolation: register/adoption stamping, validateKill, KILL guard
{
  const a = createActor(tmuxMachine, { input: { limits, owner: "111" } });
  a.start();
  register(a, "pi-own-1", "x", null);
  ok(findSession(ctx(a), "pi-own-1")?.owner === "111", "registerSession stamps owner from context");
  a.send({
    type: "RECONCILE",
    live: [
      { name: "pi-own-1" },
      { name: "pi-orph-1", owner: "" },
      { name: "pi-foreign-1", owner: "222", ownerAlive: true },
    ],
  });
  ok(findSession(ctx(a), "pi-orph-1")?.owner === null, "untagged stray adopted as orphan (owner null)");
  ok(findSession(ctx(a), "pi-foreign-1")?.owner === "222", "stray adoption carries foreign owner");
  ok(validateKill(ctx(a), "pi-own-1", false).ok, "validateKill own session: killable");
  ok(validateKill(ctx(a), "pi-orph-1", true).ok, "validateKill orphan: killable even with foreignLive=true");
  const vf = validateKill(ctx(a), "pi-foreign-1", true);
  ok(
    !vf.ok && vf.reason.includes("owner pid 222") && vf.reason.includes("not this session's to kill"),
    "validateKill foreign-live: readable rejection naming the owner",
  );
  ok(validateKill(ctx(a), "pi-foreign-1", false).ok, "validateKill foreign: killable once owner dead");
  ok(!validateKill(ctx(a), "pi-nope", false).ok, "validateKill unknown: readable rejection");
  // machine KILL guard backstop: foreign-live KILL rejected, entry kept
  a.send({ type: "KILL", id: "pi-foreign-1", foreignLive: true });
  ok(!!findSession(ctx(a), "pi-foreign-1"), "machine KILL foreign-live backstopped, entry kept");
  a.send({ type: "KILL", id: "pi-foreign-1", foreignLive: false });
  ok(!findSession(ctx(a), "pi-foreign-1"), "KILL with owner-dead evidence unregisters");
  // dead foreign entry: registry hygiene — always killable
  const b = createActor(tmuxMachine, { input: { limits, owner: "111" } });
  b.start();
  b.send({ type: "RECONCILE", live: [{ name: "pi-f-1", owner: "222", ownerAlive: true }] });
  b.send({ type: "SESSION_DEAD", id: "pi-f-1" });
  ok(validateKill(ctx(b), "pi-f-1", true).ok, "dead foreign entry killable (registry hygiene)");
  b.send({ type: "KILL", id: "pi-f-1", foreignLive: true });
  ok(!findSession(ctx(b), "pi-f-1"), "KILL dead foreign entry unregisters (hygiene)");
  // unidentified context (owner ""): isolation off — legacy behavior
  const c = freshActor();
  c.send({ type: "RECONCILE", live: [{ name: "pi-x-1", owner: "999", ownerAlive: true }] });
  ok(validateKill(ctx(c), "pi-x-1", true).ok, "unidentified context (owner '') skips isolation");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
