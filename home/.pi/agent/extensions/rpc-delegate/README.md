# rpc-delegate

Delegate a task to a supervised, ephemeral child pi over the raw JSONL RPC
protocol — for hosts that can spawn `pi` directly.

The parameter schema (defaults, pairing rules, per-param guidance) lives once
in the `registerTool` typebox definitions in `index.ts` — the same
descriptions callers see at tool-use time.

### Child extensions

Children spawn with `--no-extensions`, which turns off extension
_discovery_ (auto-loading) — this extension included — and project-local
surprises. It does **not** block recursion at the capability level: a child
with `bash` can spawn a plain `pi` that rediscovers every user extension
(live-verified: a one-shot `pi --print` in bash reported `web_search`,
browser CDP tools, and `rpc_delegate_task` itself, unsupervised). What the
param buys is the _supervised_ route: extension tool calls run inside the
delegated child's loop, under the watchdog, stall timer, timeout, and
telemetry. The bash sub-spawn route adds a second model process no one
watches — and in a live A/B, research children improvising via bash errored
2/2 (no artifacts) while the explicit `-e …/web-search/index.ts` route
worked first try.

The `extensions` param opts in to loading specific extension files
(live-verified: a child with `-e …/web-search/index.ts` reports
`web_search`, `web_fetch`, `web_report`, `web_archive`, `web_reset`). Two
footguns: a `tools` allowlist disables extension tools unless their names
are listed (plain names — `+name` syntax is not supported for tools), and
loading this extension's own path re-enables delegation in the child -
warn-not-block, depth-bounded.

### Depth budget

Bounded by depth, not path identity — the `RPC_DELEGATE_DEPTH` /
`RPC_DELEGATE_MAX_DEPTH` env lineage (set in `index.ts`, gated by
`depthViolation` in `machine.ts`) rides process lineage through every load
route (`-e` paths, copies, symlinks, wrappers, bash sub-spawns), so a
delegated child can never raise its ceiling. Raise `maxDepth` in the
top-level call to grant one more level.

## Architecture

| file           | owns                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `machine.ts`   | XState v5 machine — lifecycle, legality, success evaluation; typed stubs, testable without a child |
| `transport.ts` | child process + raw JSONL protocol — reader, pending-ID map, stall supervision, ladders, watchdog  |
| `collector.ts` | honest artifact collection                                                                         |
| `watchdog.mjs` | external orphan watchdog                                                                           |
| `index.ts`     | tool wiring — schema, wired services, result rendering                                             |

Lifecycle (state flow), stall policy, cancellation/stop ladders, and
duration evidence are documented at their code: the `machine.ts` and
`transport.ts` headers and the wired services in `index.ts`.

## Honest success

A finished child is not a successful child — the final assistant stopReason
decides. `evaluateSuccess` in `machine.ts` is the single source (run started,
settled, stopReason outside `{error, aborted, pending}`, no final-message
error); a rejected prompt fails earlier as a prompt-service error, no run at
all.

## Tests

```
node test.ts            # machine matrix — stub services, no child
node transport.test.ts  # protocol fidelity against fixtures/fake-child.mjs
node live.test.ts       # live: real pi child + real model (few cents, ~5 min)
```

Each file's header documents its coverage. `fixtures/fake-child.mjs` scripts
the protocol failure modes via `FAKE_MODE` (see its header).

## Streaming

- Stream events (message/tool) are observed live from the RPC pipe.
- `STEER` is machine-supported as evidence only: `running` accepts it as a
  self-transition (tracked in `lastSteer`). Nothing emits it — the
  transport has no steer path and the tool's `onUpdate` progress channel
  is one-way. Mid-turn steering would ride the host's `streamingBehavior:
"steer"` input channel; no emitter exists.

## Bundled skill

`skills/model-routing/` ships inside this extension and is declared
through the `resources_discover` event (`skillPaths`) — it loads wherever
this extension loads: the parent (user extension dir, startup + reload)
and any delegated child given this file via the `extensions` param. The
`model-routing-classes` dependency (extensions workspace package.json)
points at `skills/model-routing/scripts/` — single source for the
delegation failure-class patterns.

## Live-verified protocol facts

- **pi rewrites its argv** (`process.title` = `pi-rpc` for `--mode rpc`
  children) — a delegated child is invisible to `pgrep -f` by flag (`--name`
  included). Process identity is the child PID (`childPid()` on the
  transport); the watchdog (node) does not rewrite and stays greppable.
- **Raw RPC pipe + immediate stdin EOF kills a child mid-turn** — keep stdin
  open (the extension's transport never closes stdin early).
- **`get_session_stats` works on `--no-session` children** — usage/cost
  evidence (`tokens.total`, not `totalTokens`).
