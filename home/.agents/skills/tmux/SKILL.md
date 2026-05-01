---
name: tmux
description: "Remote control tmux sessions for interactive CLIs (python, gdb, etc.) by sending keystrokes and scraping pane output."
metadata:
  source: https://github.com/mitsuhiko/agent-stuff/tree/main/skills/tmux
---

# tmux Skill

Use tmux as a programmable terminal multiplexer for interactive work. Works on Linux and macOS with stock tmux; always use a private socket and clean config to avoid interference from the user's tmux setup.

## Quickstart (isolated socket)

```bash
SOCKET_DIR=${AGENT_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/agent-tmux-sockets}  # well-known dir for all agent sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/agent.sock"                # keep agent sessions separate from your personal tmux
SESSION=agent-python                           # slug-like names; avoid spaces
tmux -S "$SOCKET" -f /dev/null new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION" -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter
# After Python starts, send code with -l then Enter separately:
# tmux -S "$SOCKET" send-keys -t "$SESSION" -l -- '2 + 2'
# tmux -S "$SOCKET" send-keys -t "$SESSION" Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION" -S -200  # watch output
tmux -S "$SOCKET" kill-session -t "$SESSION"                   # clean up
```

After starting a session ALWAYS tell the user how to monitor the session by giving them a command to copy paste:

```text
To monitor this session yourself:
  tmux -S "$SOCKET" attach -t agent-lldb

Or to capture the output once:
  tmux -S "$SOCKET" capture-pane -p -J -t agent-lldb -S -200
```

This must ALWAYS be printed right after a session was started and once again at the end of the tool loop. But the earlier you send it, the happier the user will be.

## Socket convention

- Agents MUST place tmux sockets under `AGENT_TMUX_SOCKET_DIR` (defaults to `${TMPDIR:-/tmp}/agent-tmux-sockets`) and use `tmux -S "$SOCKET"` so we can enumerate/clean them. Create the dir first: `mkdir -p "$AGENT_TMUX_SOCKET_DIR"`.
- Default socket path to use unless you must isolate further: `SOCKET="$AGENT_TMUX_SOCKET_DIR/agent.sock"`.

## Targeting panes and naming

- **Use session-only targets by default** (e.g. `-t agent-py`). This targets the active pane of the active window, works regardless of `base-index` setting, and avoids hardcoding window/pane indices that may be wrong.
- Full format is `{session}:{window}.{pane}` but **avoid hardcoded indices** — `base-index` may be 0 or 1 depending on config, making `:0.0` unreliable.
- When you need multi-pane targeting (e.g. `split-window`), resolve indices dynamically:
  ```bash
  base=$(tmux show-option -gv base-index)
  pbase=$(tmux show-option -gv pane-base-index)
  target="agent-py:${base}.${pbase}"
  ```
- Or inspect live indices: `tmux -S "$SOCKET" list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}'`
- **Always use `-f /dev/null`** when creating sessions (`tmux -S "$SOCKET" -f /dev/null new ...`). This guarantees `base-index=0`, no custom keybindings, no status bar plugins, and no user config interfering with `send-keys` or `capture-pane`. Only omit `-f /dev/null` if you explicitly need the user's `~/.tmux.conf`.
- Use `-S "$SOCKET"` consistently to stay on the private socket path.
- Inspect: `tmux -S "$SOCKET" list-sessions`, `tmux -S "$SOCKET" list-panes -a`.

## Finding sessions

- List sessions on your active socket with metadata: `./scripts/find-sessions.sh -S "$SOCKET"`; add `-q partial-name` to filter.
- Scan all sockets under the shared directory: `./scripts/find-sessions.sh --all` (uses `AGENT_TMUX_SOCKET_DIR` or `${TMPDIR:-/tmp}/agent-tmux-sockets`).

## Sending input safely

- **Important:** the `-l` flag sends all following arguments as literal text — including `Enter`. When using `-l`, send the text and `Enter` key as **two separate commands**:

  ```bash
  # WRONG — sends literal text "Enter" instead of pressing Enter
  tmux -S "$SOCKET" send-keys -t target -l -- 'some code' Enter

  # RIGHT — send literal text, then Enter key separately
  tmux -S "$SOCKET" send-keys -t target -l -- 'some code'
  tmux -S "$SOCKET" send-keys -t target Enter
  ```

- For simple commands without special characters, omit `-l` and use `--` to delimit tmux options from the command:
  `tmux -S "$SOCKET" send-keys -t target -- 'echo hello' Enter`
- When composing inline commands, use single quotes or ANSI C quoting to avoid expansion: `tmux ... send-keys -t target -- $'python3 -m http.server 8000'`.
- To send control keys: `tmux ... send-keys -t target C-c`, `C-d`, `C-z`, `Escape`, etc.

## Watching output

- Capture recent history (joined lines to avoid wrapping artifacts): `tmux -S "$SOCKET" capture-pane -p -J -t target -S -200`.
- For continuous monitoring, poll with the helper script (below) instead of `tmux wait-for` (which does not watch pane output).
- You can also temporarily attach to observe: `tmux -S "$SOCKET" attach -t "$SESSION"`; detach with `Ctrl+b d`.
- When giving instructions to a user, **explicitly print a copy/paste monitor command** alongside the action don't assume they remembered the command.

## Spawning Processes

Some special rules for processes:

- when asked to debug, use lldb by default
- when starting a python interactive shell, always set the `PYTHON_BASIC_REPL=1` environment variable. This is very important as the non-basic console interferes with your send-keys.

## Synchronizing / waiting for prompts

- Use timed polling to avoid races with interactive tools. Example: wait for a Python prompt before sending code:
  ```bash
  ./scripts/wait-for-text.sh -S "$SOCKET" -t "$SESSION" -p '^>>>' -T 15 -l 4000
  ```
- For long-running commands, poll for completion text (`"Type quit to exit"`, `"Program exited"`, etc.) before proceeding.

## Interactive tool recipes

- **Python REPL**: `tmux ... send-keys -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter`; wait for `^>>>`; send code with `-l` in a separate send, then `Enter` in another; interrupt with `C-c`.
- **gdb**: `tmux ... send-keys -- 'gdb --quiet ./a.out' Enter`; disable paging `tmux ... send-keys -- 'set pagination off' Enter`; break with `C-c`; issue `bt`, `info locals`, etc.; exit via `quit` then confirm `y`.
- **Other TTY apps** (ipdb, psql, mysql, node, bash): same pattern—start the program, poll for its prompt, then send literal text and Enter.

## Cleanup

- Kill a session when done: `tmux -S "$SOCKET" kill-session -t "$SESSION"`.
- Kill all sessions on a socket: `tmux -S "$SOCKET" list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S "$SOCKET" kill-session -t`.
- Remove everything on the private socket: `tmux -S "$SOCKET" kill-server`.

## Helper: wait-for-text.sh

`./scripts/wait-for-text.sh` polls a pane for a regex (or fixed string) with a timeout. Works on Linux/macOS with bash + tmux + grep.

```bash
./scripts/wait-for-text.sh -t session -p 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000] [-S socket-path | -L socket-name]
```

- `-t`/`--target` pane target (required). Use session-only (e.g. `agent-py`) for the active pane; use `{session}:{window}.{pane}` only when you need a specific pane.
- `-p`/`--pattern` regex to match (required); add `-F` for fixed string
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (default 0.5)
- `-l` history lines to search from the pane (integer, default 1000)
- `-S`/`--socket-path` tmux socket path (passed to `tmux -S`)
- `-L`/`--socket` tmux socket name (passed to `tmux -L`)
- Exits 0 on first match, 1 on timeout. On failure prints the last captured text to stderr to aid debugging.
