/**
 * viz-kit tests — plain node, no pi: `node _viz/test.ts`
 * (deps resolve from ~/.pi/agent/extensions/node_modules).
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import { createActor, createMachine } from "xstate";
import { makeViz, portFree } from "./viz-kit.ts";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
