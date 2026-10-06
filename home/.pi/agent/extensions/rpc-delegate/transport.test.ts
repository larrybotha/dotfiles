/**
 * Transport tests — real RpcTransport against a scripted fake child
 * (fixtures/fake-child.mjs, FAKE_MODE env). No pi, no LLM, no watchdog:
 *   node transport.test.ts
 *
 * Covers the protocol-fidelity matrix: correlated responses, malformed JSON,
 * parse response without id, unmatched response id, command timeout with a
 * late response tolerated (not fatal), child death rejecting pending
 * commands, extension-UI dialog auto-cancel, flood survivability with no
 * delta forwarding, oversized-record drop policy, stderr tail capture,
 * stall supervision (silent child detected; open-tool suppression;
 * post-settle disarm; watchdog heartbeat file).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcEvent } from "./machine.ts";
import { ChildDiedError, CommandTimeoutError, ProtocolFatalError, RpcTransport } from "./transport.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));

interface Harness {
	transport: RpcTransport;
	events: RpcEvent[];
	logs: string[];
	logFile: string;
}

async function startTransport(
	mode: string,
	stall?: { gapMs: number; heartbeatPath?: string; heartbeatIntervalMs?: number },
	): Promise<Harness> {
	const events: RpcEvent[] = [];
	const logs: string[] = [];
	const logFile = path.join(os.tmpdir(), `fake-child-${mode}-${Date.now()}.log`);
	const transport = new RpcTransport({
		command: process.execPath,
		baseArgs: [FIXTURE],
		cwd: os.tmpdir(),
		sink: (ev) => events.push(ev),
		env: { FAKE_MODE: mode, FAKE_LOG: logFile },
		onLog: (msg) => logs.push(msg),
		stall,
	});
	await transport.start();
	return { transport, events, logs, logFile };
}

let passed = 0;
let failed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		passed++;
		console.log(`✓ ${name}`);
	} catch (e) {
		failed++;
		console.error(`✗ ${name}\n${e instanceof Error ? e.stack : String(e)}`);
	}
}

const waitForEvent = async (h: Harness, type: RpcEvent["type"], ms = 5000) => {
	const deadline = Date.now() + ms;
	while (!h.events.some((e) => e.type === type)) {
		if (Date.now() >= deadline) throw new Error(`event ${type} not observed within ${ms}ms`);
		await new Promise((r) => setTimeout(r, 25));
	}
};

// -- spawn failure ---------------------------------------------------------------

await ok("spawn failure (bad binary) rejects start", async () => {
	const t = new RpcTransport({
		command: "/definitely/not/a/binary",
		baseArgs: [],
		cwd: os.tmpdir(),
		sink: () => {},
	});
	await assert.rejects(() => t.start(), /ENOENT|spawn|binary/i);
	assert.equal(t.alive(), false);
});

// -- happy protocol ---------------------------------------------------------------

await ok("get_state handshake: correlated response with data", async () => {
	const h = await startTransport("ok");
	const r = await h.transport.sendCommand({ type: "get_state" }, 2000);
	assert.equal(r.success, true);
	assert.equal((r.data as { sessionId?: string })?.sessionId, "fake-session");
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard(); // idempotent cleanup
});

await ok("run events forwarded: AGENT_START, MESSAGE_END, AGENT_SETTLED; evidence kept", async () => {
	const h = await startTransport("ok");
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	await waitForEvent(h, "AGENT_SETTLED");
	const types = h.events.map((e) => e.type);
	assert.ok(types.includes("AGENT_START"));
	const msgEnd = h.events.find((e) => e.type === "MESSAGE_END");
	assert.equal((msgEnd as { stopReason: string } | undefined)?.stopReason, "stop");
	// responses and deltas are service-side only — never machine events
	assert.ok(!types.includes("BEGIN") && !types.includes("KILL"));
assert.equal(h.transport.getEvidence().assistantTextTail, "Done.");
	assert.deepEqual(h.transport.getEvidence().lastUsage, { totalTokens: 42 });
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard();
});

await ok("closeStdin → child exits 0 → CHILD_DEAD observed", async () => {
	const h = await startTransport("ok");
	h.transport.closeStdin();
	const exited = await h.transport.waitForExit(5000);
	assert.equal(exited, true);
	assert.equal(h.transport.exitCode(), 0);
	await waitForEvent(h, "CHILD_DEAD");
	assert.equal(h.transport.alive(), false);
	h.transport.killHard();
});

await ok("get_session_stats + export_html: response correlation across commands", async () => {
	const h = await startTransport("ok");
	const stats = await h.transport.sendCommand({ type: "get_session_stats" }, 2000);
	assert.equal(stats.success, true);
	assert.equal((stats.data as { cost?: number })?.cost, 0.0123);
	const html = await h.transport.sendCommand({ type: "export_html" }, 2000);
	assert.equal((html.data as { path?: string })?.path, "/tmp/fake-export.html");
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard();
});

// -- dispositions / rejections ------------------------------------------------------

await ok("disposition handled: response success, no run events", async () => {
	const h = await startTransport("handled");
	const r = await h.transport.sendCommand({ type: "prompt", message: "/cmd" }, 2000);
	assert.equal(r.success, true);
	assert.equal((r.data as { disposition?: string })?.disposition, "handled");
	assert.equal(h.events.filter((e) => e.type === "AGENT_START").length, 0);
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard();
});

await ok("prompt rejected: success:false with error surfaces to the service", async () => {
	const h = await startTransport("prompt-rejected");
	const r = await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	assert.equal(r.success, false);
	assert.match(r.error ?? "", /no model available/);
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard();
});

// -- protocol fatal (well-defined violations only) -----------------------------------

await ok("malformed JSON record → PROTOCOL_FATAL; pending rejected; further commands throw", async () => {
	const h = await startTransport("malformed");
	const pending = h.transport.sendCommand({ type: "prompt", message: "go" }, 3000);
	await assert.rejects(() => pending, ProtocolFatalError);
	await waitForEvent(h, "PROTOCOL_FATAL");
	assert.match(h.transport.getEvidence().fatalReason ?? "", /malformed JSON/);
	await assert.rejects(
		() => h.transport.sendCommand({ type: "get_state" }, 1000),
		ProtocolFatalError,
	);
	h.transport.killHard();
});

await ok("parse response without id → PROTOCOL_FATAL", async () => {
	const h = await startTransport("parse-no-id");
	await assert.rejects(
		() => h.transport.sendCommand({ type: "prompt", message: "go" }, 3000),
		(err: Error) => {
			assert.match(err.message, /Failed to parse command|without id/);
			return true;
		},
	);
	await waitForEvent(h, "PROTOCOL_FATAL");
	h.transport.killHard();
});

await ok("response id not in pending map → PROTOCOL_FATAL", async () => {
	const h = await startTransport("unmatched");
	// the correlated get_state resolves; the FOLLOW-UP unmatched-id response
	// (written by the fake after its reply) is the protocol break
	const r = await h.transport.sendCommand({ type: "get_state" }, 2000);
	assert.equal(r.success, true);
	await waitForEvent(h, "PROTOCOL_FATAL");
	assert.match(h.transport.getEvidence().fatalReason ?? "", /does not match any pending command/);
	h.transport.killHard();
});

// -- timeouts + late responses -------------------------------------------------------

await ok("command timeout rejects; a late response is logged, NOT fatal", async () => {
	const h = await startTransport("noreply");
	await assert.rejects(
		() => h.transport.sendCommand({ type: "prompt", message: "go" }, 100),
		CommandTimeoutError,
	);
	// the late response (400ms) arrives for the settled entry — tolerated
	await new Promise((r) => setTimeout(r, 700));
	assert.equal(h.events.filter((e) => e.type === "PROTOCOL_FATAL").length, 0);
	assert.equal(h.transport.diagnostics.lateResponses, 1);
	assert.ok(h.logs.some((l) => /late response for settled command/.test(l)));
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard();
});

// -- child death ---------------------------------------------------------------------

await ok("child death mid-run → CHILD_DEAD(code 3); pending rejected; alive false", async () => {
	const h = await startTransport("die-mid");
	await assert.rejects(
		() => h.transport.sendCommand({ type: "prompt", message: "go" }, 3000),
		ChildDiedError,
	);
	await waitForEvent(h, "CHILD_DEAD");
	const dead = h.events.find((e) => e.type === "CHILD_DEAD");
	assert.equal((dead as { code: number | null })?.code, 3);
	assert.equal(h.transport.alive(), false);
	assert.equal(h.transport.exitCode(), 3);
});

// -- extension UI policy -----------------------------------------------------------------

await ok("extension UI dialog auto-cancelled; notification never blocks; event forwarded", async () => {
	const h = await startTransport("extui");
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	await waitForEvent(h, "AGENT_SETTLED");
	await new Promise((r) => setTimeout(r, 300)); // auto-response round trip
	assert.equal(h.transport.getEvidence().uiAutoCancelled, 1);
	assert.ok(h.events.some((e) => e.type === "EXT_UI_REQUEST"));
	const log = fs.readFileSync(h.logFile, "utf-8");
	assert.ok(/ui:ui-1:cancelled/.test(log), `expected cancelled UI response in log, got: ${log}`);
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard();
});

// -- backpressure / flood / oversized -----------------------------------------------------

await ok("flood: 3000 deltas dropped, tool events bounded, machine survives", async () => {
	const h = await startTransport("flood");
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 5000);
	await waitForEvent(h, "AGENT_SETTLED", 10_000);
	// message_update never becomes a machine event; tool events do
	const toolStarts = h.events.filter((e) => e.type === "TOOL_START").length;
	assert.equal(toolStarts, 100);
	assert.equal(h.events.filter((e) => e.type === "TOOL_END").length, 100);
	assert.equal((h.transport.getEvidence().lastUsage as { totalTokens?: number } | null)?.totalTokens, 2999);
	await h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	h.transport.killHard();
});

await ok("oversized record dropped (not fatal); later records still parsed", async () => {
	const h = await startTransport("oversized");
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 30_000);
	await waitForEvent(h, "AGENT_SETTLED", 30_000);
	assert.ok(h.transport.diagnostics.droppedRecords >= 1);
	assert.equal(h.events.filter((e) => e.type === "PROTOCOL_FATAL").length, 0);
	assert.ok(h.logs.some((l) => /oversized/.test(l)));
	h.transport.killHard();
});

// -- stderr tail -------------------------------------------------------------------------

await ok("stderr tail captured (bounded), diagnostics never parsed as protocol", async () => {
	const h = await startTransport("stderr");
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	await waitForEvent(h, "AGENT_SETTLED");
	h.transport.closeStdin();
	await h.transport.waitForExit(5000);
	assert.match(h.transport.getEvidence().stderrTail, /diagnostic noise/);
	assert.equal(h.transport.exitCode(), 1);
	h.transport.killHard();
});

// -- stall supervision (liveness timer, open-tool suppression, heartbeat) ------

await ok("stall: silent child (no tool open) → STALL_DETECTED once, stallMs exact", async () => {
	const h = await startTransport("stall", { gapMs: 150 });
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	await waitForEvent(h, "STALL_DETECTED", 5000);
	const st = h.events.find((e) => e.type === "STALL_DETECTED");
	assert.equal((st as { stallMs: number } | undefined)?.stallMs, 150);
	await new Promise((r) => setTimeout(r, 400)); // one-shot: no duplicate events
	assert.equal(h.events.filter((e) => e.type === "STALL_DETECTED").length, 1);
	assert.ok(h.logs.some((l) => /stall: no protocol activity/.test(l)));
	h.transport.killHard();
});

await ok("stall suppressed while a child tool is open; re-arms after tool end", async () => {
	const h = await startTransport("stall-open", { gapMs: 150 });
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	// 400ms of silence INSIDE the open tool must not trip the 150ms gap
	await waitForEvent(h, "AGENT_SETTLED", 10_000);
	assert.equal(h.events.filter((e) => e.type === "STALL_DETECTED").length, 0);
	assert.equal(h.transport.getEvidence().openTools, 0); // closed again
	h.transport.killHard();
});

await ok("silent boot never stalls (timer arms on first byte; boot is the handshake timeout's job)", async () => {
	const h = await startTransport("mute", { gapMs: 80 });
	await new Promise((r) => setTimeout(r, 300)); // never spoke — nothing armed
	assert.equal(h.events.length, 0);
	h.transport.killHard();
});

await ok("agent_settled disarms the stall timer (post-settle silence is not a stall)", async () => {
	const h = await startTransport("ok", { gapMs: 100 });
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	await waitForEvent(h, "AGENT_SETTLED");
	await new Promise((r) => setTimeout(r, 350)); // silence past the gap
	assert.equal(h.events.filter((e) => e.type === "STALL_DETECTED").length, 0);
	h.transport.killHard();
});

await ok("no stall option → no stall detection (opt-in behavior unchanged)", async () => {
	const h = await startTransport("stall");
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	await waitForEvent(h, "AGENT_START");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(h.events.filter((e) => e.type === "STALL_DETECTED").length, 0);
	h.transport.killHard();
});

await ok("heartbeat file written ({t, open}) for the external watchdog", async () => {
	const hb = path.join(os.tmpdir(), `rpc-delegate-hb-test-${Date.now()}.json`);
	const h = await startTransport("stall-open", {
		gapMs: 150_000,
		heartbeatPath: hb,
		heartbeatIntervalMs: 50,
	});
	await h.transport.sendCommand({ type: "prompt", message: "go" }, 2000);
	await waitForEvent(h, "TOOL_START", 5000);
	await new Promise((r) => setTimeout(r, 200)); // heartbeat written mid-tool
	const parsed = JSON.parse(fs.readFileSync(hb, "utf8")) as { t: number; open: number };
	assert.equal(typeof parsed.t, "number");
	assert.ok(Math.abs(Date.now() - parsed.t) < 5000, "heartbeat t is fresh");
	assert.equal(parsed.open, 1); // mid-tool: open count surfaced for the watchdog
	await waitForEvent(h, "AGENT_SETTLED", 10_000);
	h.transport.killHard();
	fs.rmSync(hb, { force: true });
});

console.log(`\n${passed} tests passed${failed > 0 ? `, ${failed} failed` : ""}`);
if (failed > 0) process.exit(1);
