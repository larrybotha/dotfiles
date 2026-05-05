#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.js";
import {
  applyDevicePreset,
  clearDeviceEmulation,
  listDevicePresets,
  resolveDevicePreset,
} from "./devices.js";
import { applyActiveEmulation } from "./emulation-state.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[debug]", ...args) : () => {};

function printUsage() {
  console.log("Usage: screenshot.js [--full-page] [--device <preset>] [--landscape] [--selector <CSS>]");
  console.log("\nExamples:");
  console.log("  screenshot.js");
  console.log("  screenshot.js --full-page");
  console.log("  screenshot.js --device iphone-14");
  console.log("  screenshot.js --device pixel-7 --full-page");
  console.log("  screenshot.js --selector '.card'");
  console.log("  screenshot.js --selector '#hero' --full-page");
}

const args = process.argv.slice(2);
let fullPage = false;
let landscape = false;
let deviceName = null;
let selector = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--full-page") {
    fullPage = true;
    continue;
  }

  if (arg === "--landscape") {
    landscape = true;
    continue;
  }

  if (arg === "--device") {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error("✗ --device requires a preset name");
      printUsage();
      process.exit(1);
    }
    deviceName = value;
    i += 1;
    continue;
  }

  if (arg === "--selector") {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error("✗ --selector requires a CSS selector");
      printUsage();
      process.exit(1);
    }
    selector = value;
    i += 1;
    continue;
  }

  if (arg === "--help") {
    printUsage();
    process.exit(0);
  }

  console.error(`✗ Unknown argument: ${arg}`);
  printUsage();
  process.exit(1);
}

const preset = deviceName ? resolveDevicePreset(deviceName) : null;
if (landscape && !preset) {
  console.error("✗ --landscape requires --device <preset>");
  printUsage();
  process.exit(1);
}

if (deviceName && !preset) {
  console.error(`✗ Unknown device preset: ${deviceName}`);
  console.error("  Available presets:");
  for (const item of listDevicePresets()) {
    console.error(`  - ${item.id}`);
  }
  process.exit(1);
}

// Global timeout
const globalTimeout = setTimeout(() => {
  console.error("✗ Global timeout exceeded (30s)");
  process.exit(1);
}, 30000);

let cdp = null;

try {
  log("connecting...");
  cdp = await connect(5000);

  log("getting active page...");
  const page = await cdp.waitForActivePage();

  if (!page) {
    console.error("✗ No active tab found");
    process.exit(1);
  }

  if (page.stale) {
    console.error(`⚠ State stale: expected "${page.stateUrl}", resolved "${page.url}"`);
  }

  log("attaching to page...");
  const sessionId = await cdp.attachToPage(page.targetId);

  let temporaryEmulationApplied = false;

  try {
    if (preset) {
      log("applying temporary device emulation...");
      await applyDevicePreset(cdp, sessionId, preset, { landscape });
      temporaryEmulationApplied = true;
    } else {
      log("applying active emulation (if configured)...");
      await applyActiveEmulation(cdp, sessionId);
    }

    // Resolve selector to clip region if provided
    let clipFromSelector = null;
    if (selector) {
      log(`resolving selector: ${selector}`);
      const evalResult = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return JSON.stringify({ error: "Element not found", selector: ${JSON.stringify(selector)} });
            const r = el.getBoundingClientRect();
            const scrollX = window.scrollX;
            const scrollY = window.scrollY;
            // Scroll element into view first
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            // Re-read rect after scroll
            const r2 = el.getBoundingClientRect();
            return JSON.stringify({
              x: r2.x + window.scrollX,
              y: r2.y + window.scrollY,
              width: r2.width,
              height: r2.height,
              scrolled: true
            });
          })()`,
          returnByValue: true,
        },
        sessionId,
        5000,
      );

      const parsed = JSON.parse(evalResult.result.value);
      if (parsed.error) {
        throw new Error(parsed.error);
      }

      clipFromSelector = {
        x: Math.floor(parsed.x),
        y: Math.floor(parsed.y),
        width: Math.max(1, Math.ceil(parsed.width)),
        height: Math.max(1, Math.ceil(parsed.height)),
        scale: 1,
      };

      log(`selector clip region:`, clipFromSelector);
    }

    let params = { format: "png" };

    if (clipFromSelector) {
      // For selector screenshots, need full-page metrics to capture beyond viewport
      log("reading layout metrics for selector clip...");
      params = {
        ...params,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: clipFromSelector,
      };
    } else if (fullPage) {
      log("reading layout metrics...");
      const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId, 10000);
      const contentSize = metrics.cssContentSize || metrics.contentSize;

      if (!contentSize) {
        throw new Error("Could not determine page size for full-page screenshot");
      }

      params = {
        ...params,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.max(1, Math.ceil(contentSize.width)),
          height: Math.max(1, Math.ceil(contentSize.height)),
          scale: 1,
        },
      };
    }

    log("taking screenshot...");
    const { data } = await cdp.send(
      "Page.captureScreenshot",
      params,
      sessionId,
      fullPage ? 20000 : 10000,
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenshot-${timestamp}.png`;
    const filepath = join(tmpdir(), filename);

    writeFileSync(filepath, Buffer.from(data, "base64"));
    console.log(filepath);
  } finally {
    if (temporaryEmulationApplied) {
      try {
        log("clearing temporary device emulation...");
        await clearDeviceEmulation(cdp, sessionId);
      } catch (e) {
        log("failed to clear device emulation", e.message);
      }
    }
  }

  log("closing...");
  cdp.close();
  log("done");
} catch (e) {
  console.error("✗", e.message);
  process.exit(1);
} finally {
  clearTimeout(globalTimeout);
  if (cdp) {
    try {
      cdp.close();
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(0), 100);
}
