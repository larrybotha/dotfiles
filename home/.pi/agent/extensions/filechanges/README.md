# filechanges (pi extension)

Tracks files changed (modified/created) by **pi** via the built-in `edit` and `write` tools.

## Features

- Persistent log (stored in session as custom entries)
- Status line + widget listing changed files
- `/filechanges` overlay to inspect diffs
- `/filechanges-accept` to clear the log (keep files)
- `/filechanges-decline` to revert logged changes (restore original contents / delete created files)

## Usage

1. Reload pi: `/reload`
2. Make changes through pi (using `edit`/`write`)
3. Run:
   - `/filechanges` to inspect
   - `/filechanges-accept` to accept (clear log)
   - `/filechanges-decline` to decline (revert)

### Non-interactive usage

If `ctx.hasUI` is false (print/json mode), accept/decline require explicit confirmation:

- `/filechanges-accept force`
- `/filechanges-decline force`

## Notes

- Only tracks changes performed through `edit` and `write` tools.
- To support “decline”, the extension stores the original file contents (before the first pi change) in the session file as a custom entry.

## Architecture

State-machine enforced (same pattern as the `web-search`/`tmux` extensions):

- `machine.ts` — XState machine owning registry legality: `pending` / `baselines` / `tracked` maps + event order. Guards reject duplicate `toolCallId` starts, orphan results (e.g. a `CLEAR` mid-flight), and orphan recomputes. Pure validators (`startViolation` / `commitViolation` / `recomputeViolation`) are shared between guards and executor prechecks — single source of truth.
- `index.ts` — thin executors: file IO, diffs (via pure helpers in `machine.ts`), session entries, UI. No map is mutated outside machine actions.
- The session custom entries (`filechanges:baseline` / `clear` / `untrack`) are the persisted event log — rebuild on `session_start` / `session_tree` is event replay into a fresh actor, not snapshot restore.
- `test.ts` — machine + validator tests only (no IO). Run: `node test.ts`.

Known-fixed latent bugs from the pre-machine version: `session_switch` / `session_fork` handlers were registered against events that don't exist (rebuild never ran on switch/fork — `session_start` covers those cases: it fires on `startup` / `reload` / `new` / `resume` / `fork`), and `notify(..., "success")` was outside the API's type.
