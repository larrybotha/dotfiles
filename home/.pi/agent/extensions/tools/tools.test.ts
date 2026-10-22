/**
 * tools.ts restore tests — no LLM needed:
 *   node tools/tools.test.ts
 *
 * Rule under test: the transcript is authoritative. Pi replays tool changes
 * (system messages with toolsAdded/toolsRemoved) before session_start/
 * session_tree fires. setActiveTools is called ONLY to replay a /tools toggle
 * newer than the branch's last system message.
 */
import assert from "node:assert/strict";
import toolsExtension from "../tools.ts";

type Exposure = "direct" | "model-only" | "codemode" | "deferred";
const ALL: Record<string, Exposure> = {
	read: "direct",
	bash: "direct",
	write: "direct",
	codemode: "model-only",
	tool_search: "model-only",
	journal_read: "deferred",
	mcp__x__get: "codemode",
};

type Entry = Record<string, unknown>;

function harness(active: string[], branch: Entry[]) {
	const handlers: Record<string, Function> = {};
	const state = { active: [...active], applied: 0 };
	const pi = {
		on: (ev: string, h: Function) => (handlers[ev] = h),
		registerCommand: () => {},
		appendEntry: () => {},
		getAllTools: () => Object.entries(ALL).map(([name, exposure]) => ({ name, exposure })),
		getActiveTools: () => [...state.active],
		setActiveTools: (n: string[]) => {
			state.applied++;
			state.active = [...n];
		},
	};
	toolsExtension(pi as never);
	const ctx = { sessionManager: { getBranch: () => branch } };
	return { state, fire: (ev: string, event: Record<string, unknown> = {}) => handlers[ev](event, ctx) };
}

const cfg = (enabledTools: string[]): Entry => ({
	type: "custom",
	customType: "tools-config",
	data: { enabledTools },
});
// System message carrying a recorded tool change (what pi replays).
const sys = (added: string[] = [], removed: string[] = []): Entry => ({
	type: "message",
	message: { role: "system", toolsAdded: added, toolsRemoved: removed },
});
const sorted = (a: string[]) => [...a].sort();

// 1. Recorded toggle: transcript already has the load after the config -> no-op.
for (const ev of ["session_start", "session_tree"]) {
	const h = harness(
		["read", "codemode", "tool_search", "journal_read", "mcp__x__get"],
		[cfg(["read", "codemode", "tool_search"]), sys(["journal_read", "mcp__x__get"])],
	);
	h.fire(ev);
	assert.deepEqual(
		sorted(h.state.active),
		sorted(["read", "codemode", "tool_search", "journal_read", "mcp__x__get"]),
		`${ev}: recorded load survives restore`,
	);
	assert.equal(h.state.applied, 0, `${ev}: no setActiveTools when transcript is newer`);

	// 2. Unrecorded toggle: config after the last system message -> apply it.
	const h2 = harness(["read", "bash", "codemode", "journal_read"], [sys(), cfg(["read", "codemode", "journal_read"])]);
	h2.fire(ev);
	assert.deepEqual(
		sorted(h2.state.active),
		sorted(["read", "codemode", "journal_read"]),
		`${ev}: unrecorded toggle applied (bash removed, load kept)`,
	);
	assert.equal(h2.state.applied, 1, `${ev}: one setActiveTools for unrecorded toggle`);

	// 3. Stale config: a later system message supersedes it -> ignored.
	const h3 = harness(["read", "bash"], [cfg(["read"]), sys(["bash"])]);
	h3.fire(ev);
	assert.deepEqual(sorted(h3.state.active), sorted(["read", "bash"]), `${ev}: stale config ignored`);
	assert.equal(h3.state.applied, 0, `${ev}: no setActiveTools for stale config`);

	// 4. No config, no system message -> no-op.
	const h4 = harness(["read", "codemode", "journal_read"], []);
	h4.fire(ev);
	assert.deepEqual(sorted(h4.state.active), sorted(["read", "codemode", "journal_read"]), `${ev}: no-op without config`);
	assert.equal(h4.state.applied, 0, `${ev}: no setActiveTools without config`);

	// 5. Compaction keeps raw system messages on the branch -> later config still stale.
	const h5 = harness(["read", "journal_read"], [
		sys(["read"]),
		cfg(["read"]),
		sys(["journal_read"]),
		{ type: "compaction", systemMessage: { toolsAdded: [] } },
	]);
	h5.fire(ev);
	assert.deepEqual(sorted(h5.state.active), sorted(["read", "journal_read"]), `${ev}: compaction does not un-stale config`);
	assert.equal(h5.state.applied, 0, `${ev}: no setActiveTools across compaction`);
}

// 6. session_start reasons: startup/new/resume/fork replay; reload does not.
for (const reason of ["startup", "new", "resume", "fork"]) {
	const h = harness(["read", "bash"], [sys(), cfg(["read"])]);
	h.fire("session_start", { reason });
	assert.deepEqual(sorted(h.state.active), ["read"], `session_start/${reason}: unrecorded toggle applied`);
}
const hr = harness(["read", "bash", "journal_read"], [sys(), cfg(["read"])]);
hr.fire("session_start", { reason: "reload" });
assert.deepEqual(sorted(hr.state.active), sorted(["read", "bash", "journal_read"]), "reload: live active set kept");
assert.equal(hr.state.applied, 0, "reload: no setActiveTools");

// 7. Documented limitation: an unrecorded toggle that drops an active tool while
// an MCP tool is still connecting can clear that pending registration. Accepted
// (narrow window; recorded on next request), asserted here so it stays known.
const hp = harness(["read", "bash"], [sys(), cfg(["read", "mcp__x__get"])]);
hp.fire("session_start", { reason: "startup" });
assert.deepEqual(sorted(hp.state.active), sorted(["read", "mcp__x__get"]), "pending: unrecorded snapshot applied as-is");

console.log("tools.test.ts: ok");
