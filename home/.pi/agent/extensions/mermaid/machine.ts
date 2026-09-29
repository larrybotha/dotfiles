/**
 * Mermaid validate-gated render machine.
 *
 * Deterministic control flow for the diagram workflow:
 * - machine owns legality (validation-first rule, stale-source rule via
 *   path+hash evidence, failed-attempt cap, state order) and drives render +
 *   embed IO via invoked services (XState v5 `fromPromise`): one
 *   BEGIN_RENDER/BEGIN_EMBED event carries the evidence; the machine invokes
 *   the executor and routes its result without further model round-trips
 * - validate is deliberately two-phase (BEGIN_VALIDATE -> VALIDATE_DONE):
 *   the model round-trip is the point of validate — the tool reads the
 *   diagram, runs ascii.sh, and reports with the ASCII preview between the
 *   two events
 * - executors (Docker svg.sh render + embedBlock file IO) are injected via
 *   `mermaidMachine.provide()` — machine.ts ships typed stubs only
 *   (throwing "not wired"), so tests run without Docker or file IO
 * - the model may only send legal events via tools; illegal events are rejected
 *
 * States (`drafting`: fresh start or failed validation — no trustworthy
 * diagram yet; both call for writing or fixing one, then validating):
 *
 *   drafting -> validating -> validated -> rendering | embedding -> validated
 *                                    \-> drafting (diagram failure clears the pass)
 *
 * Event flow (validate two-phase; render/embed machine-driven via invoke):
 *   BEGIN_VALIDATE            -> (tool runs Docker ascii.sh) -> VALIDATE_DONE {path, hash, ok, errors, cause?}
 *   BEGIN_RENDER {path,hash,content,outPath,theme?} -> invokes renderService
 *     (Docker svg.sh over a temp copy of `content` — the exact validated
 *     bytes, never a re-read of the source path)
 *     renderService ok                        -> validated (render recorded)
 *     renderService fail (infra)              -> validated (pass kept, errors recorded, retry legal)
 *     renderService fail (diagram)            -> drafting (pass cleared, re-validate first)
 *   BEGIN_EMBED {path,hash,target,content,after?} -> invokes embedService (file IO)
 *     embedService ok                         -> validated (embed recorded)
 *     embedService fail                       -> validated (errors only — the pass is
 *                                               always kept: embedding is replace-safe)
 *   RESET -> drafting (context cleared)
 *
 * RESET-wins-over-in-flight is structural: exiting a state stops its invoked
 * service and a late result is dropped (actor stopped, no handler).
 * `validating` is event-driven, so a late VALIDATE_DONE after RESET is
 * dropped the same way — `drafting` has no VALIDATE_DONE handler.
 *
 * Failure taxonomy (service failures throw { errors, cause };
 * failureOf() normalizes the rejection):
 *   "diagram" — the source itself failed (mmdc parse error).
 *     Validate: attempt bumped, pass cleared, -> drafting (re-validate loop).
 *     Render:   attempt bumped (the render fix loop needs the same flail
 *               stop), pass cleared, -> drafting (re-validate before retrying).
 *     Attempts are a cumulative session budget: never decayed on success
 *     (decay would reopen the render fix loop — a validate-ok between
 *     render failures would reset it), freed by RESET. Infra failures and
 *     embed failures never bump (infra: the pass stays; embed:
 *     replace-safe, the pass is always kept).
 *   "infra"   — the pipeline broke (Docker build/run, daemon, IO); the
 *     source may still be valid. No attempt bump, pass kept, machine
 *     returns to its prior state (pass kept if one existed, else
 *     drafting). Retry is legal immediately — nothing needs fixing.
 *   Embed failures record errors only regardless of cause (the pass is
 *     kept — embedding is replace-safe).
 *   Shaped rejections missing a cause default to "diagram"; non-shaped
 *     rejections (e.g. an unwired stub's Error) are "infra" — the source
 *     is never checked, the pass stays.
 *
 * The validation-first rule mirrors web-search's known-link rule: render and
 * embed are only legal for the exact source (path + content hash) that last
 * passed validation. A change to the diagram invalidates the pass —
 * re-validate. Embedding is idempotent-safe: same source marker in the target
 * is replaced, not duplicated (executor behavior; machine only records).
 */
import { assign, fromPromise, setup } from "xstate";

import { normalizeServiceFailure } from "../_kit/machine-kit.ts";

export type ValidatedSource = { path: string; hash: string };

export interface MermaidLimits {
  maxValidateAttempts: number;
}

export interface MermaidContext {
  /** Source that last passed validation (abs path + content hash). */
  validated: ValidatedSource | null;
  /** Last problems (validation errors / render or embed failure); cleared on success. */
  errors: string[];
  /**
   * Diagram-side failures — failed validations + diagram-failed renders.
   * Cumulative session budget: never decayed on success (decay would
   * reopen the render fix loop — a validate-ok between render failures
   * would reset it), freed by RESET. See validateViolation.
   */
  validateAttempts: number;
  /** Successful SVG render output paths. */
  renders: string[];
  /** Successful embed target paths. */
  embeds: string[];
  limits: MermaidLimits;
}

/** Why a step failed: the source, or the pipeline around it. */
export type FailCause = "diagram" | "infra";

/** DONE-failure cause; a missing cause defaults to "diagram". */
function failCause(event: { cause?: FailCause }): FailCause {
  return event.cause ?? "diagram";
}

// ---------------------------------------------------------------------------
// Invoked-service slots (typed stubs here; index.ts wires the real executors
// via machine.provide(), test.ts wires controlled stubs — slide-deck pattern)
// ---------------------------------------------------------------------------

/** Render service input: evidence from the event (content included — the executor renders the validated bytes); theme is a tool/UI concern, passed straight through (not workflow state). */
export interface RenderServiceInput {
  /** Validated diagram path (abs). */
  path: string;
  /** Content hash the guard checked — evidence parity into the executor. */
  hash: string;
  /**
   * Validated diagram content — the exact bytes the hash was computed over.
   * The executor renders THIS content (a temp copy), never a re-read of
   * `path`: a disk edit between validation and render must not leak into
   * an output reported as the validated diagram (TOCTOU — same content
   * parity as the embed service).
   */
  content: string;
  /** Output .svg/.png path. */
  outPath: string;
  /** default|dark|forest|neutral — executor concern, not machine state. */
  theme?: string;
}
export interface RenderServiceOutput {
  outPath: string;
}
/** What a render service throws on failure ({ errors, cause }; failureOf normalizes). */
export interface ServiceFailure {
  errors: string[];
  cause: FailCause;
}

/** What the embed executor did to the target (embed.ts's EmbedAction, mirrored here — the wiring fails to typecheck if the two drift). */
export type EmbedAction = "replaced" | "appended" | "inserted";

/** Embed service input: index decides which IO params flow through (content is normally passed through — hash-consistent evidence; after is an executor concern). */
export interface EmbedServiceInput {
  /** Validated diagram path (abs). */
  path: string;
  /** Content hash the guard checked — evidence parity into the executor. */
  hash: string;
  /** Markdown target (abs). */
  target: string;
  /** Diagram content — normally passed through by the tool (the hash was computed over it); a service may re-read the file if absent. */
  content?: string;
  /** Insert after the last line containing this text (executor concern). */
  after?: string;
}
export interface EmbedServiceOutput {
  action: EmbedAction;
  /** Target echoed back — onDone records it into `embeds` without new context fields (snapshot shape unchanged). */
  target: string;
}

export type MermaidEvent =
  | { type: "BEGIN_VALIDATE" }
  | {
      type: "VALIDATE_DONE";
      path: string;
      hash: string;
      ok: boolean;
      errors: string[];
      cause?: FailCause;
    }
  | {
      type: "BEGIN_RENDER";
      path: string;
      hash: string;
      /** Validated bytes (hash computed over this) — evidence parity into the render service (never into the snapshot). */
      content: string;
      outPath: string;
      theme?: string;
    }
  | {
      type: "BEGIN_EMBED";
      path: string;
      hash: string;
      target: string;
      /** Diagram content — flows into the embed service input (never into the snapshot). */
      content: string;
      after?: string;
    }
  | { type: "RESET" };

export function initialContext(limits: MermaidLimits): MermaidContext {
  return {
    validated: null,
    errors: [],
    validateAttempts: 0,
    renders: [],
    embeds: [],
    limits,
  };
}

/**
 * Shared pure validators. Guards use them; tools call them directly to
 * produce readable rejection reasons. Single source of truth.
 * Paths arrive already resolved (abs) from the tool layer.
 */
export function validateViolation(ctx: MermaidContext): string | null {
  if (ctx.validateAttempts >= ctx.limits.maxValidateAttempts) {
    return `diagram failures exhausted (${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts} failed validations + diagram-failed renders, cumulative) — write a fresh diagram file or mermaid_reset to start over`;
  }
  return null;
}

function sourceMismatch(
  ctx: MermaidContext,
  path: string,
  hash: string,
): string | null {
  if (!ctx.validated) {
    return "no validated source — run mermaid_validate on the diagram first";
  }
  if (ctx.validated.path !== path) {
    return `validated source is ${ctx.validated.path}, not ${path} — run mermaid_validate on this diagram first`;
  }
  if (ctx.validated.hash !== hash) {
    return `source changed since validation (${path}) — re-run mermaid_validate before rendering or embedding`;
  }
  return null;
}

export function renderViolation(
  ctx: MermaidContext,
  path: string,
  hash: string,
): string | null {
  return sourceMismatch(ctx, path, hash);
}

export function embedViolation(
  ctx: MermaidContext,
  path: string,
  hash: string,
  target: string,
): string | null {
  const mismatch = sourceMismatch(ctx, path, hash);
  if (mismatch) return mismatch;
  if (target === path) {
    return "embed target is the diagram source itself — embed into a Markdown file";
  }
  return null;
}

/**
 * Normalize an unknown service rejection into readable failure data
 * (slide-deck's failureOf). Shaped { errors, cause } passes through —
 * a missing/garbage cause defaults to "diagram". A non-shaped rejection
 * (e.g. an unwired stub's Error) is "infra": the diagram is never checked,
 * so the pass stays.
 */
export function failureOf(output: unknown): ServiceFailure {
  return normalizeServiceFailure(output, {
    // a shaped rejection without a cause carries errors — default the
    // cause to the source side, keep the errors
    causes: ["diagram", "infra"],
    defaultCause: "diagram",
    nonShapedCause: "infra",
  });
}

export const mermaidMachine = setup({
  types: {
    context: {} as MermaidContext,
    events: {} as MermaidEvent,
    input: {} as { limits: MermaidLimits } | undefined,
  },
  actors: {
    // Typed stubs only — real executors are injected via
    // `mermaidMachine.provide({ actors })` (index.ts wires Docker svg.sh +
    // embedBlock, test.ts wires stubs). Machine.ts is IO-free; an
    // unwired machine that renders/embeds lands in `drafting`/`validated`
    // with this error recorded.
    renderService: fromPromise<RenderServiceOutput, RenderServiceInput>(
      async () => {
        throw new Error(
          "renderService not wired — machine.provide() must inject the render executor",
        );
      },
    ),
    embedService: fromPromise<EmbedServiceOutput, EmbedServiceInput>(
      async () => {
        throw new Error(
          "embedService not wired — machine.provide() must inject the embed executor",
        );
      },
    ),
  },
  guards: {
    validateLegal: ({ context }) => validateViolation(context) === null,
    renderLegal: ({ context, event }) =>
      event.type === "BEGIN_RENDER" &&
      renderViolation(context, event.path, event.hash) === null,
    embedLegal: ({ context, event }) =>
      event.type === "BEGIN_EMBED" &&
      embedViolation(context, event.path, event.hash, event.target) === null,
    // DONE-failure routing (see failure taxonomy in the header).
    validateOk: ({ event }) => event.type === "VALIDATE_DONE" && event.ok,
    validateInfraWithPass: ({ context, event }) =>
      event.type === "VALIDATE_DONE" &&
      !event.ok &&
      failCause(event) === "infra" &&
      context.validated !== null,
    validateInfraNoPass: ({ context, event }) =>
      event.type === "VALIDATE_DONE" &&
      !event.ok &&
      failCause(event) === "infra" &&
      context.validated === null,
    // renderService onError routing (ErrorActorEvent carries `error`;
    // failureOf normalizes it — see taxonomy in the header).
    renderInfra: ({ event }) =>
      "error" in event &&
      failureOf((event as { error: unknown }).error).cause === "infra",
  },
  actions: {
    applyValidation: assign(({ context, event }) => {
      if (event.type !== "VALIDATE_DONE") return {};
      if (event.ok) {
        return {
          validated: { path: event.path, hash: event.hash },
          errors: [],
        };
      }
      if (failCause(event) === "infra") {
        // Pipeline broke; the diagram (and any prior pass) is untouched.
        return { errors: event.errors };
      }
      return {
        validated: null,
        errors: event.errors,
        validateAttempts: context.validateAttempts + 1,
      };
    }),
    renderDone: assign(({ context, event }) => {
      // onDone of renderService — DoneActorEvent carries `output`
      if (!("output" in event)) return {};
      const outPath = (event as { output: RenderServiceOutput }).output.outPath;
      return {
        renders: context.renders.includes(outPath)
          ? context.renders
          : [...context.renders, outPath],
        errors: [],
      };
    }),
    renderFailed: assign(({ context, event }) => {
      // onError of renderService — ErrorActorEvent carries `error`.
      // Diagram-cause render failures bump validateAttempts like validate
      // failures (the render fix loop needs the same flail stop); infra
      // never bumps (the pass stays — retry is legal). Never records an
      // empty error list: `validated` with empty errors must stay reachable
      // only via renderDone (index.ts derives the tool outcome from that
      // shape).
      if (!("error" in event)) return {};
      const failure = failureOf((event as { error: unknown }).error);
      if (failure.cause === "infra") {
        return {
          errors:
            failure.errors.length > 0
              ? failure.errors
              : ["render pipeline failed"],
        };
      }
      return {
        validated: null,
        errors:
          failure.errors.length > 0
            ? failure.errors
            : ["render failed (diagram)"],
        validateAttempts: context.validateAttempts + 1,
      };
    }),
    embedDone: assign(({ context, event }) => {
      // onDone of embedService — output echoes the target (see
      // EmbedServiceOutput): records into `embeds` without new context
      // fields (persisted snapshot shape unchanged).
      if (!("output" in event)) return {};
      const target = (event as { output: EmbedServiceOutput }).output.target;
      return {
        embeds: context.embeds.includes(target)
          ? context.embeds
          : [...context.embeds, target],
        errors: [],
      };
    }),
    embedFailed: assign(({ event }) => {
      // onError of embedService — errors only; the pass is ALWAYS kept
      // (embedding is replace-safe; retry is legal immediately). Never
      // records an empty error list: embedDone is the only exit of
      // `embedding` leaving empty errors (index.ts derives the tool
      // outcome from that shape).
      if (!("error" in event)) return {};
      const failure = failureOf((event as { error: unknown }).error);
      return {
        errors: failure.errors.length > 0 ? failure.errors : ["embed failed"],
      };
    }),
    resetContext: assign(({ context }) => initialContext(context.limits)),
  },
}).createMachine({
  id: "mermaid",
  context: ({ input }) =>
    initialContext(input?.limits ?? { maxValidateAttempts: 8 }),
  initial: "drafting",
  states: {
    // No trustworthy diagram yet.
    drafting: {
      on: {
        BEGIN_VALIDATE: { guard: "validateLegal", target: "validating" },
        RESET: { target: "drafting", actions: "resetContext" },
      },
    },
    validating: {
      on: {
        VALIDATE_DONE: [
          {
            guard: "validateOk",
            target: "validated",
            actions: "applyValidation",
          },
          // infra fail: back to its prior state — pass kept if one existed
          {
            guard: "validateInfraWithPass",
            target: "validated",
            actions: "applyValidation",
          },
          {
            guard: "validateInfraNoPass",
            target: "drafting",
            actions: "applyValidation",
          },
          // diagram fail: fix loop
          { target: "drafting", actions: "applyValidation" },
        ],
        // reset wins over an in-flight validation (same semantics as
        // `rendering`/`embedding`): the late VALIDATE_DONE has no handler in
        // drafting and is dropped — the reset is never silently discarded.
        RESET: { target: "drafting", actions: "resetContext" },
      },
    },
    validated: {
      on: {
        BEGIN_VALIDATE: { guard: "validateLegal", target: "validating" },
        BEGIN_RENDER: { guard: "renderLegal", target: "rendering" },
        BEGIN_EMBED: { guard: "embedLegal", target: "embedding" },
        RESET: { target: "drafting", actions: "resetContext" },
      },
    },
    rendering: {
      invoke: {
        src: "renderService",
        input: ({ event }) => {
          if (event.type !== "BEGIN_RENDER") {
            throw new Error(`rendering entered by ${event.type}`);
          }
          return {
            path: event.path,
            hash: event.hash,
            content: event.content,
            outPath: event.outPath,
            theme: event.theme,
          };
        },
        onDone: { target: "validated", actions: "renderDone" },
        onError: [
          // infra fail: pass kept, stay validated, retry legal
          {
            guard: "renderInfra",
            target: "validated",
            actions: "renderFailed",
          },
          // diagram fail: pass cleared, fix loop
          { target: "drafting", actions: "renderFailed" },
        ],
      },
      // RESET wins over the in-flight render: exiting the state stops the
      // invoked service; a late result has no handler and is dropped.
      on: {
        RESET: { target: "drafting", actions: "resetContext" },
      },
    },
    embedding: {
      invoke: {
        src: "embedService",
        input: ({ event }) => {
          if (event.type !== "BEGIN_EMBED") {
            throw new Error(`embedding entered by ${event.type}`);
          }
          return {
            path: event.path,
            hash: event.hash,
            target: event.target,
            content: event.content,
            after: event.after,
          };
        },
        // ok or fail: back to validated — embed failures record errors
        // only (the pass is always kept: embedding is replace-safe)
        onDone: { target: "validated", actions: "embedDone" },
        onError: { target: "validated", actions: "embedFailed" },
      },
      // RESET wins over the in-flight embed, same as `rendering`.
      on: {
        RESET: { target: "drafting", actions: "resetContext" },
      },
    },
  },
});
