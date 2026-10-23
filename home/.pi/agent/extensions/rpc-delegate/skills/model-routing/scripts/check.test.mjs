#!/usr/bin/env node
/**
 * Telemetry lint tests for check.mjs — run with:
 *   node scripts/check.test.mjs
 *
 * Exercises the soft-key adoption window and the modelSource value domain
 * against a fixture JSONL. The real telemetry log is never touched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check.mjs", import.meta.url));

function baseRow() {
	return {
		ts: "2024-01-01T00:00:00Z",
		source: "rpc-delegate",
		provider: "p",
		model: "m",
		stopReason: "stop",
		artifactOk: true,
		artifactPolicy: "stopReason",
		failureClass: null,
		stallHit: false,
		tokensIn: null,
		tokensOut: null,
		costUsd: null,
		runSecs: null,
		note: "",
	};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-check-test-"));
try {
	const log = path.join(dir, "telemetry.jsonl");
	const rows = [
		baseRow(), // legacy: no modelSource/agent yet
		{ ...baseRow(), modelSource: "pinned", agent: "scout" }, // adoption row
		baseRow(), // post-adoption, both keys missing -> problems
		{ ...baseRow(), modelSource: "bogus", agent: "x" }, // bad domain -> problem
	];
	fs.writeFileSync(log, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

	const res = spawnSync(
		process.execPath,
		[SCRIPT, "--lint", "--telemetry", log],
		{ encoding: "utf8" },
	);
	const out = `${res.stdout}\n${res.stderr}`;

	assert.equal(res.status, 1, `expected lint problems, got status ${res.status}\n${out}`);
	assert.match(out, /missing key\(s\) modelSource/);
	assert.match(out, /modelSource must be "pinned", "registry", or "default" \(got "bogus"\)/);
	// Adoption-window semantics: the legacy first row is summarized, not flagged.
	assert.match(out, /legacy rows .*modelSource=1/);
	console.log("✓ check.mjs: modelSource soft-key adoption + value domain");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
