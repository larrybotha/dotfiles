# rpc-delegate

Delegate a task to a supervised, ephemeral child pi over the raw JSONL RPC
protocol — an in-process alternative to [tmux-delegate](../tmux-delegate) for
hosts that can spawn `pi` directly.

```
rpc_delegate_task: {
  task: string         // full task text, sent as one prompt
  cwd?: string         // working dir for the child (default: session cwd)
  timeout?: number     // seconds (default 300)
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
| `transport.ts` | The child process + raw JSONL protocol: LF-split byte reader, pending-ID correlation, ext-UI auto-cancel, cancellation ladder, external watchdog. |
| `collector.ts` | Honest artifact collection (missing / read-error / truncated, 50 KB cap). |
| `watchdog.mjs` | External orphan watchdog: TERMs the child process group if the parent dies (SIGKILL leaves no atexit) or the deadline lapses. |
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
- Deadline and abort still collect (then export the session) — tmux-delegate
  skips collection there; this protocol can read the transcript of a killed
  child.
- **Cancellation ladder** (deadline / abort): `clear_queue` → `abort` →
  stdin-close → wait 10 s → SIGTERM → wait 5 s → SIGKILL.
- **Stop ladder** (every final): `get_session_stats` → session export on
  failure-ish outcomes → stdin-close → TERM → KILL.

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
node test.ts            # 40 machine tests (stub services, no child)
node transport.test.ts  # 16 transport tests against fixtures/fake-child.mjs
node dogfood.ts         # live: real child pi, real model — success + deadline
```

`fixtures/fake-child.mjs` is a scripted fake RPC child (`FAKE_MODE`:
ok / handled / prompt-rejected / malformed / parse-no-id / unmatched /
die-mid / extui / flood / oversized / stderr / noreply) — every protocol
failure mode is testable without a model.

## Differences from tmux-delegate

- Child is a piped `pi --mode rpc --no-session` process, not a tmux pane.
- Deadline/abort paths still collect artifacts and export the session.
- Stream events (message/tool) are observed live, not scraped from a pane.
- `STEER` is machine/transport-supported (delivered mid-turn with
  `streamingBehavior: "steer"`) but not tool-exposed: the tool's `onUpdate`
  progress channel is one-way. Capability-ready if a two-way channel appears.
