# slide-deck

Machine-driven slide-deck build pipeline for pi: one event carries the deck
content, the machine runs the pipeline autonomously — copy the template,
inject the slides, Docker-validate the output, open the deck. The Docker
validation pipeline (html5lib) ships with this extension in `executors/` —
a swappable implementation detail like web-search's backend; the workflow
itself lives in an XState machine with invoked services.

## Why

The skill was a linear agent-driven pipeline with a single validate gate
and a manual template-copy step — every step a model round-trip, nothing
enforced. This extension puts the pipeline in the machine:

- **Deterministic (machine-owned):** phase order, content prechecks
  (non-empty title/nav/slides, size caps, `.html` output), fix-loop
  attempt cap, state order, service invocation order (build → validate)
- **Judgment (model-owned, via legal events):** slide wording, nav
  structure, category tags, which sources to cite
- **IO (executors):** `build.mjs` (template copy + injection, stdin
  JSON), `validate.sh` (Docker html5lib), browser open (tool-side,
  gated on `done`)

**Invoked services, not two-phase events:** the two-phase pattern
(`BEGIN_X → executor → X_DONE`) exists for model-driven IO; this pipeline
is machine-driven, so XState v5 `fromPromise` services in `building` /
`validating` run it autonomously after one `BEGIN_BUILD`. `machine.ts`
ships typed stubs only; `index.ts` provides the real executors via
`machine.provide()`, tests provide controlled stubs — machine logic stays
IO-free.

## States and tools

```
idle → researching → planning → writing → building → validating → done
                     ↘ fixing (validation failure; BEGIN_BUILD retry loop)
```

The authoring phases are **optional announcements** — the fast path (one
`BEGIN_BUILD` from `idle`) is legal because what needs enforcing is the
pipeline, not the ceremony. `RESET` from any state; in-flight services are
stopped by state exit (late results have no handler and are dropped).

| Tool                | Effect                                                                    |
| ------------------- | ------------------------------------------------------------------------- |
| `slide_deck_start`  | `idle` \| `done` → `researching` (records topic; new deck from `done`)     |
| `slide_deck_research` | `researching` → `planning` (records sources)                            |
| `slide_deck_plan`   | `planning` → `writing` (records planned slide ids)                        |
| `slide_deck_build`  | One event, full content → machine drives build → validate → `done` (opens the deck in the browser); failure lands in `fixing` with readable errors — resubmit fixed content with the same tool |
| `slide_deck_status` | Snapshot + allowed next steps                                             |
| `slide_deck_reset`  | Clear state, start over                                                   |

Output defaults to `decks/{yyyy-mm-dd}-{slug}.html` (the 30 decks retained
from the skill live there; scratch intermediates in `decks/scratch/`).

`/slidedeck` (or `/slidedeck status`) shows state; `/slidedeck reset`
clears; `/slidedeck footer` toggles the live footer line (off by default,
or `SLIDE_DECK_FOOTER=1`); `/slidedeck viz` live-visualises the running
machine (port 8083: tmux 8080, web-browser 8081, mermaid 8082).
Rejected actions return a normal result explaining why and what is allowed
next — derived from the current machine state, never a hardcoded template.
Diagnostics log: `~/.cache/slide-deck/slide-deck.log`.

Tool-result `details` carries the machine snapshot (context slimmed:
sources/plans/errors capped), so deck state follows the conversation
branch.

## Failure taxonomy

Pipeline failures carry a cause — **deck** (the content failed validation)
or **infra** (Docker build/run, template IO; the content was never
checked):

- validate.sh exit codes: `0` valid, `1` invalid deck, `2` infra
  (docker rc 125/126/127 and unexpected codes map to 2 inside the script)
- machine: deck failures record the errors, bump the attempt count
  (capped — `slide_deck_reset` to start over), land in `fixing`; infra
  failures record the errors but burn no attempt — retry is legal
  immediately
- build failures are always infra (the template/IO broke; the content was
  never validated)

## Determinism hardening (what is machine-checked)

**Pre-build fail-fast (machine.ts validators — no Docker roundtrip):**

- nav↔slide 1:1 in both directions, duplicate slide ids / duplicate nav
  targets (regex subset, lenient by design — the DOM check stays
  authoritative)
- plan conformance: when `slide_deck_plan` recorded a plan, every built
  slide id must be in it (trimming allowed; unplanned slides are drift —
  `slide_deck_plan` is legal from planning/writing/fixing to replan)

**Authoritative post-build (validate.py — html5lib DOM truth):**

4. duplicate slide ids / duplicate nav data-slide; every nav-item carries
   `data-slide`
5. every nav-item's `onclick="goToSlide('<slug>')"` argument equals its
   `data-slide` (dead-click prevention — the retained corpus shipped 17
   decks whose nav clicks silently did nothing)
6. per slide: `description` div (present, non-empty, before other content
   blocks), `sources` div with ≥ 1 link, `ext-tag` span. Title-page slides
   (`class="slide slide-title-page"`: hero-icon + subtitle + feature-grid)
   are exempt from description/tag — the subtitle is the what+why
7. tag taxonomy: every `tag-*` class must be one the template CSS defines
   (curated set — safety, tool, command, ui, render, prompt, git, session,
   game, system, provider); adding a colour to the template CSS extends the
   set automatically
8. unknown classes: non-fatal `!` note — classes without CSS render
   unstyled; the drift is surfaced, never invisible (svg subtrees are
   skipped — embedded mermaid output is foreign)

**Silent-overwrite guard (build.mjs + tool layer):** an existing foreign
output file is never replaced without `overwrite: true`; a path this
workflow itself built and validated is implicitly replaceable (the
rebuild-tweaks flow stays free).

Prebuild-rejected content burns no validation attempt (guards reject the
event before the pipeline runs) — only failed Docker validations count.

### Corpus migration (one-time)

The retained decks shipped under a validator that checked almost nothing:
17 of 31 had dead nav clicks (`data-slide="slide-<full-id>"` →
`getElementById('slide-slide-…')` → null). Migration stripped the stray
`slide-` prefix from `data-slide` values and `goToSlide` args in those 17
(backup: `~/.cache/slide-deck/decks-backup-*`). After hardening: 22/31
pass; the 9 remaining failures are genuine content drift (unstyled badge
tag categories, content slides missing description/ext-tag, slides without
source links) — surfaced, not silently shipped.

## Content rules (editorial — prompt-side)

Structural validation is machine-side (validate.py: nav↔slide 1:1, slides
inside `main`, no external deps). The editorial rules stay prompt-side, in
the `slide_deck_build` tool description — same split as the skill had:

- Read `templates/sidebar-deck.html` first — every CSS class, layout, and
  JS hook is there; copy its nesting patterns exactly, invent nothing
- One `<div class="slide" id="slide-<slug>">` per topic; nav items use
  `data-slide="<slug>"` (bare slug; ids carry the `slide-` prefix) with a
  1:1 mapping
- Every slide opens with `<div class="description">` explaining what and
  why, before anything else
- Actionable examples in `<div class="prompts">`; real runnable code in
  `<div class="code-block">` (no ellipsis); 2-4 key takeaways in
  `<div class="key-points">`; category tag
  `<span class="ext-tag tag-<category>">` on every slide
- `<div class="sources">` with at least one `<a href>` link on every
  slide
- No external dependencies of any kind (no CDN, `@import`, Google
  Fonts); no new CSS custom properties; strong highlights the noun, not
  the verb

## Executor contracts

`executors/` (override dir with `SLIDE_DECK_EXEC_DIR`):

- `build.mjs` — JSON on stdin `{title, subtitle, navHtml, slidesHtml,
  outPath}` → one-line JSON on stdout `{ok, outPath, slideCount, bytes}`.
  Template anchors (stable contract): `DECK_TITLE` / `DECK_SUBTITLE`
  placeholders, `<div class="nav-list" id="navList">`,
  `<div class="main" id="mainContent">`. Template path defaults to
  `../templates/sidebar-deck.html` relative to the script (override:
  `SLIDE_DECK_TEMPLATE`)
- `validate.sh OUTPUT.html` — exit `0` valid, `1` invalid deck (readable
  `✗` errors on stdout), `2` infra. Always rebuilds the image (cached
  layers ≈ 1s; a changed validate.py invalidates only its COPY layer —
  the stale-image bug found during migration is closed)
- `validate.py` + `Dockerfile` — html5lib parser (mirrors browser DOM
  construction); checks 1–8 above; data-slide values compare against slide
  ids through the `slide-` prefix (the template's own `goToSlide`
  convention). Needs the template mounted (`SLIDE_DECK_TEMPLATE_PATH`) for
  the class/tag whitelist — validate.sh does the mount

## Env vars

| Var                                 | Default            | Effect                          |
| ----------------------------------- | ------------------ | ------------------------------- |
| `SLIDE_DECK_MAX_VALIDATE_ATTEMPTS`  | 8                  | Failed-validation cap           |
| `SLIDE_DECK_SCRIPT_TIMEOUT_MS`      | 300000             | Per-executor timeout            |
| `SLIDE_DECK_SETTLE_TIMEOUT_MS`      | 2×script + 60s     | Whole-pipeline settle timeout   |
| `SLIDE_DECK_EXEC_DIR`               | `executors/`       | Executor dir (swappable)        |
| `SLIDE_DECK_TEMPLATE`               | `templates/sidebar-deck.html` | Build's template |
| `SLIDE_DECK_TEMPLATE_PATH` (in-container) | `/template/sidebar-deck.html` | Validate's template mount |
| `SLIDE_DECK_DECKS_DIR`              | `decks/`           | Default output dir              |
| `SLIDE_DECK_INSPECT_PORT`           | 8083               | Stately inspector port          |
| `SLIDE_DECK_INSPECT`                | —                  | Attach inspector at session start |
| `SLIDE_DECK_FOOTER`                 | —                  | `1` enables the footer line     |

## Tests

```
node test.ts
```

24 machine tests: phases, fast path, service invocation inputs (evidence
chain: build output → validate input), deck-vs-infra failure routing,
attempt cap + RESET, in-flight illegality, RESET-wins-during-pipeline,
rebuild/new-deck from `done`, unwired-stub guard, nav↔slide prebuild
fast-fail (duplicates/missing/orphan), plan conformance (unplanned
rejected, trimming allowed), replan legality from writing/fixing,
overwrite passthrough into the service input. No Docker, no LLM.
