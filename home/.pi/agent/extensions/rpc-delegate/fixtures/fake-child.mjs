#!/usr/bin/env node
/**
 * Fake RPC child for transport tests — scripted by FAKE_MODE env. Speaks the
 * pi RPC JSONL protocol well enough to exercise RpcTransport: correlated
 * responses, session events, extension-UI requests, protocol violations,
 * floods, oversized records, stderr noise, mid-run death.
 *
 * Manual LF-split stdin reader (same discipline as the transport — the real
 * protocol's U+2028/2029 caveat applies symmetrically).
 */
const MODE = process.env.FAKE_MODE ?? "ok";
const LOG = process.env.FAKE_LOG ?? "";

import * as fs from "node:fs";

const write = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const logLine = (line) => {
	if (LOG) fs.appendFileSync(LOG, line + "\n");
};

// --- command handlers per mode -------------------------------------------------

const reply = (r, overrides = {}) => write({ id: r.id, type: "response", success: true, ...overrides });

const handlers = {
	get_state: (r) => {
		if (MODE === "malformed") {
			reply(r, { data: { sessionId: "fake-session", model: { id: "fake/model" } } });
			process.stdout.write("this is not json\n");
			return;
		}
		if (MODE === "unmatched") {
			reply(r, { data: { sessionId: "fake-session", model: { id: "fake/model" } } });
			write({ id: "bogus-1", type: "response", command: "get_state", success: true, data: {} });
			return;
		}
		reply(r, { data: { sessionId: "fake-session", model: { id: "fake/model" } } });
	},

	prompt: (r) => {
		if (MODE === "handled") {
			reply(r, { data: { disposition: "handled" } });
			return;
		}
		if (MODE === "prompt-rejected") {
			write({ id: r.id, type: "response", command: "prompt", success: false, error: "no model available" });
			return;
		}
		if (MODE === "malformed") {
			// malformed record while the prompt command is still pending
			process.stdout.write("this is not json\n");
			return;
		}
		if (MODE === "parse-no-id") {
			// malformed command failure — no request id (protocol-defined shape)
			write({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
			return;
		}
		if (MODE === "die-mid") {
			// no reply — the pending command must reject on death
			write({ type: "agent_start" });
			process.exit(3);
		}
		if (MODE === "noreply") {
			setTimeout(() => reply(r, { data: { disposition: "started" } }), 400);
			return;
		}
		reply(r, { data: { disposition: "started" } });
		write({ type: "agent_start" });
		if (MODE === "extui") {
			write({
				type: "extension_ui_request",
				id: "ui-1",
				method: "select",
				title: "Pick one",
				timeout: 60000,
			});
			write({ type: "agent_settled" });
			return;
		}
		if (MODE === "flood") {
			for (let i = 0; i < 3000; i++) {
				write({
					type: "message_update",
					usage: { totalTokens: i },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
				});
			}
			for (let i = 0; i < 100; i++) {
				write({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: {} });
				write({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "bash", result: {}, isError: false });
			}
			write({ type: "agent_settled" });
			return;
		}
		if (MODE === "oversized") {
			// one >16MB record without LF: transport must drop it, not die
			const big = JSON.stringify({ type: "noise", blob: "x".repeat(17 * 1024 * 1024) }) + "\n";
			process.stdout.write(big);
			write({ type: "agent_settled" });
			return;
		}
		// ok / stderr
		write({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				stopReason: "stop",
				usage: { totalTokens: 42 },
			},
		});
		write({ type: "agent_settled" });
	},

	steer: (r) => reply(r, { data: { disposition: "queued" } }),

	clear_queue: (r) => reply(r, { data: { steering: [], followUp: [] } }),

	abort: (r) => reply(r, {}),

	get_session_stats: (r) =>
		reply(r, {
			data: { sessionFile: null, tokens: { totalTokens: 4242 }, cost: 0.0123 },
		}),

	export_html: (r) => reply(r, { data: { path: "/tmp/fake-export.html" } }),
};

if (MODE === "stderr") {
	process.stderr.write("warning: some diagnostic noise\n");
	process.stderr.write("error: more noise\n");
}

// --- stdin reader (manual LF split) -------------------------------------------

import { Readable } from "node:stream";

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	const data = buf.length ? Buffer.concat([buf, chunk]) : chunk;
	let start = 0;
	while (true) {
		const idx = data.indexOf(0x0a, start);
		if (idx === -1) break;
		const line = data.subarray(start, idx);
		if (line.length > 0) {
			try {
				const r = JSON.parse(line.toString("utf8"));
				logLine(`cmd:${r.type}`);
				if (r.type === "extension_ui_response") {
					logLine(`ui:${r.id}:${r.cancelled === true ? "cancelled" : "value"}`);
				} else {
					handlers[r.type]?.(r);
				}
			} catch {
				/* ignore our own parse quirks */
			}
		}
		start = idx + 1;
	}
	buf = data.subarray(start);
});

process.stdin.on("end", () => {
	// orderly shutdown path — exit code mirrors the mode
	setTimeout(() => {
		process.exit(MODE === "stderr" ? 1 : 0);
	}, 50);
});
