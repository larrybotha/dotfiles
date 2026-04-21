#!/usr/bin/env node
// Render a Mermaid file as ASCII art using beautiful-mermaid.
// Usage: node ascii-preview.mjs [--theme theme] <input.mmd>
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const globalModules = "/usr/local/lib/node_modules";
let bm;
try {
  bm = require("beautiful-mermaid");
} catch {
  bm = require(`${globalModules}/beautiful-mermaid`);
}
const { renderMermaidASCII } = bm;

const args = process.argv.slice(2);
let theme = "dark";
let file = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--theme" && args[i + 1]) {
    theme = args[++i];
  } else if (!file) {
    file = args[i];
  }
}

if (!file) {
  console.error("Usage: node ascii-preview.mjs [--theme theme] <input.mmd>");
  process.exit(1);
}

const text = fs.readFileSync(file, "utf8");
try {
  process.stdout.write(renderMermaidASCII(text, { theme }) + "\n");
} catch (e) {
  console.error("ASCII render failed:", e.message);
  process.exit(1);
}

