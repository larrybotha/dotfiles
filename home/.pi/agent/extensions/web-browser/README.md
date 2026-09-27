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
- Errors are a bounded ring (last `MAX_ERRORS` = 50): repeated STOP calls,
  failed launches, and drift cannot grow context without bound (persisted
  snapshots slim it further — last 5).
- Pure validators shared between guards and tool prechecks:
  `launchViolation`, `emulateViolation`, `notRunningReason`.
- `resolveAuto` (pure, in machine.ts) owns the smart-start decision table
  for `browser_start` mode `auto`: 1 CDP-attachable → attach, no ask; n →
  prompt; 0 + default usable → launch default; 0 + default blocked (global
  singleton like Arc running without CDP) → demote + warning; 0 + 1
  candidate → launch it; 0 + n candidates → prompt (default preselected);
  0 usable → readable error. Chromium-class browsers running without CDP do
  not block an isolated launch (separate user-data-dir singleton) — warning
  only.

## Executors

All local to `executors/`:

- `probe.mjs` / `stop.mjs` / `detect.mjs` — extension probes, JSON out,
  failure-as-data. `stop.mjs` kills only browsers this extension launched
  (fresh/profile/reset_profile); attach/foreign instances are never killed.
  `detect.mjs` buckets running browsers: `attachable` (CDP port answers),
  `runningNoCdp` (singleton/warning evidence), `installed` (CDP-capable
  binaries), `default` (macOS Launch Services https handler; Safari/Firefox
  excluded — no CDP).
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

`browser_start` (auto default | fresh | profile | reset_profile | attach) ·
`browser_navigate` · `browser_eval` · `browser_screenshot` · `browser_pick` ·
`browser_tabs` · `browser_switch_tab` · `browser_emulate` · `browser_status` ·
`browser_stop`

- `auto` (browser_start default): detect running browsers (detect.mjs),
  resolve via the pure table (machine.ts), and only ask (TUI select) when the
  choice is forced — n attachable, or n launchable with no usable default.
  Prompts are executor-side UX; the machine only ever sees the resolved
  attach/fresh mode. Non-TUI picks the first candidate and says so; Esc
  rejects with a readable note. `bin` param bypasses detection.
- Foreign attach policy: on an attached (`attach`/`foreign`) browser,
  `browser_navigate` never overwrites an existing tab — it always opens a
  new one, then verifies it landed in a visible window (Arc Spaces: a new
  tab may land in a hidden-Space window) and warns with the next step.
- Recorded-target policy: `browser_eval` / `browser_screenshot` /
  `browser_pick` require an extension-recorded active tab
  (`~/.cache/agent-web/browser/active-tab.json`, written by navigate /
  switch-tab) — the single source of truth for target legality, checked by
  the tool precheck and the executors (`cdp.getRecordedPage()`). Without a
  recorded tab (or when it is gone) they reject — they never fall back to a
  visible-window heuristic, which on an adopted foreign browser resolves to
  the user's focused personal tab. The machine's `activeTab` cache is
  display/status state only.

Command: `/browser status | stop | footer [on|off] | viz [off]` — subcommand
autocomplete in TUI mode. Viz via `_viz/viz-kit.ts`, preferred port 8081
(tmux/web-search viz default to 8080; makeViz walks to the next free port).

## Config (env)

- `BROWSER_DEBUG_PORT` (default 9222; `auto` attach follows a detected port,
  and the machine re-probes the port it last saw)
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

`node test.ts` — machine transitions + validators + the resolveAuto decision
table; no LLM, no browser, no CDP.
