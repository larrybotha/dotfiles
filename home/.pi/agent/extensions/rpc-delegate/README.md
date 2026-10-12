# rpc-delegate

Delegate a task to a supervised, ephemeral child pi over the raw JSONL RPC
protocol — an in-process alternative to [tmux-delegate](../tmux-delegate) for
hosts that can spawn `pi` directly.

```
rpc_delegate_task: {
  task: string         // full task text, sent as one prompt
  cwd?: string         // working dir for the child (default: session cwd)
  timeout?: number     // hard cap in seconds (default 1800) — backstop,
                       // NOT expected duration: the call returns when the
                       // child settles; a silent child is stall-cancelled
  artifacts?: string[] // declared artifact paths, collected after the run
  provider?: string    // child's model provider (optional)
  model?: string       // child's model id (optional)
  tools?: string[]     // child tool allowlist (optional)
  agentPrompt?: string // appended to the child's system prompt
  artifactPolicy?: "artifacts" | "stopReason"  // default "stopReason"
}
```

## Architecture

Same separation as tmux-delegate, one layer deeper:

| file | owns |
| --- | --- |
| `machine.ts` | XState v5 machine: lifecycle, legality, success evaluation. Ships typed service stubs that throw — tests run without any child. |
| `transport.ts` | The child process + raw JSONL protocol: LF-split byte reader, pending-ID correlation, ext-UI auto-cancel, cancellation ladder, external watchdog, stall supervision (liveness timer + heartbeat file). |
| `collector.ts` | Honest artifact collection (missing / read-error / truncated, 50 KB cap). |
| `watchdog.mjs` | External orphan watchdog: TERMs the child process group if the parent dies (SIGKILL leaves no atexit), the hard cap lapses, or the heartbeat goes stale (a wedged extension's timers are dead — the file is the backstop). |
| `index.ts` | Extension wiring: `registerTool`, typebox params, wired services, result rendering. |

The machine never sees RPC records — the transport converts them to a small
typed event set (`AGENT_START`, `MESSAGE_END`, `AGENT_SETTLED`, `CHILD_DEAD`,
`PROTOCOL_FATAL`, …). The machine's services are injected via
`rpcMachine.provide()`; the stubs exist so the machine is testable with
controllable gates and no child at all.

## Lifecycle

```
idle → spawning → handshaking → prompting → running → collecting → stopping → success | error | timeout | aborted
                              ↘ cancelling → collecting → stopping ↗
```

- **One child per call.** `--no-session` is ephemeral and never resumed.
- **Stall detection, not duration guessing.** The call returns when the
  child settles; `timeout` is only a hard-cap backstop. A silent child
  (no protocol bytes for 180s, no child tool open) is cancelled by the
  transport's liveness timer → cancellation ladder → `timeout` outcome
  with `stallHit: true`. Silence *inside* a child tool (`bash` running a
  build for minutes) is legitimate — the timer is suppressed while a
  tool is open; a hung child tool is the hard cap's job. A throttled
  heartbeat file (`{t, open}` JSON) lets the watchdog enforce the same
  policy if the extension process itself wedges; the watchdog unlinks it
  on every exit path.
- Deadline and abort still collect declared artifacts — tmux-delegate skips
  collection there; this protocol can read the transcript of a killed child.
- **Cancellation ladder** (deadline / abort): `clear_queue` → `abort` →
  stdin-close → wait 10 s → SIGTERM → wait 5 s → SIGKILL.
- **Stop ladder** (every final): `get_session_stats` (usage/cost evidence) →
  stdin-close → TERM → KILL. No session export on any outcome:
  `export_html` cannot export a `--no-session` child ("Cannot export
  in-memory session to HTML") — protocol limitation, verified live.

- **Duration evidence beside cost.** `get_session_stats` carries no
  duration, so the machine keeps its own clock: `beginAt` (BEGIN accepted),
  `runStartedAt` (prompt accepted — run arms), `runEndedAt` (first outcome
  mark), `endedAt` (terminal entry). Every result renders run duration
  (prompt accepted → outcome decided — pairs with usage/cost; usage accrues
  while the agent runs) plus total delegation duration (BEGIN → terminal,
  collect + stop ladders included); a pre-run failure leaves run duration
  null (honest evidence — never a guessed duration).

## Honest success

A finished child is not a successful child. `evaluateSuccess` inspects the
final assistant message: `stopReason` in `{error, aborted, pending}` fails;
`prompt-rejected` fails; with `artifactPolicy: "artifacts"`, a weak stopReason
still succeeds if at least one declared artifact was collected.

## Protocol handling

- **Raw JSONL, not `RpcClient`.** The stock client hides record-level
  failures; this transport surfaces them as events (`PROTOCOL_FATAL`).
- **LF-split byte reader, never `readline`.** U+2028/2029 are valid JSON
  string content; `readline` splits on them. Records are split on 0x0a only,
  optional trailing 0x0d stripped. Oversized records (>16 MB, LF-less) are
  dropped whole (drop-until-LF mode), never parsed as malformed.
- **Pending-ID map entries stay after settle.** A late or duplicate response
  is logged, never fatal. Unmatched IDs, malformed records, and id-less
  responses are fatal.
- **Ext-UI dialogs auto-cancel** (`extension_ui_response` immediately) — a
  delegated child has no UI to block on. Notifications are recorded and
  forwarded, never blocking.
- **Continuous stdout reads** with backpressure-aware stdin writes; stderr is
  an 8 KB diagnostic tail, never parsed as protocol.

## Tests

```
node test.ts            # 47 machine tests (stub services, no child)
node transport.test.ts  # 22 transport tests against fixtures/fake-child.mjs
node live.test.ts       # live: 23 checks — real pi child + real model
                       # (few cents, ~4 min): success, hard-cap deadline,
                       # abort, provider/model flags, 136 KB prompt,
                       # SIGKILL'd parent (orphan watchdog reaps child +
                       # sleep + watchdog), stall supervision (open-tool
                       # suppression + heartbeat file)
```

`fixtures/fake-child.mjs` is a scripted fake RPC child (`FAKE_MODE`:
ok / handled / prompt-rejected / malformed / parse-no-id / unmatched /
die-mid / extui / flood / oversized / stderr / noreply / stall /
stall-open, mute — a child that never speaks) — every protocol
failure mode (including a silent hung
child and a silently-running child tool) is testable without a model.

## Differences from tmux-delegate

- Child is a piped `pi --mode rpc --no-session` process, not a tmux pane.
- Deadline/abort paths still collect artifacts (tmux-delegate skips there).
- Stream events (message/tool) are observed live, not scraped from a pane.
- `STEER` is machine/transport-supported (delivered mid-turn with
  `streamingBehavior: "steer"`) but not tool-exposed: the tool's `onUpdate`
  progress channel is one-way. Capability-ready if a two-way channel appears.

## Live-verified protocol facts

- **pi rewrites its argv** (`process.title` = `pi`) — a delegated child is
  invisible to `pgrep -f` by flag (`--name` included). Process identity is
  the child PID (`childPid()` on the transport); the watchdog (node) does
  not rewrite and stays greppable.
- **Raw RPC pipe + immediate stdin EOF kills a child mid-turn** — keep stdin
  open (the extension's transport never closes stdin early). 
- **Host `PI_*` vars are inherited by children but are markers, not CLI
  config** — an inherited `PI_MODEL` does not change the child's selected
  model (verified live).
- **`get_session_stats` works on `--no-session` children** — usage/cost
  evidence (`tokens.total`, not `totalTokens`).
