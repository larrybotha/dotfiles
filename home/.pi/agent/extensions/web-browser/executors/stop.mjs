#!/usr/bin/env node
// Stop a browser the skill launched. Never kills attach/foreign instances —
// those are the user's own browser. Clears skill state files either way.
// JSON out, exit 0, failure-as-data.
// Usage: stop.mjs [port]
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv[2] || process.env.BROWSER_DEBUG_PORT || 9222);
const BROWSER_ROOT = join(homedir(), ".cache", "agent-web", "browser");
const STATE_FILE = join(BROWSER_ROOT, "state.json");
const ACTIVE_TAB_FILE = join(BROWSER_ROOT, "active-tab.json");

function readState() {
	if (!existsSync(STATE_FILE)) return null;
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return null;
	}
}

function isAlive(pid) {
	if (!pid || typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function endpointUp(ms = 3000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	timer.unref?.();
	try {
		const resp = await fetch(`http://localhost:${port}/json/version`, {
			signal: controller.signal,
		});
		return resp.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function clearFiles() {
	for (const f of [STATE_FILE, ACTIVE_TAB_FILE]) {
		try {
			rmSync(f, { force: true });
		} catch {
			// ignore
		}
	}
}

const state = readState();

if (!state) {
	// nothing we own — clear orphaned active-tab if any, report
	if (existsSync(ACTIVE_TAB_FILE)) clearFiles();
	console.log(JSON.stringify({ stopped: false, reason: "no browser state file — nothing we launched", mode: null }));
	process.exit(0);
}

const mode = state.mode ?? "attach";

if (mode === "attach" || mode === "foreign" || !state.pid) {
	clearFiles();
	console.log(
		JSON.stringify({
			stopped: true,
			killed: false,
			mode,
			reason: mode === "attach" ? "attach mode — browser left running (user's instance)" : "no pid recorded — browser left as-is",
		}),
	);
	process.exit(0);
}

if (!isAlive(state.pid)) {
	clearFiles();
	console.log(JSON.stringify({ stopped: true, killed: false, mode, pid: state.pid, reason: "process already gone" }));
	process.exit(0);
}

try {
	process.kill(state.pid, "SIGTERM");
} catch (e) {
	console.log(JSON.stringify({ stopped: false, mode, pid: state.pid, reason: `kill failed: ${e.message}` }));
	process.exit(0);
}

// wait up to 3s for the debug endpoint to go down
const deadline = Date.now() + 3000;
let down = false;
while (Date.now() < deadline) {
	if (!(await endpointUp(1000))) {
		down = true;
		break;
	}
	await new Promise((r) => setTimeout(r, 250));
}

clearFiles();
console.log(
	JSON.stringify({
		stopped: true,
		killed: true,
		mode,
		pid: state.pid,
		endpointDown: down,
		...(down ? {} : { reason: "SIGTERM sent; endpoint still up after 3s — check for a second instance on the port" }),
	}),
);
