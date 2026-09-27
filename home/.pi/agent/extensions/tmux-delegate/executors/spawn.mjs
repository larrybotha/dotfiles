#!/usr/bin/env node
/**
 * Spawn executor — builds the runner script and creates the delegate tmux
 * session. Input as JSON on argv[2]; output one-line JSON on stdout.
 *
 * In:  { sessionId, socketDir, workingDir, task, agentPrompt?,
 *        parentPid?, timeoutSecs?,
 *        pi: { command, args } }
 *      `pi` is resolved by the extension (running inside the pi process —
 *      this process cannot resolve it, process.argv points here).
 *      `parentPid` + `timeoutSecs` (both, optional for older callers) drive
 *      the runner's watchdog: if the parent pi dies (SIGKILL — no cleanup
 *      path runs) the watchdog kills the session's process group, so
 *      unmonitored delegates never orphan.
 * Out: { ok: true, sessionId, socketPath, files: {...} }
 *    | { ok: false, error }
 *      (failure cleans up its own temp files — files are only handed out on success)
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const input = JSON.parse(process.argv[2] ?? "{}");

const out = (o) => process.stdout.write(JSON.stringify(o));

const socketDir = input.socketDir;
const sessionId = input.sessionId;
const socketPath = path.join(socketDir ?? "", "agent.sock");

const tmpBase = path.join(os.tmpdir(), `pi-delegate-${sessionId}`);
const files = {
	signalFile: `${tmpBase}-signal`,
	stderrFile: `${tmpBase}-stderr`,
	taskFile: `${tmpBase}-task.md`,
	scriptFile: `${tmpBase}-run.sh`,
	promptFile: input.agentPrompt ? `${tmpBase}-prompt.md` : null,
};

function shellQuote(s) {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

try {
	if (!input.socketDir || !sessionId || !input.workingDir || !input.task) {
		out({ ok: false, error: "spawn.mjs: missing sessionId/socketDir/workingDir/task" });
		process.exit(0);
	}
	if (!input.pi?.command) {
		out({ ok: false, error: "spawn.mjs: missing pi binary resolution" });
		process.exit(0);
	}
	fs.mkdirSync(socketDir, { recursive: true });

	// Task file — file content, no shell escaping
	const taskContent = [
		"# Delegated Task",
		"",
		input.task,
		"",
		"## Instructions",
		"- Complete the task using available tools (read, write, edit, bash, grep, find, ls)",
		"- Write all output to the artifact file paths specified by the caller",
		"- When done, simply exit",
	].join("\n");
	fs.writeFileSync(files.taskFile, taskContent, "utf-8");
	if (files.promptFile) {
		fs.writeFileSync(files.promptFile, input.agentPrompt, "utf-8");
	}

	// pi command — reads the task from file at runtime (avoids escaping issues)
	const piCmd = [
		shellQuote(input.pi.command),
		...(input.pi.args ?? []).map(shellQuote),
		"--no-session",
		"-p",
		`"$(cat ${shellQuote(files.taskFile)})"`,
	].join(" ");

	// Runner script
	const scriptLines = [
		"#!/usr/bin/env bash",
		`cd ${shellQuote(input.workingDir)}`,
		`export AGENT_TMUX_SOCKET_DIR=${shellQuote(socketDir)}`,
	];
	// Watchdog (only when the caller supplies the contract): parent-pi death
	// (SIGKILL skips every cleanup path) or grace-deadline (parent hung past
	// its own timeout + margin) → kill the whole process group (runner + pi +
	// this subshell), so an unmonitored delegate never outlives its parent.
	// Killed at normal script exit below.
	if (input.parentPid && input.timeoutSecs) {
		scriptLines.push(
			`PARENTPID=${String(input.parentPid)}`,
			`GRACE=$(( ${String(input.timeoutSecs)} + 120 ))`,
			"(",
			"  deadline=$(( $(date +%s) + GRACE ))",
			"  while :; do",
			"    sleep 15",
			'    kill -0 "$PARENTPID" 2>/dev/null || { kill -TERM -- -$$ 2>/dev/null; exit 0; }',
			'    [ "$(date +%s)" -ge "$deadline" ] && { kill -TERM -- -$$ 2>/dev/null; exit 0; }',
			"  done",
			") &",
			"WATCHDOG=$!",
		);
	}
	const runLine = files.promptFile
		? `${piCmd} --append-system-prompt ${shellQuote(files.promptFile)} 2>${shellQuote(files.stderrFile)}`
		: `${piCmd} 2>${shellQuote(files.stderrFile)}`;
	scriptLines.push(runLine);
	scriptLines.push(`echo $? > ${shellQuote(files.signalFile)}`);
	// normal completion — the watchdog is no longer needed
	if (input.parentPid && input.timeoutSecs) {
		scriptLines.push('kill "$WATCHDOG" 2>/dev/null');
	}
	fs.writeFileSync(files.scriptFile, scriptLines.join("\n"), { mode: 0o755 });

	// Create the tmux session (no shell — args passed directly)
	execFileSync(
		"tmux",
		["-S", socketPath, "-f", "/dev/null", "new", "-d", "-s", sessionId, "-n", "shell", "--", "bash", files.scriptFile],
		{ stdio: "ignore" },
	);

	out({ ok: true, sessionId, socketPath, files });
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	// failure cleans up its own temp files — files are only handed out on success
	for (const f of Object.values(files)) {
		if (f) {
			try {
				fs.unlinkSync(f);
			} catch {
				/* already gone */
			}
		}
	}
	out({ ok: false, error: msg });
}
