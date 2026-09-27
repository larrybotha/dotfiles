#!/usr/bin/env node
/**
 * Cleanup executor — unlink temp files, best-effort. One-line JSON on stdout.
 *
 * In:  { files: string[] }
 * Out: { ok: true, removed: number }
 */
import * as fs from "node:fs";

const input = JSON.parse(process.argv[2] ?? "{}");
const out = (o) => process.stdout.write(JSON.stringify(o));

let removed = 0;
for (const f of input.files ?? []) {
	if (typeof f === "string" && f) {
		try {
			fs.unlinkSync(f);
			removed++;
		} catch {
			/* already gone */
		}
	}
}
out({ ok: true, removed });
