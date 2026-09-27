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
- **IO (executors):** `ascii.sh` / `svg.sh` (Docker); file reads + embed
  insertion in `embed.ts`

Render and embed are only legal for the **exact source that last passed
validation** — same path, unchanged content. Editing the diagram invalidates
the pass; re-validate. The workflow tracks one diagram at a time: validating
another diagram switches the tracked source. Embedding is idempotent: the
fenced block carries a `<!-- mermaid: <path> -->` marker; re-embedding
replaces the marked block instead of duplicating it.

## Failure taxonomy

Every DONE failure carries a cause — **diagram** (the source itself: mmdc
parse error) or **infra** (the pipeline around it: Docker build/run, daemon,
IO). The distinction is enforced end to end:

- executor exit codes: `0` success, `1` invalid diagram, `2` infra
  (docker-run rc 125/126/127 and unexpected codes map to 2 inside the
  scripts; usage/file errors are caller-side → 2)
- machine: diagram failures bump the attempt count / clear the pass and go
  to `fixing`; infra failures keep the pass, consume no attempt, and return
  the machine to the state it was in — retry is legal immediately
- tools: an infra failure is reported as "pipeline failed, the diagram was
  NOT checked", never as "invalid diagram"

## Tools

| Tool               | Effect                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `mermaid_validate` | Validate diagram (Docker `ascii.sh`), returns ASCII preview (optional theme); moves to `validated`                                |
| `mermaid_render`   | Render validated source to SVG/PNG (Docker `svg.sh`; format follows outPath); optional theme; opens the file in the system viewer |
| `mermaid_embed`    | Insert fenced mermaid block into Markdown (validated source only); idempotent; optional `after` anchor                            |
| `mermaid_reset`    | Clear state, start over                                                                                                           |

`/mermaid` (or `/mermaid status`) shows state; `/mermaid reset` clears it;
`/mermaid output [mode]` sets what the user sees on validation (picker with
no argument); `/mermaid footer` toggles the live footer line (off by
default); `/mermaid viz` live-visualises the running machine.
Rejected actions return a normal result explaining why and what is allowed
next — derived from the current machine state, never a hardcoded template.
Diagnostics log: `~/.cache/mermaid/mermaid.log`.

### Extension-driven output (`/mermaid output`, persisted)

What the user sees after a successful `mermaid_validate` is a user setting —
never the model's choice. `/mermaid output` (no argument) opens a picker;
`/mermaid output <mode>` sets directly. Selecting a mode previews the side
effect immediately on the last validated diagram (render modes are
machine-gated + lock-serialized like `mermaid_render`; before the first
validate there is nothing to demo). The last selection persists in
`~/.cache/mermaid/output-mode` and is the default for the next session.
`MERMAID_OUTPUT` beats the persisted mode at startup.

| Mode              | On validation                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ascii` (default) | ASCII preview overlay in the TUI — fire-and-forget (j/k/arrows/PgUp/PgDn/g/G scroll; Esc/q/Enter closes), never blocks the tool result or the agent turn         |
| `png-tui`         | render PNG to the preview cache (`~/.cache/mermaid/previews/`, content-hashed), show it inline in the TUI (kitty/iTerm2 images; dim filename fallback otherwise) |
| `svg`             | render SVG next to the diagram, reveal it in Finder/file manager                                                                                                 |
| `png`             | render PNG to the preview cache, reveal it in Finder/file manager (`open -R`)                                                                                    |
| `none`            | no auto-output                                                                                                                                                   |

Auto-renders go through the same machine-gated path as `mermaid_render`
(fresh pass required); the result text records what the user got, so the
model stays in sync. Interactive modes only — print/JSON/RPC sessions skip
auto-output (background; a viewer launch would be a surprise).

**`mermaid_render`** itself renders `.svg` or `.png` (format follows the
outPath extension) and — unless the mode is `none` — opens the file in the
system viewer immediately; the result names what was opened.

## Layout

```
mermaid/
  index.ts      extension: tools, command, footer, logging, tool lock
  machine.ts    XState machine: states, guards, events, context
  embed.ts      Markdown embed executor (pure file IO) + marker/svgPath helpers
  test.ts       machine tests — no LLM, no Docker (node test.ts)
  embed.test.ts embed executor tests — no LLM, no Docker (node embed.test.ts)
  executors/    Docker pipeline (implementation detail, swappable)
    Dockerfile, ascii.sh, svg.sh, entrypoint.sh, ascii-preview.mjs
```

## Executor contract

`ascii.sh [-t theme] diagram.mmd` — exit `0` = valid (ASCII preview on
stdout only; `Validating:` status goes to stderr), `1` = invalid diagram
(parse errors on stderr), `2` = infra error. `svg.sh [-t theme] diagram.mmd
output.svg|output.png` — same exit semantics; mmdc infers the format from
the output extension. Validation is authoritative via mmdc (the
same parser the SVG render uses); the beautiful-mermaid ASCII preview is
best-effort — a preview failure is a stderr note with exit `0`.

Swap the pipeline by replacing `executors/` scripts or pointing
`MERMAID_EXEC_DIR` at a dir honoring the same contract — machine and tools
untouched.

Image: `pi-mermaid-validate:<hash>` where `<hash>` is the content hash of the
executor files — **editing any executor file changes the tag and triggers a
rebuild automatically** (no stale cached image). The first run builds it
(can take minutes — mermaid-cli installs inside Docker). Pin a prebuilt
image with `MERMAID_IMAGE=<name>[:tag]`. To pin the base, use a Dockerfile
digest (`FROM node:22-alpine@sha256:…` — note that unpinned `apk chromium`
can drift under pinned `mermaid-cli@11`; re-run the tests after a rebuild).

## Machine

`drafting → validating → validated → rendering → validated`, with
`validating → fixing` / `rendering → fixing` on diagram failures and
`fixing → validating` as the fix loop. Infra failures return the machine to
its prior state (pass kept). There is no separate `rendered` state —
`context.renders` records render history; after a successful render the
machine is `validated` again, so re-render and embed stay legal. Re-validation
is legal from `validated` (edited or different source). RESET → `drafting`
from anywhere. Full control flow lives in `machine.ts`; paste the
`createMachine({...})` config into [Stately
Studio](https://stately.ai) to visualize, or watch the running machine live:
`/mermaid viz` (port 8082 by default; viz-kit walks to the first free port —
tmux owns 8080, web-browser 8081).

Tool-result `details` carry the persisted machine snapshot (error text
truncated — transcript already holds full output), so diagram state follows
the conversation branch (rewind/branch-safe; reconstructed on
`session_start` / `session_tree`). Tool bodies run under a lock
(`withToolLock`) — concurrent tool calls queue instead of interleaving
BEGIN/DONE events the machine would drop.

Embed markers use the diagram path **relative to the target file's
directory** (portable — no absolute local layout in committed docs;
diagrams outside the target's tree fall back to basename, so same-named
diagrams from different dirs share a marker in one target). Legacy
absolute-path markers still match, so pre-existing embeds keep updating in
place.

## Config (env)

- `MERMAID_MAX_VALIDATE_ATTEMPTS` (default 8, failed validations)
- `MERMAID_SCRIPT_TIMEOUT_MS` (default 180000 — first run builds the Docker
  image, which installs mermaid-cli)
- `MERMAID_ASCII_TRUNCATE` (default 8000 chars)
- `MERMAID_EXEC_DIR` (default this extension's `executors/`)
- `MERMAID_IMAGE` (override the image name; default `pi-mermaid-validate:<content-hash>`)
- `MERMAID_OUTPUT` (output mode on validation: `ascii` | `png-tui` | `svg` | `png` | `none`; beats the persisted `~/.cache/mermaid/output-mode`; `/mermaid output` changes it)
- `MERMAID_THEME` (default theme for auto-renders and `mermaid_render`: default|dark|forest|neutral; default dark)
- `MERMAID_FOOTER` (set to 1 for the live footer line; `/mermaid footer` toggles in-session)
- `MERMAID_LOG_DIR` (default `~/.cache/mermaid`)
- `MERMAID_INSPECT` (set to attach the Stately inspector at session start)
- `MERMAID_INSPECT_PORT` (default 8082)

Numeric values fall back to the default when missing or not an integer.

## Live visualisation (`/mermaid viz`)

Same opt-in model as web-search: the actor is re-created from its persisted
snapshot with the inspector wired, so validated source, attempts, renders,
and embeds carry over exactly. Context streams to Stately's inspector page —
diagram content included; don't use `viz` for private material. The relay
binds all interfaces (package limitation) and stops at session end.
