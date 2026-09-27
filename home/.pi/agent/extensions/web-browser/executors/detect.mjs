#!/usr/bin/env node
// smart-start detection probe — pure IO, JSON out, exit 0, failure-as-data.
// Buckets for browser_start mode "auto":
//   attachable    — processes with --remote-debugging-port whose port answers
//                   /json/version: {name, port, browser, pid}
//   runningNoCdp  — known browser main processes without a debug port
//                   (Arc: global singleton lock blocks any Arc launch;
//                   Chromium-class: isolated launch is a separate instance,
//                   informational only): {name, pid}
//   installed     — CDP-capable browser binaries present on disk:
//                   {name, bin, globalSingleton}
//   default       — macOS Launch Services https handler (Safari/Firefox
//                   excluded — no CDP): {name, bin, globalSingleton} | null

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

// CDP-capable browsers. globalSingleton: a second instance is impossible
// while one runs (Arc locks globally, even with a separate --user-data-dir).
// Chromium-class singleton locks live in the user-data-dir, so an isolated
// launch works while the user's instance runs.
const BROWSERS = [
	{ name: "Arc", bin: "/Applications/Arc.app/Contents/MacOS/Arc", bundle: "company.thebrowser.browser", globalSingleton: true },
	{ name: "Chrome", bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", bundle: "com.google.Chrome", globalSingleton: false },
	{ name: "Chrome Canary", bin: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary", bundle: "com.google.Chrome.Canary", globalSingleton: false },
	{ name: "Chromium", bin: "/Applications/Chromium.app/Contents/MacOS/Chromium", bundle: "org.chromium.Chromium", globalSingleton: false },
	{ name: "Brave", bin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", bundle: "com.brave.Browser", globalSingleton: false },
	{ name: "Edge", bin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", bundle: "com.microsoft.edgemac", globalSingleton: false },
];

/** Friendly name from a /json/version product string, e.g. "Chrome/126.0". */
function productName(product) {
	if (!product) return "browser";
	if (/^Arc\//.test(product)) return "Arc";
	if (/^Edg\//.test(product)) return "Edge";
	if (/^Chromium\//.test(product)) return "Chromium";
	if (/^Chrome\//.test(product)) return "Chrome";
	const prefix = product.split("/")[0];
	return prefix && prefix.length > 1 ? prefix : "browser";
}

function listMainBrowserProcesses() {
	// ps axo pid=,command= — full args per process. Renderer/GPU helpers carry
	// --type=; the main process does not.
	try {
		const out = execFileSync("ps", ["axo", "pid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
		const procs = [];
		for (const line of out.split("\n")) {
			const m = /^(\d+)\s+(.*)$/.exec(line.trim());
			if (!m) continue;
			const pid = Number(m[1]);
			const cmd = m[2];
			if (cmd.includes("--type=")) continue;
			const exe = cmd.split(/\s+/)[0] ?? "";
			const exeBase = basename(exe);
			const b = BROWSERS.find((x) => basename(x.bin) === exeBase);
			const port = /--remote-debugging-port=(\d+)/.exec(cmd);
			procs.push({
				pid,
				name: b ? b.name : null,
				browser: b ?? null,
				port: port ? Number(port[1]) : null,
			});
		}
		return procs;
	} catch {
		return [];
	}
}

async function cdpAnswers(port) {
	try {
		const resp = await fetch(`http://localhost:${port}/json/version`, {
			signal: AbortSignal.timeout(800),
		});
		if (!resp.ok) return null;
		const v = await resp.json();
		return typeof v.Browser === "string" ? v.Browser : "unknown";
	} catch {
		return null;
	}
}

function installedBrowsers() {
	const out = [];
	for (const b of BROWSERS) {
		if (existsSync(b.bin)) out.push({ name: b.name, bin: b.bin, globalSingleton: b.globalSingleton });
	}
	const envBin = process.env.BROWSER_BIN;
	if (envBin && existsSync(envBin)) {
		out.push({ name: basename(envBin), bin: envBin, globalSingleton: false });
	}
	return out;
}

function defaultBrowser() {
	// macOS default browser: Launch Services https handler bundle id.
	// Safari/Firefox never expose CDP — excluded (treated as no default).
	const plist =
		process.env.HOME || homedir() ?
			`${process.env.HOME || homedir()}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist` :
			null;
	if (!plist || !existsSync(plist)) return null;
	try {
		const json = execFileSync("plutil", ["-convert", "json", "-o", "-", plist], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		const parsed = JSON.parse(json);
		const handlers = parsed?.LSHandlers;
		if (!Array.isArray(handlers)) return null;
		const https = handlers.find((h) => h?.LSHandlerURLScheme === "https");
		const bundle = https?.LSHandlerRoleAll;
		if (typeof bundle !== "string") return null;
		const b = BROWSERS.find((x) => x.bundle === bundle);
		if (!b || !existsSync(b.bin)) return null;
		return { name: b.name, bin: b.bin, globalSingleton: b.globalSingleton };
	} catch {
		return null;
	}
}

const procs = listMainBrowserProcesses();
// attach candidates: any main process with a debug port (unknown binaries
// included — a CDP port is a CDP port), deduped by port
const portMap = new Map();
for (const p of procs) {
	if (p.port === null) continue;
	if (!portMap.has(p.port)) portMap.set(p.port, p);
}
const attachable = [];
for (const [port, p] of portMap) {
	const product = await cdpAnswers(port);
	if (product === null) continue;
	attachable.push({
		name: p.name ?? productName(product),
		port,
		browser: product,
		pid: p.pid,
	});
}
// known browsers running without a debug port (singleton/warning evidence)
const runningNoCdp = procs
	.filter((p) => p.name !== null && p.port === null)
	.map((p) => ({ name: p.name, pid: p.pid }));

const out = {
	attachable,
	runningNoCdp,
	installed: installedBrowsers(),
	default: defaultBrowser(),
};

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
