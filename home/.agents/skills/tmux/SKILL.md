---
name: tmux
description: "Remote control tmux sessions for interactive CLIs (python, gdb, etc.) by sending keystrokes and scraping pane output. In pi sessions the tmux extension provides machine-enforced tmux_* tools; raw tmux remains as an escape hatch."
metadata:
  source: https://github.com/mitsuhiko/agent-stuff/tree/main/skills/tmux
---

# tmux Skill

Interactive CLIs (python, gdb, node, psql, ...) run in managed tmux sessions: send keystrokes, poll pane output for prompts and results, capture text.

## Choose your path

| Situation | Use |
|---|---|
| pi session with the tmux extension | `tmux_*` tools — caps, liveness probing, cleanup, monitor commands, branch restore are machine-enforced |
| No extension, other agent, or multi-pane (`split-window`) work | Raw tmux below |

With the extension present, prefer its tools. They enforce the session cap, probe liveness before sends, print monitor commands, reconcile registry vs ground truth across branches, and kill sessions at pi exit. Raw tmux bypasses all of that — you own the hygiene.

## pi: tmux extension tools

- `tmux_start(tool, cmd, prompt_regex?)` — start a CLI and wait for its prompt; omit `prompt_regex` for servers/novel TTY apps (ready immediately)
- `tmux_send(target, text)` — text goes as-is; embedded `\n` submit lines; end REPL blocks (`def`/`class`/`if`) with a trailing blank line (`\n\n`)
- `tmux_wait(target, regex, timeout?)` — one call polls until match or timeout; anchor the regex (`^…$`) so you don't match the text you sent
- `tmux_capture(target, lines?)` — bounded pane text
- `tmux_kill(target)` — kills + unregisters (explicit kill overrides monitor)
- `tmux_status()` — registry, drift report, monitor commands

Rejections are readable: they name what's live, what died, and the next step. Unknown ids come back with the live session list — when unsure, `tmux_status`.

User commands (not model tools): `/tmux status | kill --all | monitor <id> | footer | viz` (`/tmux monitor <id>` keeps a session alive across pi quit).

### Prompt regex recipes

| Tool | cmd | prompt_regex | Notes |
|---|---|---|---|
| Python REPL | `PYTHON_BASIC_REPL=1 python3 -q` | `^>>> ` | **always this cmd** — the default PyREPL auto-indents continuation lines, compounding sent indentation into IndentationError (8→12→16…); basic REPL takes multiline sends verbatim. Multiline `def` needs the trailing blank line — send exactly `'def f():\n    return 1\n\n'` (note the `\n\n`); without it the block stays open and the next send lands inside it as a SyntaxError |
| gdb | `gdb --quiet ./a.out` | `^\(gdb\) ` | send `set pagination off` first; then `bt`, `info locals`; exit `quit` |
| node REPL | `node` | `^> ` | |
| psql | `psql <db>` | `^ postgres=# ` | |
| server / novel TTY | e.g. `python3 -m http.server 8000` | (omit) | ready immediately, no wait |

Control keys (`C-c`, `C-d`) can't go through `tmux_send` (literal text only) — use the raw escape hatch below for those.

## Raw tmux escape hatch (no extension)

Socket convention — hygiene: the extension owns `pi.sock` + `pi-` prefixed sessions on it. Raw use stays off that socket; never touch other sockets' sessions.

```bash
SOCKET_DIR=${AGENT_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/agent-tmux-sockets}
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/agent.sock"   # raw / other-agent use
```

Start, drive, watch, interrupt, clean — session-only targets, `-f /dev/null` on creation, `-l` text then `Enter` separately:

```bash
tmux -S "$SOCKET" -f /dev/null new-session -d -s agent-py 'PYTHON_BASIC_REPL=1 python3 -q'
tmux -S "$SOCKET" send-keys -t agent-py -l -- '2 + 2'    # literal text
tmux -S "$SOCKET" send-keys -t agent-py Enter             # Enter is a separate send
tmux -S "$SOCKET" capture-pane -p -J -t agent-py -S -200  # watch output
tmux -S "$SOCKET" send-keys -t agent-py C-c              # control keys (raw only)
tmux -S "$SOCKET" kill-session -t agent-py                # clean up your session
```

Raw-mode rules that stay yours:

- Wait for prompts by polling `capture-pane` output for a regex (`^>>>`, `^\(gdb\) `) with a deadline — never fixed `sleep`s.
- `-l` sends arguments literally (including the word `Enter`) — text and `Enter` are two sends.
- Session-only targets (`-t agent-py`); never hardcode `:0.0` pane indices (`base-index` varies).
- `-f /dev/null` on creation — no user config, no status bar plugins, deterministic `base-index`.
- Tell the user the attach command (`tmux -S "$SOCKET" attach -t agent-py`) when you start a raw session.
- Kill your own sessions when done; only the extension cleans `pi-*` on `pi.sock`.
