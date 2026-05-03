---
name: web-browser
description: "Allows to interact with web pages by performing actions such as clicking buttons, filling out forms, and navigating links. It works by remote controlling Google Chrome, Chromium, or Arc browsers using the Chrome DevTools Protocol (CDP). When Claude needs to browse the web, it can use this skill to do so."
license: Stolen from Mario
---

# Web Browser Skill

Minimal CDP tools for collaborative site exploration. Supports Chrome, Chromium, and Arc.

## Start Browser

```bash
./scripts/start.js                  # Isolated reusable profile (default)
./scripts/start.js --profile        # Copy your Chrome profile into isolated cache
./scripts/start.js --reset-profile  # Clear selected cached profile before launch
./scripts/start.js --attach         # Attach to already-running browser with CDP
```

Starts Chrome with remote debugging (default port `:9222`).

Profile behavior:
- Default mode uses: `~/.cache/agent-web/browser/fresh-profile`
- `--profile` mode uses: `~/.cache/agent-web/browser/profile-copy`
- The skill **does not attach to your live Chrome profile directly**
- If `:9222` is already used by an unknown instance, start will fail instead of reusing it

If Chrome is installed in a non-standard location, set:

```bash
BROWSER_BIN=/path/to/chrome ./scripts/start.js
```

Optional debug endpoint override:

```bash
BROWSER_DEBUG_PORT=9333 ./scripts/start.js
```

## Using Arc

Arc is Chromium-based and supports CDP. Two ways to use it:

### Option A: Launch Arc via the skill (isolated profile)

```bash
# Must close Arc first — singleton lock prevents second instance
BROWSER_BIN="/Applications/Arc.app/Contents/MacOS/Arc" ./scripts/start.js
```

### Option B: Attach to your running Arc (real profile)

1. Close Arc completely
2. Relaunch with debug flag:
```bash
/Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=9222 &
```
3. Attach from the skill:
```bash
./scripts/start.js --attach
```

This connects to your running Arc with all your tabs, extensions, and history.

**Note:** Arc organizes tabs into Spaces (each Space = separate window). The skill
automatically targets tabs in visible windows and avoids hidden-Space tabs.

## Active Tab Resolution

When multiple tabs are open (common with Arc), the skill resolves the active tab via:
1. **State file** — last tab navigated to (validated as visible)
2. **Visible-window heuristic** — tabs in windows with non-zero dimensions
3. **Fallback** — last page target

## Navigate

```bash
./scripts/nav.js https://example.com
./scripts/nav.js https://example.com --new
```

Navigate current tab or open new tab.

## Device Emulation (Mobile)

```bash
./scripts/emulate.js --list
./scripts/emulate.js iphone-14
./scripts/emulate.js pixel-7 --landscape
./scripts/emulate.js --reset
```

Set an active device emulation preference (viewport, DPR, touch, UA) for browser skill commands. Use `--reset` to clear.

Commands like `nav.js`, `eval.js`, `pick.js`, `dismiss-cookies.js`, and `screenshot.js` automatically apply the active preference.

## Evaluate JavaScript

```bash
./scripts/eval.js 'document.title'
./scripts/eval.js 'document.querySelectorAll("a").length'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

Execute JavaScript in active tab (async context). Be careful with string escaping, best to use single quotes.

## Screenshot

```bash
./scripts/screenshot.js
./scripts/screenshot.js --full-page
./scripts/screenshot.js --device iphone-14
./scripts/screenshot.js --device pixel-7 --full-page
```

Takes a screenshot and returns a temp file path.

- Default: current viewport
- `--full-page`: captures full document height
- `--device <preset>`: temporary mobile emulation for that screenshot only

## Pick Elements

```bash
./scripts/pick.js "Click the submit button"
```

Interactive element picker. Click to select, Cmd/Ctrl+Click for multi-select, Enter to finish.

## Dismiss Cookie Dialogs

```bash
./scripts/dismiss-cookies.js          # Accept cookies
./scripts/dismiss-cookies.js --reject # Reject cookies (where possible)
```

Automatically dismisses EU cookie consent dialogs.

Run after navigating to a page:
```bash
./scripts/nav.js https://example.com && ./scripts/dismiss-cookies.js
```

## Quick Mobile Debug Flow

```bash
./scripts/start.js
./scripts/nav.js https://example.com
./scripts/emulate.js iphone-14
./scripts/nav.js https://example.com      # reload with mobile UA
./scripts/dismiss-cookies.js
./scripts/screenshot.js --full-page
```

## Background Logging (Console + Errors + Network)

Automatically started by `start.js` and writes JSONL logs to:

```
~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl
```

Manually start:
```bash
./scripts/watch.js
```

Tail latest log:
```bash
./scripts/logs-tail.js           # dump current log and exit
./scripts/logs-tail.js --follow  # keep following
```

Summarize network responses:
```bash
./scripts/net-summary.js
```

## Arc-Specific Commands

These scripts read Arc's local sidebar data (`~/Library/Application Support/Arc/`) and correlate it with CDP window information. They only work when Arc is the active browser.

### List Spaces

```bash
./scripts/arc-spaces.js              # List all spaces with tab counts
./scripts/arc-spaces.js --tabs       # Include tab details per space
./scripts/arc-spaces.js --json       # Raw JSON output
```

Shows Space name, tab count, visibility, focused state, and CDP windowId. Uses URL-overlap matching to correlate Arc Space UUIDs with CDP `windowId`s.

### List Tabs with Space Info

```bash
./scripts/arc-tabs.js                # All tabs grouped by space
./scripts/arc-tabs.js --visible       # Only visible windows
./scripts/arc-tabs.js --json          # Raw JSON output
./scripts/arc-tabs.js --space "HS Dev" # Filter by space name
```

Enriches live CDP tab data with Arc Space names and folder structure. Tabs not found in Arc's sidebar appear under "No Space" (e.g., recently opened tabs not yet synced to sidebar).

## Switch to Existing Tab

```bash
./scripts/switch-tab.js "WhatsApp"              # Search by title/URL, activate best match
./scripts/switch-tab.js --id <targetId>        # Switch by exact targetId
./scripts/switch-tab.js --list                  # List all tabs
./scripts/switch-tab.js --list --visible        # Only visible tabs
./scripts/switch-tab.js --list --json           # JSON output
```

Searches tabs by title/URL substring with scoring (exact > domain > substring). Prefers visible and focused-window tabs. If the best match is in a hidden Arc Space, restores the window automatically. Updates the active-tab state file so subsequent `eval.js`/`screenshot.js`/`pick.js` calls operate on the switched tab.

If multiple tabs tie on score, prints all candidates and activates the first — disambiguate with `--id`.

### Agent Workflow for Tab Switching

1. Run `switch-tab.js "<query>"` to find and activate a tab
2. If ambiguous output, use `switch-tab.js --id <targetId>` to pick exact tab
3. After switching, `eval.js`/`screenshot.js`/`pick.js` operate on that tab

## Stale State Warnings

Consumer scripts (`eval.js`, `screenshot.js`, `pick.js`, `dismiss-cookies.js`, `nav.js`) emit a warning to stderr when the active tab's URL has changed since the state file was written:

```
⚠ State stale: expected "https://example.com", resolved "https://other.com"
```

The script still proceeds on the correctly-resolved tab — the warning is informational, not blocking.

The background watcher (`watch.js`) keeps `active-tab.json` in sync by updating the URL on `Target.targetInfoChanged` events and clearing the state on `Target.targetDestroyed`.
