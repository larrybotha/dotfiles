/**
 * Active tab state — persists last-used targetId across script invocations.
 *
 * State file: ~/.cache/agent-web/browser/active-tab.json
 * Written by: nav.js (after navigation)
 * Read by:    eval.js, screenshot.js, pick.js, dismiss-cookies.js, nav.js
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env["HOME"] || homedir();
const STATE_FILE = join(HOME, ".cache", "agent-web", "browser", "active-tab.json");

export function readActiveTab() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeActiveTab(targetId, url) {
  const dir = join(HOME, ".cache", "agent-web", "browser");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ targetId, url, updatedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}

export function clearActiveTab() {
  try {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}
