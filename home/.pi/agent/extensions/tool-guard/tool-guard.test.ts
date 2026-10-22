/**
 * tool-guard.ts tests — no LLM needed:
 *   node tool-guard/tool-guard.test.ts
 */
import assert from "node:assert/strict";
import toolGuardExtension from "../tool-guard.ts";

type Result = { block?: boolean; reason?: string } | void;

function harness() {
	let handler: ((event: Record<string, unknown>) => Result) | undefined;
	const pi = {
		on: (ev: string, h: (event: Record<string, unknown>) => Result) => {
			if (ev === "tool_call") handler = h;
		},
	};
	toolGuardExtension(pi as never);
	return (event: Record<string, unknown>) => handler?.(event);
}

const fire = harness();
const nested = (toolName: string) => ({
	type: "tool_call",
	toolName,
	toolCallId: "p/1",
	parentToolCallId: "p",
	input: {},
});
const top = (toolName: string) => ({ type: "tool_call", toolName, toolCallId: "t", input: {} });

// Nested human-facing calls are blocked with a reason.
for (const name of ["browser_pick", "browser_annotate"]) {
	const r = fire(nested(name)) as Exclude<Result, void>;
	assert.equal(r?.block, true, `nested ${name} blocked`);
	assert.match(r?.reason ?? "", /interactive/, `nested ${name} reason mentions interactive`);
}

// Top-level calls are untouched.
assert.equal(fire(top("browser_pick")), undefined, "top-level browser_pick allowed");
assert.equal(fire(top("browser_annotate")), undefined, "top-level browser_annotate allowed");

// Nested non-human tools are untouched.
for (const name of ["web_search", "tmux_capture", "journal_template_create", "read"]) {
	assert.equal(fire(nested(name)), undefined, `nested ${name} allowed`);
}

console.log("tool-guard.test.ts: ok");
