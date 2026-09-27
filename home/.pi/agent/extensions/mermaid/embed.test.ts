/**
 * Embed executor tests — run without an LLM, Docker, or a machine:
 *   node embed.test.ts
 * (machine tests live in test.ts)
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedBlock, markerPath, svgPathFor } from "./embed.ts";

const DIR = mkdtempSync(join(tmpdir(), "mermaid-embed-"));

const target = join(DIR, "notes.md");
const sourceAbs = join(DIR, "diagram.mmd");
const content = "flowchart LR\n  A --> B";

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
	await fn();
	passed++;
	console.log(`✓ ${name}`);
}

await ok("markerPath: diagram in the target's dir -> relative path", () => {
	assert.equal(markerPath(target, sourceAbs), "diagram.mmd");
});

await ok("markerPath: diagram in a subdir -> relative path with dir", () => {
	assert.equal(markerPath(target, join(DIR, "docs", "d.mmd")), join("docs", "d.mmd"));
});

await ok("markerPath: diagram outside the target's tree -> basename fallback", () => {
	assert.equal(markerPath(target, "/tmp/elsewhere/diagram.mmd"), "diagram.mmd");
});

await ok("svgPathFor: .mmd swapped for .svg", () => {
	assert.equal(svgPathFor("/a/b/diagram.mmd"), "/a/b/diagram.svg");
	assert.equal(svgPathFor("diagram.MMD"), "diagram.svg");
});

await ok("svgPathFor: other extensions append .svg", () => {
	assert.equal(svgPathFor("/a/b/diagram.txt"), "/a/b/diagram.txt.svg");
});

await ok("embedBlock appends at end (no after), trailing newlines trimmed", async () => {
	writeFileSync(target, "# Notes\n\nSome text.\n", "utf8");
	const r = await embedBlock(target, sourceAbs, `${content}\n\n`);
	assert.equal(r.action, "appended");
	assert.equal(r.marker, "<!-- mermaid: diagram.mmd -->");
	const out = readFileSync(target, "utf8");
	assert.match(out, /# Notes\n\nSome text\.\n\n<!-- mermaid: diagram\.mmd -->\n```mermaid\nflowchart LR\n  A --> B\n```\n$/);
	assert.equal(out.match(/```mermaid/g)?.length, 1);
});

await ok("embedBlock re-embed replaces the marked block in place (idempotent)", async () => {
	const r = await embedBlock(target, sourceAbs, "flowchart LR\n  A --> C");
	assert.equal(r.action, "replaced");
	const out = readFileSync(target, "utf8");
	assert.match(out, /A --> C/);
	assert.doesNotMatch(out, /A --> B/);
	assert.equal(out.match(/<!-- mermaid:/g)?.length, 1);
	assert.equal(out.match(/```mermaid/g)?.length, 1);
});

await ok("embedBlock replaces a legacy absolute-path marker in place", async () => {
	const legacy = `# T\n\n<!-- mermaid: ${sourceAbs} -->\n\`\`\`mermaid\nold\n\`\`\`\n`;
	writeFileSync(target, legacy, "utf8");
	const r = await embedBlock(target, sourceAbs, content);
	assert.equal(r.action, "replaced");
	const out = readFileSync(target, "utf8");
	assert.match(out, /<!-- mermaid: diagram\.mmd -->/);
	assert.doesNotMatch(out, /<!-- mermaid: \/tmp/);
	assert.doesNotMatch(out, /old/);
});

await ok("embedBlock inserts after the LAST line containing the anchor", async () => {
	writeFileSync(target, "# T\nsection A\nx\nsection A\ny\n", "utf8");
	const r = await embedBlock(target, sourceAbs, content, "section A");
	assert.equal(r.action, "inserted");
	const lines = readFileSync(target, "utf8").split("\n");
	const markerIdx = lines.findIndex((l) => l.includes("<!-- mermaid:"));
	const openIdx = lines.findIndex((l) => l.trim() === "```mermaid");
	const anchors = lines.flatMap((l, i) => (l.includes("section A") ? [i] : []));
	assert.equal(anchors.length, 2);
	// blank line + block directly after the LAST anchor (not the first)
	assert.equal(markerIdx, anchors[1]! + 2);
	assert.equal(lines[markerIdx - 1], "");
	assert.equal(lines[markerIdx - 2], "section A");
	assert.ok(openIdx > anchors[1]!);
	// "y" (which followed the last anchor) now comes after the fenced block
	const yIdx = lines.findIndex((l) => l === "y");
	assert.ok(yIdx > openIdx);
});

await ok("embedBlock: missing anchor throws a readable error", async () => {
	writeFileSync(target, "# T\n", "utf8");
	await assert.rejects(embedBlock(target, sourceAbs, content, "no-such-anchor"), /anchor not found/);
});

await ok("embedBlock replaces a stray marker (no fence) in place — no duplicate markers, no growth on re-embed", async () => {
	writeFileSync(target, `# T\n\n<!-- mermaid: diagram.mmd -->\ntext after stray marker\n`, "utf8");
	const r = await embedBlock(target, sourceAbs, content);
	assert.equal(r.action, "replaced");
	let out = readFileSync(target, "utf8");
	assert.equal(out.match(/<!-- mermaid:/g)?.length, 1); // stray line replaced, not kept + duplicated
	assert.equal(out.match(/```mermaid/g)?.length, 1);
	assert.ok(out.includes("text after stray marker"));
	assert.match(out, /# T\n\n<!-- mermaid: diagram\.mmd -->\n```mermaid/);
	// re-embed: still exactly one marker + one fenced block (idempotent)
	await embedBlock(target, sourceAbs, content);
	out = readFileSync(target, "utf8");
	assert.equal(out.match(/<!-- mermaid:/g)?.length, 1);
	assert.equal(out.match(/```mermaid/g)?.length, 1);
});

await ok("embedBlock handles a target without trailing newline", async () => {
	writeFileSync(target, "# T\nno trailing newline", "utf8");
	const r = await embedBlock(target, sourceAbs, content);
	assert.equal(r.action, "appended");
	assert.match(readFileSync(target, "utf8"), /newline\n\n<!-- mermaid:/);
});

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} tests passed`);
