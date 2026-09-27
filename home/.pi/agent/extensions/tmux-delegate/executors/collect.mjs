#!/usr/bin/env node
/**
 * Collect executor — read declared artifact files + stderr. One-line JSON on
 * stdout. Failure-as-data: read errors become artifact entries, never a
 * thrown error.
 *
 * In:  { artifactPaths, workingDir, stderrFile }
 * Out: { ok: true, artifacts: [{path, content, missing, readError?, truncated?}], stderr }
 *    | { ok: false, error }   (only for bad input)
 */
import * as fs from "node:fs";
import * as path from "node:path";

const input = JSON.parse(process.argv[2] ?? "{}");
const out = (o) => process.stdout.write(JSON.stringify(o));

const MAX_ARTIFACT_SIZE = Number(process.env.TMUX_DELEGATE_MAX_ARTIFACT_SIZE ?? 50 * 1024);

if (!Array.isArray(input.artifactPaths) || !input.workingDir || !input.stderrFile) {
	out({ ok: false, error: "collect.mjs: missing artifactPaths/workingDir/stderrFile" });
	process.exit(0);
}

function truncateContent(content, maxBytes) {
	if (content.length <= maxBytes) return { content, truncated: false };
	return { content: content.slice(0, maxBytes) + "\n… [truncated]", truncated: true };
}

const artifacts = [];
for (const p of input.artifactPaths) {
	const fullPath = path.isAbsolute(p) ? p : path.join(input.workingDir, p);
	try {
		if (!fs.existsSync(fullPath)) {
			artifacts.push({ path: p, content: "", missing: true });
		} else {
			const raw = fs.readFileSync(fullPath, "utf-8");
			const { content, truncated } = truncateContent(raw, MAX_ARTIFACT_SIZE);
			artifacts.push({ path: p, content, missing: false, truncated });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// distinct flag — never fake content: counted like missing, rendered ✗
		artifacts.push({ path: p, content: "", missing: false, readError: msg });
	}
}

let stderr = "";
try {
	stderr = fs.readFileSync(input.stderrFile, "utf-8").trim();
} catch {
	/* no stderr file (spawn failed / pi still writing) */
}

out({ ok: true, artifacts, stderr });
