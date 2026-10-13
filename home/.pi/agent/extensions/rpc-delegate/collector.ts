/**
 * Artifact collector — honest-accounting contract (64-artifact cap
 * enforced by paramsViolation; per-file byte cap; readError flags;
 * relative-to-cwd resolution; truncation marked):
 *
 * - a missing path is `missing` (declared, never produced);
 * - an unreadable path (EISDIR/EACCES/…) is `readError` — counted like
 *   missing, never fake content;
 * - oversized content is truncated and marked;
 * - failure-as-data: read errors become entries, never thrown errors.
 *
 * Pure TS (no executor subprocess): collection runs in-process against the
 * parent's filesystem — the child wrote its artifacts there before the
 * machine reached `collecting`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactEntry } from "./machine.ts";

const DEFAULT_MAX_BYTES = 50 * 1024;

export function collectArtifacts(
	artifactPaths: string[],
	workingDir: string,
	maxBytes: number = Number(process.env.RPC_DELEGATE_MAX_ARTIFACT_SIZE ?? DEFAULT_MAX_BYTES),
): ArtifactEntry[] {
	const artifacts: ArtifactEntry[] = [];
	for (const p of artifactPaths) {
		const fullPath = path.isAbsolute(p) ? p : path.join(workingDir, p);
		try {
			if (!fs.existsSync(fullPath)) {
				artifacts.push({ path: p, content: "", missing: true });
				continue;
			}
			const raw = fs.readFileSync(fullPath, "utf-8");
			if (raw.length <= maxBytes) {
				artifacts.push({ path: p, content: raw, missing: false });
			} else {
				artifacts.push({
					path: p,
					content: raw.slice(0, maxBytes) + "\n… [truncated]",
					missing: false,
					truncated: true,
				});
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			artifacts.push({ path: p, content: "", missing: false, readError: msg });
		}
	}
	return artifacts;
}
