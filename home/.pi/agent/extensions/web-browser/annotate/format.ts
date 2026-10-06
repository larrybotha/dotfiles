/**
 * Annotation result → markdown.
 *
 * Screenshot payloads never cross this boundary — the executor
 * (executors/annotate.js) writes PNGs to tmpdir and passes file paths in
 * `files`; the formatter prints paths only.
 *
 * Derived from pi-annotate (https://github.com/nicobailon/pi-annotate),
 * MIT License, © Nico Bailon.
 */
import type {
  AnnotationResult,
  EditCapture,
  ElementSelection,
} from "./types.ts";

export interface AnnotationFiles {
  /** Full-page screenshot path (full mode). */
  full?: string;
  /** Element screenshot paths, 1-based index matching element numbers. */
  elements?: { index: number; path: string }[];
  /** Edit-capture before/after screenshot paths. */
  before?: string;
  after?: string;
}

function formatEditCapture(capture: EditCapture): string {
  let output = "";

  if (capture.warnings?.length) {
    for (const w of capture.warnings) {
      output += `> **Note:** ${w}\n`;
    }
    output += "\n";
  }

  if (capture.inlineStyles.length > 0) {
    output += `### Inline Style Changes\n\n`;
    for (const change of capture.inlineStyles) {
      output += `**\`${change.selector}\`**\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  if (capture.rules.length > 0) {
    output += `### CSS Rule Changes\n\n`;
    for (const change of capture.rules) {
      output += `**\`${change.ruleSelector}\`** (${change.sheet})\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  if (capture.dom.length > 0) {
    output += `### DOM Changes\n\n`;
    for (const change of capture.dom) {
      output += `- **\`${change.selector}\`** — ${change.detail}\n`;
    }
    output += "\n";
  }

  return output;
}

export function formatResult(
  result: AnnotationResult,
  files: AnnotationFiles = {},
): string {
  if (!result.success) {
    if (result.cancelled) {
      if (result.reason?.includes("Another terminal")) {
        return `Annotation session ended: ${result.reason}`;
      }
      if (result.reason && result.reason !== "user") {
        return `Annotation cancelled: ${result.reason}`;
      }
      return "Annotation cancelled by user.";
    }
    return `Annotation failed: ${result.reason || "Unknown error"}`;
  }

  let output = `## Page Annotation: ${result.url || "Unknown"}\n`;
  if (result.viewport) {
    output += `**Viewport:** ${result.viewport.width}×${result.viewport.height}\n\n`;
  }

  if (result.prompt) {
    output += `**Context:** ${result.prompt}\n\n`;
  }

  const hasDebugData = result.elements?.some(
    (el) => el.computedStyles || el.parentContext || el.cssVariables,
  );
  if (hasDebugData) {
    output += `**Debug Mode:** Enabled\n\n`;
  }

  if (result.elements && result.elements.length > 0) {
    output += `### Selected Elements (${result.elements.length})\n\n`;
    result.elements.forEach((el: ElementSelection, i) => {
      output += `${i + 1}. **${el.tag}**\n`;
      output += `   - Selector: \`${el.selector}\`\n`;
      if (el.id) output += `   - ID: \`${el.id}\`\n`;
      if (el.classes?.length) {
        output += `   - Classes: ${el.classes.join(", ")}\n`;
      }
      if (el.text) {
        output += `   - Text: "${el.text}"\n`;
      }

      if (el.boxModel) {
        const bm = el.boxModel;
        const padStr = `${bm.padding.top} ${bm.padding.right} ${bm.padding.bottom} ${bm.padding.left}`;
        const borderStr =
          bm.border.top || bm.border.right || bm.border.bottom || bm.border.left
            ? `${bm.border.top} ${bm.border.right} ${bm.border.bottom} ${bm.border.left}`
            : "0";
        const marginStr = `${bm.margin.top} ${bm.margin.right} ${bm.margin.bottom} ${bm.margin.left}`;
        output += `   - **Box Model:** ${el.rect.width}×${el.rect.height} (content: ${bm.content.width}×${bm.content.height}, padding: ${padStr}, border: ${borderStr}, margin: ${marginStr})\n`;
      } else {
        output += `   - Size: ${el.rect.width}×${el.rect.height}px\n`;
      }

      if (el.attributes && Object.keys(el.attributes).length > 0) {
        const attrStr = Object.entries(el.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(", ");
        output += `   - **Attributes:** ${attrStr}\n`;
      }

      if (el.accessibility) {
        const a11y = el.accessibility;
        const parts: string[] = [];
        if (a11y.role) parts.push(`role=${a11y.role}`);
        if (a11y.name) parts.push(`name="${a11y.name}"`);
        parts.push(`focusable=${a11y.focusable}`);
        parts.push(`disabled=${a11y.disabled}`);
        if (a11y.expanded !== undefined) parts.push(`expanded=${a11y.expanded}`);
        if (a11y.pressed !== undefined) parts.push(`pressed=${a11y.pressed}`);
        if (a11y.checked !== undefined) parts.push(`checked=${a11y.checked}`);
        if (a11y.selected !== undefined) parts.push(`selected=${a11y.selected}`);
        if (a11y.description) {
          parts.push(`description="${a11y.description}"`);
        }
        output += `   - **Accessibility:** ${parts.join(", ")}\n`;
      }

      const hasComputedStyles =
        el.computedStyles && Object.keys(el.computedStyles).length > 0;
      if (
        !hasComputedStyles &&
        el.keyStyles &&
        Object.keys(el.keyStyles).length > 0
      ) {
        const styleStr = Object.entries(el.keyStyles)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        output += `   - **Styles:** ${styleStr}\n`;
      }

      if (el.comment) {
        output += `   - **Comment:** ${el.comment}\n`;
      }

      if (el.computedStyles && Object.keys(el.computedStyles).length > 0) {
        output += `   - **Computed Styles:**\n`;
        for (const [key, value] of Object.entries(el.computedStyles)) {
          output += `     - ${key}: ${value}\n`;
        }
      }

      if (el.parentContext) {
        const pc = el.parentContext;
        const pcLabel = pc.id
          ? `${pc.tag}#${pc.id}`
          : `${pc.tag}${pc.classes[0] ? "." + pc.classes[0] : ""}`;
        const pcStyles = Object.entries(pc.styles)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        output += `   - **Parent Context:** ${pcLabel} (${pcStyles})\n`;
      }

      if (el.cssVariables && Object.keys(el.cssVariables).length > 0) {
        output += `   - **CSS Variables:**\n`;
        for (const [name, value] of Object.entries(el.cssVariables)) {
          output += `     - ${name}: ${value}\n`;
        }
      }

      output += `\n`;
    });
  } else {
    output += "*No elements selected*\n\n";
  }

  if (files.full) {
    output += `**Screenshot (full page):** ${files.full}\n`;
  }

  if (files.elements && files.elements.length > 0) {
    output += `### Screenshots\n\n`;
    for (const shot of files.elements) {
      output += `- Element ${shot.index}: ${shot.path}\n`;
    }
    output += "\n";
  }

  if (result.editCapture && result.editCapture.changeCount > 0) {
    const ec = result.editCapture;
    output += `## Edit Capture (${ec.changeCount} changes, ${Math.round(ec.duration / 1000)}s)\n\n`;
    output += formatEditCapture(ec);

    if (files.before || files.after) {
      output += `### Before/After Screenshots\n\n`;
      if (files.before) output += `- Before: ${files.before}\n`;
      if (files.after) output += `- After: ${files.after}\n`;
      output += "\n";
    }
  }

  return output;
}
