# mermaid

State-machine-enforced Mermaid diagram workflow for pi: validate-gated
rendering and embedding. The Docker render pipeline (mmdc + beautiful-mermaid)
ships with this extension in `executors/` — a swappable implementation detail
like web-search's backend; the workflow itself lives in an XState machine.

## Why

Prompt-only workflows rely on soft constraints ("validate before you
render"). This extension puts the workflow in the machine:

- **Deterministic (machine-owned):** validation-first rule, source freshness
  (path + content hash), fix-loop attempt cap, state order, idempotent
  re-embed (same source marker replaced)
- **Judgment (model-owned, via legal events):** diagram wording, where to
  embed, whether SVG is wanted
- **IO (executors):** skill's `ascii.sh` / `svg.sh` (Docker); file reads +
  embed insertion in `index.ts`

Render and embed are only legal for the **exact source that last passed
validation** — same path, unchanged content. Editing the diagram invalidates
the pass; re-validate. Embedding is idempotent: the fenced block carries a
`<!-- mermaid: <path> -->` marker; re-embedding replaces the marked block
instead of duplicating it.

## Tools

| Tool | Effect |
|---|---|
| `mermaid_validate` | Validate diagram (Docker `ascii.sh`), returns ASCII preview; moves to `validated` |
| `mermaid_render` | Render validated source to SVG (Docker `svg.sh`); optional theme |
| `mermaid_embed` | Insert fenced mermaid block into Markdown (validated source only); idempotent; optional `after` anchor |
| `mermaid_reset` | Clear state, start over |

`/mermaid` (or `/mermaid status`) shows state; `/mermaid reset` clears it;
`/mermaid ask` toggles the output prompt on validation (off by default);
`/mermaid footer` toggles the live footer line (off by default);
`/mermaid viz` live-visualises the running machine.
Rejected actions return a normal result explaining why and what is allowed
next — the machine never silently misbehaves.
Diagnostics log: `~/.cache/mermaid/mermaid.log`.

### Output prompt (`/mermaid ask`)

Opt-in (or `MERMAID_ASK_OUTPUT=1`): on a successful `mermaid_validate`, the
extension asks the user — ASCII preview only, or build the SVG and open it.
The user's output-format judgment replaces the model's; the render still
goes through the same machine-gated path (`BEGIN_RENDER → svg.sh →
RENDER_DONE`, guard passes for the just-validated source), then `open`/
`xdg-open` shows it. The tool blocks while the user picks (Esc = skip,
default flow); the tool result names the user's choice, so the model sees
the decision. TUI only — non-interactive sessions skip the prompt.

## Layout

```
mermaid/
  index.ts    extension: tools, command, footer, logging, embed executor
  machine.ts  XState machine: states, guards, events, context
  test.ts     machine tests — no LLM, no Docker (node test.ts)
  executors/  Docker pipeline (implementation detail, swappable)
    Dockerfile, ascii.sh, svg.sh, entrypoint.sh, ascii-preview.mjs
```

Executor contract: `ascii.sh diagram.mmd` exit 0 = valid (ASCII preview on
stdout — authoritative mmdc parse gates it, lenient beautiful-mermaid renders
the preview), non-zero = invalid (parse errors on stderr). `svg.sh [-t theme]
diagram.mmd output.svg` same exit semantics. Swap the pipeline by replacing
`executors/` scripts or pointing `MERMAID_EXEC_DIR` at a dir honoring the
same contract — machine and tools untouched. Image: `pi-mermaid-validate`
(built on first run; rebuild after editing executor files with `docker build
t pi-mermaid-validate ~/.pi/agent/extensions/mermaid/executors`).

## Machine

`drafting → validating → validated → rendering → rendered`, with
`validating → fixing` / `rendering → fixing` on failure and `fixing →
validating` as the fix loop. Re-validation is legal from `validated` /
`rendered` (edited or different source). RESET → `drafting` from anywhere.
Full control flow lives in `machine.ts`; paste the `createMachine({...})`
config into [Stately Studio](https://stately.ai) to visualize, or watch the
running machine live: `/mermaid viz` (port 8082 by default; viz-kit walks to
the first free port — tmux owns 8080, web-browser 8081).

Tool-result `details` carry the persisted machine snapshot (error text
truncated — transcript already holds full output), so diagram state follows
the conversation branch (rewind/branch-safe; reconstructed on
`session_start` / `session_tree`).

## Config (env)

- `MERMAID_MAX_VALIDATE_ATTEMPTS` (default 8, failed validations)
- `MERMAID_SCRIPT_TIMEOUT_MS` (default 180000 — first run builds the Docker
  image, which installs mermaid-cli)
- `MERMAID_ASCII_TRUNCATE` (default 8000 chars)
- `MERMAID_EXEC_DIR` (default this extension's `executors/`)
- `MERMAID_ASK_OUTPUT` (set to 1 for the output prompt on validation; `/mermaid ask` toggles in-session)
- `MERMAID_LOG_DIR` (default `~/.cache/mermaid`)
- `MERMAID_INSPECT` (set to attach the Stately inspector at session start)
- `MERMAID_INSPECT_PORT` (default 8082)

## Live visualisation (`/mermaid viz`)

Same opt-in model as web-search: the actor is re-created from its persisted
snapshot with the inspector wired, so validated source, attempts, renders,
and embeds carry over exactly. Context streams to Stately's inspector page —
diagram content included; don't use `viz` for private material. The relay
binds all interfaces (package limitation) and stops at session end.
