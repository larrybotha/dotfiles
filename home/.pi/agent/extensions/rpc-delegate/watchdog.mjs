#!/usr/bin/env node
/**
 * External orphan watchdog for the rpc-delegate extension. Direct
 * child_process.spawn does not kill the child when
 * the parent pi is SIGKILLed — this detached process holds the contract:
 *
 *   node watchdog.mjs <parentPid> <childPid> <deadlineEpochMs> [pollMs]
 *                     [heartbeatPath] [stallMs]
 *
 * - child dies (normal end, ladder kill) → exit quietly (heartbeat unlinked);
 * - parent dies (SIGKILL skips every cleanup path) → TERM the child's
 *   process group, then KILL after a short grace;
 * - hard deadline passes (run hard cap + grace — the parent hung past its
 *   own timeout + margin) → same TERM/KILL;
 * - heartbeat stale (optional, gap + margin, no open child tool) → same
 *   TERM/KILL. The transport resets a stall timer in-process; the heartbeat
 *   file is the belt-and-suspenders for a WEDGED extension process (its
 *   timers dead, its reader dead). open > 0 in the file means a child tool
 *   is legitimately running silently — never reaped on staleness then.
 *
 * Spawned detached + unref'd so it survives the parent's death; it must
 * never outlive the child it guards.
 */
import * as fs from "node:fs";

const [parentPid, childPid, deadlineMs, pollMsArg, heartbeatPath, stallMsArg] = process.argv
	.slice(2)
	.map(Number);
const pollMs = Number.isFinite(pollMsArg) && pollMsArg > 0 ? pollMsArg : 5000;
const stallMs = Number.isFinite(stallMsArg) && stallMsArg > 0 ? stallMsArg : 0;
/** Margin over the transport's own stall gap: poll cadence + fs latency. */
const HB_STALL_MARGIN_MS = 60_000;

function alive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM"; // exists, just not ours
	}
}

/** True when the heartbeat says the child went silent (no open tool) beyond
 *  the stall gap + margin. Missing/unreadable/stale-schema file is ignored —
 *  the hard deadline still guards that case. */
function heartbeatStalled() {
	if (!heartbeatPath || !stallMs) return false;
	try {
		const hb = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
		if (typeof hb?.t !== "number" || hb.open > 0) return false;
		return Date.now() - hb.t > stallMs + HB_STALL_MARGIN_MS;
	} catch {
		return false;
	}
}

function cleanupHeartbeat() {
	if (!heartbeatPath) return;
	try {
		fs.unlinkSync(heartbeatPath);
	} catch {
		/* already gone */
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
		if (!alive(childPid)) {
			cleanupHeartbeat(); // normal end — the watchdog outlived the file
			return;
		}
		if (!alive(parentPid) || Date.now() >= deadlineMs || heartbeatStalled()) break;
		await sleep(pollMs);
	}
	await termGroup();
	cleanupHeartbeat();
}

main().catch(() => {
	cleanupHeartbeat();
	process.exit(0);
});
