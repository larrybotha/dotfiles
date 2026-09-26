# web-browser extension

Machine-backed browser control over CDP. One XState machine owns browser
lifecycle legality + active-tab/emulation caches; executor scripts implement
browser actions; tools stay thin.

## Machine (`machine.ts`)

- States: `stopped → starting → running` (launch), `running → stopped`
  (stop / drift). Page ops are only legal in `running`; launch only from
  `stopped`.
- Context caches: `browser` (mode/port/pid/product), `activeTab` (last
  navigate/switch), `emulation` (device preference — survives STOP),
  `devices` (known presets, ground truth = `executors/devices.js`).
- `PROBE` is ground truth, both directions: adopts a live browser from
  `stopped` (kept open across a pi restart), marks drift from `running`
  (browser died underneath).
- `RESTORE` (branch restore) fills caches only — browser info is always
  re-derived from a probe, never resurrected from a snapshot.
- Pure validators shared between guards and tool prechecks:
  `launchViolation`, `emulateViolation`, `notRunningReason`.

## Executors

All local to `executors/`:

- `probe.mjs` / `stop.mjs` — extension probes, JSON out, failure-as-data.
  `stop.mjs` kills only browsers this extension launched
  (fresh/profile/reset_profile); attach/foreign instances are never killed.
- Action scripts: `start.js`, `nav.js`, `eval.js`, `screenshot.js`,
  `pick.js`, `switch-tab.js`, `emulate.js` + libs (`cdp.js`, `devices.js`,
  `active-tab.js`, `emulation-state.js`). Run as child processes,
  failure-as-data, readable stderr reasons passed through to the model.
- Un-tooled (raw use via bash; future tool backlog): `dismiss-cookies.js`,
  `watch.js`, `net-summary.js`, `logs-tail.js`, `set-cookie.mjs`,
  `set-file.mjs`, `arc-tabs.js`, `arc-spaces.js`.
- `ws` dep lives in `extensions/package.json` (scripts resolve it by
  walking up to `extensions/node_modules`).

## Tools

`browser_start` (fresh | profile | reset_profile | attach) ·
`browser_navigate` · `browser_eval` · `browser_screenshot` · `browser_pick` ·
`browser_tabs` · `browser_switch_tab` · `browser_emulate` · `browser_status` ·
`browser_stop`

Command: `/browser status | stop | footer [on|off] | viz [off]` — subcommand
autocomplete in TUI mode. Viz via `_viz/viz-kit.ts`, preferred port 8081
(tmux/web-search viz default to 8080; makeViz walks to the next free port).

## Config (env)

- `BROWSER_DEBUG_PORT` (default 9222)
- `BROWSER_BIN` (browser binary path; default: auto-detected Chrome/Chromium/Arc)
- `BROWSER_VIZ=1` (attach the Stately inspector at session start)
- `BROWSER_VIZ_PORT` (default 8081)

## Lifecycle

- **session_start/tree**: load devices → RESTORE caches from branch →
  PROBE (adopt/mark drift).
- **session_shutdown**: the browser is **never killed** at pi exit — it is a
  GUI app the user may still be using; `state.json` + the watch daemon
  persist and the next session's probe adopts the live browser. Footer and
  viz tear down idempotently.
- Tool-result `details` carries the machine context snapshot (todo.ts
  pattern) → branch restore survives pi restarts.

## Tests

`node test.ts` — machine transitions + validators only; no LLM, no browser,
no CDP.
