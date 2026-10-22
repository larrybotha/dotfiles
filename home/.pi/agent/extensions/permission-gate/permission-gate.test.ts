/**
 * permission-gate.ts tests — no LLM needed:
 *   node permission-gate/permission-gate.test.ts
 */
import assert from "node:assert/strict";
import permissionGate from "../permission-gate.ts";

type Result = { block?: boolean; reason?: string } | void;

function harness(opts: { hasUI: boolean; choice?: string }) {
	let handler: ((event: Record<string, unknown>, ctx: unknown) => Promise<Result>) | undefined;
	let selectCalls = 0;
	const pi = {
		on: (ev: string, h: (event: Record<string, unknown>, ctx: unknown) => Promise<Result>) => {
			if (ev === "tool_call") handler = h;
		},
	};
	permissionGate(pi as never);
	const ctx = {
		hasUI: opts.hasUI,
		ui: {
			select: async () => {
				selectCalls++;
				return opts.choice;
			},
		},
	};
	return {
		selectCalls: () => selectCalls,
		fire: (event: Record<string, unknown>) => handler?.(event, ctx),
	};
}

const top = (command: string) => ({ type: "tool_call", toolName: "bash", toolCallId: "t", input: { command } });
const nested = (command: string) => ({
	type: "tool_call",
	toolName: "bash",
	toolCallId: "p/1",
	parentToolCallId: "p",
	input: { command },
});

// Nested dangerous commands are blocked without prompting.
{
	const h = harness({ hasUI: true, choice: "Yes" });
	const r = (await h.fire(nested("rm -rf /tmp/x"))) as Exclude<Result, void>;
	assert.equal(r?.block, true, "nested dangerous blocked");
	assert.match(r?.reason ?? "", /script/, "nested reason mentions script");
	assert.equal(h.selectCalls(), 0, "nested dangerous does not prompt");
}

// Nested safe commands pass.
{
	const h = harness({ hasUI: true });
	assert.equal(await h.fire(nested("ls -la")), undefined, "nested safe allowed");
}

// Top-level dangerous with UI: user Yes -> allowed, user No -> blocked.
{
	const yes = harness({ hasUI: true, choice: "Yes" });
	assert.equal(await yes.fire(top("sudo ls")), undefined, "top-level dangerous allowed on Yes");
	assert.equal(yes.selectCalls(), 1, "top-level dangerous prompts");

	const no = harness({ hasUI: true, choice: "No" });
	const r = (await no.fire(top("sudo ls"))) as Exclude<Result, void>;
	assert.equal(r?.block, true, "top-level dangerous blocked on No");
}

// Top-level dangerous without UI is blocked by default.
{
	const h = harness({ hasUI: false });
	const r = (await h.fire(top("rm -rf /tmp/x"))) as Exclude<Result, void>;
	assert.equal(r?.block, true, "top-level dangerous blocked without UI");
	assert.equal(h.selectCalls(), 0, "no prompt without UI");
}

console.log("permission-gate.test.ts: ok");
