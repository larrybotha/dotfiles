/**
 * Raw JSONL RPC transport for the rpc-delegate extension.
 *
 * Deliberately NOT the stock RpcClient: it owns ID correlation internally and
 * swallows parser failures and unmatched records — this transport must surface
 * those as PROTOCOL_FATAL. Owns the pending-ID map, the reader, and the
 * record → machine-event conversion:
 *
 * - Reader: byte-chunk LF splitter (never Node `readline` — U+2028/2029 are
 *   valid inside JSON strings and readline splits on them). Always-on: stdout
 *   is consumed continuously (a stalled reader stalls the child), evidence
 *   lives in capped rings, `message_update` deltas are never forwarded — the
 *   machine receives a small typed event set only.
 * - Pending map: command ids → {resolve, reject, settled}. A timed-out entry
 *   stays with `settled: true` so its late response is logged, not treated as
 *   an unmatched-id protocol violation.
 * - PROTOCOL_FATAL (well-defined violations only): malformed JSON, response
 *   without id (including the id-less `parse` failure response), response id
 *   not in the pending map. Unknown session event types are logged and
 *   ignored (forward compatibility) — never guessed at, never fatal.
 * - Extension UI policy: dialog requests (select/confirm/input/editor) are
 *   auto-cancelled (`cancelled: true`) — a headless child must never hang on
 *   a blocked dialog; fire-and-forget notifications are logged. The machine
 *   gets EXT_UI_REQUEST evidence either way.
 * - Stdin backpressure honored (write() false → await drain). Oversized
 *   records (>16MB without LF) are dropped and logged, not fatal.
 * - Watchdog: external runner (watchdog.mjs) holding parentPid + hard
 *   deadline, TERMed separately so it survives parent SIGKILL — direct
 *   spawn does not kill the child when the parent dies (orphan guard).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
	CommandResponse,
	RpcEvent,
	TransportEvidence,
	TransportHandle,
} from "./machine.ts";

export class CommandTimeoutError extends Error {
	commandType: string;
	timeoutMs: number;
	constructor(commandType: string, timeoutMs: number) {
		super(`RPC command '${commandType}' timed out after ${timeoutMs}ms`);
		this.name = "CommandTimeoutError";
		this.commandType = commandType;
		this.timeoutMs = timeoutMs;
	}
}
export class ProtocolFatalError extends Error {
	constructor(reason: string) {
		super(`RPC protocol fatal: ${reason}`);
		this.name = "ProtocolFatalError";
	}
}
export class ChildDiedError extends Error {
	constructor(detail: string) {
		super(`RPC child died: ${detail}`);
		this.name = "ChildDiedError";
	}
}

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const ASSISTANT_TAIL_CHARS = 4000;
const KILL_TERM_TO_KILL_MS = 250;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Diagnostics counters (compaction/retry evidence — log-only, never machine events). */
export interface TransportDiagnostics {
	compactions: number;
	autoRetries: number;
	lateResponses: number;
	droppedRecords: number;
	unknownEventTypes: number;
}

export interface TransportOptions {
	/** Binary to run (pi resolution result). */
	command: string;
	/** Arguments BEFORE the transport's own flags (pi's own invocation args). */
	baseArgs: string[];
	cwd: string;
	/** Machine-event sink (typed events only — raw records never cross this). */
	sink: (ev: RpcEvent) => void;
	env?: Record<string, string>;
	/** External orphan watchdog; omit to skip (tests). */
	watchdog?: {
		scriptPath: string;
		parentPid: number;
		/** Hard deadline in ms from transport start (run timeout + grace). */
		graceMs: number;
		pollMs?: number;
	};
	/** Diagnostic log (evidence; defaults to no-op). */
	onLog?: (msg: string) => void;
}

interface PendingEntry {
	commandType: string;
	resolve: (r: CommandResponse) => void;
	reject: (e: Error) => void;
	/** Timed-out (or otherwise settled) — a late response is logged, not fatal. */
	settled: boolean;
}

function isRec(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

export class RpcTransport implements TransportHandle {
	private child: ChildProcess | null = null;
	private watchdogPid: number | null = null;
	private pending = new Map<string, PendingEntry>();
	private seq = 0;
	private exited = false;
	private deadCode: number | null = null;
	private deadSignal: string | null = null;
	private fatalReason: string | null = null;
	private tail: Buffer = Buffer.alloc(0);
	private dropping = false;
	private stderrChunks: Buffer[] = [];
	private stderrBytes = 0;
	private assistantTail = "";
	private lastUsage: unknown = null;
	private uiAutoCancelled = 0;
	private started = false;
	public readonly diagnostics: TransportDiagnostics = {
		compactions: 0,
		autoRetries: 0,
		lateResponses: 0,
		droppedRecords: 0,
		unknownEventTypes: 0,
	};

	private opts: TransportOptions;
	constructor(opts: TransportOptions) {
		this.opts = opts;
	}

	private log(msg: string): void {
		this.opts.onLog?.(msg);
	}

	// -- lifecycle -----------------------------------------------------------

	/** Spawn the child (own process group), attach readers + watchdog. Rejects
	 *  on spawn failure — the transport cleans up what it made. */
	async start(signal?: AbortSignal): Promise<void> {
		if (this.started) throw new Error("transport already started");
		this.started = true;
		const child = spawn(this.opts.command, this.opts.baseArgs, {
			cwd: this.opts.cwd,
			env: { ...process.env, ...this.opts.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true, // own process group: kill(-pid) reaches the tree
		});
		this.child = child;

		// Reader + stderr attached synchronously — before any await.
		child.stdout?.on("data", (c: Buffer) => this.onStdoutChunk(c));
		child.stderr?.on("data", (c: Buffer) => this.onStderrChunk(c));
		child.on("exit", (code, signal) => this.handleExit(code, signal));
		child.on("error", (err) => {
			// Pre-spawn error (ENOENT…) → surface to the start() caller; post-spawn
			// runtime errors are handled by 'exit'.
			if (!this.exited && this.pending.size === 0 && !this.deadCode && !this.fatalReason) {
				this.handleExit(null, `error: ${err.message}`);
			}
		});

		await new Promise<void>((resolve, reject) => {
			const onSpawnError = (err: Error) => reject(err);
			child.once("error", onSpawnError);
			child.once("spawn", () => {
				child.off("error", onSpawnError);
				resolve();
			});
		});

		if (signal?.aborted) {
			this.killHard();
			throw new Error("spawn aborted");
		}

		// External watchdog — detached + unref so it survives parent SIGKILL.
		const wd = this.opts.watchdog;
		if (wd) {
			const deadline = Date.now() + wd.graceMs;
			const w = spawn(
				process.execPath,
				[wd.scriptPath, String(wd.parentPid), String(child.pid), String(deadline), String(wd.pollMs ?? 5000)],
				{ stdio: "ignore", detached: true },
			);
			w.unref();
			this.watchdogPid = w.pid ?? null;
		}
	}

	// -- TransportHandle ----------------------------------------------------

	async sendCommand(cmd: Record<string, unknown>, timeoutMs: number): Promise<CommandResponse> {
		if (this.fatalReason) throw new ProtocolFatalError(this.fatalReason);
		if (this.exited) throw new ChildDiedError(`exited (code ${this.deadCode}, signal ${this.deadSignal})`);
		const id = `rd-${++this.seq}`;
		const commandType = str(cmd.type) || "?";
		let timer: NodeJS.Timeout | undefined;
		const entry: PendingEntry = {
			commandType,
			settled: false,
			resolve: () => {},
			reject: () => {},
		};
		const promise = new Promise<CommandResponse>((resolve, reject) => {
			entry.resolve = (r) => {
				if (entry.settled) return;
				entry.settled = true;
				clearTimeout(timer);
				resolve(r);
			};
			entry.reject = (e) => {
				if (entry.settled) return;
				entry.settled = true;
				clearTimeout(timer);
				reject(e);
			};
		});
		// Settled entries STAY in the map (resolved, timed out, or failed):
		// a late or duplicate response is logged, never treated as an
		// unmatched-id violation. The map holds one small entry per command
		// issued and is cleared on fatal/exit. The resolve/reject wrappers own
		// the settled flag (idempotent) — callers never pre-set it.
		timer = setTimeout(() => {
			entry.reject(new CommandTimeoutError(commandType, timeoutMs));
		}, timeoutMs);
		timer.unref?.();
		this.pending.set(id, entry);
		try {
			await this.write({ ...cmd, id });
		} catch (err) {
			entry.reject(err instanceof Error ? err : new Error(String(err)));
		}
		return promise;
	}

	alive(): boolean {
		return this.child !== null && !this.exited;
	}

	pid(): number | null {
		return this.child?.pid ?? null;
	}

	closeStdin(): void {
		try {
			this.child?.stdin?.end();
		} catch {
			/* already closed */
		}
	}

	/** TERM the process group (and watchdog). */
	killTerm(): void {
		this.killWatchdog();
		if (this.child?.pid) {
			try {
				process.kill(-this.child.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}

	/** KILL the process group (and watchdog). */
	killKill(): void {
		this.killWatchdog();
		if (this.child?.pid) {
			try {
				process.kill(-this.child.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}

	/** Immediate TERM now + KILL shortly — for abort paths that must not wait. */
	killHard(): void {
		this.killTerm();
		const pid = this.child?.pid;
		if (pid) {
			const t = setTimeout(() => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}, KILL_TERM_TO_KILL_MS);
			t.unref?.();
		}
	}

	async waitForExit(ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (this.alive()) {
			if (Date.now() >= deadline) return false;
			await new Promise((r) => setTimeout(r, 50));
		}
		return true;
	}

	exitCode(): number | null {
		return this.deadCode;
	}

	childPid(): number | null {
		return this.child?.pid ?? null;
	}

	getEvidence(): TransportEvidence {
		return {
			stderrTail: Buffer.concat(this.stderrChunks).toString("utf8"),
			assistantTextTail: this.assistantTail,
			lastUsage: this.lastUsage,
			uiAutoCancelled: this.uiAutoCancelled,
			fatalReason: this.fatalReason,
		};
	}

	// -- internals -----------------------------------------------------------

	private killWatchdog(): void {
		if (this.watchdogPid) {
			try {
				process.kill(this.watchdogPid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}

	/** Stdin write honoring backpressure (write() false → await drain). */
	private async write(record: object): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || this.exited) {
			throw new ChildDiedError("stdin unavailable");
		}
		const ok = stdin.write(JSON.stringify(record) + "\n");
		if (!ok) {
			await new Promise<void>((resolve) => stdin.once("drain", () => resolve()));
		}
	}

	/** Always-on reader: byte-chunk LF splitter (never readline). An
	 *  oversized record (no LF within MAX_RECORD_BYTES) enters drop-until-LF
	 *  mode — its remainder (still huge, still LF-less) is discarded whole,
	 *  never parsed as a malformed record; parsing resumes at the next LF. */
	private onStdoutChunk(chunk: Buffer): void {
		let data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
		if (this.dropping) {
			const idx = data.indexOf(0x0a);
			if (idx === -1) {
				this.diagnostics.droppedRecords++;
				this.log(`discarding oversized stdout remainder (${data.length} bytes, still no LF)`);
				this.tail = Buffer.alloc(0);
				return;
			}
			this.diagnostics.droppedRecords++;
			this.log(`dropped oversized stdout record (resuming at next LF)`);
			data = data.subarray(idx + 1);
			this.dropping = false;
		}
		let start = 0;
		while (true) {
			const idx = data.indexOf(0x0a, start);
			if (idx === -1) break;
			let line = data.subarray(start, idx);
			if (line.length > 0 && line[line.length - 1] === 0x0d) {
				line = line.subarray(0, line.length - 1);
			}
			if (line.length > 0) this.handleLine(line);
			start = idx + 1;
		}
		this.tail = data.subarray(start);
		if (this.tail.length > MAX_RECORD_BYTES) {
			this.diagnostics.droppedRecords++;
			this.log(`dropped oversized stdout record (${this.tail.length} bytes without LF)`);
			this.tail = Buffer.alloc(0);
			this.dropping = true;
		}
	}

	private handleLine(line: Buffer): void {
		let record: unknown;
		try {
			record = JSON.parse(line.toString("utf8"));
		} catch (err) {
			this.fatal(`malformed JSON record: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (!isRec(record)) {
			this.fatal("non-object JSON record on stdout");
			return;
		}
		this.routeRecord(record);
	}

	private routeRecord(r: Record<string, unknown>): void {
		const type = str(r.type);

		if (type === "response") {
			const id = typeof r.id === "string" ? r.id : null;
			if (id === null) {
				const cmd = str(r.command) || "?";
				const err = str(r.error);
				this.fatal(
					`response without id (command '${cmd}')${err ? `: ${err}` : ""} — malformed command or protocol break`,
				);
				return;
			}
			const entry = this.pending.get(id);
			if (!entry) {
				this.fatal(`response id '${id}' does not match any pending command`);
				return;
			}
			if (entry.settled) {
				this.diagnostics.lateResponses++;
				this.log(`late response for settled command '${entry.commandType}' (${id}) — ignored`);
				return;
			}
			entry.resolve(this.toCommandResponse(r));
			return;
		}

		if (type === "extension_ui_request") {
			this.handleUiRequest(r);
			return;
		}

		switch (type) {
			case "agent_start":
				this.opts.sink({ type: "AGENT_START" });
				return;
			case "agent_end":
				this.opts.sink({ type: "AGENT_END", willRetry: r.willRetry === true });
				return;
			case "agent_settled":
				this.opts.sink({ type: "AGENT_SETTLED" });
				return;
			case "message_end":
				this.handleMessageEnd(r);
				return;
			case "message_update":
				// Deltas are never forwarded; keep only the cumulative usage.
				if (r.usage) this.lastUsage = r.usage;
				return;
			case "tool_execution_start":
				this.opts.sink({ type: "TOOL_START", toolName: str(r.toolName) });
				return;
			case "tool_execution_end":
				this.opts.sink({
					type: "TOOL_END",
					toolName: str(r.toolName),
					isError: r.isError === true,
				});
				return;
			case "compaction_start":
			case "compaction_end":
				this.diagnostics.compactions++;
				return;
			case "auto_retry_start":
				this.diagnostics.autoRetries++;
				return;
			case "auto_retry_end":
			case "summarization_retry_scheduled":
			case "summarization_retry_attempt_start":
			case "summarization_retry_finished":
				return;
			case "extension_error":
				this.log(
					`extension_error in child: ${str(r.extensionPath)} ${str(r.event)}: ${str(r.error)}`,
				);
				return;
			case "bash_execution_update":
				// Supervisor-issued bash only — this transport never issues bash.
				return;
			case "turn_start":
			case "turn_end":
			case "message_start":
			case "queue_update":
			case "session_info_changed":
			case "thinking_level_changed":
			case "entry_appended":
				return;
			default:
				// Unknown session event: logged, never fatal (forward compatibility).
				this.diagnostics.unknownEventTypes++;
				this.log(`unrecognized session event type '${type || "(none)"}' — ignored`);
				return;
		}
	}

	private toCommandResponse(r: Record<string, unknown>): CommandResponse {
		return {
			success: r.success === true,
			data: isRec(r.data) ? r.data : null,
			error: typeof r.error === "string" ? r.error : null,
		};
	}

	private handleMessageEnd(r: Record<string, unknown>): void {
		const m = isRec(r.message) ? r.message : null;
		if (!m || m.role !== "assistant") return;
		if (m.usage) this.lastUsage = m.usage;
		if (Array.isArray(m.content)) {
			const texts: string[] = [];
			for (const b of m.content) {
				if (isRec(b) && b.type === "text" && typeof b.text === "string") texts.push(b.text);
			}
			if (texts.length > 0) {
				let tail = texts.join("\n");
				if (tail.length > ASSISTANT_TAIL_CHARS) tail = tail.slice(tail.length - ASSISTANT_TAIL_CHARS);
				this.assistantTail = tail;
			}
		}
		this.opts.sink({
			type: "MESSAGE_END",
			stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
			errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
		});
	}

	private handleUiRequest(r: Record<string, unknown>): void {
		const id = typeof r.id === "string" ? r.id : null;
		const method = str(r.method) || "?";
		const title = str(r.title);
		if (DIALOG_METHODS.has(method)) {
			// Headless child: a blocked dialog is a hang — auto-cancel, log.
			if (id) {
				this.write({ type: "extension_ui_response", id, cancelled: true }).catch(() => {
					/* child dying — the exit path reports it */
				});
				this.uiAutoCancelled++;
			}
			this.log(`auto-cancelled extension UI dialog '${method}' (${title || id || "no id"})`);
		} else {
			this.log(`extension UI notification '${method}' (${title}) — logged fire-and-forget`);
		}
		this.opts.sink({ type: "EXT_UI_REQUEST", method, title });
	}

	/** Well-defined protocol violations only. */
	private fatal(reason: string): void {
		if (this.fatalReason) return;
		this.fatalReason = reason;
		this.log(`PROTOCOL_FATAL: ${reason}`);
		for (const [id, e] of this.pending) {
			if (e.settled) continue;
			e.reject(new ProtocolFatalError(reason));
		}
		this.pending.clear();
		this.opts.sink({ type: "PROTOCOL_FATAL", reason });
	}

	private handleExit(code: number | null, signal: string | null): void {
		if (this.exited) return;
		this.exited = true;
		this.deadCode = code;
		this.deadSignal = signal;
		for (const [id, e] of this.pending) {
			if (e.settled) continue;
			e.reject(new ChildDiedError(`exited (code ${code}, signal ${signal})`));
		}
		this.pending.clear();
		this.opts.sink({ type: "CHILD_DEAD", code, signal });
	}

	private onStderrChunk(chunk: Buffer): void {
		this.stderrChunks.push(chunk);
		this.stderrBytes += chunk.length;
		while (this.stderrBytes > STDERR_TAIL_BYTES && this.stderrChunks.length > 1) {
			this.stderrBytes -= this.stderrChunks[0]!.length;
			this.stderrChunks.shift();
		}
	}
}
