# smcat

State-machine-enforced [state-machine-cat](https://state-machine-cat.js.org/)
(`.smcat`) diagram workflow for pi: validate-gated rendering and embedding.
The Docker pipeline (native Graphviz + `state-machine-cat`) ships with this
extension in `executors/` — a swappable implementation detail like
web-search's backend; the workflow itself lives in an XState machine.

## Why

Prompt-only workflows rely on soft constraints ("validate before you
render"). This extension puts the workflow in the machine:

- **Deterministic (machine-owned):** validation-first rule, source freshness
  (path + content hash), fix-loop attempt cap, state order, idempotent
  re-embed (same source marker replaced)
- **Judgment (model-owned, via legal events):** diagram wording, layout
  direction, where to embed, whether an image is wanted, output format via
  `outPath`
- **IO (executors):** `text.sh` / `svg.sh` (Docker); file reads + embed
  insertion in `embed.ts`

Render and embed are only legal for the **exact source that last passed
validation** — same path, unchanged content. Editing the diagram invalidates
the pass; re-validate. The workflow tracks one diagram at a time: validating
another diagram switches the tracked source. Embedding is idempotent: the
fenced block carries a `<!-- smcat: <path> -->` marker; re-embedding
replaces the marked block instead of duplicating it.

## DSL reference

Full reference: `docs/smcat-language.md`.

Statements end with `;`. Declarations are separated by `,` (also allowed
inside a state declaration). `#` starts a comment to end of line. Both `=>`
and `->` are transition operators.

```smcat
# comment
initial => idle;
idle => running: start;
running => paused: pause;
paused => running: resume;
running => done: finish;
done => final;
```

States are declared implicitly by appearing in a transition. Explicit
declaration adds attributes and/or an activity body. All declarations form
one comma-separated statement terminated by `;`; multiple declaration
statements are a syntax error.

```smcat
# state attributes + entry/exit activities + display names, one statement
doing:
  entry/ make a feature branch
  exit/ deploy code
  ...,
on [label="Lamp aan"],
off [label="Lamp uit"],
eat   [color="#008800"],
sleep [color="blue" active],
initialized [color="red" type=regular],
meow  [class="dismissed"];
```

Transition attributes go **before** the `:` label:

```smcat
sleep -> meow [color="red"]            : wake up;
meow  -> play [color="purple"]         : human gives toy;
eat   -> sleep [color="blue" width=3.5] : belly full;
playing => playing [type=internal]     : ingest drink;
a => b [class="a bunch of classes"];
```

Labels follow UML notation `from => to: event [conditions]/ actions`;
smcat records the split but does not validate the convention.

State type is derived from the name (`initial`, `final`, `history`, `choice`,
`fork`, `join`, `junction`, `parallel`, `terminate`, …) and can be overridden
with `type=`. Values: `regular`, `initial`, `final`, `history`, `deephistory`,
`choice`, `fork`, `join`, `forkjoin`, `junction`, `parallel`, `terminate`.

A state name containing `;`, `,`, `{`, `[` or a space is quoted: `"a state"`.

Caveats:

- All state declarations form one comma-separated statement; a second
  declaration statement is a syntax error.
- State declarations precede transition statements; a declaration after a
  transition is a syntax error.
- `initial` and `final` are state **names**, not modifiers.
- `direction` (`top-down|bottom-top|left-right|right-left`) changes layout
  only; it is not part of the source hash — the same validated bytes may be
  rendered in either direction.
- `svg`/`dot` are pure-node outputs; `png`/`pdf` require native Graphviz
  (present in the image).
- `color`, `width` and `class` are experimental upstream; renderer support
  varies by output type.

Syntax is pinned to `state-machine-cat@15.0.10` (the Docker image
`executors/Dockerfile` installs). `SMCAT_IMAGE` can point at a different
build, whose grammar may differ.

## Failure taxonomy

Every failure carries a cause — **diagram** (the source itself: smcat parse
error) or **infra** (the pipeline around it: Docker build/run, daemon, IO).
Validate failures carry it on `VALIDATE_DONE`; render/embed failures throw
`{ errors, cause }` from the invoked service (the machine's `failureOf`
normalizes it). The distinction is enforced end to end:

- executor exit codes: `0` success, `1` invalid diagram, `2` infra
  (docker-run rc 125/126/127 and unexpected codes map to 2 inside the
  scripts; usage/file errors and unsupported output extensions are
  caller-side → 2)
- machine: diagram failures bump the attempt count (failed validations AND
  diagram-failed renders — the render fix loop gets the same flail stop; the
  count is a cumulative session budget: successes never decay, or a
  validate-ok between render failures would reset it) / clear the pass and
  go to `drafting`; infra failures keep the pass, consume no attempt, and
  return the machine to its prior state — retry is legal immediately
- tools: an infra failure is reported as "pipeline failed, the diagram was
  NOT checked", never as "invalid diagram"

## Tools

| Tool             | Effect                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smcat_validate` | Validate diagram (Docker `text.sh`), returns the DOT source preview (optional `direction`); moves to `validated`                                                                                                                                                                    |
| `smcat_render`   | Render validated source to SVG/PNG/PDF (Docker `svg.sh`; format follows outPath; **outPath optional — default is the extension's out dir**, `~/.pi/agent/extensions/smcat/tmp/`, never the project cwd); optional `direction`; returns the path — opening/showing it is left to other tools or the user |
| `smcat_embed`    | Insert fenced smcat block into Markdown (validated source only); idempotent; optional `after` anchor                                                                                                                                                                                |
| `smcat_reset`    | Clear state, start over                                                                                                                                                                                                                                                             |

`/smcat` (or `/smcat status`) shows state; `/smcat reset` clears it (reset
count tracked outside the machine, surfaced in status/footer); `/smcat
output [mode]` sets what the user sees on validation (picker with no
argument); `/smcat footer` toggles the live footer line (off by default);
`/smcat viz` live-visualises the running machine.
Rejected actions return a normal result explaining why and what is allowed
next — derived from the current machine state, never a hardcoded template.
Diagnostics log: `~/.cache/smcat/smcat.log`.

### Extension-driven output (`/smcat output`, persisted)

What the user sees after a successful `smcat_validate` is a user setting —
never the model's choice. `/smcat output` (no argument) opens a picker;
`/smcat output <mode>` sets directly. Selecting a mode previews the side
effect immediately on the last validated diagram (render modes are
machine-gated + lock-serialized like `smcat_render`; before the first
validate there is nothing to demo). The last selection persists in
`~/.cache/smcat/output-mode` and is the default for the next session.
`SMCAT_OUTPUT` beats the persisted mode at startup.

| Mode             | On validation                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dot` (default)  | DOT source inline in the tool result — no overlay, no re-run (the preview already rides the tool-result content); compact one-liner + dim `ctrl+e preview` hint, full DOT on expand |
| `png-tui`        | render PNG to the preview cache (`~/.cache/smcat/previews/`, content-hashed), show it inline in the TUI (kitty/iTerm2 images; dim filename fallback otherwise)                        |
| `finder`         | render SVG next to the diagram, reveal it in Finder (macOS `open -R`; non-macOS opens the parent dir) — opening the file stays the user's call                                       |
| `none`           | no auto-output                                                                                                                                                                        |

Auto-renders go through the same machine-gated path as `smcat_render`
(fresh pass required); the result text records what the user got, so the
model stays in sync. Interactive modes only — print/JSON/RPC sessions skip
auto-output (background; Finder/TUI output would be a surprise).

**`smcat_render`** renders `.svg`, `.png`, or `.pdf` (format follows the
outPath extension). **outPath is optional**: omitted, the render lands in
the extension's out dir (`~/.pi/agent/extensions/smcat/tmp/`, svg) — a
deterministic, extension-owned default, so renders never pollute the
project cwd by accident; the model passes outPath only when the render
belongs at a specific location. The result names the output path —
opening/showing the file (browser via another tool, Finder, TUI preview)
is left to other tools or the user; the extension never launches a
browser. `direction` (`top-down|bottom-top|left-right|right-left`) is
optional per call; `SMCAT_DIRECTION` supplies the default.

## Layout

```
smcat/
  index.ts      extension: tools, command, footer, logging, tool lock,
                service wiring (smcatMachine.provide → wiredMachine)
  machine.ts    XState machine: states, guards, events, context, invoked
                render/embed services (typed stubs; wired in index.ts)
  embed.ts      Markdown embed executor (pure file IO) + marker/svgPath helpers
  test.ts       machine tests — no LLM, no Docker, stubbed services
                (node test.ts)
  embed.test.ts embed executor tests — no LLM, no Docker (node embed.test.ts)
  docs/         smcat-language.md — language reference
  executors/    Docker pipeline (implementation detail, swappable)
    Dockerfile, text.sh, svg.sh, entrypoint.sh
```

## Executor contract

`text.sh [-d direction] diagram.smcat` — exit `0` = valid (DOT source on
stdout only; `Validating:` status goes to stderr), `1` = invalid diagram
(parse errors on stderr), `2` = infra error. `svg.sh [-d direction]
diagram.smcat output.svg|output.png|output.pdf` — same exit semantics; the
output format is inferred from the output extension. Validation and render
use the same `smcat` parser/binary, so a source that validates renders.

Swap the pipeline by replacing `executors/` scripts or pointing
`SMCAT_EXEC_DIR` at a dir honoring the same contract — machine and tools
untouched.

Image: `pi-smcat-validate:<hash>` where `<hash>` is the content hash of the
executor files — **editing any executor file changes the tag and triggers a
rebuild automatically** (no stale cached image). The first run builds it
(installs `state-machine-cat@15.0.10` and Graphviz inside Docker; needs
network). Pin a prebuilt image with `SMCAT_IMAGE=<name>[:tag]`. To pin the
base, use a Dockerfile digest (`FROM node:22-alpine@sha256:…`).

## Machine

`drafting → validating → validated → rendering | embedding → validated`,
with `validating → drafting` / `rendering → drafting` on diagram failures and
`drafting → validating` as the fix loop. `drafting` is the
no-validated-diagram state: a fresh start and a failed validation both mean
"no trustworthy diagram, validate next".
Infra failures return the machine to its prior state (pass kept). There is
no separate `rendered` state — `context.renders` records render history;
after a successful render the machine is `validated` again, so re-render
and embed stay legal. Re-validation is legal from `validated` (edited or
different source). RESET → `drafting` from anywhere.

Validate is two-phase (`BEGIN_VALIDATE` → `VALIDATE_DONE`) — the model
round-trip is the point of validate (the tool runs `text.sh` between the
events). Render and embed are machine-driven: `BEGIN_RENDER` / `BEGIN_EMBED`
invoke the wired `renderService` / `embedService` (Docker `svg.sh` /
`embedBlock`) and the machine routes the result; the tools wait for settle
and report from context. Both events carry the validated content — the
render is made from a temp copy of those exact bytes (never a re-read of
the source path), so a disk edit between validation and render cannot leak
into an output reported as the validated diagram. RESET wins over any in-flight action structurally:
leaving a state stops its invoked service and a late result is dropped.
Full control flow lives in `machine.ts`; paste the `createMachine({...})`
config into [Stately
Studio](https://stately.ai) to visualize, or watch the running machine live:
`/smcat viz` (port 8083 by default; viz-kit walks to the first free port).

Tool-result `details` carry the persisted machine snapshot (error text
truncated — transcript already holds full output), so diagram state follows
the conversation branch (rewind/branch-safe; reconstructed on
`session_start` / `session_tree`; a snapshot taken mid-invoke restores and
re-runs the service — render/embed are idempotent, so that is safe). Tool
bodies run under a lock (`withToolLock`) — concurrent tool calls queue
instead of interleaving events the machine would drop.

Embed markers use the diagram path **relative to the target file's
directory** (portable — no absolute local layout in committed docs;
diagrams outside the target's tree fall back to basename, so same-named
diagrams from different dirs share a marker in one target). Absolute-path
markers also match, so embeds carrying one update in place.

## Config (env)

- `SMCAT_MAX_VALIDATE_ATTEMPTS` (default 8, diagram-side failures —
  failed validations + diagram-failed renders; cumulative session budget:
  successes never decay, `smcat_reset` frees)
- `SMCAT_SCRIPT_TIMEOUT_MS` (default 180000 — first run builds the Docker
  image, which installs state-machine-cat + Graphviz)
- `SMCAT_SETTLE_TIMEOUT_MS` (default script timeout + 60s — render/embed
  tool settle wait; past it the tool reports "still in flight")
- `SMCAT_TEXT_TRUNCATE` (default 8000 chars)
- `SMCAT_DIRECTION` (default direction for `smcat_validate` / `smcat_render`
  / auto-output: `top-down` | `bottom-top` | `left-right` | `right-left`)
- `SMCAT_EXEC_DIR` (default this extension's `executors/`)
- `SMCAT_IMAGE` (override the image name; default `pi-smcat-validate:<content-hash>`)
- `SMCAT_OUTPUT` (output mode on validation: `dot` | `png-tui` | `finder` | `none`; beats the persisted `~/.cache/smcat/output-mode`; `/smcat output` changes it)
- `SMCAT_FOOTER` (set to 1 for the live footer line; `/smcat footer` toggles in-session)
- `SMCAT_LOG_DIR` (default `~/.cache/smcat`)
- `SMCAT_INSPECT` (set to attach the Stately inspector at session start)
- `SMCAT_INSPECT_PORT` (default 8083)

Numeric values fall back to the default when missing or not an integer.

## Testing

`node test.ts` (machine behavior, stubbed services — Docker-free) and
`node embed.test.ts` (embed executor, pure file IO). Executor scripts are
not unit-tested; verify manually with a sample `.smcat` file:

```sh
executors/text.sh -d left-right /tmp/diagram.smcat   # exit 0, DOT on stdout
executors/svg.sh  -d left-right /tmp/diagram.smcat /tmp/diagram.svg
```

## Live visualisation (`/smcat viz`)

Same opt-in model as web-search: the actor is re-created from its persisted
snapshot with the inspector wired, so validated source, attempts, renders,
and embeds carry over exactly. Context streams to Stately's inspector page —
diagram content included; don't use `viz` for private material. The relay
binds all interfaces (package limitation) and stops at session end.
