# tmux-delegate

Delegate tasks to a pi instance running in an isolated tmux session. Results
are read from declared artifact files — not terminal output — keeping the
parent context clean.

## Architecture

State-machine-enforced delegation lifecycle (see `machine.ts`):

```
idle ──BEGIN_DELEGATION──> spawning ──SPAWN_OK──> running ──EXIT_SEEN(0)──> success
                              │                     │──EXIT_SEEN(n)──> error
                              └─SPAWN_FAIL─> error   │──SESSION_DEAD──> error
                                                    │──DEADLINE_HIT─> timeout
                                                    └──KILL─────────> aborted
success/error/timeout/aborted ──COLLECT_DONE──> (same state, artifacts stored)
```

- **Machine owns legality** — event order (begin → spawn → exit/dead/deadline/
  kill → collect), collect-once. The tool result is built from the machine
  snapshot; there is no ad-hoc status enum (`statusOf()` maps state → status).
- **Executors own IO** — `executors/` (plain node scripts, one-line JSON
  contracts, failure-as-data): `spawn.mjs`, `probe.mjs`, `kill.mjs`,
  `collect.mjs`, `cleanup.mjs`. Swap backends by replacing scripts with the
  same contracts.
- **One actor per delegate_task call** — the machine is transient, like the
  call. Nothing persists across calls; monitored sessions are plain tmux
  sessions on `agent.sock` the user attaches to manually.
- **Runner watchdog** — the spawn caller passes `parentPid` + `timeoutSecs`
  (optional, older callers skip it); the runner script embeds a watchdog that
  TERMs the whole process group if the parent pi dies (SIGKILL skips every
  cleanup path) or the grace deadline (timeout + 120s) passes — unmonitored
  delegates never orphan.
- **Honest artifact accounting** — a path that exists but cannot be read
  (EISDIR/EACCES) is flagged `readError`, rendered `✗ … (read error: …)` and
  counted like missing (“Unreadable: …”), never as fake content. Declared
  artifacts cap at 64 (collect payload is bounded). Nonzero exit codes are
  surfaced in the result text (`Exit code: N`), not only structured details.

Improvement over the legacy flow: `SESSION_DEAD` — a session that dies
without writing the signal file (external kill, OOM, bash crash) used to burn
the whole timeout; the probe reports tmux liveness and the machine lands in
`error` with a readable reason instead of `timeout`.

## The tool

```
delegate_task(
  task="What the delegated pi should do",
  artifacts=["path/to/expected/output/file"],
  cwd="/optional/working/dir",
  timeout=300,
  monitor=false,
  agentPrompt="Optional system prompt addition"
)
```

| Param | Required | Default | Purpose |
|---|---|---|---|
| task | Yes | — | What the delegated pi should do. Be specific about expected output files. |
| artifacts | No | [] | File paths to read back after completion. Relative to cwd or absolute. |
| cwd | No | session cwd | Working directory for the delegated instance. |
| timeout | No | 300 | Max seconds before killing the session. |
| monitor | No | false | Keep session alive after completion for attach/debug. |
| agentPrompt | No | — | Additional system prompt for the delegated instance. |

Tool details carry the lifecycle: `status` (state value), `sessionId`,
`socketPath`, `artifacts`, `summary`, `stderr`, `exitCode`, `monitor`.

## When to use / not

| Scenario | Use |
|---|---|
| Multi-file refactor, large code review, test generation | `delegate_task` |
| Quick REPL check, gdb session, live log watching | `tmux` extension |

Not for: tasks fitting 2–3 inline tool calls, tasks needing reaction to
intermediate output, bounded small output (<100 lines).

## Prompt guide

### Do

- Be specific about what files to write
- Include context the delegated pi needs (file paths, patterns, constraints)
- Tell it to exit when done

```
task="Read src/auth.py and refactor all callback-based functions to async/await.
Write the refactored code back to src/auth.py.
Write a summary of changes to /tmp/auth-refactor-summary.txt.
Exit when done."
```

### Don't

- Vague instructions with no expected output
- Tasks that require interactive decision-making
- "Figure it out" without specifying deliverables

## Anti-patterns

| Anti-pattern | Why it fails | Fix |
|---|---|---|
| No artifacts declared | Nothing collected, result is opaque | Always declare expected output files |
| Vague task description | Delegated pi doesn't know what to produce | Specify files, patterns, constraints |
| Delegate inline-worthy tasks | Overhead > benefit | Use inline tools for <3 step tasks |
| Long tasks without timeout | Runs forever on failure | Set appropriate timeout |
| Monitor mode for every call | Sessions accumulate, waste resources | Only use monitor=true when debugging |

## Debugging

Inspect delegate sessions with the `tmux` extension or raw tmux — delegate
sessions live on `agent.sock` in `AGENT_TMUX_SOCKET_DIR` (default
`$TMPDIR/agent-tmux-sockets`), named `delegate-<ts>-<rand>`:

```bash
tmux -S "$AGENT_TMUX_SOCKET_DIR/agent.sock" list-sessions
tmux -S "$AGENT_TMUX_SOCKET_DIR/agent.sock" capture-pane -p -J -t delegate-12345-abcd -S -50
tmux -S "$AGENT_TMUX_SOCKET_DIR/agent.sock" attach -t delegate-12345-abcd   # detach: Ctrl+b d
```

Validation checklist after each delegation:

1. ✅ Status is "success" (not error/timeout/aborted)
2. ✅ All expected artifacts exist (missing: 0)
3. ✅ Artifact content is non-empty and relevant
4. ✅ stderr is clean (no unexpected errors)
5. ✅ Session is cleaned up (unless monitor=true)

The delegated pi instance has its own isolated context window. It does not
share context with the parent session.

## Tests

```
node test.ts    # machine tests — no LLM, no tmux
```
