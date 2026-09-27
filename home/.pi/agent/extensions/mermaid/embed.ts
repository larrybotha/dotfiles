/**
 * Markdown embed executor (pure file IO — no machine, no Docker; unit-tested
 * in embed.test.ts).
 *
 * Marker: `<!-- mermaid: <path> -->` where <path> is the diagram path relative
 * to the TARGET file's directory — portable: no local absolute layout leaked
 * into committed docs. Diagrams outside the target's tree fall back to the
 * basename (same-named diagrams from different dirs then share a marker in
 * one target — accepted, documented). Legacy absolute-path markers still
 * match for replacement so pre-existing embeds keep updating in place.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/** Marker path for `sourcePath` relative to `target`: rel path, or basename outside the tree. */
export function markerPath(target: string, sourcePath: string): string {
  const rel = relative(dirname(resolve(target)), resolve(sourcePath));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    return basename(sourcePath);
  return rel;
}

/** Default SVG output path for a diagram path: swap/append .svg. */
export function svgPathFor(path: string): string {
  return /\.mmd$/i.test(path) ? path.replace(/\.mmd$/i, ".svg") : `${path}.svg`;
}

export type EmbedAction = "replaced" | "appended" | "inserted";

/**
 * Insert (or replace) the fenced mermaid block for `sourcePath` in `target`.
 * Idempotent: a block with the same `<!-- mermaid: ... -->` marker (current
 * relative form or legacy absolute form) is replaced in place, not
 * duplicated. Without `after`, appends at end of file; with it, inserts
 * after the last line containing the anchor text.
 */
export async function embedBlock(
  target: string,
  sourcePath: string,
  content: string,
  after?: string,
): Promise<{ action: EmbedAction; marker: string }> {
  const raw = await readFile(target, "utf8");
  const lines = raw.split("\n");
  const marker = `<!-- mermaid: ${markerPath(target, sourcePath)} -->`;
  const legacy = `<!-- mermaid: ${sourcePath} -->`;
  const block = [
    marker,
    "```mermaid",
    ...content.replace(/\n+$/, "").split("\n"),
    "```",
  ];

  // Replace an existing block with the same marker (marker ... closing fence).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line !== marker && line !== legacy) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j < lines.length && lines[j].trim() === "```mermaid") {
      let k = j + 1;
      while (k < lines.length && lines[k].trim() !== "```") k++;
      if (k < lines.length) {
        lines.splice(i, k - i + 1, ...block);
        await writeFile(target, lines.join("\n"));
        return { action: "replaced", marker };
      }
    }
    // Stray marker without a following fence (hand-corrupted block): replace
    // the marker line itself, in place — falling through to insert/append
    // would leave the stray behind and duplicate markers on every embed.
    lines.splice(i, 1, ...block);
    await writeFile(target, lines.join("\n"));
    return { action: "replaced", marker };
  }

  // Insert after the last line containing the anchor text.
  if (after) {
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(after)) at = i;
    }
    if (at === -1) {
      throw new Error(
        `anchor not found in target: no line contains "${after}"`,
      );
    }
    lines.splice(at + 1, 0, "", ...block);
    await writeFile(target, lines.join("\n"));
    return { action: "inserted", marker };
  }

  // Append at end of file.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push("", ...block, "");
  await writeFile(target, lines.join("\n"));
  return { action: "appended", marker };
}
