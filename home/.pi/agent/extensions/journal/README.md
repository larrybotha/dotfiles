# Journal

Machine-driven journalling workflow over a directory-local sqlite db.

- `/journal add` — interactive gather flow (no model round-trips): template
  select → one editor dialog per template step (the user writes the
  content) → free-form tags → save confirm → persist. Every answer is a
  machine event; illegal transitions abort honestly. A cancelled dialog
  **pauses** the flow (answers stay in the machine context, memory-only) —
  rerun `/journal add` to continue where you left off or start over;
  `/journal reset` discards.
- `/journal status` (also bare `/journal`) · `/journal reset` ·
  `/journal list` (recent entries) · `/journal templates`

## Agent tools

| Tool | Role |
|---|---|
| `journal_read` | Query the db: entries (tag/search filters, previews), one entry's full markdown, tag counts, template schemas |
| `journal_template_create` | Write a template schema to the db (strict validation) |
| `journal_link` | Post-hoc many-to-many links between entries |
| `journal_status` / `journal_reset` | Workflow snapshot / abort — discarding answers in progress or a mid-save requires user confirmation; with no UI, blocked. Reset count surfaced in status |

## Storage contract

A completed entry is a **single markdown text field**. Template steps shape
gathering, not storage: a single-step template (the seeded `freeform`)
persists the answer as-is; a multi-step template composes `## {name}`
sections, skipping empty answers. Tags (normalized: trim/lowercase/dedupe),
entry links (m:n, post-hoc only), and the ISO timestamp live in their own
tables.

```
entries(id, content, template_id, created_at)
tags(id, name UNIQUE)  ·  entry_tags(entry_id, tag_id)
entry_links(from_id, to_id)   -- directional rows, read symmetrically
templates(id, name UNIQUE, description, schema_json, created_at)
```

Templates are schemas written as content (`schema_json`:
`{ steps: [{ name, prompt }], defaultTags?: ["work"] }`), validated at
create time and revalidated at load — a hand-edited db row is rejected,
not trusted.

`defaultTags` are suggested, never silently applied: the tags dialog shows
them in the placeholder; **blank input + defaults → one confirm dialog**
(“use this template's default tags?”). Typing your own tags replaces the
defaults without asking.

## Machine

`machine.ts` is pure (no IO; `persistService` stubbed — wired to sqlite via
`machine.provide()` in `index.ts`). One `authoring` state with the ceremony
phase in context, then the pipeline:

```
authoring (phase: null → writing → tagging → reviewing)
  START {template} · STEP_DONE {step, content} · TAGS_DONE {tags}
  APPROVE → persisting (invoke persistService) → done
  persist error → authoring (reviewing; retry legal, capped)
RESET legal anywhere; wins over an in-flight persist
```

## Config

| Env | Default | |
|---|---|---|
| `JOURNAL_DB_PATH` | `journal/tmp/journal.db` (this dir; gitignored via the global `tmp` rule) | sqlite file |
| `JOURNAL_MAX_PERSIST_ATTEMPTS` | 4 | failed-persist retry cap |
| `JOURNAL_SETTLE_TIMEOUT_MS` | 30000 | persist settle backstop |

## Tests

```
node test.ts   # machine (stubbed services) + db (throwaway sqlite file)
```
