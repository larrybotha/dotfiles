/**
 * Live checks — the extension's wired machine + transport against a real
 * child pi (`pi --mode rpc --no-session`), self-spawned:
 *
 *   node live.test.ts                # full run (real model, a few cents)
 *   node live.test.ts --orphan-victim  # internal: parent-death watchdog victim
 *
 * Runs:
 * 1. happy path — reply PONG + write an artifact; success, disposition
 *    started, stopReason stop, artifact content exact, session stats,
 *    duration evidence (run + total, machine-stamped).
 * 2. deadline — sleep past a short timeout; timeout, ladder terminates the
 *    child, session exported (failure-ish outcome) to an HTML file.
 * 3. abort — KILL mid-run (the tool's ctx.signal path); aborted, ladder
 *    terminates, no export (user cancelled — by design).
 * 4. provider/model — explicit --provider/--model flag assembly live.
 * 5. big prompt — ~100 KB task through stdin backpressure (pipe capacity
 *    64 KB); success, reply intact.
 * 6. orphan — self-spawned victim process is SIGKILLed mid-run; the external
 *    watchdog must TERM the child process group (the sleep task would
 *    otherwise outlive everything).
 * 7. stall supervision — a 4s stall gap survives a 15s silently-running
 *    child tool (open-tool suppression) and the watchdog heartbeat file
 *    ({t, open}) is written live.
 *
 * The extension tool itself (rpc_delegate_task) runs the same wired machine
 * in-process — this script exercises the same wiring without a pi host.
 * Env note: host PI_* vars (PI_MODEL etc.) are inherited by children but are
 * markers for shell tools, not CLI config — verified live: an inherited
 * PI_MODEL does not change the child's selected model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createActor, waitFor } from "xstate";
import { wiredMachine } from "./index.ts";
import { runDurationMs, statusOf, totalDurationMs, type RpcEvent } from "./machine.ts";

const isFinal = (v: unknown) =>
	v === "success" || v === "error" || v === "timeout" || v === "aborted";

interface RunResult {
	status: string;
	disposition: string | null;
	stopReason: string | null;
	childExit: number | null;
	deadlineHit: boolean;
	stallHit: boolean;
	failureDetail: string | null;
	artifacts: { path: string; content: string; missing: boolean; readError?: string }[];
	summary: string;
	assistantTextTail: string;
	usage: unknown;
	runDurationMs: number | null;
	totalDurationMs: number | null;
	childExitSignal: string | null;
}

async function run(input: {
	task: string;
	artifactPaths?: string[];
	timeoutSecs?: number;
	abortAfterMs?: number;
	provider?: string;
	model?: string;
	/** Stall gap override (default 180s) — small gaps prove suppression live. */
	stallMs?: number;
	/** Watchdog heartbeat file path (live check 7 asserts it). */
	heartbeatPath?: string;
}): Promise<RunResult> {
	const sessionId = `live-check-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const a = createActor(wiredMachine);
	a.start();
	const sink = (ev: RpcEvent) => a.send(ev);

	a.send({
		type: "BEGIN",
		sessionId,
		task: input.task,
		agentPrompt: null,
		provider: input.provider ?? null,
		model: input.model ?? null,
		tools: null,
		extensions: null,
		artifactPolicy: "stopReason",
		timeoutSecs: input.timeoutSecs ?? 300,
		workingDir: process.cwd(),
		artifactPaths: input.artifactPaths ?? [],
		launch: {
			// live checks run under plain node — resolve pi from PATH, not from
			// this process's argv (that points at live.test.ts, not pi)
			pi: { command: "pi", args: [] },
			parentPid: process.pid,
			sink,
			watchdogPath: path.join(import.meta.dirname, "watchdog.mjs"),
			stallGapMs: input.stallMs ?? 180_000,
			heartbeatPath: input.heartbeatPath ?? null,
		},
	});

	// mid-run abort: the tool's ctx.signal path sends the same KILL event
	if (input.abortAfterMs !== undefined) {
		setTimeout(() => a.send({ type: "KILL" }), input.abortAfterMs);
	}

	await waitFor(a, (s) => isFinal(s.value), { timeout: input.timeoutSecs! * 1000 + 180_000 });

	const c = a.getSnapshot().context;
	const ev = c.transport?.getEvidence();
	a.stop();

	return {
		status: statusOf(String(a.getSnapshot().value)),
		disposition: c.promptDisposition,
		stopReason: c.lastAssistantStopReason,
		childExit: c.childExit,
		deadlineHit: c.deadlineHit,
		stallHit: c.stallHit,
		failureDetail: c.failureDetail,
		artifacts: c.artifacts,
		summary: c.summary,
		assistantTextTail: ev?.assistantTextTail ?? "",
		usage: c.usage,
		runDurationMs: runDurationMs(c),
		totalDurationMs: totalDurationMs(c),
		childExitSignal: c.childExitSignal,
	};
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function sh(cmd: string): Promise<string> {
	return new Promise((resolve) => {
		const p = spawn("/bin/sh", ["-c", cmd], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		p.stdout.on("data", (c: Buffer) => (out += c.toString()));
		p.on("close", () => resolve(out));
		p.on("error", () => resolve(""));
	});
}

// --- 0. victim mode (spawned by live check 6) ------------------------------

if (process.argv.includes("--orphan-victim")) {
	// Victim: start a delegated sleep task, then hold — the main live-check
	// process SIGKILLs this one mid-run (no atexit, no signals reach the
	// child group) and expects the external watchdog to reap everything.
	const sessionId = `live-check-orphan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const a = createActor(wiredMachine);
	a.start();
	a.send({
		type: "BEGIN",
		sessionId,
		task: "Immediately run the bash tool with the command: sleep 137. This is mandatory: do not reply, do not stop, and do nothing else until it completes.",
		agentPrompt: null,
		provider: null,
		model: null,
		tools: null,
		extensions: null,
		artifactPolicy: "stopReason",
		timeoutSecs: 300,
		workingDir: process.cwd(),
		artifactPaths: [],
		launch: {
			pi: { command: "pi", args: [] },
			parentPid: process.pid,
			sink: (ev: RpcEvent) => a.send(ev),
			watchdogPath: path.join(import.meta.dirname, "watchdog.mjs"),
			stallGapMs: 180_000,
			heartbeatPath: null,
		},
	});
	await waitFor(a, (s) => s.matches("running"), { timeout: 30_000 });
	const childPid = a.getSnapshot().context.transport?.childPid() ?? null;
	process.stdout.write(JSON.stringify({ sessionId, pid: process.pid, childPid }) + "\n");
	// hold the event loop: never settle, never exit — the parent kills us
	setInterval(() => {}, 1 << 30);
	await new Promise<never>(() => {});
}

// --- 1. happy path -----------------------------------------------------------

const artifactPath = path.join(os.tmpdir(), `rpc-delegate-live-check-${Date.now()}.txt`);
console.log("== live check 1: happy path (real pi child, real model) ==");
const okRun = await run({
	task: [
		`Reply with exactly the single word PONG and nothing else.`,
		`Then write the file ${artifactPath} containing exactly the text PONG (no trailing newline beyond one).`,
		`Then stop.`,
	].join(" "),
	artifactPaths: [artifactPath],
	timeoutSecs: 120,
});
console.log(`  status=${okRun.status} disposition=${okRun.disposition} stopReason=${okRun.stopReason} exit=${okRun.childExit}`);
check("status is success", okRun.status === "success", `got ${okRun.status} (${okRun.failureDetail ?? ""})`);
check("disposition started", okRun.disposition === "started", `got ${okRun.disposition}`);
check("stopReason stop", okRun.stopReason === "stop", `got ${okRun.stopReason}`);
const artifact = okRun.artifacts[0];
check("artifact collected", !!artifact && !artifact.missing && !artifact.readError, JSON.stringify(artifact));
check("artifact content PONG", artifact?.content.trim() === "PONG", `got ${JSON.stringify(artifact?.content)}`);
check("assistant text tail present", okRun.assistantTextTail.length > 0, `tail: ${JSON.stringify(okRun.assistantTextTail.slice(0, 80))}`);
check("usage recorded (get_session_stats)", okRun.usage !== null, "no usage");
check("duration recorded (run + total, stamped by the machine)", okRun.runDurationMs !== null && okRun.totalDurationMs !== null, `run=${okRun.runDurationMs} total=${okRun.totalDurationMs}`);

// --- 2. hard-cap deadline path -----------------------------------------------

console.log("== live check 2: hard-cap deadline (sleeping child, ladder) ==");
const deadlineRun = await run({
	task: "Immediately run the bash tool with the command: sleep 137. This is mandatory: do not reply, do not stop, and do nothing else until it completes.",
	timeoutSecs: 8,
});
console.log(`  status=${deadlineRun.status} deadlineHit=${deadlineRun.deadlineHit} exit=${deadlineRun.childExit} signal=${deadlineRun.childExitSignal}`);
check("status is timeout", deadlineRun.status === "timeout", `got ${deadlineRun.status} (${deadlineRun.failureDetail ?? ""})`);
check("deadline marked", deadlineRun.deadlineHit === true);
check("child terminated (graceful exit 0 via stdin-close ladder rung is fine)", deadlineRun.childExit !== null, `exit=${deadlineRun.childExit} signal=${deadlineRun.childExitSignal}`);
// --- 3. abort path -----------------------------------------------------------

console.log("== live check 3: abort mid-run (ctx.signal → KILL event) ==");
const abortRun = await run({
	task: "Immediately run the bash tool with the command: sleep 137. This is mandatory: do not reply, do not stop, and do nothing else until it completes.",
	timeoutSecs: 300,
	abortAfterMs: 6000,
});
console.log(`  status=${abortRun.status} exit=${abortRun.childExit} signal=${abortRun.childExitSignal}`);
check("status is aborted", abortRun.status === "aborted", `got ${abortRun.status} (${abortRun.failureDetail ?? ""})`);
check("child terminated by the ladder", abortRun.childExit !== null, `exit=${abortRun.childExit} signal=${abortRun.childExitSignal}`);

// --- 4. explicit provider/model flags ---------------------------------------

console.log("== live check 4: explicit provider + model (flag assembly) ==");
const pinnedRun = await run({
	task: "Reply with exactly the single word PINNED and stop.",
	provider: "opencode",
	model: "glm-5.1",
	timeoutSecs: 120,
});
console.log(`  status=${pinnedRun.status} stopReason=${pinnedRun.stopReason}`);
check("status is success with --provider opencode --model glm-5.1", pinnedRun.status === "success", `got ${pinnedRun.status} (${pinnedRun.failureDetail ?? ""})`);
check("reply mentions PINNED", /PINNED/.test(pinnedRun.assistantTextTail), `tail: ${JSON.stringify(pinnedRun.assistantTextTail.slice(0, 120))}`);

// --- 5. big prompt (stdin backpressure) --------------------------------------

console.log("== live check 5: ~100 KB task (stdin backpressure, drain path) ==");
const filler = "Reference material follows; ignore it entirely. ".repeat(1) +
	Array.from({ length: 2600 }, (_, i) => `Fact ${i}: the quick brown fox jumps over 0123456789. `).join("");
const bigTask = `${filler}\n\nIgnore all of the above. Reply with exactly the single word BIGPROMPT and stop.`;
console.log(`  task size: ${(bigTask.length / 1024).toFixed(1)} KB`);
const bigRun = await run({ task: bigTask, timeoutSecs: 180 });
console.log(`  status=${bigRun.status} stopReason=${bigRun.stopReason}`);
check("status is success on a ~100 KB task", bigRun.status === "success", `got ${bigRun.status} (${bigRun.failureDetail ?? ""})`);
check("reply mentions BIGPROMPT", /BIGPROMPT/.test(bigRun.assistantTextTail), `tail: ${JSON.stringify(bigRun.assistantTextTail.slice(0, 120))}`);

// --- 6. orphan watchdog (parent SIGKILL) -------------------------------------

console.log("== live check 6: orphan watchdog (SIGKILL the parent mid-run) ==");
const victim = spawn(process.execPath, [import.meta.filename, "--orphan-victim"], {
	stdio: ["ignore", "pipe", "inherit"],
});
let victimInfo = "";
const victimDeadline = Date.now() + 40_000;
await new Promise<void>((resolve, reject) => {
	victim.stdout!.on("data", (c: Buffer) => {
		victimInfo += c.toString();
		if (victimInfo.includes("\n")) resolve();
	});
	victim.once("error", reject);
	setTimeout(() => reject(new Error(`victim silent: ${victimInfo.slice(0, 200)}`)), 20_000).unref?.();
	if (Date.now() > victimDeadline) reject(new Error("unreachable"));
});
let childPid = 0;
try {
	const v = JSON.parse(victimInfo.split("\n")[0]) as { sessionId: string; childPid: number | null };
	childPid = v.childPid ?? 0;
} catch {
	check("victim reported its child pid", false, victimInfo.slice(0, 200));
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
if (childPid) {
	// pi rewrites its argv (process.title) — track the child by PID
	check("victim's delegated child alive before parent kill", alive(childPid), `child pid ${childPid} not running`);

	victim.kill("SIGKILL"); // no atexit, no signal to the child group
	await new Promise((r) => setTimeout(r, 300));

	// the watchdog must TERM the child process group; the sleep task would
	// otherwise outlive everything (its grandchild bash runs in the child's
	// process group)
	let orphanFree = false;
	let last = "";
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		const childAlive = alive(childPid);
		const sleepers = (await sh("pgrep -f 'sleep 137'") ?? "").trim();
		const watchdog = (await sh(`pgrep -f 'watchdog.mjs.*${victim.pid}'`) ?? "").trim();
		last = `childAlive=${childAlive} sleep=${sleepers} watchdog=${watchdog}`;
		if (!childAlive && !sleepers && !watchdog) {
			orphanFree = true;
			break;
		}
	}
	check("no orphans after parent SIGKILL (child, sleep task, watchdog all gone)", orphanFree, `still alive: ${last}`);
	try {
		victim.kill("SIGKILL"); // no-op if already dead
	} catch { /* already dead */ }
}

// --- 7. stall supervision (open-tool suppression + heartbeat) ------------------

console.log("== live check 7: stall supervision (suppression during a child tool + heartbeat file) ==");
const hbPath = path.join(os.tmpdir(), `rpc-delegate-live-check-hb-${Date.now()}.json`);
let hbSeen = false;
let hbOpenPeak = 0;
const hbWatch = setInterval(() => {
	try {
		const hb = JSON.parse(fs.readFileSync(hbPath, "utf8")) as { t: number; open: number };
		hbSeen = true;
		hbOpenPeak = Math.max(hbOpenPeak, hb.open);
	} catch {
		/* not written yet */
	}
}, 250);
// 4s stall gap vs 15s of silence INSIDE a child bash tool: without open-tool
// suppression the stall timer would cancel the run at ~4s.
const stallRun = await run({
	task: "Immediately run the bash tool with the command: sleep 15. This is mandatory: do not reply, do not stop, and do nothing else until it completes. After it completes, reply with exactly the single word DONE and stop.",
	timeoutSecs: 120,
	stallMs: 4000,
	heartbeatPath: hbPath,
});
clearInterval(hbWatch);
console.log(`  status=${stallRun.status} stallHit=${stallRun.stallHit} exit=${stallRun.childExit} hbSeen=${hbSeen} hbOpenPeak=${hbOpenPeak}`);
check(
	"status is success (15s of silence inside a child tool must NOT trip the 4s stall gap)",
	stallRun.status === "success",
	`got ${stallRun.status} (${stallRun.failureDetail ?? ""})`,
);
check("stall not hit", stallRun.stallHit === false);
check("heartbeat file written during the run", hbSeen);
check("heartbeat observed an open child tool", hbOpenPeak >= 1, `peak open=${hbOpenPeak}`);
try {
	fs.rmSync(hbPath, { force: true });
} catch {
	/* already gone */
}

// --- cleanup -----------------------------------------------------------------

try {
	fs.unlinkSync(artifactPath);
} catch { /* already gone */ }
console.log(`\n${passed} checks passed${failed > 0 ? `, ${failed} failed` : ""}`);
if (failed > 0) process.exit(1);
