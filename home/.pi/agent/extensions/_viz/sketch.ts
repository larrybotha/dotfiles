/**
 * sketch.ts — local Stately Sketch host lifecycle.
 *
 * github.com/statelyai/sketch (MIT) serves `/inspect` with the same
 * postMessage protocol as https://stately.ai/inspect (`createBrowserReceiver`
 * + `@statelyai.connected` handshake), so the inspector relay's bridge page
 * can iframe it instead of the remote UI: machine events never leave
 * localhost.
 *
 * Two faces, one file:
 *   - module: extensions import `ensureSketch()` before `viz.enable()`
 *   - CLI: skill scripts shell out — `node sketch.ts ensure|url|status|stop`
 *     (node ≥23 strips types natively; no deps, builtins only)
 *
 * Host = a checkout at XSTATE_SKETCH_DIR (default ~/.cache/sketch-host)
 * running `pnpm dev --host 127.0.0.1 --port N` detached. Health = GET
 * /inspect → 2xx/3xx. A healthy foreign Sketch on a walked port is reused
 * (never killed by us — only hosts we spawned).
 *
 * Lifecycle: detached host survives the spawning process (fast next run);
 * `stop` is explicit — CLI subcommand or session_shutdown of the owning pi
 * process (stopSketch({ onlyIfOwner })). XSTATE_SKETCH_REMOTE=1 makes
 * ensureSketch() report disabled so callers fall back to the remote UI.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";

export interface SketchHostInfo {
	url: string;
	port: number;
	/** true when an already-healthy server was reused (not spawned here). */
	reused: boolean;
}

export type SketchResult =
	| { ok: true; host: SketchHostInfo }
	| { ok: false; reason: string; logTail?: string };

const DEFAULT_PORT = 3000;
const PORT_TRIES = 8;
const REPO = "https://github.com/statelyai/sketch.git";

export function sketchDir(): string {
	return process.env.XSTATE_SKETCH_DIR || path.join(os.homedir(), ".cache", "sketch-host");
}

function hostFile(): string {
	return path.join(sketchDir(), "host.json");
}

interface HostRecord {
	port: number;
	pid: number;
	/** pid of the process that spawned the host. */
	ownerPid: number;
	startedAt: number;
}

function readHost(): HostRecord | null {
	try {
		const raw = JSON.parse(fs.readFileSync(hostFile(), "utf8")) as HostRecord;
		if (
			typeof raw.port !== "number" ||
			raw.port < 1 ||
			raw.port > 65535 ||
			typeof raw.pid !== "number"
		) {
			return null;
		}
		return { ...raw, ownerPid: raw.ownerPid ?? -1, startedAt: raw.startedAt ?? 0 };
	} catch {
		return null;
	}
}

function writeHost(rec: HostRecord): void {
	fs.mkdirSync(sketchDir(), { recursive: true });
	fs.writeFileSync(hostFile(), JSON.stringify(rec, null, "\t") + "\n");
}

/**
 * GET /inspect — 2xx after redirects = live Sketch. Not "any <500": a
 * foreign dev server on the port 404s unknown routes, and a 404-ing
 * non-Sketch server must not be reused (its /inspect speaks no inspector
 * protocol) nor block the walk.
 */
export function sketchHealth(port: number): Promise<boolean> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 1500);
	return fetch(`http://127.0.0.1:${port}/inspect`, {
		signal: ctrl.signal,
		redirect: "follow",
	})
		.then((res) => {
			clearTimeout(timer);
			return res.ok;
		})
		.catch(() => {
			clearTimeout(timer);
			return false;
		});
}

function portBase(): number {
	return Number(process.env.XSTATE_SKETCH_PORT) || DEFAULT_PORT;
}

/** Walk the port range; first healthy port wins (ours or foreign — reusable). */
async function probePorts(): Promise<number | undefined> {
	for (let p = portBase(); p < portBase() + PORT_TRIES; p++) {
		if (await sketchHealth(p)) return p;
	}
	return undefined;
}

/** Bind-probe `::` (same style as viz-kit): can this process listen on the port? */
function bindFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "::", () => probe.close(() => resolve(true)));
	});
}

function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): string {
	return execFileSync(cmd, args, {
		cwd: opts.cwd,
		timeout: opts.timeoutMs,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * The repo's pinned pnpm (package.json "packageManager"), via npx — node 26
 * ships no corepack and the global pnpm may be too new (v12 refuses the
 * repo's pnpm-workspace.yaml; v10.32.1 is what the repo pins). Never touches
 * the user's global install.
 */
function pinnedPnpm(dir: string): string[] {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
			packageManager?: string;
		};
		const m = pkg.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/);
		if (m) return ["-y", `pnpm@${m[1]}`];
	} catch {
		/* fall through */
	}
	return ["-y", "pnpm"];
}

/** Clone (once) + install (once). Idempotent; network only on first run. */
function bootstrapSketch(): string {
	const dir = sketchDir();
	if (!fs.existsSync(path.join(dir, ".git"))) {
		fs.mkdirSync(dir, { recursive: true });
		run("git", ["clone", "--depth", "1", REPO, dir], { cwd: os.homedir(), timeoutMs: 300000 });
	}
	if (!fs.existsSync(path.join(dir, "node_modules", ".pnpm"))) {
		run("npx", [...pinnedPnpm(dir), "install"], { cwd: dir, timeoutMs: 600000 });
	}
	return dir;
}

function logPath(): string {
	return path.join(sketchDir(), "sketch.log");
}

function tailLog(n = 20): string {
	try {
		return fs
			.readFileSync(logPath(), "utf8")
			.trimEnd()
			.split("\n")
			.slice(-n)
			.join("\n");
	} catch {
		return "";
	}
}

async function waitHealthy(port: number, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (await sketchHealth(port)) return true;
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 500));
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure a local Sketch host is running; spawn (bootstrap + `pnpm dev`) if not.
 * Never kills foreign processes; never throws.
 */
export async function ensureSketch(): Promise<SketchResult> {
	if (process.env.XSTATE_SKETCH_REMOTE) {
		return { ok: false, reason: "XSTATE_SKETCH_REMOTE set — remote inspector UI" };
	}

	const live = await probePorts();
	if (live !== undefined) {
		return {
			ok: true,
			host: { url: `http://127.0.0.1:${live}/inspect`, port: live, reused: true },
		};
	}

	try {
		const dir = bootstrapSketch();

		// walk for a spawn-able port: not healthy AND bind-free (a foreign
		// non-HTTP holder would EADDRINUSE vite into the log — fail fast instead)
		let port: number | undefined;
		for (let p = portBase(); p < portBase() + PORT_TRIES; p++) {
			if (await sketchHealth(p)) continue;
			if (await bindFree(p)) {
				port = p;
				break;
			}
		}
		if (port === undefined) {
			return {
				ok: false,
				reason: `no free port in ${portBase()}-${portBase() + PORT_TRIES - 1} for the sketch dev server`,
			};
		}

		const log = fs.openSync(logPath(), "a");
		const child = spawn("npx", [...pinnedPnpm(dir), "dev", "--host", "127.0.0.1", "--port", String(port)], {
			cwd: dir,
			detached: true,
			stdio: ["ignore", log, log],
			env: { ...process.env },
		});
		child.unref();
		fs.closeSync(log);
		const pid = child.pid ?? -1;
		writeHost({ port, pid, ownerPid: process.pid, startedAt: Date.now() });

		// health-wait with death-watch: vite dying (bad install, EADDRINUSE)
		// should fail in seconds, not the full 60s deadline
		const deadline = Date.now() + 60000;
		for (;;) {
			if (await sketchHealth(port)) break;
			if (!pidAlive(pid)) {
				fs.rmSync(hostFile(), { force: true });
				return {
					ok: false,
					reason: `sketch dev server died on port ${port} (pnpm dev exited)`,
					logTail: tailLog(),
				};
			}
			if (Date.now() > deadline) {
				killTree(pid);
				fs.rmSync(hostFile(), { force: true });
				return {
						ok: false,
						reason: `sketch dev server did not become healthy on port ${port} within 60s`,
						logTail: tailLog(),
					};
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		return {
			ok: true,
			host: { url: `http://127.0.0.1:${port}/inspect`, port, reused: false },
		};
	} catch (e) {
		return {
			ok: false,
			reason: `sketch host bootstrap failed: ${e instanceof Error ? e.message : String(e)}`,
			logTail: tailLog(),
		};
	}
}

/** Kill the host's process group (pnpm + vite children), best effort. */
function killTree(pid: number): void {
	if (pid < 1) return;
	for (const sig of ["SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(-pid, sig);
		} catch {
			try {
				process.kill(pid, sig);
			} catch {
				return; // already dead
			}
		}
		try {
			process.kill(pid, 0);
			// fall through to stronger signal if still alive
		} catch {
			return;
		}
	}
}

export interface StopResult {
	ok: boolean;
	message: string;
}

/**
 * Stop our host. `onlyIfOwner`: kill only when this process spawned it —
 * session_shutdown uses this so one pi session never kills another's (or the
 * skill CLI's) host. Foreign Sketch (no host.json) is never touched.
 */
export function stopSketch(opts: { onlyIfOwner?: number } = {}): StopResult {
	const rec = readHost();
	if (!rec) return { ok: false, message: "sketch host: not running (no host.json)" };
	if (opts.onlyIfOwner !== undefined && rec.ownerPid !== opts.onlyIfOwner) {
		return {
			ok: false,
			message: `sketch host: left running (owner pid ${rec.ownerPid}, not ${opts.onlyIfOwner})`,
		};
	}
	if (!pidAlive(rec.pid)) {
		fs.rmSync(hostFile(), { force: true });
		return { ok: true, message: "sketch host: was already dead (host.json cleaned)" };
	}
	killTree(rec.pid);
	fs.rmSync(hostFile(), { force: true });
	return { ok: true, message: `sketch host: stopped (port ${rec.port})` };
}

export interface StatusInfo {
	running: boolean;
	url?: string;
	port?: number;
	spawnedPid?: number;
	ownerPid?: number;
	ownerAlive?: boolean;
}

export function sketchStatus(): StatusInfo {
	const rec = readHost();
	// stale host.json (killed out from under us) should not read as running
	const info: StatusInfo = rec
		? {
				running: pidAlive(rec.pid),
				port: rec.port,
				spawnedPid: rec.pid,
				ownerPid: rec.ownerPid,
				ownerAlive: pidAlive(rec.ownerPid),
			}
		: { running: false };
	if (info.running) info.url = `http://127.0.0.1:${info.port}/inspect`;
	return info;
}

// ---------------------------------------------------------------------------
// CLI: node sketch.ts ensure|url|status|stop
// ---------------------------------------------------------------------------
// realpath both sides: argv[1] carries the invoked path (often through a
// symlink — ~/.pi → dotfiles), import.meta.url the realpath; resolve() alone
// mismatches and the CLI silently no-ops.
const invokedDirectly = (() => {
	try {
		return (
			!!process.argv[1] &&
			fs.realpathSync(process.argv[1]) ===
				fs.realpathSync(new URL(import.meta.url).pathname)
		);
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	const cmd = process.argv[2] ?? "status";
	if (cmd === "ensure" || cmd === "url") {
		const r = await ensureSketch();
		if (!r.ok) {
			console.error(`error: ${r.reason}${r.logTail ? `\n--- log tail ---\n${r.logTail}` : ""}`);
			process.exit(1);
		}
		console.log(r.host.url);
	} else if (cmd === "stop") {
		const r = stopSketch();
		console.log(r.message);
		if (!r.ok) process.exit(1);
	} else if (cmd === "status") {
		const s = sketchStatus();
		console.log(JSON.stringify(s));
		if (!s.running) process.exit(1);
	} else {
		console.error("usage: node sketch.ts ensure|url|status|stop");
		process.exit(2);
	}
}
