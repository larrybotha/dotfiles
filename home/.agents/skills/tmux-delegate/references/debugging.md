# Debugging

## Validate with existing tmux skill

After delegation, use the **tmux** skill to inspect sessions when something looks wrong:

```bash
# List all sessions on the delegate socket
tmux -S "$AGENT_TMUX_SOCKET_DIR/agent.sock" list-sessions

# Capture last output from a specific delegate session
tmux -S "$AGENT_TMUX_SOCKET_DIR/agent.sock" capture-pane -p -J -t delegate-12345-abcd -S -50

# Attach to a monitor-mode session for live debugging
tmux -S "$AGENT_TMUX_SOCKET_DIR/agent.sock" attach -t delegate-12345-abcd
# Detach with Ctrl+b d
```

## Validation checklist

After each delegation, verify:

1. ✅ Status is "success" (not error/timeout)
2. ✅ All expected artifacts exist (missing: 0)
3. ✅ Artifact content is non-empty and relevant
4. ✅ stderr is clean (no unexpected errors)
5. ✅ Session is cleaned up (unless monitor=true)

If validation fails:

- Use tmux skill to inspect the session (if monitor=true)
- Check stderr for error details
- Refine task prompt and retry

## How it works (internals)

1. Extension creates isolated tmux session (`-f /dev/null`, no user config)
2. Writes task to a temp file
3. Runs `pi --no-session -p "$(cat taskfile)"` inside the session
4. Polls for a signal file (written when pi exits)
5. Reads declared artifact files
6. Kills session (unless `monitor=true`)
7. Returns structured result with artifacts

The delegated pi instance has its own isolated context window.
It does NOT share context with the parent session.
