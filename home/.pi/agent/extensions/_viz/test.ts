/**
 * viz-kit tests — plain node, no pi: `node _viz/test.ts`
 * (deps resolve from ~/.pi/agent/extensions/node_modules).
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import { createActor, createMachine } from "xstate";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeViz, portFree } from "./viz-kit.ts";
import {
	ensureSketch,
	sketchHealth,
	sketchStatus,
	stopSketch,
	sketchDir,
} from "./sketch.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string) {
	if (cond) {
		passed++;
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  NOT OK - ${name}`);
	}
}

/** Bind an ephemeral port, return it closed (a known-free port). */
function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(p));
		});
	});
}

/** Bind and hold a port the way the relay does (`::` wildcard). A
 * 127.0.0.1-only holder does not conflict with the relay's `::` bind on
 * macOS — specific and wildcard binds coexist — so it is not a competitor. */
function holdPort(port: number): Promise<net.Server> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(port, "::", () => resolve(s));
	});
}

/** Someone listening on the port? */
function listening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const c = net.connect({ port, host: "127.0.0.1" });
		c.once("connect", () => {
			c.destroy();
			resolve(true);
		});
		c.once("error", () => resolve(false));
	});
}

/** Poll until true or ~2s deadline. */
async function eventually(fn: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + 2000;
	for (;;) {
		if (await fn()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}

const toggleMachine = createMachine({
	id: "toggle",
	initial: "off",
	states: {
		off: { on: { TOGGLE: "on" } },
		on: { on: { TOGGLE: "off" } },
	},
});

console.log("viz-kit");

// 1. portFree
{
	const p = await freePort();
	ok(await portFree(p), "portFree: free port -> true");
	const holder = await holdPort(p);
	ok((await portFree(p)) === false, "portFree: bound port -> false");
	holder.close();
}

// 2. enable + option + real xstate actor
{
	const p = await freePort();
	const viz = makeViz({ name: "test", preferredPort: p });
	assert.deepEqual(viz.option(), {}, "option() off -> {}");
	const r = await viz.enable({ open: false });
	ok(r.ok && r.port === p && viz.port === p, `enable: ok, preferred port kept (${r.message})`);
	ok(await listening(p), "enable: relay listening");
	ok(viz.enabled(), "enable: enabled()");
	const inspectOpt = viz.option().inspect;
	ok(
		typeof inspectOpt === "function" || typeof inspectOpt?.next === "function",
		"option() on -> { inspect }",
	)
	// real actor wiring: inspect option must be accepted by createActor
	const actor = createActor(toggleMachine, { ...viz.option() });
	actor.start();
	actor.send({ type: "TOGGLE" });
	ok(actor.getSnapshot().status === "active" && (actor.getSnapshot().value as string) === "on", "createActor accepts option(); machine runs");

	// 3. idempotent enable
	const again = await viz.enable({ open: false });
	ok(again.ok && again.port === p && /already running/.test(again.message), "enable twice: ok, already running, same port");

	// 4. disable
	const d = viz.disable();
	ok(d.ok && /stopped/.test(d.message), `disable: ok (${d.message})`);
	ok(!viz.enabled() && viz.port === undefined, "disable: not enabled, port undefined");
	ok(
		await eventually(async () => !(await listening(p))),
		"disable: port released",
	);
	ok(typeof viz.option().inspect === "undefined", "option() after disable -> {}");

	// 5. stop idempotent (silent)
	viz.stop();
	ok(!viz.enabled(), "stop after disable: no throw, still off");

	// 6. disable when never enabled
	const fresh = makeViz({ name: "fresh", preferredPort: await freePort() });
	const nd = fresh.disable();
	ok(nd.ok === false && /not running/.test(nd.message), "disable when off: ok:false, not running");
}

// 7. port allocation walk — second viz in the same process
{
	const p = await freePort();
	const a = makeViz({ name: "a", preferredPort: p });
	const ra = await a.enable({ open: false });
	ok(ra.ok && ra.port === p, "alloc: first viz takes preferred port");
	const b = makeViz({ name: "b", preferredPort: p, portTries: 3 });
	const rb = await b.enable({ open: false });
	ok(rb.ok && rb.port === p + 1, `alloc: second viz walks to next port (${rb.message})`);
	ok(await listening(p + 1), "alloc: second relay listening on walked port");
	a.stop();
	b.stop();
}

// 8. allocation walk exhausted
{
	const p = await freePort();
	const holders = await Promise.all([holdPort(p), holdPort(p + 1)]);
	const v = makeViz({ name: "c", preferredPort: p, portTries: 2 });
	const r = await v.enable({ open: false });
	ok(r.ok === false && /busy/.test(r.message), `alloc exhausted: ok:false (${r.message})`);
	ok(v.enabled() === false, "alloc exhausted: not enabled");
	for (const h of holders) h.close();
}

// 9. end-to-end: inspection events must reach a WS client of the relay.
// Regression: enable() used to skip inspector.start(), so the pi-side
// adapter never connected and zero events ever reached the relay/bridge.
{
	const p = await freePort();
	const viz = makeViz({ name: "e2e", preferredPort: p });
	const r = await viz.enable({ open: false });
	ok(r.ok, `e2e: enable (${r.message})`);

	const actor = createActor(toggleMachine, { ...viz.option() });
	actor.start();

	const ws = new WebSocket(`ws://127.0.0.1:${p}`);
	const msgs: string[] = [];
	ws.addEventListener("message", (e) => {
		msgs.push(String(e.data));
	});
	await new Promise((res) => ws.addEventListener("open", res));
	// grace for the pi-side adapter's WS to open (queue flushes onopen)
	await new Promise((res) => setTimeout(res, 150));
	actor.send({ type: "TOGGLE" });
	ok(
		await eventually(() => Promise.resolve(msgs.length > 0)),
		"e2e: inspection events reach relay WS client",
	);
	ws.close();
	viz.stop();
}

// 10. inspectorUrl passthrough: relay bridge must iframe the given URL
// (local Sketch /inspect) instead of the stock remote stately.ai UI.
{
	const p = await freePort();
	const viz = makeViz({ name: "urlpass", preferredPort: p });
	const local = `http://127.0.0.1:${await freePort()}/inspect`;
	const r = await viz.enable({ open: false, inspectorUrl: local });
	ok(r.ok, `urlpass: enable (${r.message})`);
	const html = await fetch(`http://127.0.0.1:${p}`).then((x) => x.text());
	ok(html.includes(`src="${local}"`), "urlpass: bridge iframe src = local sketch URL");
	ok(/events local via/.test(r.message), "urlpass: message notes local UI");
	viz.stop();
}

console.log("sketch.ts");

/** Fake HTTP server answering /inspect with a configurable status. */
function fakeInspect(port: number, status: number): Promise<http.Server> {
	return new Promise((resolve) => {
		const s = http.createServer((req, res) => {
			res.writeHead(status, { "content-type": "text/html" });
			res.end("<html></html>");
		});
		s.listen(port, "127.0.0.1", () => resolve(s));
	});
}

const ENV_KEYS = ["XSTATE_SKETCH_DIR", "XSTATE_SKETCH_PORT", "XSTATE_SKETCH_REMOTE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function restoreEnv() {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
}

// 11. sketchHealth: 2xx -> true; 3xx-unfollowed/4xx/5xx/closed -> false
// (a foreign dev server 404s unknown routes — must not read as Sketch)
{
	const up = await fakeInspect(await freePort(), 200);
	const err5 = await fakeInspect(await freePort(), 500);
	const err4 = await fakeInspect(await freePort(), 404);
	const upPort = (up.address() as net.AddressInfo).port;
	const err5Port = (err5.address() as net.AddressInfo).port;
	const err4Port = (err4.address() as net.AddressInfo).port;
	ok(await sketchHealth(upPort), "health: 200 -> true");
	ok((await sketchHealth(err5Port)) === false, "health: 500 -> false");
	ok((await sketchHealth(err4Port)) === false, "health: 404 (foreign server) -> false");
	ok((await sketchHealth(await freePort())) === false, "health: closed port -> false");
	up.close();
	err5.close();
	err4.close();
}

// 12. ensureSketch: reuses a healthy server on the walked port without
// cloning/spawning anything (probe happens before bootstrap).
{
	const fake = await fakeInspect(await freePort(), 200);
	const fakePort = (fake.address() as net.AddressInfo).port;
	process.env.XSTATE_SKETCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sketch-test-"));
	process.env.XSTATE_SKETCH_PORT = String(fakePort);
	const r = await ensureSketch();
	ok(
		r.ok && r.host.reused === true && r.host.url === `http://127.0.0.1:${fakePort}/inspect`,
		`ensure: healthy server reused, no spawn (${r.ok ? r.host.url : r.reason})`,
	);
	// second ensure on the same port: same result (idempotent probe)
	const r2 = await ensureSketch();
	ok(r2.ok && r2.host.port === fakePort, "ensure: idempotent on healthy host");
	// no host.json written for a reused foreign server
	ok(!fs.existsSync(path.join(sketchDir(), "host.json")), "ensure: reuse writes no host.json");
	fake.close();
}

// 13. ensureSketch: XSTATE_SKETCH_REMOTE=1 -> disabled (caller falls back to
// the remote stately.ai UI)
{
	process.env.XSTATE_SKETCH_REMOTE = "1";
	const r = await ensureSketch();
	ok(r.ok === false && /REMOTE/.test(r.reason), `ensure: remote env -> disabled (${r.reason})`);
	restoreEnv();
}

// 14. sketchStatus/stopSketch against a dead-pid host.json — never touches a
// live process (pid group kill on the test runner would kill the tests).
{
	process.env.XSTATE_SKETCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sketch-test-"));
	// a freshly exited child's pid is dead but valid
	const { spawn } = await import("node:child_process");
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((res) => dead.once("exit", res));
	fs.mkdirSync(sketchDir(), { recursive: true });
	fs.writeFileSync(
		path.join(sketchDir(), "host.json"),
		JSON.stringify({ port: 31234, pid: dead.pid, ownerPid: process.pid, startedAt: Date.now() }),
	);
	const s = sketchStatus();
	ok(s.running === false, "status: dead pid -> not running");
	const stop = stopSketch({ onlyIfOwner: process.pid });
	ok(stop.ok && /already dead/.test(stop.message), `stop: dead pid -> cleaned (${stop.message})`);
	ok(!fs.existsSync(path.join(sketchDir(), "host.json")), "stop: host.json removed");
	// no host.json at all
	const none = stopSketch();
	ok(none.ok === false && /no host.json/.test(none.message), `stop: nothing running (${none.message})`);
	// owner mismatch: left running, nothing killed
	fs.writeFileSync(
		path.join(sketchDir(), "host.json"),
		JSON.stringify({ port: 31234, pid: dead.pid, ownerPid: 999999, startedAt: Date.now() }),
	);
	const foreign = stopSketch({ onlyIfOwner: process.pid });
	ok(foreign.ok === false && /left running/.test(foreign.message), `stop: owner mismatch -> left (${foreign.message})`);
	fs.rmSync(path.join(sketchDir(), "host.json"), { force: true });
	restoreEnv();
}

restoreEnv();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
