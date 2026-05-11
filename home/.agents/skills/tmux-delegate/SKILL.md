---
name: tmux-delegate
description: "Delegate work to a pi instance running in an isolated tmux session. Results come from files, not terminal output — keeping context clean. Use the delegate_task tool provided by the tmux-delegate extension. Use when delegating multi-file refactors, code reviews, or test generation. Not for tasks fitting 2-3 inline tool calls."
compatibility: Requires pi (agent) and tmux
allowed-tools: Bash(delegate_task:*) Read
---

# tmux-delegate

Delegate long-running or context-heavy tasks to a separate pi instance inside tmux.
Results are collected from files, not pane captures.

## When to use

| Scenario | Use |
|---|---|
| Multi-file refactor | `delegate_task` |
| Code review of large module | `delegate_task` |
| Generate tests for existing code | `delegate_task` |
| Quick REPL check | existing `tmux` skill (python REPL) |
| Debug crash with gdb | existing `tmux` skill |
| Inspect live logs | existing `tmux` skill |

## When NOT to use

- Task fits in 2-3 tool calls inline
- You need to react to intermediate output
- Output is bounded and small (<100 lines)

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

### Parameters

| Param | Required | Default | Purpose |
|---|---|---|---|
| task | Yes | — | What the delegated pi should do. Be specific about expected output files. |
| artifacts | No | [] | File paths to read back after completion. Relative to cwd or absolute. |
| cwd | No | session cwd | Working directory for the delegated instance. |
| timeout | No | 300 | Max seconds before killing the session. |
| monitor | No | false | Keep session alive after completion for attach/debug. |
| agentPrompt | No | — | Additional system prompt for the delegated instance. |

### Returns

```json
{
  "status": "success | error | timeout | aborted",
  "sessionId": "delegate-12345-abcd",
  "socketPath": "/tmp/agent-tmux-sockets/agent.sock",
  "artifacts": [
    {"path": "src/auth.py", "content": "...", "missing": false}
  ],
  "summary": "Collected 1/1 artifacts.",
  "stderr": "",
  "exitCode": 0,
  "monitor": false
}
```

## Artifact patterns

The delegated pi must write results to files. The parent reads only those files.

**Single file output:**
```
artifacts=["src/refactored.py"]
```

**Multiple files:**
```
artifacts=["src/auth.py", "tests/test_auth.py", "/tmp/summary.txt"]
```

**Summary + code:**
```
task="Refactor X. Write code to src/x.py and a summary of changes to /tmp/summary.txt."
artifacts=["src/x.py", "/tmp/summary.txt"]
```

## Anti-patterns

| Anti-pattern | Why it fails | Fix |
|---|---|---|
| No artifacts declared | Nothing collected, result is opaque | Always declare expected output files |
| Vague task description | Delegated pi doesn't know what to produce | Specify files, patterns, constraints |
| Delegate inline-worthy tasks | Overhead > benefit | Use inline tools for <3 step tasks |
| Long tasks without timeout | Runs forever on failure | Set appropriate timeout |
| Monitor mode for every call | Sessions accumulate, waste resources | Only use monitor=true when debugging |

## Deeper reference

- [references/prompt-guide.md](references/prompt-guide.md) — writing effective task prompts
- [references/debugging.md](references/debugging.md) — validation checklist, tmux inspection, internals
