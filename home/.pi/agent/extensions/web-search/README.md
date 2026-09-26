# web-search

State-machine-enforced web search + page extraction for pi, wrapping the
[brave-search skill](https://github.com/) (`~/.agents/skills/brave-search`) —
Docker-isolated Brave API + Readability extraction stay unchanged.

## Why

The skill alone relies on prompt instructions (soft constraints). This
extension puts the workflow in an XState state machine: budgets, dedupe,
known-link rules, and state ordering are enforced in code, not requested in
a prompt. The model keeps the judgment calls — query formulation, which
links to fetch, when results are sufficient — but can only act via legal
machine events.

- **Deterministic (machine-owned):** budgets, retry caps, dedupe, state
  order, truncation, output format
- **Judgment (model-owned, via legal events):** query wording, link
  selection, sufficiency
- **IO (Docker via skill scripts):** Brave API, Readability → markdown;
  API key never leaves `pass` + Docker

## Tools

| Tool | Effect |
|---|---|
| `web_search` | Brave search; results tracked (budget: 5 searches) |
| `web_fetch` | Extract markdown for known, unfetched links (budget: 10) |
| `web_report` | End research (requires ≥1 successful search) |
| `web_reset` | Clear state, start over |

`/research` (or `/research status`) shows state; `/research reset` clears it; unknown subcommands error.

Diagnostics log: `~/.cache/web-search/web-search.log` (requests, results, rejections, failures).

Rejected actions return a normal result explaining why and what is allowed
next — the machine never silently misbehaves.

## Config (env)

- `WEB_RESEARCH_MAX_SEARCHES` (default 5)
- `WEB_RESEARCH_MAX_SEARCH_ATTEMPTS` (default 8, failed searches don't consume search budget)
- `WEB_RESEARCH_MAX_FETCHES` (default 10)
- `WEB_RESEARCH_CONTENT_TRUNCATE` (default 5000 chars/page)
- `WEB_RESEARCH_SCRIPT_TIMEOUT_MS` (default 120000)
- `BRAVE_SEARCH_SKILL_DIR` (default `~/.agents/skills/brave-search`)

## Machine

`idle → researching → done`, with `RESET → idle` from researching/done.
Full control flow lives in `machine.ts`; paste into
[Stately Studio](https://stately.ai) to visualize.

Tool-result `details` carry the persisted machine snapshot (fetched markdown
bodies stripped — transcript already holds content), so research state follows
the conversation branch (rewind/branch-safe; reconstructed on
`session_start`/`session_tree`).

## Skill contract

Executors call the brave-search skill scripts with `--json`:
`search.sh <query> --json` → JSON array on stdout; `content.sh <url> --json`
→ `{link,title,markdown}` or `{link,error}` (exit 0). Unparseable output is a
hard error, never misclassified as "no results".

## Test

```
node test.ts
```

12 tests, no LLM required — control flow is testable without the model.
