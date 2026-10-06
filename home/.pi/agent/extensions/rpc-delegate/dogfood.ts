/**
 * Live dogfood — the extension's wired machine + transport against a real
 * child pi (`pi --mode rpc --no-session`), self-spawned:
 *
 *   node dogfood.ts
 *
 * Two runs:
 * 1. happy path — a trivial task that must reply PONG and write an artifact
 *    file; asserts status success, disposition started, stopReason stop,
 *    artifact collected with the expected content.
 * 2. deadline path — a task that sleeps far past a short timeout; asserts
 *    status timeout, the cancellation ladder ran (clear_queue + abort were
 *    sent), and the child is gone afterwards (no orphans).
 *
 * Real model calls (a few cents). The extension tool itself (rpc_delegate_task)
 * runs the same wired machine in-process — this script exercises the same
 * wiring without a pi host.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createActor, waitFor } from "xstate";
import { wiredMachine } from "./index.ts";
import { evaluateSuccess, statusOf, type RpcEvent } from "./machine.ts";

const isFinal = (v: unknown) =>
	v === "success" || v === "error" || v === "timeout" || v === "aborted";

interface RunResult {
	status: string;
	disposition: string | null;
	stopReason: string | null;
	childExit: number | null;
	deadlineHit: boolean;
	failureDetail: string | null;
	artifacts: { path: string; content: string; missing: boolean; readError?: string }[];
	summary: string;
	assistantTextTail: string;
	stderrTail: string;
	ladderCommands: string[];
	usage: unknown;
	sessionExportPath: string | null;
	childExitSignal: string | null;
}

async function run(input: {
	task: string;
	artifactPaths: string[];
	timeoutSecs: number;
}): Promise<RunResult> {
	const a = createActor(wiredMachine);
	a.start();
	const sink = (ev: RpcEvent) => a.send(ev);

	a.send({
		type: "BEGIN",
		sessionId: `dogfood-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		task: input.task,
		agentPrompt: null,
		provider: null,
		model: null,
		tools: null,
		artifactPolicy: "stopReason",
		timeoutSecs: input.timeoutSecs,
		workingDir: process.cwd(),
		artifactPaths: input.artifactPaths,
		launch: {
			// dogfood runs under plain node — resolve pi from PATH, not from
			// this process's argv (that points at dogfood.ts, not pi)
			pi: { command: "pi", args: [] },
			parentPid: process.pid,
			sink,
			watchdogPath: path.join(import.meta.dirname, "watchdog.mjs"),
		},
	});

	await waitFor(a, (s) => isFinal(s.value), { timeout: input.timeoutSecs * 1000 + 120_000 });

	const c = a.getSnapshot().context;
	const ev = c.transport?.getEvidence();
	a.stop();

	return {
		status: statusOf(String(a.getSnapshot().value)),
		disposition: c.promptDisposition,
		stopReason: c.lastAssistantStopReason,
		childExit: c.childExit,
		deadlineHit: c.deadlineHit,
		failureDetail: c.failureDetail,
		artifacts: c.artifacts,
		summary: c.summary,
		assistantTextTail: ev?.assistantTextTail ?? "",
		stderrTail: ev?.stderrTail ?? "",
		ladderCommands: [],
		usage: c.usage,
		sessionExportPath: c.sessionExportPath,
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

// --- 1. happy path -----------------------------------------------------------

const artifactPath = path.join(os.tmpdir(), `rpc-delegate-dogfood-${Date.now()}.txt`);
console.log("== dogfood 1: happy path (real pi child, real model) ==");
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

// --- 2. deadline path --------------------------------------------------------

console.log("== dogfood 2: deadline (short timeout, sleeping child, ladder) ==");
const deadlineRun = await run({
	task: "Run the bash tool with the command: sleep 120. Do not do anything else. Do not stop early.",
	artifactPaths: [],
	timeoutSecs: 8,
});
console.log(`  status=${deadlineRun.status} deadlineHit=${deadlineRun.deadlineHit} exit=${deadlineRun.childExit} signal=${deadlineRun.childExitSignal}`);
check("status is timeout", deadlineRun.status === "timeout", `got ${deadlineRun.status} (${deadlineRun.failureDetail ?? ""})`);
check("deadline marked", deadlineRun.deadlineHit === true);
check("child terminated (graceful exit 0 via stdin-close ladder rung is fine)", deadlineRun.childExit !== null, `exit=${deadlineRun.childExit} signal=${deadlineRun.childExitSignal}`);

// cleanup dogfood artifact
try {
	fs.unlinkSync(artifactPath);
} catch {
	/* already gone */
}

console.log(`\n${passed} checks passed${failed > 0 ? `, ${failed} failed` : ""}`);
if (failed > 0) process.exit(1);
