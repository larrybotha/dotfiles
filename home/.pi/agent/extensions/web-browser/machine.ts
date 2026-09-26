/**
 * Browser lifecycle machine for the web-browser extension.
 *
 * States own legality: page ops (nav / eval / screenshot / pick / switch /
 * emulate) are only legal in `running`; launch only from `stopped`.
 * Context carries last-known caches (browser info, active tab, emulation
 * preference) + known device presets. Executors (skill scripts + extension
 * probes) own IO and embed evidence in events.
 *
 * Ground truth for "is the browser up" is the probe executor — never a stale
 * context field. PROBE reconciles both directions: adopts a live browser
 * from `stopped` (user kept it open across a pi restart), marks drift from
 * `running` (browser died underneath us).
 *
 * RESTORE (branch restore) fills caches only — browser info is always
 * re-derived from a live probe, never resurrected from a snapshot.
 * Emulation preference survives STOP: it is a preference, not lifecycle.
 */
import { assign, setup } from "xstate";

export type LaunchMode = "fresh" | "profile" | "reset-profile" | "attach";
/** Probed-live browser with no skill state file — connect-only, never killed. */
export type BrowserMode = LaunchMode | "foreign";

export interface BrowserInfo {
	mode: BrowserMode;
	port: number;
	/** Null for attach/foreign, or if the pid is unknown. */
	pid: number | null;
	userDataDir: string | null;
	/** Product string from /json/version, e.g. "Chrome/126.0.6478.57". */
	browser: string | null;
	startedAt: string | null;
}

export interface ActiveTab {
	targetId: string | null;
	url: string;
	at: string;
}

export interface EmulationPref {
	device: string;
	landscape: boolean;
	at: string;
}

export interface BrowserContext {
	browser: BrowserInfo | null;
	activeTab: ActiveTab | null;
	emulation: EmulationPref | null;
	errors: string[];
	/** Known device preset ids. Ground truth: skill devices.js; loaded at
	 *  session_start, refreshed via DEVICES. Default mirrors it. */
	devices: string[];
}

export type BrowserEvent =
	| { type: "BEGIN_LAUNCH"; mode: LaunchMode }
	| {
			type: "LAUNCH_DONE";
			mode: LaunchMode;
			port: number;
			pid: number | null;
			userDataDir: string | null;
			browser: string | null;
			error: string | null;
	  }
	| {
			type: "PROBE";
			up: boolean;
			port: number;
			browser: string | null;
			pid: number | null;
			mode: BrowserMode;
			userDataDir: string | null;
			startedAt: string | null;
	  }
	| { type: "NAV"; url: string; newTab: boolean }
	| { type: "TAB_SWITCH"; targetId: string | null; url: string }
	| { type: "EMULATE_SET"; device: string; landscape: boolean }
	| { type: "EMULATE_RESET" }
	| { type: "STOP"; reason: string }
	| {
			type: "RESTORE";
			activeTab: ActiveTab | null;
			emulation: EmulationPref | null;
			devices: string[] | null;
	  }
	| { type: "DEVICES"; ids: string[] };

/** Mirrors skill devices.js preset ids — replaced at session_start by a live read. */
export const DEFAULT_DEVICES = ["iphone-se", "iphone-14", "pixel-7", "galaxy-s20"];

export function initialContext(devices: string[] = DEFAULT_DEVICES): BrowserContext {
	return {
		browser: null,
		activeTab: null,
		emulation: null,
		errors: [],
		devices: devices.length > 0 ? [...devices] : [...DEFAULT_DEVICES],
	};
}

// ---- pure validators: shared by guards and tool prechecks ----

export function launchViolation(ctx: BrowserContext): string | null {
	if (ctx.browser) {
		return `browser already running (${ctx.browser.mode} on :${ctx.browser.port}) — browser_stop first, or browser_start mode "attach" to reuse it`;
	}
	return null;
}

export function emulateViolation(ctx: BrowserContext, device: string): string | null {
	if (!device) return "no device preset provided";
	if (!ctx.devices.includes(device)) {
		return `unknown device preset "${device}" — known: ${ctx.devices.join(", ")}`;
	}
	return null;
}

/** Readable reason for page-op prechecks (state-value level, not context). */
export function notRunningReason(value: string): string {
	if (value === "starting") {
		return "browser still starting — wait for the browser_start result before page ops";
	}
	return "browser not running — browser_start first (fresh | profile | reset_profile | attach), or browser_status to probe";
}

// ---- machine ----

function browserFromEvent(e: Extract<BrowserEvent, { type: "LAUNCH_DONE" | "PROBE" }>): BrowserInfo {
	return {
		mode: e.mode,
		port: e.port,
		pid: e.pid,
		userDataDir: e.userDataDir,
		browser: e.browser,
		startedAt: "startedAt" in e ? e.startedAt : null,
	};
}

export const browserMachine = setup({
	types: {
		context: {} as BrowserContext,
		events: {} as BrowserEvent,
		input: {} as { devices?: string[] } | undefined,
	},
	guards: {
		deviceKnown: ({ context, event }) =>
			event.type === "EMULATE_SET" && emulateViolation(context, event.device) === null,
		restoreShape: ({ event }) =>
			event.type === "RESTORE" &&
			(event.activeTab === null ||
				(typeof event.activeTab.url === "string" &&
					typeof event.activeTab.at === "string" &&
					(event.activeTab.targetId === null || typeof event.activeTab.targetId === "string"))) &&
			(event.emulation === null ||
				(typeof event.emulation.device === "string" && typeof event.emulation.landscape === "boolean")) &&
			(event.devices === null ||
				(Array.isArray(event.devices) && event.devices.every((d) => typeof d === "string"))),
	},
	actions: {
		setBrowser: assign(({ event }) => {
			if (event.type !== "LAUNCH_DONE" && event.type !== "PROBE") return {};
			return { browser: browserFromEvent(event) };
		}),
		recordLaunchError: assign(({ context, event }) => {
			if (event.type !== "LAUNCH_DONE" || !event.error) return {};
			return { errors: [...context.errors, `launch ${event.mode}: ${event.error}`] };
		}),
		recordDrift: assign(({ context, event }) => {
			if (event.type !== "PROBE" || event.up) return {};
			const had = context.browser
				? `browser gone (was ${context.browser.mode} on :${context.browser.port})`
				: "browser gone";
			return { errors: [...context.errors, had], browser: null, activeTab: null };
		}),
		setActiveTab: assign(({ event }) => {
			if (event.type === "NAV") {
				return {
					activeTab: { targetId: null, url: event.url, at: new Date().toISOString() },
				};
			}
			if (event.type === "TAB_SWITCH") {
				return {
					activeTab: { targetId: event.targetId, url: event.url, at: new Date().toISOString() },
				};
			}
			return {};
		}),
		setEmulation: assign(({ event }) => {
			if (event.type !== "EMULATE_SET") return {};
			return {
				emulation: {
					device: event.device,
					landscape: event.landscape,
					at: new Date().toISOString(),
				},
			};
		}),
		clearEmulation: assign(() => ({ emulation: null })),
		stopBrowser: assign(({ context, event }) => {
			if (event.type !== "STOP") return {};
			// browser + active tab die with the session; emulation pref survives
			return {
				browser: null,
				activeTab: null,
				errors: [...context.errors, `stopped: ${event.reason}`],
			};
		}),
		restoreCaches: assign(({ context, event }) => {
			if (event.type !== "RESTORE") return {};
			return {
				activeTab: event.activeTab ?? context.activeTab,
				emulation: event.emulation ?? context.emulation,
				devices: event.devices && event.devices.length > 0 ? [...event.devices] : context.devices,
			};
		}),
		setDevices: assign(({ context, event }) => {
			if (event.type !== "DEVICES" || event.ids.length === 0) return {};
			return { devices: [...event.ids] };
		}),
	},
}).createMachine({
	id: "browser",
	context: ({ input }) => initialContext(input?.devices),
	initial: "stopped",
	states: {
		stopped: {
			on: {
				BEGIN_LAUNCH: { target: "starting" },
				// adopt: user kept the browser open across a pi restart
				PROBE: [
					{
						guard: ({ event }) => event.type === "PROBE" && event.up,
						target: "running",
						actions: "setBrowser",
					},
					{
						guard: ({ context, event }) =>
							event.type === "PROBE" && !event.up && !!context.browser,
						actions: "recordDrift",
					},
					{},
				],
				RESTORE: { guard: "restoreShape", actions: "restoreCaches" },
				DEVICES: { actions: "setDevices" },
				STOP: { actions: "stopBrowser" },
			},
		},
		starting: {
			on: {
				LAUNCH_DONE: [
					{
						guard: ({ event }) => event.type === "LAUNCH_DONE" && event.error === null,
						target: "running",
						actions: "setBrowser",
					},
					{ target: "stopped", actions: "recordLaunchError" },
				],
				DEVICES: { actions: "setDevices" },
			},
		},
		running: {
			on: {
				// fresh evidence overwrites the cache; drift marks the browser gone
				PROBE: [
					{
						guard: ({ event }) => event.type === "PROBE" && event.up,
						actions: "setBrowser",
					},
					{ target: "stopped", actions: "recordDrift" },
				],
				NAV: { actions: "setActiveTab" },
				TAB_SWITCH: { actions: "setActiveTab" },
				EMULATE_SET: { guard: "deviceKnown", actions: "setEmulation" },
				EMULATE_RESET: { actions: "clearEmulation" },
				STOP: { target: "stopped", actions: "stopBrowser" },
				RESTORE: { guard: "restoreShape", actions: "restoreCaches" },
				DEVICES: { actions: "setDevices" },
			},
		},
	},
});
