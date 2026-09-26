/**
 * List Arc Spaces — correlates Arc sidebar data with CDP windows.
 *
 * Reads Arc's StorableSidebar.json and StorableWindows.json to get Space
 * names and tab lists, then queries CDP to map each Space to a browser
 * window and determine visibility/focused state.
 *
 * Usage:
 *   ./scripts/spaces.js              # List all spaces
 *   ./scripts/spaces.js --tabs       # Include tab details per space
 *   ./scripts/spaces.js --json       # Raw JSON output
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.js";

const HOME = process.env["HOME"] || homedir();
const ARC_DATA = join(HOME, "Library", "Application Support", "Arc");

const showTabs = process.argv.includes("--tabs");
const jsonOutput = process.argv.includes("--json");

// ── Arc sidebar parsing ──────────────────────────────────────────────

function loadJson(filename) {
  const path = join(ARC_DATA, filename);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseSpaces(sidebarData) {
  if (!sidebarData) return [];
  const sidebar = sidebarData.sidebar || sidebarData;
  const containers = sidebar.containers || [];
  // Container index 1 holds the user's spaces (index 0 is global)
  const c1 = containers[1] || containers[0] || {};
  const items = c1.items || [];

  // Build item lookup
  const itemMap = new Map();
  for (const item of items) {
    if (typeof item === "object" && item.id) {
      itemMap.set(item.id, item);
    }
  }

  // Recursively collect tabs from a container
  function collectTabs(containerId) {
    const tabs = [];
    const container = itemMap.get(containerId);
    if (!container) return tabs;
    for (const cid of container.childrenIds || []) {
      const child = itemMap.get(cid);
      if (!child) continue;
      const data = child.data;
      if (data && typeof data === "object" && data.tab) {
        const tab = data.tab;
        if (typeof tab === "object") {
          tabs.push({
            id: cid,
            title: tab.savedTitle || child.title || "",
            url: tab.savedURL || "",
          });
        }
      }
      // Recurse into sub-containers (folder nesting)
      tabs.push(...collectTabs(cid));
    }
    return tabs;
  }

  // Parse each space
  const spaces = c1.spaces || [];
  const result = [];
  for (const s of spaces) {
    if (typeof s !== "object" || !s.id) continue;
    const containerIDs = s.containerIDs || [];
    const tabs = [];
    // containerIDs: alternating [label, id, label, id, ...]
    for (let i = 1; i < containerIDs.length; i += 2) {
      if (typeof containerIDs[i] === "string") {
        tabs.push(...collectTabs(containerIDs[i]));
      }
    }
    result.push({
      id: s.id,
      title: s.title || "Unnamed",
      profile: s.profile || null,
      tabs,
    });
  }
  return result;
}

function parseFocusedSpaceId(windowsData) {
  if (!windowsData) return null;
  const windows = windowsData.windows || [];
  // Return last focused space across all windows
  for (const w of windows) {
    if (w.focusedSpaceID) return w.focusedSpaceID;
  }
  return windowsData.lastFocusedSpaceID || null;
}

// ── CDP correlation ──────────────────────────────────────────────────

async function getCdpWindowMap() {
  const cdp = await connect();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");

  const windowMap = new Map(); // windowId -> { bounds, tabs[] }
  for (const p of pages) {
    try {
      const { bounds, windowId } = await cdp.send(
        "Browser.getWindowForTarget",
        { targetId: p.targetId },
        null,
        2000,
      );
      if (!windowMap.has(windowId)) {
        windowMap.set(windowId, { bounds, tabs: [] });
      }
      windowMap.get(windowId).tabs.push({
        targetId: p.targetId,
        title: p.title,
        url: p.url,
        windowId,
      });
    } catch {
      // Target might not support getWindowForTarget
    }
  }

  cdp.close();
  return windowMap;
}

function matchSpaceToWindow(space, cdpWindowMap) {
  // Match by finding a CDP window whose tabs share URLs with this space's tabs
  const spaceUrls = new Set(space.tabs.map((t) => t.url).filter(Boolean));
  if (spaceUrls.size === 0) return null;

  let bestWindowId = null;
  let bestOverlap = 0;

  for (const [windowId, window] of cdpWindowMap) {
    const overlap = window.tabs.filter((t) => spaceUrls.has(t.url)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestWindowId = windowId;
    }
  }

  if (bestOverlap === 0) return null;
  return bestWindowId;
}

// ── Main ─────────────────────────────────────────────────────────────

const sidebarData = loadJson("StorableSidebar.json");
const windowsData = loadJson("StorableWindows.json");
const spaces = parseSpaces(sidebarData);
const focusedSpaceId = parseFocusedSpaceId(windowsData);

let cdpWindowMap;
try {
  cdpWindowMap = await getCdpWindowMap();
} catch (e) {
  console.error(`! Could not connect to CDP: ${e.message}`);
  cdpWindowMap = new Map();
}

// Build space → window mapping
const spaceWindowMap = new Map();
for (const space of spaces) {
  const wid = matchSpaceToWindow(space, cdpWindowMap);
  if (wid) spaceWindowMap.set(space.id, wid);
}

// Also build reverse: windowId -> spaces[]
const windowSpacesMap = new Map();
for (const [spaceId, wid] of spaceWindowMap) {
  if (!windowSpacesMap.has(wid)) windowSpacesMap.set(wid, []);
  windowSpacesMap.get(wid).push(spaceId);
}

// ── Output ───────────────────────────────────────────────────────────

if (jsonOutput) {
  const output = spaces.map((space) => {
    const wid = spaceWindowMap.get(space.id);
    const window = wid ? cdpWindowMap.get(wid) : null;
    return {
      id: space.id,
      title: space.title,
      focused: space.id === focusedSpaceId,
      visible: window
        ? window.bounds.width > 0 && window.bounds.height > 0
        : false,
      windowId: wid || null,
      bounds: window?.bounds || null,
      tabCount: space.tabs.length,
      ...(showTabs ? { tabs: space.tabs } : {}),
    };
  });
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

// Human-readable output
for (const space of spaces) {
  const wid = spaceWindowMap.get(space.id);
  const window = wid ? cdpWindowMap.get(wid) : null;
  const focused = space.id === focusedSpaceId;
  const visible = window
    ? window.bounds.width > 0 && window.bounds.height > 0
    : false;

  const indicators = [];
  if (focused) indicators.push("★ focused");
  if (visible)
    indicators.push(`visible ${window.bounds.width}×${window.bounds.height}`);
  else indicators.push("hidden");

  console.log(
    `▸ ${space.title} (${space.tabs.length} tabs) [${indicators.join(", ")}]`,
  );
  if (wid) console.log(`  windowId: ${wid}`);

  if (showTabs && space.tabs.length > 0) {
    for (const t of space.tabs) {
      const title =
        t.title.length > 55 ? t.title.slice(0, 52) + "..." : t.title;
      const url = t.url.length > 60 ? t.url.slice(0, 57) + "..." : t.url;
      console.log(`  • ${title}`);
      if (showTabs) console.log(`    ${url}`);
    }
  }
}
