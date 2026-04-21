---
name: mermaid
description: "Validate and render Mermaid diagrams. Defaults to ASCII output. Generates SVG (dark-themed) only when user requests it. All rendering runs in Docker — no host dependencies required. Use when creating, editing, or verifying Mermaid syntax."
license: vibecoded
---

# Mermaid

Validate and render Mermaid diagrams. All rendering runs inside a Docker container — no host dependencies required beyond Docker itself.

## ASCII output (default)

```bash
./scripts/ascii.sh [-t theme] diagram.mmd
```

- `-t theme` — `default`, `dark`, `forest`, or `neutral`. Default: `dark`. Also set via `MERMAID_THEME` env var.
- **Theme has no effect on ASCII output** (colors only apply to SVG). Kept for CLI parity.
- Validates syntax and prints ASCII to stdout.
- Non-zero exit = invalid syntax (errors to stderr).

## SVG output (only when user requests)

```bash
./scripts/svg.sh [-t theme] diagram.mmd output.svg
```

- `-t theme` — same themes. Default: `dark`. Also set via `MERMAID_THEME` env var.
- Non-zero exit = invalid syntax.

## Workflow

1. Draft diagram in a standalone `diagram.mmd` file
2. Run `./scripts/ascii.sh diagram.mmd` — validates and prints ASCII
3. Fix any errors shown
4. If user wants SVG: run `./scripts/svg.sh diagram.mmd diagram.svg`
5. Copy validated Mermaid block into Markdown

## Requirements

- Docker (image `pi-mermaid-validate` built on first run)
- No Node.js, npm, or `beautiful-mermaid` needed on host

