#!/usr/bin/env node

/**
 * Switch to an existing tab — search, score, activate.
 *
 * Resolves a query (title/URL substring, or exact targetId) to a tab,
 * brings its window to the foreground if hidden, activates the tab,
 * and updates the active-tab state file.
 *
 * Usage:
 *   ./scripts/switch-tab.js <query>                  # Search by title or URL
 *   ./scripts/switch-tab.js --id <targetId>           # Switch by exact targetId
 *   ./scripts/switch-tab.js --list                    # List all tabs (like arc-tabs but browser-agnostic)
 *   ./scripts/switch-tab.js --list --json             # JSON output
 *   ./scripts/switch-tab.js --list --visible          # Only visible tabs
 */

import { connect } from "./cdp.js";
import { writeActiveTab } from "./active-tab.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env["HOME"] || homedir();
const ARC_DATA = join(HOME, "Library", "Application Support", "Arc");

const args = process.argv.slice(2);
const isList = args.includes("--list");
const isJson = args.includes("--json");
const onlyVisible = args.includes("--visible");

// Parse --id flag
const idIdx = args.indexOf("--id");
const targetIdArg = idIdx !== -1 ? args[idIdx + 1] : null;

// Query is all positional args that aren't flags
const query = args
  .filter((a) => !a.startsWith("--") && a !== targetIdArg)
  .join(" ")
  .trim();

// ── Arc sidebar enrichment ────────────────────────────────────────────

function loadArcSpaces() {
  const path = join(ARC_DATA, "StorableSidebar.json");
  if (!existsSync(path)) return new Map(); // url -> { spaceTitle, folder }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const sidebar = data.sidebar || data;
    const containers = sidebar.containers || [];
    const c1 = containers[1] || containers[0] || {};
    const items = c1.items || [];

    const itemMap = new Map();
    for (const item of items) {
      if (typeof item === "object" && item.id) itemMap.set(item.id, item);
    }

    function collectTabs(containerId, folderChain = []) {
      const tabs = [];
      const container = itemMap.get(containerId);
      if (!container) return tabs;
      const folderName = container.title || null;
      const chain = folderName ? [...folderChain, folderName] : folderChain;
      for (const cid of container.childrenIds || []) {
        const child = itemMap.get(cid);
        if (!child) continue;
        const d = child.data;
        if (d && typeof d === "object" && d.tab) {
          const tab = d.tab;
          if (typeof tab === "object") {
            tabs.push({
              url: tab.savedURL || "",
              spaceTitle: null, // filled below
              folder: chain.length > 0 ? chain.join(" / ") : null,
            });
          }
        }
        tabs.push(...collectTabs(cid, chain));
      }
      return tabs;
    }

    const spaces = c1.spaces || [];
    const urlMap = new Map();
    for (const s of spaces) {
      if (typeof s !== "object" || !s.id) continue;
      const title = s.title || "Unnamed";
      const containerIDs = s.containerIDs || [];
      const tabs = [];
      for (let i = 1; i < containerIDs.length; i += 2) {
        if (typeof containerIDs[i] === "string") {
          tabs.push(...collectTabs(containerIDs[i]));
        }
      }
      for (const t of tabs) {
        if (t.url) {
          t.spaceTitle = title;
          urlMap.set(t.url, t);
        }
      }
    }
    return urlMap;
  } catch {
    return new Map();
  }
}

function loadArcFocusedSpace() {
  const path = join(ARC_DATA, "StorableWindows.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const windows = data.windows || [];
    for (const w of windows) {
      if (w.focusedSpaceID) return w.focusedSpaceID;
    }
    return data.lastFocusedSpaceID || null;
  } catch {
    return null;
  }
}

// ── CDP helpers ──────────────────────────────────────────────────────

async function getEnrichedPages(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");

  const arcUrlMap = loadArcSpaces();
  const focusedSpaceId = loadArcFocusedSpace();

  const enriched = [];
  for (const p of pages) {
    let windowId = null;
    let bounds = null;
    let visible = false;
    try {
      const result = await cdp.send(
        "Browser.getWindowForTarget",
        { targetId: p.targetId },
        null,
        2000,
      );
      windowId = result.windowId;
      bounds = result.bounds;
      visible = bounds.width > 0 && bounds.height > 0;
    } catch {
      // can't determine window
    }

    const arcInfo = arcUrlMap.get(p.url) || null;
    enriched.push({
      targetId: p.targetId,
      title: p.title || "",
      url: p.url || "",
      windowId,
      bounds,
      visible,
      spaceTitle: arcInfo?.spaceTitle || null,
      folder: arcInfo?.folder || null,
      focusedSpace: arcInfo?.spaceTitle
        ? focusedSpaceId && arcUrlMap.get(p.url)?.spaceTitle === focusedSpaceId
        : null,
    });
  }
  return enriched;
}

// ── Scoring ──────────────────────────────────────────────────────────

function scoreTab(tab, query) {
  const q = query.toLowerCase();
  let score = 0;

  // URL match
  const urlLower = tab.url.toLowerCase();
  if (urlLower === q) score += 100;
  else if (urlLower.includes(q)) score += 80;

  // Domain match (extract hostname)
  try {
    const hostname = new URL(tab.url).hostname.toLowerCase();
    if (hostname === q) score += 95;
    else if (hostname.includes(q)) score += 60;
  } catch {
    // not a valid URL
  }

  // Title match
  const titleLower = tab.title.toLowerCase();
  if (titleLower === q) score += 90;
  else if (titleLower.includes(q)) score += 70;

  // Arc space/folder match
  if (tab.spaceTitle?.toLowerCase().includes(q)) score += 30;
  if (tab.folder?.toLowerCase().includes(q)) score += 20;

  // Preference: visible > hidden, focused window > other
  if (tab.visible) score += 10;
  if (tab.focusedSpace) score += 20;

  return score;
}

// ── Window activation ─────────────────────────────────────────────────

async function activateWindow(cdp, windowId, bounds) {
  // If window is hidden (0×0 or minimized), restore it
  if (!bounds || bounds.width === 0 || bounds.height === 0) {
    // Use reasonable defaults — Arc typically uses ~1728×1083
    await cdp.send(
      "Browser.setWindowBounds",
      {
        windowId,
        bounds: { windowState: "normal" },
      },
      null,
      5000,
    );
  }
}

// ── List mode ────────────────────────────────────────────────────────

async function listMode() {
  const cdp = await connect(5000);
  const pages = await getEnrichedPages(cdp);
  cdp.close();

  let filtered = onlyVisible ? pages.filter((t) => t.visible) : pages;

  if (isJson) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  // Group by space
  const bySpace = new Map();
  for (const t of filtered) {
    const key = t.spaceTitle || "No Space";
    if (!bySpace.has(key)) bySpace.set(key, []);
    bySpace.get(key).push(t);
  }

  for (const [spaceName, tabs] of bySpace) {
    const vis = tabs.some((t) => t.visible) ? "visible" : "hidden";
    console.log(`▸ ${spaceName} (${tabs.length} tabs, ${vis})`);
    for (const t of tabs) {
      const dot = t.visible ? "●" : "○";
      const title =
        t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title;
      const folderTag = t.folder ? ` [${t.folder}]` : "";
      console.log(`  ${dot} ${title}${folderTag}`);
    }
    console.log();
  }
}

// ── Switch mode ───────────────────────────────────────────────────────

async function switchMode() {
  if (!query && !targetIdArg) {
    console.error("✗ Provide a query or --id <targetId>");
    console.error("  switch-tab.js <query>       # Search by title/URL");
    console.error("  switch-tab.js --id ABC123   # Switch by targetId");
    console.error("  switch-tab.js --list        # List all tabs");
    process.exit(1);
  }

  const cdp = await connect(5000);
  const pages = await getEnrichedPages(cdp);

  // Direct targetId match
  if (targetIdArg) {
    const match = pages.find((p) => p.targetId === targetIdArg);
    if (!match) {
      console.error(`✗ No tab with targetId: ${targetIdArg}`);
      cdp.close();
      process.exit(1);
    }

    await activateWindow(cdp, match.windowId, match.bounds);
    await cdp.send("Target.activateTarget", { targetId: match.targetId }, null, 5000);
    writeActiveTab(match.targetId, match.url);
    console.log(`✓ Switched to: ${match.title}`);
    console.log(`  ${match.url}`);
    if (match.spaceTitle) console.log(`  Space: ${match.spaceTitle}`);
    cdp.close();
    return;
  }

  // Score all tabs
  const scored = pages
    .map((p) => ({ ...p, score: scoreTab(p, query) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  // Exclude tabs that only scored on visibility/focused bonuses (no actual query match)
  const matched = scored.filter((p) => p.score > 30);

  if (matched.length === 0) {
    console.error(`✗ No tabs match "${query}"`);
    // Show closest tabs for guidance
    const all = pages.slice(0, 5);
    if (all.length > 0) {
      console.error("  Open tabs:");
      for (const t of all) {
        console.error(`    ${t.title.slice(0, 50)}  (${t.url.slice(0, 50)})`);
      }
    }
    cdp.close();
    process.exit(1);
  }

  // Check for true tie (same score, can't auto-resolve)
  const best = matched[0];
  const tied = matched.filter(
    (s) => s.score === best.score && s.targetId !== best.targetId,
  );

  if (tied.length > 0) {
    console.error(`? Multiple tabs match "${query}" (score: ${best.score}):`);
    console.error(`  [0] ${best.visible ? "●" : "○"} ${best.title}`);
    console.error(`      ${best.url}`);
    if (best.spaceTitle) console.error(`      Space: ${best.spaceTitle}`);
    for (let i = 0; i < tied.length; i++) {
      const t = tied[i];
      console.error(`  [${i + 1}] ${t.visible ? "●" : "○"} ${t.title}`);
      console.error(`      ${t.url}`);
      if (t.spaceTitle) console.error(`      Space: ${t.spaceTitle}`);
    }
    console.error(`Use: switch-tab.js --id <targetId>`);
    // Activate the first one anyway
  }

  // Activate best match
  await activateWindow(cdp, best.windowId, best.bounds);
  await cdp.send("Target.activateTarget", { targetId: best.targetId }, null, 5000);
  writeActiveTab(best.targetId, best.url);

  console.log(`✓ Switched to: ${best.title}`);
  console.log(`  ${best.url}`);
  if (best.spaceTitle) console.log(`  Space: ${best.spaceTitle}`);
  if (!best.visible && best.bounds) {
    console.log(`  (restored hidden window)`);
  }

  cdp.close();
}

// ── Main ─────────────────────────────────────────────────────────────

if (isList) {
  await listMode();
} else {
  await switchMode();
}
