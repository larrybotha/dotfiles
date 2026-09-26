// machine tests — no LLM, no pi, no file IO. Synthetic snapshots only.
// run: node test.ts

import { createActor, type Actor } from "xstate";
import {
  fileChangesMachine,
  normalizeToolPath,
  countDiffLines,
  patchFromBaseline,
  startViolation,
  commitViolation,
  recomputeViolation,
  type FileChangesRegistry,
  type TrackedFile,
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

type A = Actor<typeof fileChangesMachine>;

function freshActor(): A {
  const a = createActor(fileChangesMachine);
  a.start();
  return a;
}

function ctx(a: A): FileChangesRegistry {
  return a.getSnapshot().context;
}

function trackedEntry(path: string, kind: "new" | "edited" = "edited"): TrackedFile {
  return {
    path,
    absPath: `/tmp/${path}`,
    displayPath: path,
    originalContent: kind === "new" ? null : "original",
    currentContent: "current",
    diff: "patch",
    added: 1,
    removed: 0,
    kind,
    updatedAt: 1000,
  };
}

function start(a: A, toolCallId: string, path: string, before: string | null = "original"): void {
  a.send({ type: "TOOL_CALL_STARTED", toolCallId, path, absPath: `/tmp/${path}`, before });
}

function succeed(a: A, toolCallId: string, timestamp = 1234): void {
  a.send({ type: "TOOL_CALL_SUCCEEDED", toolCallId, timestamp });
}

function baseline(a: A, path: string, originalContent: string | null, createdAt = 1): void {
  a.send({ type: "BASELINE", path, absPath: `/tmp/${path}`, originalContent, createdAt });
}

// 1. initial state
{
  const a = freshActor();
  ok(a.getSnapshot().value === "empty", "initial state is empty");
  ok(ctx(a).pending.size === 0 && ctx(a).baselines.size === 0 && ctx(a).tracked.size === 0, "initial registry empty");
}

// 2. TOOL_CALL_STARTED records pending; machine goes active
{
  const a = freshActor();
  start(a, "tc1", "a.ts");
  ok(a.getSnapshot().value === "active", "started -> active");
  ok(ctx(a).pending.size === 1, "pending recorded");
  ok(ctx(a).pending.get("tc1")?.before === "original", "pending holds before snapshot");
}

// 3. duplicate toolCallId rejected
{
  const a = freshActor();
  start(a, "tc1", "a.ts", "v1");
  start(a, "tc1", "a.ts", "v2");
  ok(ctx(a).pending.size === 1, "duplicate toolCallId rejected (size)");
  ok(ctx(a).pending.get("tc1")?.before === "v1", "first snapshot kept after duplicate rejection");
}

// 4. two files pending simultaneously (legal)
{
  const a = freshActor();
  start(a, "tc1", "a.ts");
  start(a, "tc2", "b.ts");
  ok(ctx(a).pending.size === 2, "two pendings coexist");
}

// 5. SUCCEEDED commits baseline from before, drops pending
{
  const a = freshActor();
  start(a, "tc1", "a.ts", "original");
  succeed(a, "tc1", 5000);
  ok(ctx(a).pending.size === 0, "succeeded drops pending");
  const b = ctx(a).baselines.get("a.ts");
  ok(!!b, "succeeded creates baseline");
  ok(b?.originalContent === "original", "baseline keeps before snapshot as original");
  ok(b?.createdAt === 5000, "baseline createdAt from event timestamp");
}

// 6. orphan SUCCEEDED rejected (no pending)
{
  const a = freshActor();
  succeed(a, "ghost");
  ok(ctx(a).baselines.size === 0, "orphan succeeded rejected — no baseline created");
}

// 7. second edit of same path: baseline NOT overwritten
{
  const a = freshActor();
  start(a, "tc1", "a.ts", "original");
  succeed(a, "tc1", 100);
  start(a, "tc2", "a.ts", "original-edited");
  succeed(a, "tc2", 200);
  const b = ctx(a).baselines.get("a.ts");
  ok(b?.originalContent === "original", "first baseline preserved on second edit");
  ok(b?.createdAt === 100, "first baseline createdAt preserved");
}

// 8. FAILED drops pending
{
  const a = freshActor();
  start(a, "tc1", "a.ts");
  a.send({ type: "TOOL_CALL_FAILED", toolCallId: "tc1" });
  ok(ctx(a).pending.size === 0, "failed drops pending");
  ok(a.getSnapshot().value === "empty", "failed returns to empty when nothing else tracked");
}

// 9. orphan FAILED rejected (no crash, no change)
{
  const a = freshActor();
  a.send({ type: "TOOL_CALL_FAILED", toolCallId: "ghost" });
  ok(a.getSnapshot().value === "empty", "orphan failed rejected, state unchanged");
}

// 10. CLEAR mid-flight: pending dropped; late SUCCEEDED rejected
{
  const a = freshActor();
  start(a, "tc1", "a.ts", "original");
  a.send({ type: "CLEAR", reason: "accept", timestamp: 1 });
  ok(ctx(a).pending.size === 0, "clear drops pending");
  succeed(a, "tc1");
  ok(ctx(a).baselines.size === 0, "late succeeded after clear rejected — no baseline");
}

// 11. RECOMPUTE_DONE records tracked entry
{
  const a = freshActor();
  start(a, "tc1", "a.ts");
  succeed(a, "tc1");
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: trackedEntry("a.ts") });
  ok(ctx(a).tracked.get("a.ts")?.added === 1, "recompute records tracked entry");
}

// 12. RECOMPUTE_DONE null entry deletes tracked
{
  const a = freshActor();
  start(a, "tc1", "a.ts");
  succeed(a, "tc1");
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: trackedEntry("a.ts") });
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: null });
  ok(!ctx(a).tracked.has("a.ts"), "null recompute deletes tracked entry");
}

// 13. orphan RECOMPUTE_DONE rejected (no baseline for path)
{
  const a = freshActor();
  a.send({ type: "RECOMPUTE_DONE", path: "ghost.ts", entry: trackedEntry("ghost.ts") });
  ok(ctx(a).tracked.size === 0, "orphan recompute rejected — nothing tracked");
}

// 14. UNTRACK removes baseline + tracked
{
  const a = freshActor();
  baseline(a, "a.ts", "original");
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: trackedEntry("a.ts") });
  a.send({ type: "UNTRACK", path: "a.ts" });
  ok(!ctx(a).baselines.has("a.ts") && !ctx(a).tracked.has("a.ts"), "untrack removes baseline + tracked");
  ok(a.getSnapshot().value === "empty", "untrack of last data -> empty");
}

// 15. UNTRACK unknown path is a legal no-op
{
  const a = freshActor();
  a.send({ type: "UNTRACK", path: "ghost.ts" });
  ok(a.getSnapshot().value === "empty", "unknown untrack is no-op");
}

// 16. backToOriginal full flow: edit -> revert -> untracked -> empty
{
  const a = freshActor();
  start(a, "tc1", "a.ts", "same");
  succeed(a, "tc1", 100);
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: null }); // executor: content back to original
  ok(!ctx(a).tracked.has("a.ts"), "revert leaves nothing tracked");
  a.send({ type: "UNTRACK", path: "a.ts" });
  ok(ctx(a).baselines.size === 0, "untrack clears baseline after revert");
  ok(a.getSnapshot().value === "empty", "back-to-original flow ends empty");
}

// 17. pending survives tracked-empty (still active)
{
  const a = freshActor();
  baseline(a, "a.ts", "original");
  a.send({ type: "UNTRACK", path: "a.ts" });
  start(a, "tc1", "b.ts");
  ok(a.getSnapshot().value === "active", "pending keeps machine active");
}

// 18. CLEAR clears all three maps -> empty
{
  const a = freshActor();
  start(a, "tc1", "a.ts");
  baseline(a, "b.ts", "original");
  a.send({ type: "RECOMPUTE_DONE", path: "b.ts", entry: trackedEntry("b.ts") });
  a.send({ type: "CLEAR", reason: "accept", timestamp: 1 });
  ok(ctx(a).pending.size === 0 && ctx(a).baselines.size === 0 && ctx(a).tracked.size === 0, "clear empties registry");
  ok(a.getSnapshot().value === "empty", "clear -> empty");
}

// 19. CLEAR on empty machine is a legal no-op
{
  const a = freshActor();
  a.send({ type: "CLEAR", reason: "replay", timestamp: 1 });
  ok(a.getSnapshot().value === "empty", "clear on empty is no-op");
}

// 20. replay sequence: BASELINE a, BASELINE b, UNTRACK a, CLEAR, BASELINE c
{
  const a = freshActor();
  baseline(a, "a.ts", "A");
  baseline(a, "b.ts", "B");
  a.send({ type: "UNTRACK", path: "a.ts" });
  a.send({ type: "CLEAR", reason: "accept", timestamp: 9 });
  baseline(a, "c.ts", "C", 10);
  a.send({ type: "RECOMPUTE_DONE", path: "c.ts", entry: trackedEntry("c.ts", "new") });
  ok(ctx(a).baselines.size === 1 && ctx(a).baselines.has("c.ts"), "replay: only post-clear baseline remains");
  ok(ctx(a).tracked.get("c.ts")?.kind === "new", "replay: recomputed tracked entry recorded");
  ok(a.getSnapshot().value === "active", "replay ends active");
}

// 21. later RECOMPUTE_DONE replaces earlier entry (recompute refresh)
{
  const a = freshActor();
  baseline(a, "a.ts", "original");
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: trackedEntry("a.ts") });
  const e2 = { ...trackedEntry("a.ts"), added: 9, updatedAt: 2000 };
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: e2 });
  ok(ctx(a).tracked.get("a.ts")?.added === 9, "recompute overwrites earlier tracked entry");
}

// 22. pending survives UNTRACK; next SUCCEEDED recreates baseline
{
  const a = freshActor();
  start(a, "tc1", "a.ts", "original");
  succeed(a, "tc1", 100);
  a.send({ type: "RECOMPUTE_DONE", path: "a.ts", entry: null });
  a.send({ type: "UNTRACK", path: "a.ts" });
  start(a, "tc2", "a.ts", "original"); // file is back to original; next edit starts fresh
  succeed(a, "tc2", 200);
  ok(ctx(a).baselines.get("a.ts")?.originalContent === "original", "baseline recreated after untrack");
}

// 23. pure helpers: normalizeToolPath
{
  const cwd = "/home/user/proj";
  const r1 = normalizeToolPath(cwd, "src/a.ts");
  ok(r1.absPath === "/home/user/proj/src/a.ts" && r1.relPath === "src/a.ts", "relative path normalized");
  const r2 = normalizeToolPath(cwd, "@src/a.ts");
  ok(r2.relPath === "src/a.ts", "@-prefix stripped");
  const r3 = normalizeToolPath(cwd, "../outside.ts");
  ok(r3.relPath === "../outside.ts", "cwd escape keeps cleaned input");
}

// 24. pure helpers: countDiffLines / patchFromBaseline
{
  const diff = patchFromBaseline("f.ts", "a\n", "a\nb\n");
  const { added, removed } = countDiffLines(diff);
  ok(added === 1 && removed === 0, "countDiffLines counts hunks (added)");
  const zero = countDiffLines(patchFromBaseline("f.ts", "x\n", "x\n"));
  ok(zero.added === 0 && zero.removed === 0, "identical content -> zero added/removed");
  const rm = countDiffLines(patchFromBaseline("f.ts", "x\ny\n", ""));
  ok(rm.removed === 2, "deleted file diff counts removals");
}

// 25. validators return readable reasons
{
  const a = freshActor();
  start(a, "tc1", "a.ts");
  const sv = startViolation(ctx(a), "tc1");
  ok(typeof sv === "string" && sv.includes("tc1"), "startViolation names the toolCallId");
  const cv = commitViolation(ctx(a), "ghost");
  ok(typeof cv === "string" && cv.includes("ghost"), "commitViolation names the toolCallId");
  const rv = recomputeViolation(ctx(a), "ghost.ts");
  ok(typeof rv === "string" && rv.includes("ghost.ts"), "recomputeViolation names the path");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
