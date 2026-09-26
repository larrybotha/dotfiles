/**
 * viz-kit — shared Stately-inspector wiring for XState-machine extensions.
 *
 * Every extension that owns an XState machine and exposes "/x viz" needs the
 * same transport around `@statelyai/inspect`:
 *
 *   - port pre-check: createInspectorServer attaches no 'error' handler, so a
 *     listen failure surfaces as an unhandled async 'error' event and kills
 *     the pi process. Probe by binding before creating the server.
 *   - clean-stop WS adapter: the stock createWebSocketInspector retries every
 *     5s forever from ws.onerror — including after stop() when close races the
 *     CONNECTING state — leaking timers that keep the pi process alive
 *     (partysocket). This adapter never retries after stop(); events sent
 *     while closed queue (bounded).
 *   - port auto-allocation: multiple machines default to 8080; walk to the
 *     first free port so two extensions can run in one session.
 *   - idempotent teardown for session_shutdown.
 *
 * Transport only. The extension owns config (env names, preferred port),
 * actor creation — spread `viz.option()` into createActor; XState `inspect`
 * is a creation-time option, so attach = re-create the actor from its
 * persisted snapshot — and the thin "/x viz" command wrapper.
 *
 * Privacy: the relay serves a bridge page that iframes the remote
 * https://stately.ai/inspect UI and postMessages every machine event into it;
 * it binds all interfaces (the package exposes no host/bind option) with no
 * auth. Opt-in is the control — nothing runs unless asked.
 */
import * as net from "node:net";
import { createInspector } from "@statelyai/inspect";
import { createInspectorServer } from "@statelyai/inspect/server";

export interface VizResult {
	ok: boolean;
	message: string;
	/** Actual listening port (set when ok). */
	port?: number;
}

export interface Viz {
	/** Actual listening port once enabled; undefined before. */
	readonly port: number | undefined;
	enabled(): boolean;
	/** Start inspector server + client. Idempotent; never throws. */
	enable(opts?: { open?: boolean }): Promise<VizResult>;
	/** Stop and report. Idempotent. */
	disable(): VizResult;
	/** Silent idempotent teardown (session_shutdown). */
	stop(): void;
	/** Spread into createActor options: {} when off, { inspect } when on. */
	option(): InspectOption;
}

/**
 * XState `inspect` option shape: Observer<InspectionEvent>, widened so the
 * kit needs no xstate type imports. Assignable to createActor's option type
 * (next param contravariant: `unknown` accepts any InspectionEvent).
 */
export type InspectOption = {
	inspect?: { next?: (event: unknown) => void } | ((event: unknown) => void);
};

/**
 * WebSocket adapter with clean stop semantics.
 * The stock createWebSocketInspector adapter retries every 5s forever from
 * ws.onerror — including after stop() when close races the CONNECTING state —
 * leaking timers that keep the pi process alive. This adapter never retries
 * after stop(); events sent while closed are queued (bounded).
 */
class CleanWebSocketAdapter {
	private ws: WebSocket | null = null;
	private stopped = false;
	private queue: string[] = [];
	private status: "open" | "closed" = "closed";
	private readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	private connect(): void {
		if (this.stopped) return;
		const ws = new WebSocket(this.url);
		this.ws = ws;
		ws.onopen = () => {
			this.status = "open";
			for (const msg of this.queue.splice(0)) ws.send(msg);
		};
		ws.onclose = () => {
			this.status = "closed";
		};
		ws.onerror = () => {
			this.status = "closed";
		};
		ws.onmessage = () => {};
	}

	stop(): void {
		this.stopped = true;
		try {
			this.ws?.close(1000);
		} catch {
			/* already closed */
		}
		this.ws = null;
		this.status = "closed";
	}

	send(event: unknown): void {
		let msg: string;
		try {
			msg = JSON.stringify(event);
		} catch {
			return;
		}
		if (this.ws && this.status === "open") this.ws.send(msg);
		else {
			this.queue.push(msg);
			if (this.queue.length > 200) this.queue.shift();
		}
	}
}

/**
 * Bind-probe: true only if this process can listen on the port. Probes `::`
 * (all interfaces) — the same bind createInspectorServer uses; a 127.0.0.1
 * probe passes on macOS even when the port is held on `::`, so a same-process
 * second relay would EADDRINUSE-crash the pi process (unhandled 'error'
 * event — the package attaches no handler). `::` is the conservative probe:
 * it conflicts with wildcard AND specific-address binds on macOS. Checks
 * both "port free" and "the eventual relay can bind" — the WS client must
 * not stream machine events to whatever already owns the port either.
 */
export function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "::", () => probe.close(() => resolve(true)));
	});
}

export function makeViz(opts: {
	/** Extension name, used in messages. */
	name: string;
	preferredPort: number;
	/** Ports tried on the allocation walk (default 8). */
	portTries?: number;
}): Viz {
	const { name, preferredPort } = opts;
	const portTries = opts.portTries ?? 8;

	let on = false;
	let port: number | undefined;
	let server: { stop(): void } | null = null;
	let inspector: ReturnType<typeof createInspector> | null = null;

	function teardown(): void {
		// Inspector.stop() calls adapter.stop?.(); call adapter directly too —
		// idempotent (stopped flag), and a null-ed reference alone would leave
		// a CONNECTING socket dangling.
		inspector?.stop();
		inspector?.adapter.stop?.();
		inspector = null;
		server?.stop();
		server = null;
		on = false;
		port = undefined;
	}

	return {
		get port() {
			return port;
		},

		enabled() {
			return on;
		},

		async enable(enableOpts?: { open?: boolean }): Promise<VizResult> {
			if (on) {
				return { ok: true, message: `${name} viz already running: http://localhost:${port}`, port };
			}
			let free: number | undefined;
			for (let p = preferredPort; p < preferredPort + portTries; p++) {
				if (await portFree(p)) {
					free = p;
					break;
				}
			}
			if (free === undefined) {
				return {
					ok: false,
					message: `${name} viz cannot start: ports ${preferredPort}-${preferredPort + portTries - 1} busy (other inspectors or foreign processes)`,
				};
			}
			server = createInspectorServer({ port: free, autoOpen: enableOpts?.open ?? true });
			inspector = createInspector(new CleanWebSocketAdapter(`ws://localhost:${free}`));
			on = true;
			port = free;
			const walked = free !== preferredPort ? ` (preferred port ${preferredPort} busy)` : "";
			return { ok: true, message: `${name} viz live: http://localhost:${free}${walked}`, port: free };
		},

		disable(): VizResult {
			if (!on) return { ok: false, message: `${name} viz not running` };
			teardown();
			return { ok: true, message: `${name} viz stopped` };
		},

		stop(): void {
			if (!on) return;
			teardown();
		},

		option() {
			return on ? { inspect: inspector!.inspect as InspectOption["inspect"] } : {};
		},
	};
}
