#!/usr/bin/env node
/**
 * annotate.js — visual annotation session driver (CDP).
 *
 * Targets the recorded active tab only. Injects annotate/ui.js into a CDP
 * isolated world ("pi-annotate"), starts the session, serves screenshot
 * requests over the `piAnnotateEvent` binding, and waits for the UI's start()
 * promise (submit or cancel). Writes screenshots to tmpdir; stdout is one
 * JSON object — { ok, result, files } — never base64.
 *
 * Usage: annotate.js [--timeout <seconds>]   (default 300)
 * Env:   BROWSER_DEBUG_HOST / BROWSER_DEBUG_PORT, DEBUG=1
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.js";
import { applyActiveEmulation } from "./emulation-state.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[debug]", ...args) : () => {};

const UI_PATH = fileURLToPath(new URL("../annotate/ui.js", import.meta.url));
const WORLD_NAME = "pi-annotate";
const BINDING = "piAnnotateEvent";
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024; // 15MB

// executors run from index.ts via runSkill with a 320s budget; internal
// budgets keep the executor inside it
const T_SCREENSHOT = 15_000;
const T_CANCEL = 2_000;

function parseArgs() {
  const out = { timeout: 300 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timeout") {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) out.timeout = Math.min(n, 310);
      i++;
    }
  }
  return out;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/.test(url);
}

function stripDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    throw new Error("invalid screenshot data");
  }
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error("screenshot too large");
  }
  return buffer;
}

async function writeScreenshot(dataUrl, name) {
  const buffer = stripDataUrl(dataUrl);
  const file = path.join(os.tmpdir(), `browser-annotate-${Date.now()}-${name}.png`);
  await fs.promises.writeFile(file, buffer);
  return file;
}

async function main() {
  const { timeout } = parseArgs();
  const cdp = await connect(5000);
  let bindingAdded = false;

  try {
    log("recorded page...");
    const rec = await cdp.getRecordedPage();
    if (rec.error) {
      console.error(`✗ ${rec.error}`);
      process.exit(1);
    }
    const page = rec.page;

    if (isRestrictedUrl(page.url)) {
      console.error(
        `✗ recorded tab is a restricted URL (${page.url}) — browser_annotate with a url navigates first`,
      );
      process.exit(1);
    }

    log("attach + emulation...");
    const sessionId = await cdp.attachToPage(page.targetId);
    await applyActiveEmulation(cdp, sessionId);

    const frameTree = await cdp.getFrameTree(sessionId);
    const frameId = frameTree.frame.id;

    // supersede any live session on this document (a stale run in another
    // pi process — DOM events cross isolated worlds, so the old world's
    // listener hears this): cancel event first, #pi-cancel click as the
    // version-independent fallback
    log("supersede check...");
    if (
      await cdp.evaluate(
        sessionId,
        `!!document.getElementById("pi-panel")`,
        5000,
      )
    ) {
      await cdp.evaluate(
        sessionId,
        `(() => {
          document.dispatchEvent(new CustomEvent("pi-annotate:cancel"));
          document.getElementById("pi-cancel")?.click();
          return true;
        })()`,
        5000,
      );
      const start = Date.now();
      while (Date.now() - start < 2000) {
        if (
          !(await cdp.evaluate(
            sessionId,
            `!!document.getElementById("pi-panel")`,
            2000,
          ))
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    log("isolated world...");
    // unique world per run: worlds are keyed by (frame, name) — a reused
    // name would no-op the injection guard against a stale world
    const worldName = `${WORLD_NAME}-${Date.now()}`;
    const { executionContextId } = await cdp.send(
      "Page.createIsolatedWorld",
      { frameId, worldName },
      sessionId,
    );

    const evalInWorld = (
      expression,
      { awaitPromise = false, timeout = 10_000 } = {},
    ) =>
      cdp.send(
        "Runtime.evaluate",
        {
          expression,
          contextId: executionContextId,
          returnByValue: true,
          awaitPromise,
        },
        sessionId,
        timeout,
      );

    const assertOk = (r, what) => {
      if (r.exceptionDetails) {
        throw new Error(
          r.exceptionDetails.exception?.description ||
            r.exceptionDetails.text ||
            `evaluate failed: ${what}`,
        );
      }
      return r.result?.value;
    };

    // per-context binding: only the isolated world can call it
    await cdp.send(
      "Runtime.addBinding",
      { name: BINDING, executionContextId },
      sessionId,
    );
    bindingAdded = true;

    // screenshot requests: UI → binding → Page.captureScreenshot → UI
    const onBinding = (params) => {
      if (params.name !== BINDING) return;
      void (async () => {
        let request = null;
        try {
          request = JSON.parse(params.payload);
        } catch {
          return;
        }
        if (request?.type !== "screenshot" || !Number.isInteger(request.id)) {
          return;
        }
        try {
          const { data } = await cdp.send(
            "Page.captureScreenshot",
            { format: "png" },
            sessionId,
            T_SCREENSHOT,
          );
          await evalInWorld(
            `window.__piAnnotateScreenshotResult(${request.id}, ${JSON.stringify(`data:image/png;base64,${data}`)})`,
          );
        } catch (err) {
          log("screenshot request failed:", err.message);
          try {
            await evalInWorld(
              `window.__piAnnotateScreenshotResult(${request.id}, null)`,
            );
          } catch {
            // world gone — session is ending anyway
          }
        }
      })();
    };
    cdp.on("Runtime.bindingCalled", onBinding);

    log("inject UI...");
    const uiSource = fs.readFileSync(UI_PATH, "utf8");
    assertOk(await evalInWorld(uiSource), "ui injection");

    log("start session...");
    let result;
    try {
      const start = await evalInWorld("window.__piAnnotate.start()", {
        awaitPromise: true,
        timeout: timeout * 1000,
      });
      result = assertOk(start, "annotation session");
    } catch (err) {
      // best-effort teardown so the UI does not linger on the page
      try {
        await evalInWorld("window.__piAnnotate.cancel('timeout')", {
          timeout: T_CANCEL,
        });
      } catch {
        // world gone — navigation or close already ended it
      }
      throw err;
    }

    // write screenshots, strip payloads
    const files = {};
    if (result.screenshot) {
      files.full = await writeScreenshot(result.screenshot, "full");
      delete result.screenshot;
    }
    if (Array.isArray(result.screenshots) && result.screenshots.length > 0) {
      files.elements = [];
      for (let i = 0; i < result.screenshots.length; i++) {
        const shot = result.screenshots[i];
        if (!shot?.dataUrl) continue;
        const index = Number.isFinite(shot.index) ? shot.index : i + 1;
        files.elements.push({
          index,
          path: await writeScreenshot(shot.dataUrl, `el${index}`),
        });
      }
      delete result.screenshots;
    }
    if (result.editCapture?.beforeScreenshot) {
      files.before = await writeScreenshot(
        result.editCapture.beforeScreenshot,
        "before",
      );
      delete result.editCapture.beforeScreenshot;
    }
    if (result.editCapture?.afterScreenshot) {
      files.after = await writeScreenshot(
        result.editCapture.afterScreenshot,
        "after",
      );
      delete result.editCapture.afterScreenshot;
    }

    console.log(JSON.stringify({ ok: true, result, files }));
  } finally {
    // session-level teardown, best-effort: the world dies with the frame on
    // navigation; nothing to clean then
    if (bindingAdded) {
      try {
        await cdp.send(
          "Runtime.removeBinding",
          { name: BINDING },
          sessionId,
          1000,
        );
      } catch {
        // endpoint closed or session destroyed — process is exiting
      }
    }
    try {
      cdp.close();
    } catch {
      // already closed
    }
  }
}

main().catch((e) => {
  const m = e?.message || String(e);
  const message = m.startsWith("CDP timeout")
    ? "annotation timed out — the executor budget (default 300s) ran out"
    : m.includes("Target closed") ||
        m.includes("session not found") ||
        m.includes("Cannot find context")
      ? "page navigated or closed during annotation — session lost"
      : m;
  console.error(`✗ ${message}`);
  process.exit(1);
});
