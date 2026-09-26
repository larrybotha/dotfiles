---
name: xstate-viz
description: Open an XState machine in the Stately visualiser in a local browser, with live state streaming and simulation. Use when asked to open, show, visualize, or inspect a state machine/statechart file, or to author XState v5 machines for visualization.
---

# XState visualizer

Opens a machine in the Stately inspector (`@statelyai/inspect`): browser at `http://localhost:8080` shows the machine diagram and streams live state, context, and transitions.

## Machines it accepts

Any `.ts`/`.js`/`.mjs` file on disk containing one of:

- an XState v5 machine as any named export (e.g. `export const loginMachine`) or default export
- a raw machine config object (plain `{ id, initial, states }` shape), named or default — it is wrapped with `createMachine()` automatically

Resolution: if the machine's own directory has `xstate` + `@statelyai/inspect` in `node_modules`, the machine runs **in place** (its other imports resolve — app code fine). Otherwise it runs from the sandbox, where only `xstate`/`@statelyai/inspect` resolve; a machine importing anything else there fails with `Cannot find module`.

## Usage

```bash
# open in visualiser (starts server, opens browser; default port 8080)
scripts/viz.sh path/to/machine.ts

# custom port / headless
scripts/viz.sh path/to/machine.ts 8081
scripts/viz.sh --no-open path/to/machine.ts

# check / stop
scripts/viz.sh status
scripts/viz.sh stop
```

Behavior:

- Re-running with the **same machine** while running: no restart — just reopens the browser tab at `http://localhost:<port>`.
- Re-running with a **different machine**: stops the previous instance, starts the new one (one inspector at a time; reload the browser tab).
- Sandbox (node deps: `xstate`, `@statelyai/inspect`, `tsx`) bootstraps once at `~/.cache/xstate-viz`.
- Log: `~/.cache/xstate-viz/inspector.log`.

## Authoring machines for clean diagrams (optional but recommended)

- XState v5: `setup({ types, actions, guards, actors })` + `createMachine()`, export as a named export.
- Add `description` on states — renders in Stately as built-in documentation.
- Implement actions/guards/actors inline in `setup()`; stub real effects (network, fs, timers) so simulation stays clean.
- Typed events/context via `setup.types` catch authoring errors before the diagram renders.

## Send events

Inspector UI shows the live machine. Drive it from the terminal (one JSON per line, or bare event types):

```bash
cd ~/.cache/xstate-viz
printf '{"type":"TOGGLE"}\nRESET\n' | ./node_modules/.bin/tsx runner.mjs machine.ts 8080 0
```

Exit with Ctrl-C (server keeps the process alive).

## Static diagram alternative

Clickable diagram without a running server: paste machine code (XState, JSON, or Mermaid) into [sketch.stately.ai](https://sketch.stately.ai) — open-source, click transitions to simulate. Not automatable from the shell.
