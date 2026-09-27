#!/usr/bin/env node
/**
 * Kill executor — best-effort tmux kill-session. Idempotent: already-dead is
 * success. One-line JSON on stdout.
 *
 * In:  { socketPath, sessionId }
 * Out: { ok: true, alreadyDead? }
 */
import { execFileSync } from "node:child_process";

const input = JSON.parse(process.argv[2] ?? "{}");
const out = (o) => process.stdout.write(JSON.stringify(o));

try {
	execFileSync("tmux", ["-S", input.socketPath, "kill-session", "-t", input.sessionId], {
		stdio: "ignore",
	});
	out({ ok: true });
} catch {
	out({ ok: true, alreadyDead: true });
}
