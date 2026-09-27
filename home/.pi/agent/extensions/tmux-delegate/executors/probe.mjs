#!/usr/bin/env node
/**
 * Probe executor — poll the delegate session. One-line JSON on stdout.
 *
 * In:  { signalFile, socketPath, sessionId }
 * Out: { done, exitCode, alive }
 *      done    — signal file written and parseable (pi exited, $? recorded)
 *      exitCode— parsed $? (null while mid-write/unparseable)
 *      alive   — tmux has-session (false = died without signal file)
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const input = JSON.parse(process.argv[2] ?? "{}");
const out = (o) => process.stdout.write(JSON.stringify(o));

if (!input.signalFile || !input.socketPath || !input.sessionId) {
	// bad input is a caller bug, not a session death — say so, don't guess
	out({ ok: false, error: "probe.mjs: missing signalFile/socketPath/sessionId" });
	process.exit(0);
}

let done = false;
let exitCode = null;
try {
	const raw = fs.readFileSync(input.signalFile, "utf-8").trim();
	const code = parseInt(raw, 10);
	if (!Number.isNaN(code)) {
		done = true;
		exitCode = code;
	}
} catch {
	/* no signal file yet, or mid-write */
}

let alive = true;
try {
	execFileSync("tmux", ["-S", input.socketPath, "has-session", "-t", input.sessionId], {
		stdio: "ignore",
	});
} catch {
	alive = false;
}

out({ ok: true, done, exitCode, alive });
