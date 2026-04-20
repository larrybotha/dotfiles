---
name: mermaid
description: "Validate, render, and preview Mermaid diagrams. Outputs dark-themed SVG and ASCII art. Use when creating, editing, or verifying Mermaid syntax for flowcharts, ER diagrams, sequence diagrams, and other chart types."
license: Apache-2.0
metadata:
  author: aretw0
  version: "1.3.0"
compatibility: "Requires Docker with internet access for first-run image build"
---

# Mermaid

Validate Mermaid diagrams by parsing and rendering them with the official Mermaid CLI inside a Docker container (Alpine + Chromium). Outputs SVG (dark-themed by default) and an ASCII preview.

## Validate a diagram

```bash
./scripts/validate.sh [-t theme] diagram.mmd [output.svg]
```

- `-t theme` — `default`, `dark`, `forest`, or `neutral`. Default: `dark`. Also set via `MERMAID_THEME` env var.
- Non-zero exit = invalid syntax (parse errors printed to stderr).
- If `output.svg` is omitted, SVG is rendered to a temp file and discarded.
- ASCII preview printed to stdout after validation.

## Workflow

1. Draft diagram in a standalone `diagram.mmd` file
2. Run `./scripts/validate.sh diagram.mmd`
3. Fix any errors shown
4. Copy validated Mermaid block into Markdown