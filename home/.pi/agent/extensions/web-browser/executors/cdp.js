/**
 * Minimal CDP client - no puppeteer, no hangs
 */

import WebSocket from "ws";
import { readActiveTab, writeActiveTab } from "./active-tab.js";

const DEBUG_HOST = process.env.BROWSER_DEBUG_HOST || "localhost";
const DEBUG_PORT = Number(process.env.BROWSER_DEBUG_PORT || 9222);
const DEBUG_HTTP_URL = `http://${DEBUG_HOST}:${DEBUG_PORT}`;

export async function connect(timeout = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(`${DEBUG_HTTP_URL}/json/version`, {
      signal: controller.signal,
    });
    const { webSocketDebuggerUrl } = await resp.json();
    clearTimeout(timeoutId);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      const connectTimeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connect timeout"));
      }, timeout);

      ws.on("open", () => {
        clearTimeout(connectTimeout);
        resolve(new CDP(ws));
      });
      ws.on("error", (e) => {
        clearTimeout(connectTimeout);
        reject(e);
      });
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error(
        `Connection timeout - is Chrome running with --remote-debugging-port=${DEBUG_PORT}?`,
      );
    }
    throw e;
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.callbacks = new Map();
    this.sessions = new Map();
    this.eventHandlers = new Map();

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
        return;
      }

      if (msg.method) {
        this.emit(msg.method, msg.params || {}, msg.sessionId || null);
      }
    });
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set());
    }
    this.eventHandlers.get(method).add(handler);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const handlers = this.eventHandlers.get(method);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.eventHandlers.delete(method);
    }
  }

  emit(method, params, sessionId) {
    const handlers = this.eventHandlers.get(method);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(params, sessionId);
      } catch {
        // Ignore handler errors to keep CDP session alive.
      }
    }
  }

  send(method, params = {}, sessionId = null, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const msgId = ++this.id;
      const msg = { id: msgId, method, params };
      if (sessionId) msg.sessionId = sessionId;

      const timeoutId = setTimeout(() => {
        this.callbacks.delete(msgId);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);

      this.callbacks.set(msgId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  async getPages() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page");
  }

  /**
   * Check if a target is in a visible window (non-zero bounds).
   */
  async isTargetVisible(targetId) {
    try {
      const { bounds } = await this.send(
        "Browser.getWindowForTarget",
        { targetId },
        null,
        2000,
      );
      return bounds && bounds.width > 0 && bounds.height > 0;
    } catch {
      // Can't determine — assume visible
      return true;
    }
  }

  /**
   * Find the active page using three strategies:
   *   1. State file — last targetId saved by nav.js (validated as visible)
   *   2. Visible window heuristic — pages in windows with non-zero bounds
   *   3. Fallback — last page (original behaviour)
   *
   * After browser launch, windows may not be rendered yet (0x0 bounds).
   * Retries up to 3 times with 500ms delay to handle this race.
   */
  async getActivePage() {
    const pages = await this.getPages();
    if (pages.length === 0) return null;

    const state = readActiveTab();
    const stateTargetId = state?.targetId || null;
    const stateUrl = state?.url || null;

    // Strategy 1: state file (must be in a visible window)
    if (stateTargetId) {
      const match = pages.find((p) => p.targetId === stateTargetId);
      if (match && (await this.isTargetVisible(match.targetId))) {
        return {
          ...match,
          stale: stateUrl && match.url !== stateUrl,
          stateUrl,
        };
      }
    }

    // Strategy 2: visible-window heuristic (with retry for browser startup race)
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const currentPages = attempt === 0 ? pages : await this.getPages();
        if (currentPages.length === 0) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        const visible = [];
        for (const p of currentPages) {
          if (await this.isTargetVisible(p.targetId)) {
            visible.push(p);
          }
        }
        if (visible.length > 0) {
          const result = visible.at(-1);
          // Update state file for faster subsequent lookups
          writeActiveTab(result.targetId, result.url);
          return {
            ...result,
            stale: stateTargetId !== result.targetId,
            stateUrl,
          };
        }
        // No visible pages yet — browser windows may still be initializing
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {
      // heuristic failed — fall through
    }

    // Strategy 3: fallback — any page is better than none
    const finalPages = await this.getPages();
    if (finalPages.length === 0) return null;
    const fallback = finalPages.at(-1);
    return {
      ...fallback,
      stale: stateTargetId !== fallback.targetId,
      stateUrl,
    };
  }

  /**
   * Wait for at least one page target to exist, then return the active page.
   * Useful right after browser launch when no tabs exist yet.
   */
  async waitForActivePage(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const page = await this.getActivePage();
      if (page) return page;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  async attachToPage(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return sessionId;
  }

  async evaluate(sessionId, expression, timeout = 30000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      timeout
    );

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      );
    }
    return result.result?.value;
  }

  async screenshot(sessionId, timeout = 10000) {
    const { data } = await this.send(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
      timeout
    );
    return Buffer.from(data, "base64");
  }

  async navigate(sessionId, url, timeout = 30000) {
    await this.send("Page.navigate", { url }, sessionId, timeout);
  }

  async getFrameTree(sessionId) {
    const { frameTree } = await this.send("Page.getFrameTree", {}, sessionId);
    return frameTree;
  }

  async evaluateInFrame(sessionId, frameId, expression, timeout = 30000) {
    // Create isolated world for the frame
    const { executionContextId } = await this.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "cdp-eval" },
      sessionId
    );

    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        contextId: executionContextId,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      timeout
    );

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      );
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}
