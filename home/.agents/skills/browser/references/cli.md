# playwright-cli contract for pwb

Pinned `playwright-cli`; the version lives in `scripts/pins`. Commands run
through `pwb`.

## Open options

`playwright-cli open` accepts `--browser`, `--config`, `--device`,
`--headed`, `--idle-timeout`, `--mobile`, `--persistent`, and `--profile`.

`pwb` accepts only `--headed`, `--device`, `--mobile`, and `--restart` on
`open`. It injects `-s`, `--config`, `--profile`, and `--idle-timeout`.
`--restart` is consumed by `pwb`; the CLI restarts the same-name session.

## Output

After each command, the CLI prints an action-dependent subset of:

```text
### Page
### Open tabs
### Snapshot
### Events
### Modal state
### Error
### Result
```

Do not assume every section exists. Parse a `### Snapshot` link only when
present.

Snapshots are written to disk. The snapshot file contains the accessibility
tree and element refs.

Element refs come from the latest snapshot. They expire after navigation or a
DOM change.

## Indexes

- Tabs are 0-based.
- Requests are 1-based with gaps. Static requests may be hidden.

## Commands and quirks

```text
tab-list
tab-new [url]
tab-select <index>
tab-close [index]

requests
request <index>
request-headers <index>
request-body <index>
response-headers <index>
response-body <index>

console [min-level]
snapshot [target]
find "<text>"
find --regex "<pattern>"
```

`find` accepts text or `--regex`, not both. A pattern starting with `-` uses
`find --regex=<pattern>`.

`fill --submit` and `type --submit` press Enter.

`upload` requires an open file chooser. `drop` takes repeatable `--path` or
`--data`, one form only.

`delete-data` removes daemon directories, not an explicit `--profile`.

`request` headers and bodies may contain secrets.

Explicit relative filenames resolve against the caller cwd. Prefer
`"$(pwb path output)/name"`.

## Config

`pwb` writes:

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "headless": true,
      "channel": "chromium"
    }
  },
  "outputDir": "<session-root>/output"
}
```

`--headed` overrides the config headless flag for that `open`.

After `open`, `pwb` reads `config-print` and closes the session on drift.

## Sessions

`pwb` names sessions from the Git worktree root:

```text
pi-<sanitized-basename>-<sha256-prefix>[-<suffix>]
```

`PWB_SESSION_SUFFIX` isolates parallel agents. Valid suffix:
`^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$`, no `..`.

Session state:

```text
<root>/profile/
<root>/output/
<root>/config.json
```

`pwb session --json` prints the paths.

## Idle timeout

`pwb` passes `--idle-timeout` on every `open`:

- headless default: `3600000`
- headed default: `900000`
- override: numeric `PWB_IDLE_TIMEOUT_MS`
- `0` disables the timeout

## Recovery

Session absent or stale:

```text
pwb close
pwb open --restart <url>
```

Open refused:

```text
pwb open --restart <url>
```

Persistent failure:

```text
pwb reset --yes
pwb open <url>
```

Diagnose:

```text
playwright-cli list --all --json
```

`pwb close` polls `list --all --json` and exits non-zero when the session is
still live.

## Output and JSON

`--json` and `--raw` pass through before or after the command:

```text
pwb --json tab-list
pwb tab-list --json
```

`pwb reset --yes` removes the session root. It requires explicit confirmation.
