#!/usr/bin/env node
// Render a Mermaid file as ASCII art using beautiful-mermaid
// Usage: node ascii-preview.mjs <input.mmd>
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// Resolve from local node_modules first, fall back to global
let renderMermaidAscii;
try {
  ({ renderMermaidAscii } = require(path.join('/usr/local/lib/node_modules', 'beautiful-mermaid')));
} catch {
  console.error('ASCII preview failed: beautiful-mermaid not found');
  process.exit(1);
}

const file = process.argv[2];
if (!file) { console.error('Usage: node ascii-preview.mjs <input.mmd>'); process.exit(1); }

const text = fs.readFileSync(file, 'utf8');
try {
  process.stdout.write(renderMermaidAscii(text) + '\n');
} catch (e) {
  console.error('ASCII preview failed:', e.message);
  process.exit(1);
}