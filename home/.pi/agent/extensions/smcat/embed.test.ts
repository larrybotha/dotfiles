/**
 * Embed executor tests — run without an LLM, Docker, or a machine:
 *   node embed.test.ts
 * (machine tests live in test.ts)
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultOutPath,
  embedBlock,
  markerPath,
  svgPathFor,
} from "./embed.ts";

const DIR = mkdtempSync(join(tmpdir(), "smcat-embed-"));

const target = join(DIR, "notes.md");
const sourceAbs = join(DIR, "diagram.smcat");
const content = "initial,\n  a => b;";

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
	await fn();
	passed++;
	console.log(`✓ ${name}`);
}

await ok("markerPath: diagram in the target's dir -> relative path", () => {
	assert.equal(markerPath(target, sourceAbs), "diagram.smcat");
});

await ok("markerPath: diagram in a subdir -> relative path with dir", () => {
	assert.equal(markerPath(target, join(DIR, "docs", "d.smcat")), join("docs", "d.smcat"));
});

await ok("markerPath: diagram outside the target's tree -> basename fallback", () => {
	assert.equal(markerPath(target, "/tmp/elsewhere/diagram.smcat"), "diagram.smcat");
});

await ok("svgPathFor: .smcat swapped for .svg", () => {
	assert.equal(svgPathFor("/a/b/diagram.smcat"), "/a/b/diagram.svg");
	assert.equal(svgPathFor("diagram.SMCAT"), "diagram.svg");
});

await ok("svgPathFor: other extensions append .svg", () => {
	assert.equal(svgPathFor("/a/b/diagram.txt"), "/a/b/diagram.txt.svg");
});

await ok("defaultOutPath: basename + .svg swap into the given dir", () => {
	assert.equal(
		defaultOutPath("/tmp/out", "/proj/diagram.smcat"),
		"/tmp/out/diagram.svg",
	);
	assert.equal(
		defaultOutPath("/tmp/out", "/proj/nested/auth-flow.SMCAT"),
		"/tmp/out/auth-flow.svg",
	);
});

await ok("embedBlock appends at end (no after), trailing newlines trimmed", async () => {
	writeFileSync(target, "# Notes\n\nSome text.\n", "utf8");
	const r = await embedBlock(target, sourceAbs, `${content}\n\n`);
	assert.equal(r.action, "appended");
	assert.equal(r.marker, "<!-- smcat: diagram.smcat -->");
	const out = readFileSync(target, "utf8");
	assert.match(out, /# Notes\n\nSome text\.\n\n<!-- smcat: diagram\.smcat -->\n```smcat\ninitial,\n  a => b;\n```\n$/);
	assert.equal(out.match(/```smcat/g)?.length, 1);
});

await ok("embedBlock re-embed replaces the marked block in place (idempotent)", async () => {
	const r = await embedBlock(target, sourceAbs, "initial,\n  a => c;");
	assert.equal(r.action, "replaced");
	const out = readFileSync(target, "utf8");
	assert.match(out, /a => c/);
	assert.doesNotMatch(out, /a => b/);
	assert.equal(out.match(/<!-- smcat:/g)?.length, 1);
	assert.equal(out.match(/```smcat/g)?.length, 1);
});

await ok("embedBlock replaces an absolute-path marker in place", async () => {
	const absolute = `# T\n\n<!-- smcat: ${sourceAbs} -->\n\`\`\`smcat\nold\n\`\`\`\n`;
	writeFileSync(target, absolute, "utf8");
	const r = await embedBlock(target, sourceAbs, content);
	assert.equal(r.action, "replaced");
	const out = readFileSync(target, "utf8");
	assert.match(out, /<!-- smcat: diagram\.smcat -->/);
	assert.doesNotMatch(out, /<!-- smcat: \/tmp/);
	assert.doesNotMatch(out, /old/);
});

await ok("embedBlock inserts after the LAST line containing the anchor", async () => {
	writeFileSync(target, "# T\nsection A\nx\nsection A\ny\n", "utf8");
	const r = await embedBlock(target, sourceAbs, content, "section A");
	assert.equal(r.action, "inserted");
	const lines = readFileSync(target, "utf8").split("\n");
	const markerIdx = lines.findIndex((l) => l.includes("<!-- smcat:"));
	const openIdx = lines.findIndex((l) => l.trim() === "```smcat");
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
	writeFileSync(target, `# T\n\n<!-- smcat: diagram.smcat -->\ntext after stray marker\n`, "utf8");
	const r = await embedBlock(target, sourceAbs, content);
	assert.equal(r.action, "replaced");
	let out = readFileSync(target, "utf8");
	assert.equal(out.match(/<!-- smcat:/g)?.length, 1); // stray line replaced, not kept + duplicated
	assert.equal(out.match(/```smcat/g)?.length, 1);
	assert.ok(out.includes("text after stray marker"));
	assert.match(out, /# T\n\n<!-- smcat: diagram\.smcat -->\n```smcat/);
	// re-embed: still exactly one marker + one fenced block (idempotent)
	await embedBlock(target, sourceAbs, content);
	out = readFileSync(target, "utf8");
	assert.equal(out.match(/<!-- smcat:/g)?.length, 1);
	assert.equal(out.match(/```smcat/g)?.length, 1);
});

await ok("embedBlock handles a target without trailing newline", async () => {
	writeFileSync(target, "# T\nno trailing newline", "utf8");
	const r = await embedBlock(target, sourceAbs, content);
	assert.equal(r.action, "appended");
	assert.match(readFileSync(target, "utf8"), /newline\n\n<!-- smcat:/);
});

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} tests passed`);
