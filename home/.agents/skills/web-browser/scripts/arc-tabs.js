/**
 * List all browser tabs enriched with Arc Space names.
 *
 * Combines CDP page data (live tabs) with Arc sidebar data (Space names,
 * folder structure) to show which Space each tab belongs to.
 *
 * Usage:
 *   ./scripts/arc-tabs.js              # List all tabs with space info
 *   ./scripts/arc-tabs.js --visible    # Only visible windows
 *   ./scripts/arc-tabs.js --json      # Raw JSON output
 *   ./scripts/arc-tabs.js --space "HS Dev"  # Filter by space name
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.js";

const HOME = process.env["HOME"] || homedir();
const ARC_DATA = join(HOME, "Library", "Application Support", "Arc");

const onlyVisible = process.argv.includes("--visible");
const jsonOutput = process.argv.includes("--json");
const spaceFilterIdx = process.argv.indexOf("--space");
const spaceFilter =
  spaceFilterIdx !== -1 ? process.argv[spaceFilterIdx + 1] : null;

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
  const c1 = containers[1] || containers[0] || {};
  const items = c1.items || [];

  const itemMap = new Map();
  for (const item of items) {
    if (typeof item === "object" && item.id) {
      itemMap.set(item.id, item);
    }
  }

  function collectTabs(containerId, folderChain = []) {
    const tabs = [];
    const container = itemMap.get(containerId);
    if (!container) return tabs;
    const folderName = container.title || null;
    const chain = folderName
      ? [...folderChain, folderName]
      : folderChain;
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
            folder: chain.length > 0 ? chain.join(" / ") : null,
          });
        }
      }
      tabs.push(...collectTabs(cid, chain));
    }
    return tabs;
  }

  const spaces = c1.spaces || [];
  const result = [];
  for (const s of spaces) {
    if (typeof s !== "object" || !s.id) continue;
    const containerIDs = s.containerIDs || [];
    const tabs = [];
    for (let i = 1; i < containerIDs.length; i += 2) {
      if (typeof containerIDs[i] === "string") {
        tabs.push(...collectTabs(containerIDs[i]));
      }
    }
    result.push({
      id: s.id,
      title: s.title || "Unnamed",
      tabs,
    });
  }
  return result;
}

// ── CDP data ─────────────────────────────────────────────────────────

async function getCdpPages() {
  const cdp = await connect();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");

  const enriched = [];
  for (const p of pages) {
    try {
      const { bounds, windowId } = await cdp.send(
        "Browser.getWindowForTarget",
        { targetId: p.targetId },
        null,
        2000,
      );
      enriched.push({
        targetId: p.targetId,
        title: p.title,
        url: p.url,
        windowId,
        bounds,
        visible: bounds.width > 0 && bounds.height > 0,
      });
    } catch {
      enriched.push({
        targetId: p.targetId,
        title: p.title,
        url: p.url,
        windowId: null,
        bounds: null,
        visible: false,
      });
    }
  }

  cdp.close();
  return enriched;
}

// ── Space → window mapping via URL overlap ───────────────────────────

function buildSpaceWindowMap(spaces, cdpPages) {
  const map = new Map(); // spaceId -> windowId

  // Group CDP pages by windowId
  const windowUrls = new Map(); // windowId -> Set<url>
  for (const p of cdpPages) {
    if (!p.windowId) continue;
    if (!windowUrls.has(p.windowId)) windowUrls.set(p.windowId, new Set());
    if (p.url) windowUrls.get(p.windowId).add(p.url);
  }

  for (const space of spaces) {
    const spaceUrls = new Set(space.tabs.map((t) => t.url).filter(Boolean));
    if (spaceUrls.size === 0) continue;

    let bestWindow = null;
    let bestOverlap = 0;

    for (const [wid, urls] of windowUrls) {
      const overlap = [...urls].filter((u) => spaceUrls.has(u)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestWindow = wid;
      }
    }

    if (bestOverlap > 0) map.set(space.id, bestWindow);
  }

  return map;
}

// ── Build URL → space lookup ─────────────────────────────────────────

function buildUrlSpaceMap(spaces, spaceWindowMap) {
  const map = new Map(); // url -> { spaceId, spaceTitle, folder }
  for (const space of spaces) {
    for (const tab of space.tabs) {
      if (tab.url) {
        map.set(tab.url, {
          spaceId: space.id,
          spaceTitle: space.title,
          folder: tab.folder,
        });
      }
    }
  }
  return map;
}

// ── Main ─────────────────────────────────────────────────────────────

const sidebarData = loadJson("StorableSidebar.json");
const spaces = parseSpaces(sidebarData);

let cdpPages;
try {
  cdpPages = await getCdpPages();
} catch (e) {
  console.error(`⚠ Could not connect to CDP: ${e.message}`);
  process.exit(1);
}

const spaceWindowMap = buildSpaceWindowMap(spaces, cdpPages);
const urlSpaceMap = buildUrlSpaceMap(spaces, spaceWindowMap);

// Enrich CDP pages with space info
const enriched = cdpPages.map((p) => {
  const spaceInfo = urlSpaceMap.get(p.url) || null;
  return {
    ...p,
    spaceId: spaceInfo?.spaceId || null,
    spaceTitle: spaceInfo?.spaceTitle || null,
    folder: spaceInfo?.folder || null,
  };
});

// Apply filters
let filtered = enriched;
if (onlyVisible) {
  filtered = filtered.filter((t) => t.visible);
}
if (spaceFilter) {
  filtered = filtered.filter(
    (t) => t.spaceTitle && t.spaceTitle.toLowerCase().includes(spaceFilter.toLowerCase()),
  );
}

// ── Output ───────────────────────────────────────────────────────────

if (jsonOutput) {
  console.log(JSON.stringify(filtered, null, 2));
  process.exit(0);
}

// Group by space for display
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
    const title =
      t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title;
    const folderTag = t.folder ? ` [${t.folder}]` : "";
    const active = t.visible ? "●" : "○";
    console.log(`  ${active} ${title}${folderTag}`);
  }
  console.log();
}
