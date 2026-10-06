#!/usr/bin/env node
// Close + relaunch a browser with --remote-debugging-port, then wait for
// its CDP endpoint. JSON out, exit 0, failure-as-data. The auto-start gate
// (default blocked by a running singleton without CDP — e.g. Arc) runs this
// after the user opts in; it is also agent-runnable via bash.
// Usage: restart.mjs <bin> [port]
//   1. graceful quit — osascript `tell application "<name>" to quit`
//   2. poll the main process away (a second instance is impossible while
//      it lives — the global singleton lock)
//   3. relaunch — `open -a <app.bundle> --args --remote-debugging-port=<port>`
//   4. poll http://localhost:<port>/json/version until it answers

import { execFileSync } from "node:child_process";

const bin = process.argv[2];
const port = Number(
	process.argv[3] || process.env.BROWSER_DEBUG_PORT || 9222,
);

const T_QUIT_MS = 20_000;
const T_UP_MS = 40_000;
const T_STEP_MS = 500;

function out(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}
function fail(error) {
	out({ ok: false, error });
	process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!bin) fail("usage: restart.mjs <bin> [port]");

// /Applications/Arc.app/Contents/MacOS/Arc -> /Applications/Arc.app + "Arc"
const bundle = /^(.*)\/Contents\/MacOS\/[^/]+$/.exec(bin);
if (!bundle) fail(`not a macOS .app bundle binary: ${bin}`);
const appPath = bundle[1];
const appName = appPath.split("/").pop().replace(/\.app$/, "");

// main processes for the binary: no --type= (renderer/GPU helpers), the
// command starts with the binary path — same truth detect.mjs reads
function mainPids() {
	try {
		const ps = execFileSync("ps", ["axo", "pid=,command="], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		const pids = [];
		for (const line of ps.split("\n")) {
			const m = /^(\d+)\s+(.*)$/.exec(line.trim());
			if (!m) continue;
			if (m[2].includes("--type=")) continue;
			if (m[2].split(/\s+/)[0] === bin) pids.push(Number(m[1]));
		}
		return pids;
	} catch {
		return [];
	}
}

// 1. graceful quit — tabs/windows restore on relaunch
try {
	execFileSync(
		"osascript",
		["-e", `tell application "${appName}" to quit`],
		{ timeout: 10_000 },
	);
} catch (err) {
	fail(`graceful quit of ${appName} failed: ${err.message}`);
}

// 2. wait for the singleton lock to clear
{
	const deadline = Date.now() + T_QUIT_MS;
	while (mainPids().length > 0) {
		if (Date.now() > deadline) {
			fail(
				`${appName} did not exit within ${T_QUIT_MS / 1000}s — quit it manually, then: open -a ${appPath} --args --remote-debugging-port=${port}`,
			);
		}
		await sleep(T_STEP_MS);
	}
}

// 3. relaunch with the debug port
try {
	execFileSync("open", ["-a", appPath, "--args", `--remote-debugging-port=${port}`], {
		timeout: 10_000,
	});
} catch (err) {
	fail(`relaunch of ${appName} failed: ${err.message}`);
}

// 4. wait for the CDP endpoint to answer
{
	const deadline = Date.now() + T_UP_MS;
	for (;;) {
		try {
			const resp = await fetch(`http://localhost:${port}/json/version`, {
				signal: AbortSignal.timeout(1000),
			});
			if (resp.ok) {
				const v = await resp.json();
				out({
					ok: true,
					port,
					browser: typeof v.Browser === "string" ? v.Browser : null,
				});
			}
		} catch {}
		if (Date.now() > deadline) {
			fail(
				`relaunched ${appName} but no CDP answer on :${port} within ${T_UP_MS / 1000}s — the port may be taken; check the process command line and retry with a free port`,
			);
		}
		await sleep(1000);
	}
}
