# web-search

State-machine-enforced web search + page extraction for pi. Search backend
(Brave API + Readability extraction, Docker-isolated) is an **implementation
detail** — it ships with this extension in `executors/` and can be swapped
(Docker, Tavily, SearXNG, …) without touching the machine or tools, as long
as the `--json` contract holds.

## Why

Prompt-only workflows rely on soft constraints. This extension puts the
workflow in an XState state machine: budgets, dedupe, known-link rules, and
state ordering are enforced in code, not requested in a prompt. The model
keeps the judgment calls — query formulation, which links to fetch, when
results are sufficient — but can only act via legal machine events.

- **Deterministic (machine-owned):** budgets, retry caps, dedupe, state
  order, truncation, output format
- **Judgment (model-owned, via legal events):** query wording, link
  selection, sufficiency
- **IO (Docker executors):** Brave API, Readability → markdown; API key
  never leaves `pass` + Docker

## Tools

| Tool | Effect |
|---|---|
| `web_search` | Brave search; results tracked (budget: 5 searches) |
| `web_fetch` | Extract markdown for known, unfetched links (budget: 10) |
| `web_report` | End research (requires ≥1 successful search) |
| `web_reset` | Clear state, start over |

`/websearch` (or `/websearch status`) shows state; `/websearch reset` clears it;
`/websearch footer` toggles the live footer line (off by default);
unknown subcommands error. Diagnostics log: `~/.cache/web-search/web-search.log`.

Rejected actions return a normal result explaining why and what is allowed
next — the machine never silently misbehaves.

## Layout

```
web-search/
  index.ts      extension: tools, command, live status, logging
  machine.ts    XState machine: states, guards, events, context
  test.ts       machine tests — no LLM, no network (node test.ts)
  executors/    Docker-wrapped search backend (implementation detail)
    Dockerfile, search.sh, search.js, content.sh, content.js
```

## Executor contract (`executors/`)

- `search.sh <query> [-n N] [--country CC] [--freshness P] --json`
  → stdout: JSON array of `{title, link, snippet, age}`
- `content.sh <url> --json`
  → stdout: `{link, title, markdown}` or `{link, error}` (exit 0 — failures
  are data)
- Unparseable output is a hard error in the extension — never misclassified
  as "no results".
- API key: `pass brave-search/api-key/pi` → env → Docker. Never in this
  process, image, or session.

Swap the backend by replacing `executors/` scripts; keep the contract.

## Machine

`idle → researching → done`, with `RESET → idle` from researching/done.
Full control flow lives in `machine.ts`; paste the `createMachine({...})`
config into [Stately Studio](https://stately.ai) to visualize.

Tool-result `details` carry the persisted machine snapshot (fetched markdown
bodies stripped — transcript already holds content), so research state follows
the conversation branch (rewind/branch-safe; reconstructed on
`session_start`/`session_tree`).

Live status in the TUI footer via `ctx.ui.setStatus` + `actor.subscribe` —
opt-in (`/websearch footer`), off by default.

## Config (env)

- `WEB_SEARCH_MAX_SEARCHES` (default 5)
- `WEB_SEARCH_MAX_SEARCH_ATTEMPTS` (default 8, failed searches don't consume search budget)
- `WEB_SEARCH_MAX_FETCHES` (default 10)
- `WEB_SEARCH_CONTENT_TRUNCATE` (default 5000 chars/page)
- `WEB_SEARCH_SCRIPT_TIMEOUT_MS` (default 120000)
- `WEB_SEARCH_EXEC_DIR` (default this extension's `executors/`)
- `WEB_SEARCH_LOG_DIR` (default `~/.cache/web-search`)
