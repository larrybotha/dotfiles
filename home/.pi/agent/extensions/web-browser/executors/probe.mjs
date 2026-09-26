#!/usr/bin/env node
// Probe the browser CDP debug endpoint + the skill browser state file.
// JSON out, exit 0, failure-as-data ({up:false} is not an error).
// Usage: probe.mjs [port]
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv[2] || process.env.BROWSER_DEBUG_PORT || 9222);
const host = process.env.BROWSER_DEBUG_HOST || "localhost";
const STATE_FILE = join(homedir(), ".cache", "agent-web", "browser", "state.json");

function readState() {
	if (!existsSync(STATE_FILE)) return null;
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return null;
	}
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3000);
timer.unref?.();

try {
	const resp = await fetch(`http://${host}:${port}/json/version`, {
		signal: controller.signal,
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	const info = await resp.json();
	const state = readState();
	console.log(
		JSON.stringify({
			up: true,
			port,
			browser: info.Browser || null,
			pid: typeof state?.pid === "number" ? state.pid : null,
			mode: state?.mode ?? "foreign", // no state file = instance we did not launch
			userDataDir: state?.userDataDir ?? null,
			startedAt: state?.startedAt ?? null,
		}),
	);
} catch {
	console.log(JSON.stringify({ up: false, port }));
} finally {
	clearTimeout(timer);
}
