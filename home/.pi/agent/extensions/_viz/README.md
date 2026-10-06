# viz-kit

Shared Stately-inspector transport for XState-machine extensions (`web-search`,
`tmux`). Not a pi extension — no `index.ts`, so pi does not load this directory;
extensions import `viz-kit.ts` directly.

Owns: `::` port pre-check (relay binds all interfaces; a 127.0.0.1 probe passes
while the port is held on `::`, and the relay would then crash with an unhandled
listen `error`), clean-stop WS adapter (stock `createWebSocketInspector`
retries forever, leaking timers past shutdown), port auto-allocation (multiple
extensions default to 8080), idempotent teardown.

Extensions own: config (env names, preferred port), actor creation (spread
`viz.option()` into `createActor` — XState `inspect` is creation-time, so
attach = re-create the actor from its persisted snapshot), and the thin
`/x viz` command wrapper.

## Local UI (sketch.ts)

`viz.enable({ inspectorUrl })` sets the bridge page's iframe target (stock
default: remote `https://stately.ai/inspect` — machine events postMessaged
there). A local Stately Sketch `/inspect` (same postMessage protocol) keeps
events on localhost.

`sketch.ts` owns the Sketch host lifecycle (module + CLI; builtins only):

```
node _viz/sketch.ts ensure   # bootstrap (clone+install once) + spawn + health-wait; prints URL
node _viz/sketch.ts url      # same, prints URL; exits 1 if impossible
node _viz/sketch.ts status   # JSON: running/port/pids
node _viz/sketch.ts stop     # kill our host (foreign Sketch never touched)
```

- Host: checkout at `XSTATE_SKETCH_DIR` (default `~/.cache/sketch-host`) running the repo's pinned pnpm (`packageManager`) via npx; port walk from `XSTATE_SKETCH_PORT` (default 3000); health = GET `/inspect` → 2xx (404ing foreign servers are not Sketch).
- Detached host survives the spawning process (fast next run); extensions'
  `session_shutdown` calls `stopSketch({ onlyIfOwner: process.pid })` — kills
  only what that session spawned. Explicit stop: the CLI above.
- `XSTATE_SKETCH_REMOTE=1` → `ensureSketch()` reports disabled; callers fall
  back to the remote UI.
- Extensions (`web-search`, `tmux`) call `ensureSketch()` before `viz.enable()`
  and pass the URL. The xstate-viz skill shells out to the CLI (`viz.sh`,
  `sketch-sim.sh`).

Tests: `node _viz/test.ts` (plain node; deps resolve from
`~/.pi/agent/extensions/node_modules`).
