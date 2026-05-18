/**
 * Ollama Manager Extension
 *
 * Auto-starts Ollama server when an Ollama model is selected.
 * Optionally stops Ollama on session shutdown if idle.
 *
 * Usage: Drop in ~/.pi/agent/extensions/ollama-manager.ts
 *        pi automatically loads it on next start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execAsync = promisify(exec);

const OLLAMA_API = "http://localhost:11434";
const STATE_DIR = join(homedir(), ".pi", "agent", "state");
const REF_FILE = join(STATE_DIR, "ollama-refs.json");
const PID_FILE = join(STATE_DIR, "ollama-pid.json");

interface RefState {
	count: number;
	pids: number[];
}

async function isOllamaReachable(timeoutMs = 1500): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch(`${OLLAMA_API}/api/tags`, { signal: ctrl.signal });
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

async function getOllamaPids(): Promise<number[]> {
	try {
		// Prefer pgrep for reliability across macOS/Linux
		const { stdout } = await execAsync("pgrep -f 'ollama serve' || true");
		return stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((s) => parseInt(s.trim(), 10))
			.filter((n) => !isNaN(n));
	} catch {
		return [];
	}
}

function readRefState(): RefState {
	try {
		if (!existsSync(REF_FILE)) return { count: 0, pids: [] };
		return JSON.parse(readFileSync(REF_FILE, "utf-8")) as RefState;
	} catch {
		return { count: 0, pids: [] };
	}
}

function writeRefState(state: RefState) {
	try {
		writeFileSync(REF_FILE, JSON.stringify(state, null, 2));
	} catch {
		// ignore
	}
}

function readPidFile(): number | null {
	try {
		if (!existsSync(PID_FILE)) return null;
		const data = JSON.parse(readFileSync(PID_FILE, "utf-8"));
		return typeof data.pid === "number" ? data.pid : null;
	} catch {
		return null;
	}
}

function writePidFile(pid: number) {
	try {
		writeFileSync(PID_FILE, JSON.stringify({ pid }, null, 2));
	} catch {
		// ignore
	}
}

function clearPidFile() {
	try {
		if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
	} catch {
		// ignore
	}
}

async function isOllamaIdle(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_API}/api/ps`, { signal: AbortSignal.timeout(1000) });
		if (!res.ok) return true;
		const data = (await res.json()) as { models?: unknown[] };
		return !data.models || data.models.length === 0;
	} catch {
		return true;
	}
}

export default async function (pi: ExtensionAPI) {
	// Ensure state directory exists
	try {
		await execAsync(`mkdir -p "${STATE_DIR}"`);
	} catch {
		// ignore
	}

	let ownedPid: number | null = null;
	let didIncrement = false;

	function isOllamaModel(model: { provider?: string } | undefined | null): boolean {
		return model?.provider === "ollama";
	}

	async function ensureOllama(notify: boolean): Promise<void> {
		if (await isOllamaReachable()) {
			if (notify) {
				// Already running, no need to notify on every model switch
			}
			return;
		}

		// Check if another pi instance already started it (PID file)
		const existingPid = readPidFile();
		if (existingPid) {
			try {
				process.kill(existingPid, 0); // signal 0 = existence check
				// Process exists, wait a moment for it to become ready
				await new Promise((r) => setTimeout(r, 500));
				if (await isOllamaReachable()) return;
			} catch {
				// PID stale
				clearPidFile();
			}
		}

		// Start Ollama
		const proc = spawn("ollama", ["serve"], {
			detached: false,
			stdio: "ignore",
		});

		ownedPid = proc.pid ?? null;
		if (ownedPid) {
			writePidFile(ownedPid);
		}

		// Wait for it to be ready
		let ready = false;
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 300));
			if (await isOllamaReachable()) {
				ready = true;
				break;
			}
		}

		if (!ready) {
			throw new Error("Ollama failed to start within 6 seconds");
		}
	}

	function incrementRef(): void {
		if (didIncrement) return;
		const state = readRefState();
		state.count += 1;
		if (ownedPid && !state.pids.includes(ownedPid)) {
			state.pids.push(ownedPid);
		}
		writeRefState(state);
		didIncrement = true;
	}

	function decrementRef(): void {
		if (!didIncrement) return;
		const state = readRefState();
		state.count = Math.max(0, state.count - 1);
		if (ownedPid) {
			state.pids = state.pids.filter((p) => p !== ownedPid);
		}
		writeRefState(state);
		didIncrement = false;
	}

	async function maybeShutdown(): Promise<void> {
		decrementRef();

		const state = readRefState();

		// If other pi sessions still hold refs, do not kill
		if (state.count > 0) {
			return;
		}

		// If we didn't start it, don't kill it
		if (!ownedPid) {
			return;
		}

		// Verify it's still our process
		const currentPids = await getOllamaPids();
		if (!currentPids.includes(ownedPid)) {
			clearPidFile();
			return;
		}

		// Only kill if truly idle (no active inference)
		if (!(await isOllamaIdle())) {
			return;
		}

		try {
			process.kill(ownedPid, "SIGTERM");
			// Give it a moment, then SIGKILL if needed
			await new Promise((r) => setTimeout(r, 1000));
			try {
				process.kill(ownedPid, 0);
				process.kill(ownedPid, "SIGKILL");
			} catch {
				// Already dead
			}
		} catch {
			// ignore
		} finally {
			clearPidFile();
			ownedPid = null;
		}
	}

	// ── Events ─────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (isOllamaModel(ctx.model)) {
			try {
				await ensureOllama(false);
				incrementRef();
			} catch (err) {
				ctx.ui.notify(`Ollama start failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (isOllamaModel(event.model)) {
			try {
				await ensureOllama(true);
				incrementRef();
				ctx.ui.notify("Ollama ready", "info");
			} catch (err) {
				ctx.ui.notify(`Ollama start failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await maybeShutdown();
	});

	// ── Commands ─────────────────────────────────────────────

	pi.registerCommand("ollama-status", {
		description: "Show Ollama server status",
		handler: async (_args, ctx) => {
			const reachable = await isOllamaReachable();
			const pids = await getOllamaPids();
			const state = readRefState();
			const lines = [
				`Running: ${reachable ? "yes" : "no"}`,
				`PIDs: ${pids.join(", ") || "none"}`,
				`Owned PID: ${ownedPid ?? "none"}`,
				`Ref count: ${state.count}`,
			];
			ctx.ui.notify(lines.join(" | "), reachable ? "info" : "warning");
		},
	});

	pi.registerCommand("ollama-start", {
		description: "Start Ollama server manually",
		handler: async (_args, ctx) => {
			if (await isOllamaReachable()) {
				ctx.ui.notify("Ollama already running", "info");
				return;
			}
			try {
				await ensureOllama(true);
				incrementRef();
				ctx.ui.notify("Ollama started", "info");
			} catch (err) {
				ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("ollama-stop", {
		description: "Stop Ollama server if idle and we own it",
		handler: async (_args, ctx) => {
			if (!ownedPid) {
				ctx.ui.notify("We did not start this Ollama instance; not stopping.", "warning");
				return;
			}
			if (!(await isOllamaIdle())) {
				ctx.ui.notify("Ollama is busy (active inference); not stopping.", "warning");
				return;
			}
			// Force decrement to zero so maybeShutdown succeeds
			const state = readRefState();
			state.count = 1; // allow our decrement to bring it to 0
			writeRefState(state);
			await maybeShutdown();
			ctx.ui.notify("Ollama stopped", "info");
		},
	});
}
