// Registry machine for the tmux extension.
// Flat machine: registry context + guards + pure validators shared with tool
// prechecks (single source of truth). No IO here — executors own IO, tools
// embed probe evidence in events. empty/active discriminate legality for
// nothing; value = inspector + single mutation path, not state gating.
//
// Owner isolation: context.owner = this pi instance's pid ("" = unidentified,
// isolation off); entries carry the creating pi's pid (null = orphan/untagged).
// KILL legality (validateKill, shared guard + tool precheck) rejects sessions
// owned by another live pi — cross-instance kill protection on the shared
// pi.sock. Dead is sticky to stale events: PROMPT_SEEN/PROMPT_TIMEOUT are
// legal only from waiting_prompt — dead/failed entries are never resurrected
// by late tool results. RECONCILE alone may correct dead→ready, on fresh
// probe evidence (ground truth beats a misjudged prompt-wait).

import { setup, assign } from "xstate";

export type SessionStatus = "starting" | "waiting_prompt" | "ready" | "failed" | "dead";

export interface SessionEntry {
  id: string; // pi-<slug>-<n>; n = first free suffix
  socket: string; // "pi.sock"
  tool: string; // python, gdb, ...; "?" for adopted strays
  promptRegex: string | null;
  status: SessionStatus;
  waitAttempts: number; // tmux_wait timeouts; reset by WAIT_MATCHED
  monitor: boolean; // keep alive across pi quit (/tmux monitor <id>)
  owner: string | null; // creating pi's pid (PI_OWNER session env); null = orphan/untagged
}

export interface RegistryLimits {
  maxSessions: number;
  maxPromptWaits: number;
  maxWaitAttempts: number;
}

export interface RegistryContext {
  sessions: SessionEntry[];
  limits: RegistryLimits;
  owner: string; // this pi instance's pid ("" = unidentified, isolation off)
}

export interface MachineInput {
  limits?: RegistryLimits;
  owner?: string;
}

function num(env: string, fallback: number): number {
  const v = process.env[env];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const DEFAULT_LIMITS: RegistryLimits = {
  maxSessions: num("TMUX_MAX_SESSIONS", 3),
  maxPromptWaits: num("TMUX_MAX_PROMPT_WAITS", 2),
  maxWaitAttempts: num("TMUX_MAX_WAIT_ATTEMPTS", 3),
};

export type TmuxEvent =
  | { type: "RESTORE"; registry: RegistryContext }
  | { type: "SESSION_START"; tool: string; cmd: string; promptRegex: string | null; liveCount: number }
  | { type: "SESSION_STARTED"; id: string; tool: string; promptRegex: string | null }
  | { type: "PROMPT_SEEN"; id: string }
  | { type: "PROMPT_TIMEOUT"; id: string }
  | { type: "SESSION_DEAD"; id: string }
  | { type: "SEND"; id: string; text: string; live: boolean }
  | { type: "WAIT_MATCHED"; id: string; regex: string }
  | { type: "WAIT_TIMEOUT"; id: string; regex: string }
  | { type: "KILL"; id: string; foreignLive?: boolean }
  | { type: "MONITOR_TOGGLE"; id: string }
  | { type: "RECONCILE"; live: { name: string; owner?: string; ownerAlive?: boolean }[] };

// normalize restored entries defensively — snapshots are our own details shape,
// but older snapshots may lack newer fields
function normalizeEntry(e: Partial<SessionEntry> & { id: string }): SessionEntry {
  return {
    id: e.id,
    socket: e.socket ?? "pi.sock",
    tool: e.tool ?? "?",
    promptRegex: e.promptRegex ?? null,
    status: e.status ?? "ready",
    waitAttempts: typeof e.waitAttempts === "number" ? e.waitAttempts : 0,
    monitor: e.monitor === true,
    owner: typeof e.owner === "string" && e.owner !== "" ? e.owner : null,
  };
}

// ---- pure validators: shared by guards and tool prechecks ----

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

export function findSession(ctx: RegistryContext, id: string): SessionEntry | undefined {
  return ctx.sessions.find((s) => s.id === id);
}

export function liveNames(ctx: RegistryContext): string[] {
  return ctx.sessions.filter((s) => s.status !== "dead").map((s) => s.id);
}

export function validateStart(ctx: RegistryContext, liveCount: number): Validation<null> {
  if (liveCount >= ctx.limits.maxSessions) {
    return {
      ok: false,
      reason: `session cap reached: ${liveCount} live pi-* sessions on pi.sock, max ${ctx.limits.maxSessions} — tmux_kill a session first (tmux_status lists them)`,
    };
  }
  return { ok: true, value: null };
}

export function validateRegister(ctx: RegistryContext, id: string): Validation<null> {
  if (findSession(ctx, id)) {
    return {
      ok: false,
      reason: `session id "${id}" already registered — pick the next free suffix (pi-<slug>-<n>)`,
    };
  }
  return { ok: true, value: null };
}

export function validateSend(ctx: RegistryContext, id: string, live: boolean): Validation<SessionEntry> {
  const entry = findSession(ctx, id);
  if (!entry) {
    return { ok: false, reason: unknownReason(ctx, id) };
  }
  if (!live || entry.status === "dead") {
    return {
      ok: false,
      reason: `session "${id}" is not live (status: ${entry.status}, probe: ${live ? "live" : "gone"}) — start a fresh session with tmux_start, or check tmux_status`,
    };
  }
  return { ok: true, value: entry };
}

export function validateWait(ctx: RegistryContext, id: string): Validation<SessionEntry> {
  const entry = findSession(ctx, id);
  if (!entry) {
    return { ok: false, reason: unknownReason(ctx, id) };
  }
  if (entry.waitAttempts >= ctx.limits.maxWaitAttempts) {
    return {
      ok: false,
      reason: `wait attempts exhausted for "${id}": ${entry.waitAttempts} >= ${ctx.limits.maxWaitAttempts} — session looks stuck; tmux_capture the output, then decide: kill, send, or retry with new params`,
    };
  }
  return { ok: true, value: entry };
}

export function validateKnown(ctx: RegistryContext, id: string): Validation<SessionEntry> {
  const entry = findSession(ctx, id);
  if (!entry) {
    return { ok: false, reason: unknownReason(ctx, id) };
  }
  return { ok: true, value: entry };
}

/** Kill legality: own + orphaned sessions only. foreignLive = probe evidence
 *  that the entry is owned by another *running* pi (owner pid alive). Dead
 *  entries are always killable (registry hygiene). ctx.owner "" = unidentified
 *  actor (tests/legacy) — isolation off. */
export function validateKill(
  ctx: RegistryContext,
  id: string,
  foreignLive: boolean,
): Validation<SessionEntry> {
  const entry = findSession(ctx, id);
  if (!entry) {
    return { ok: false, reason: unknownReason(ctx, id) };
  }
  if (
    foreignLive &&
    ctx.owner !== "" &&
    entry.owner !== null &&
    entry.owner !== ctx.owner &&
    entry.status !== "dead"
  ) {
    return {
      ok: false,
      reason:
        `session "${id}" is owned by another live pi (owner pid ${entry.owner}) — not this session's to kill. ` +
        `Kill it from its owning session, or manually: tmux kill-session -t =${id} (socket path in tmux_status monitor lines)`,
    };
  }
  return { ok: true, value: entry };
}

function unknownReason(ctx: RegistryContext, id: string): string {
  const live = liveNames(ctx);
  const peers = live.length > 0 ? live.join(", ") : "none";
  return `unknown session "${id}" — live on pi.sock: ${peers} (was it killed outside the extension? retry, or tmux_status)`;
}

// readable drift between registry snapshots (reconcile reporting)
export function driftReport(
  before: SessionEntry[],
  after: SessionEntry[],
  selfOwner?: string,
): string[] {
  const report: string[] = [];
  for (const b of before) {
    const a = after.find((s) => s.id === b.id);
    if (!a) {
      report.push(`"${b.id}" unregistered`);
    } else if (a.status === "dead" && b.status !== "dead") {
      report.push(`"${b.id}" found dead (was ${b.status})`);
    } else if (b.status === "dead" && a.status !== "dead") {
      report.push(`"${b.id}" recovered (probe live, was dead)`);
    }
  }
  for (const a of after) {
    if (a.tool === "?" && !before.find((s) => s.id === a.id)) {
      const foreign =
        selfOwner !== undefined && selfOwner !== "" && a.owner !== null && a.owner !== selfOwner;
      report.push(
        `"${a.id}" adopted (live pi-* stray${foreign ? `, foreign owner pid ${a.owner}` : ""})`,
      );
    }
  }
  return report;
}

// ---- machine ----

function withStatus(ctx: RegistryContext, event: TmuxEvent, status: SessionStatus): SessionEntry[] {
  if (!("id" in event)) return ctx.sessions;
  return ctx.sessions.map((s) => (s.id === event.id ? { ...s, status } : s));
}

function withWaitAttempts(ctx: RegistryContext, event: TmuxEvent, reset: boolean): SessionEntry[] {
  if (!("id" in event)) return ctx.sessions;
  return ctx.sessions.map((s) =>
    s.id === event.id ? { ...s, waitAttempts: reset ? 0 : s.waitAttempts + 1 } : s,
  );
}

export const tmuxMachine = setup({
  types: {
    context: {} as RegistryContext,
    events: {} as TmuxEvent,
    input: {} as MachineInput,
  },
  guards: {
    startUnderCap: ({ context, event }) =>
      event.type === "SESSION_START" && validateStart(context, event.liveCount).ok,
    idUnique: ({ context, event }) =>
      event.type === "SESSION_STARTED" && validateRegister(context, event.id).ok,
    known: ({ context, event }) => "id" in event && !!findSession(context, event.id),
    killLegal: ({ context, event }) =>
      event.type === "KILL" && validateKill(context, event.id, event.foreignLive === true).ok,
    // sticky dead/failed: prompt transitions only from waiting_prompt
    waiting: ({ context, event }) => {
      if (!("id" in event)) return false;
      const entry = findSession(context, event.id);
      return !!entry && entry.status === "waiting_prompt";
    },
    sendLegal: ({ context, event }) =>
      event.type === "SEND" && validateSend(context, event.id, event.live).ok,
    noSessions: ({ context }) => context.sessions.length === 0,
    reconcileNonEmpty: ({ context, event }) =>
      event.type === "RECONCILE" && (context.sessions.length > 0 || event.live.length > 0),
    restoreValid: ({ context, event }) =>
      event.type === "RESTORE" &&
      context.sessions.length === 0 &&
      !!event.registry &&
      Array.isArray(event.registry.sessions) &&
      typeof event.registry.limits?.maxSessions === "number",
  },
  actions: {
    // RESTORE: registry is pure data — statuses carry over exactly
    // (dead stays dead, failed stays failed, monitor kept). Valid only on an
    // empty registry (fresh actor); viz survives restore (snapshot is data).
    restoreRegistry: assign(({ event }) => {
      if (event.type !== "RESTORE") return {};
      return {
        sessions: event.registry.sessions
          .filter((s) => s && typeof s.id === "string")
          .map((s) => normalizeEntry(s)),
        limits: event.registry.limits,
      };
    }),
    registerSession: assign({
      sessions: ({ context, event }) => {
        if (event.type !== "SESSION_STARTED") return context.sessions;
        return [
          ...context.sessions,
          {
            id: event.id,
            socket: "pi.sock",
            tool: event.tool,
            promptRegex: event.promptRegex,
            status: event.promptRegex ? "waiting_prompt" : "ready",
            waitAttempts: 0,
            monitor: false,
            owner: context.owner || null,
          },
        ];
      },
    }),
    markReady: assign({
      sessions: ({ context, event }) => withStatus(context, event, "ready"),
    }),
    markFailed: assign({
      sessions: ({ context, event }) => withStatus(context, event, "failed"),
    }),
    markDead: assign({
      sessions: ({ context, event }) => withStatus(context, event, "dead"),
    }),
    resetWaits: assign({
      sessions: ({ context, event }) => withWaitAttempts(context, event, true),
    }),
    bumpWaits: assign({
      sessions: ({ context, event }) => withWaitAttempts(context, event, false),
    }),
    toggleMonitor: assign({
      sessions: ({ context, event }) =>
        "id" in event
          ? context.sessions.map((s) => (s.id === event.id ? { ...s, monitor: !s.monitor } : s))
          : context.sessions,
    }),
    unregister: assign({
      sessions: ({ context, event }) =>
        "id" in event ? context.sessions.filter((s) => s.id !== event.id) : context.sessions,
    }),
    reconcile: assign({
      sessions: ({ context, event }) => {
        if (event.type !== "RECONCILE") return context.sessions;
        const live = new Set(event.live.map((l) => l.name));
        // probe is ground truth both ways: not-live → dead, and dead-but-live
        // → ready (recovery from a misjudged prompt-wait — stale tool events
        // cannot flip statuses; only fresh probe evidence can)
        const marked = context.sessions.map((s) => {
          if (s.status !== "dead" && !live.has(s.id)) {
            return { ...s, status: "dead" as SessionStatus };
          }
          if (s.status === "dead" && live.has(s.id)) {
            return { ...s, status: "ready" as SessionStatus };
          }
          return s;
        });
        const adopted: SessionEntry[] = event.live
          .filter((l) => !marked.find((s) => s.id === l.name))
          .map((l) => ({
            id: l.name,
            socket: "pi.sock",
            tool: "?",
            promptRegex: null,
            status: "ready",
            waitAttempts: 0,
            monitor: false,
            owner: l.owner || null,
          }));
        return [...marked, ...adopted];
      },
    }),
  },
}).createMachine({
  id: "tmux",
  context: ({ input }) => ({
    sessions: [],
    limits: input?.limits ?? DEFAULT_LIMITS,
    owner: input?.owner ?? "",
  }),
  initial: "empty",
  states: {
    empty: {
      on: {
        RESTORE: { guard: "restoreValid", target: "active", actions: "restoreRegistry" },
        SESSION_START: { guard: "startUnderCap" },
        SESSION_STARTED: { guard: "idUnique", target: "active", actions: "registerSession" },
        RECONCILE: [
          { guard: "reconcileNonEmpty", target: "active", actions: "reconcile" },
          { actions: "reconcile" },
        ],
      },
    },
    active: {
      always: [{ guard: "noSessions", target: "empty" }],
      on: {
        SESSION_START: { guard: "startUnderCap" },
        SESSION_STARTED: { guard: "idUnique", actions: "registerSession" },
        PROMPT_SEEN: { guard: "waiting", actions: "markReady" },
        PROMPT_TIMEOUT: { guard: "waiting", actions: "markFailed" },
        SESSION_DEAD: { guard: "known", actions: "markDead" },
        SEND: { guard: "sendLegal" },
        WAIT_MATCHED: { guard: "known", actions: "resetWaits" },
        WAIT_TIMEOUT: { guard: "known", actions: "bumpWaits" },
        KILL: { guard: "killLegal", actions: "unregister" },
        MONITOR_TOGGLE: { guard: "known", actions: "toggleMonitor" },
        RECONCILE: { actions: "reconcile" },
      },
    },
  },
});
