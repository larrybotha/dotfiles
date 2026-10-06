#!/usr/bin/env node
/**
 * External orphan watchdog for the rpc-delegate extension (tmux-delegate
 * runner pattern). Direct child_process.spawn does not kill the child when
 * the parent pi is SIGKILLed — this detached process holds the contract:
 *
 *   node watchdog.mjs <parentPid> <childPid> <deadlineEpochMs> [pollMs]
 *
 * - child dies (normal end, ladder kill) → exit quietly;
 * - parent dies (SIGKILL skips every cleanup path) → TERM the child's
 *   process group, then KILL after a short grace;
 * - hard deadline passes (run timeout + 120s grace — the parent hung past
 *   its own timeout + margin) → same TERM/KILL.
 *
 * Spawned detached + unref'd so it survives the parent's death; it must
 * never outlive the child it guards.
 */
const [parentPid, childPid, deadlineMs, pollMsArg] = process.argv.slice(2).map(Number);
const pollMs = Number.isFinite(pollMsArg) && pollMsArg > 0 ? pollMsArg : 5000;

function alive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM"; // exists, just not ours
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function termGroup() {
	try {
		process.kill(-childPid, "SIGTERM");
	} catch {
		/* already gone */
	}
	const hard = Date.now() + 5000;
	while (Date.now() < hard) {
		if (!alive(childPid)) return;
		await sleep(250);
	}
	try {
		process.kill(-childPid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

async function main() {
	for (;;) {
		if (!alive(childPid)) return; // normal end — watchdog not needed
		if (!alive(parentPid) || Date.now() >= deadlineMs) break;
		await sleep(pollMs);
	}
	await termGroup();
}

main().catch(() => process.exit(0));
