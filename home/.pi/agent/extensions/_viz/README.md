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

Tests: `node _viz/test.ts` (plain node; deps resolve from
`~/.pi/agent/extensions/node_modules`).
