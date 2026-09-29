/**
 * Slide-deck build machine — invoked build service.
 *
 * Deterministic control flow for the deck workflow:
 * - machine owns legality (phase order, content prechecks, attempt cap,
 *   state order) and runs the build pipeline autonomously via invoked
 *   services (XState v5 `fromPromise`): one BEGIN_BUILD event carries the
 *   deck content; the machine then drives copy/inject → validate → done
 *   without further model round-trips (the two-phase pattern exists for
 *   model-driven IO; this pipeline is machine-driven, so invoke wins)
 * - executors own IO (build.mjs: template copy + injection; validate.sh:
 *   Docker html5lib validation; browser open happens tool-side, gated on
 *   `done`) and are injected via `machine.provide()` — machine.ts ships
 *   typed stubs only (throwing "not wired"), so tests run without Docker
 * - the model may only send legal events via tools; illegal events are
 *   rejected
 *
 * States (the authoring ceremony — start/research/plan — is ONE state,
 * `authoring`: phases are optional announcements tracked as `phase` in
 * context (null|researching|planning|writing ≡ the old idle/researching/
 * planning/writing states); what the machine enforces is the pipeline —
 * so the fast path, one BEGIN_BUILD from a fresh authoring state, is
 * legal):
 *   authoring -> building -> validating -> done
 *             \-> fixing (validation failure; retry loop)
 *
 * Event flow (authoring events are phase-gated in context, ≡ the old
 * per-state handlers; pipeline events are state-gated):
 *   START {topic}                  authoring(phase null)|done -> authoring(phase researching)
 *                                  (from done: NEW deck — authoring cleared,
 *                                  build history kept)
 *   RESEARCH_DONE {sources}        authoring(phase researching) -> authoring(phase planning)
 *   PLAN_DONE {slides}             authoring(phase planning|writing) -> authoring(phase writing)
 *                                  (replan mid-authoring; also legal in fixing,
 *                                  phase-agnostic — the plan is load-bearing)
 *   BEGIN_BUILD {content}          authoring|fixing|done -> building  (invoke buildService)
 *     buildService ok             building -> validating (outPath evidence)
 *     buildService error (infra)  building -> fixing (attempt untouched)
 *   validating: invoke validateService
 *     ok                          validating -> done (opens tool-side)
 *     fail cause "deck"           validating -> fixing (errors, attempt +1)
 *     fail cause "infra"          validating -> fixing (attempt untouched)
 *   BEGIN_BUILD from fixing        retry loop; capped by maxValidateAttempts
 *   RESET                         any -> authoring (context cleared, phase
 *                                 null; in-flight services are stopped by
 *                                 state exit, late results have no handler
 *                                 and are dropped)
 *
 * Failure taxonomy (mirrors mermaid): "deck" — the content itself failed
 * validation (bumped attempt, fix loop); "infra" — the pipeline broke
 * (Docker build/run, template IO; attempt untouched, retry legal
 * immediately). Deck content flows through events into service inputs,
 * never into the snapshot — context records meta only (title, counts),
 * keeping persisted snapshots small.
 */
import { assign, fromPromise, setup } from "xstate";

import { normalizeServiceFailure } from "../_kit/machine-kit.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Deck content submitted with BEGIN_BUILD — flows into the build service input. */
export interface DeckContent {
  title: string;
  subtitle: string;
  /** Nav sidebar HTML: nav-category/nav-item blocks with data-slide attributes. */
  navHtml: string;
  /** Slide HTML: one <div class="slide"> per topic. */
  slidesHtml: string;
  /** Absolute output path for the built deck. */
  outPath: string;
  /** Replace an existing output file (tool layer computes it: explicit param, or a path this machine itself built). */
  overwrite?: boolean;
}

export interface SlideDeckLimits {
  maxValidateAttempts: number;
}

/**
 * Authoring ceremony phase — ≡ the old authoring states. The pipeline
 * states (building/validating/fixing/done) do not change it.
 */
export type AuthoringPhase = "researching" | "planning" | "writing";

export interface SlideDeckContext {
  /** Ceremony phase; null ≡ old idle (nothing announced yet — START legal). */
  phase: AuthoringPhase | null;
  topic: string | null;
  sources: string[];
  plannedSlides: string[];
  /** Meta of the last submitted deck — full content lives in events, not context. */
  deck: { title: string; subtitle: string; slideCount: number } | null;
  outPath: string | null;
  /** Last problems (validation errors / pipeline failures); cleared on success. */
  errors: string[];
  /** Failed validations — capped separately from successes; cleared only by RESET. */
  validateAttempts: number;
  /** Successfully validated output paths (history). */
  builds: string[];
  limits: SlideDeckLimits;
}

/** Why a pipeline step failed: the deck content, or the infrastructure around it. */
export type FailCause = "deck" | "infra";

/** Build service input: the submitted content (executor resolves template path itself). */
export type BuildServiceInput = DeckContent;
export interface BuildServiceOutput {
  outPath: string;
  slideCount: number;
  bytes: number;
}

/** Validate service input: the built output (evidence carried from buildService output). */
export interface ValidateServiceInput {
  outPath: string;
}
export interface ValidateServiceOutput {
  slideCount: number;
  message: string;
}
export interface ValidateServiceFailure {
  errors: string[];
  cause: FailCause;
}

export type SlideDeckEvent =
  | { type: "START"; topic: string }
  | { type: "RESEARCH_DONE"; sources: string[] }
  | { type: "PLAN_DONE"; slides: string[] }
  | ({ type: "BEGIN_BUILD" } & DeckContent)
  | { type: "RESET" };

export function initialContext(limits: SlideDeckLimits): SlideDeckContext {
  return {
    phase: null,
    topic: null,
    sources: [],
    plannedSlides: [],
    deck: null,
    outPath: null,
    errors: [],
    validateAttempts: 0,
    builds: [],
    limits,
  };
}

// ---------------------------------------------------------------------------
// Pure validators — shared by guards and the tool precheck (single source
// of truth; readable reasons surface directly in tool rejections)
// ---------------------------------------------------------------------------

export function startViolation(topic: string): string | null {
  if (!topic.trim()) {
    return "topic is empty — name the deck topic to start the workflow";
  }
  if (topic.length > 200) {
    return `topic too long (${topic.length} > 200 chars)`;
  }
  return null;
}

export function researchViolation(sources: string[]): string | null {
  const clean = sources.filter((s) => s.trim());
  if (clean.length === 0) {
    return "sources is empty — pass the URLs/files the research came from";
  }
  if (sources.length > 128) {
    return `too many sources (${sources.length} > 128)`;
  }
  return null;
}

export function planViolation(slides: string[]): string | null {
  const clean = slides.filter((s) => s.trim());
  if (clean.length === 0) {
    return "plan is empty — list the slide ids planned for the deck";
  }
  if (slides.length > 128) {
    return `too many planned slides (${slides.length} > 128)`;
  }
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const s of slides) {
    const key = s.trim();
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  if (dupes.length > 0) {
    return `duplicate slide ids in plan: ${dupes.join(", ")}`;
  }
  return null;
}

/** Count slide divs in submitted HTML (cheap sanity; the authoritative 1:1 nav↔slide check is the validate service). */
export function countSlides(slidesHtml: string): number {
  const m = slidesHtml.match(/<div[^>]*class="[^"]*\bslide\b[^"]*"/g);
  return m ? m.length : 0;
}

/** Slide ids (bare slugs) from submitted slide HTML — regex, double-quoted ids (template convention). */
export function extractSlideIds(slidesHtml: string): string[] {
  const out: string[] = [];
  const re = /<div[^>]*\bid="slide-([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slidesHtml)) !== null) out.push(m[1]);
  return out;
}

/** Nav targets (bare slugs) from submitted nav HTML — regex, double-quoted attrs (template convention). */
export function extractNavTargets(navHtml: string): string[] {
  const out: string[] = [];
  const re = /data-slide="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(navHtml)) !== null) out.push(m[1]);
  return out;
}

/**
 * Cheap structural precheck on the submitted strings (fast-fail BEFORE the
 * Docker roundtrip): duplicate slide ids, duplicate nav targets, nav↔slide
 * 1:1 in both directions. Regex-lenient by design — single-quoted attrs are
 * missed here and caught by the validate service (html5lib DOM truth), so
 * the precheck can never wrongly reject, only save a cycle. Single source of
 * truth stays validate.py; this is the fast subset.
 */
export function navSlideViolation(
  navHtml: string,
  slidesHtml: string,
): string | null {
  const ids = extractSlideIds(slidesHtml);
  const targets = extractNavTargets(navHtml);
  const dupIds = duplicates(ids);
  if (dupIds.length > 0) {
    return `duplicate slide ids (goToSlide only ever finds the first): ${dupIds.join(", ")}`;
  }
  const dupTargets = duplicates(targets);
  if (dupTargets.length > 0) {
    return `duplicate nav data-slide values: ${dupTargets.join(", ")}`;
  }
  const idSet = new Set(ids);
  const missing = targets.filter((t) => !idSet.has(t));
  if (missing.length > 0) {
    return `nav data-slide with no matching slide id slide-<slug>: ${missing.join(", ")} (ids carry the slide- prefix)`;
  }
  const targetSet = new Set(targets);
  const orphan = ids.filter((id) => !targetSet.has(id));
  if (orphan.length > 0) {
    return `slide id with no matching nav item (nav↔slide must be 1:1): ${orphan.join(", ")}`;
  }
  return null;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

export function buildViolation(
  ctx: SlideDeckContext,
  content: DeckContent,
): string | null {
  if (ctx.validateAttempts >= ctx.limits.maxValidateAttempts) {
    return `validation attempts exhausted (${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts} failed validations) — the deck keeps failing; slide_deck_reset to start over or rethink the deck structure`;
  }
  if (!content.title.trim()) {
    return "deck title is empty";
  }
  if (content.title.length > 200) {
    return `deck title too long (${content.title.length} > 200 chars)`;
  }
  if (!content.subtitle.trim()) {
    return "deck subtitle is empty (sidebar tagline under the title)";
  }
  if (content.subtitle.length > 300) {
    return `deck subtitle too long (${content.subtitle.length} > 300 chars)`;
  }
  if (!content.navHtml.trim()) {
    return "navHtml is empty — write the sidebar nav (nav-category/nav-item blocks)";
  }
  if (content.navHtml.length > 128_000) {
    return `navHtml too large (${content.navHtml.length} > 128000 chars)`;
  }
  if (!content.slidesHtml.trim()) {
    return "slidesHtml is empty — write one <div class='slide'> per topic";
  }
  if (content.slidesHtml.length > 1_000_000) {
    return `slidesHtml too large (${content.slidesHtml.length} > 1000000 chars)`;
  }
  const slideCount = countSlides(content.slidesHtml);
  if (slideCount === 0) {
    return "slidesHtml contains no <div class='slide'> — every topic is one slide div";
  }
  if (!/data-slide=/.test(content.navHtml)) {
    return "navHtml contains no data-slide attribute — every nav-item needs data-slide matching a slide id";
  }
  const navSlide = navSlideViolation(content.navHtml, content.slidesHtml);
  if (navSlide) {
    return `${navSlide} — fix navHtml/slidesHtml before building`;
  }
  // Plan conformance (when the plan ceremony was used): every built slide
  // was planned. Missing planned slides are allowed (trimming); unplanned
  // slides are drift — replan first (slide_deck_plan is legal from
  // planning|writing|fixing).
  if (ctx.plannedSlides.length > 0) {
    const ids = extractSlideIds(content.slidesHtml);
    const planSet = new Set(ctx.plannedSlides);
    const unplanned = ids.filter((id) => !planSet.has(id));
    if (unplanned.length > 0) {
      return `slide ids not in the recorded plan: ${unplanned.join(", ")} — record them with slide_deck_plan first, or remove them from slidesHtml`;
    }
  }
  if (!/\.(html?|htm)$/i.test(content.outPath)) {
    return `outPath must end in .html (got ${content.outPath})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers for executor evidence in events
// ---------------------------------------------------------------------------

/** Normalize an unknown service-error output into readable failure data. */
export function failureOf(output: unknown): ValidateServiceFailure {
  // Only a shaped failure carrying a KNOWN cause is trusted: a non-shaped
  // rejection (e.g. an Error from an unwired stub), or a shaped one without
  // a known cause, is infra — the content was never checked.
  return normalizeServiceFailure(output, {
    causes: ["deck", "infra"],
    defaultCause: null,
    nonShapedCause: "infra",
  });
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const slideDeckMachine = setup({
  types: {
    context: {} as SlideDeckContext,
    events: {} as SlideDeckEvent,
    input: {} as { limits: SlideDeckLimits } | undefined,
  },
  actors: {
    /**
     * Typed stubs only — real executors are injected via
     * `slideDeckMachine.provide({ actors: ... })` (index.ts wires the Docker
     * pipeline, test.ts wires stubs). Machine.ts stays IO-free; an unwired
     * machine that enters `building` lands in `fixing` with this error.
     */
    buildService: fromPromise<BuildServiceOutput, BuildServiceInput>(
      async () => {
        throw new Error(
          "buildService not wired — machine.provide() must inject the build executor",
        );
      },
    ),
    validateService: fromPromise<ValidateServiceOutput, ValidateServiceInput>(
      async () => {
        throw new Error(
          "validateService not wired — machine.provide() must inject the validate executor",
        );
      },
    ),
  },
  guards: {
    // Ceremony legality lives in context (phase ≡ the old per-state
    // handlers); each authoring guard = phase + content precheck.
    // buildLegal is phase-agnostic everywhere — the pipeline, not the
    // ceremony, is what needs enforcing.
    startLegal: ({ context, event }) =>
      event.type === "START" &&
      // Fresh authoring only (phase null ≡ old idle); `done` keeps its own
      // START (newDeckStartLegal) — this guard never runs there.
      context.phase === null &&
      startViolation(event.topic) === null,
    newDeckStartLegal: ({ event }) =>
      // START from done: a NEW deck begins whatever phase the finished
      // deck used — the start action clears authoring, keeps build history
      event.type === "START" && startViolation(event.topic) === null,
    researchLegal: ({ context, event }) =>
      event.type === "RESEARCH_DONE" &&
      // Research phase only (≡ old researching state)
      context.phase === "researching" &&
      researchViolation(event.sources) === null,
    planLegal: ({ context, event }) =>
      event.type === "PLAN_DONE" &&
      // Replan mid-authoring (phase planning|writing ≡ old planning|writing
      // states); mid-fix replans are fixPlanLegal (fixing's own handler)
      (context.phase === "planning" || context.phase === "writing") &&
      planViolation(event.slides) === null,
    fixPlanLegal: ({ event }) =>
      // Replan mid-fix: phase-agnostic (≡ old fixing state) — the plan is
      // load-bearing for the retry loop, whatever phase led here
      event.type === "PLAN_DONE" && planViolation(event.slides) === null,
    buildLegal: ({ context, event }) =>
      event.type === "BEGIN_BUILD" && buildViolation(context, event) === null,
  },
  actions: {
    start: assign(({ event }) => {
      if (event.type !== "START") return {};
      // Phase researching ≡ old researching state (RESEARCH_DONE legal).
      // From `done` this is a NEW deck: clear authoring state, keep build history.
      return {
        phase: "researching" as const,
        topic: event.topic,
        sources: [],
        plannedSlides: [],
        deck: null,
        outPath: null,
        errors: [],
      };
    }),
    recordResearch: assign(({ event }) => {
      if (event.type !== "RESEARCH_DONE") return {};
      // Phase planning ≡ old planning state (PLAN_DONE legal)
      return {
        phase: "planning" as const,
        sources: event.sources.map((s) => s.trim()).filter(Boolean),
      };
    }),
    recordPlan: assign(({ event }) => {
      if (event.type !== "PLAN_DONE") return {};
      // Phase writing ≡ old writing state (replan legal); also runs from
      // fixing (fixPlanLegal) — phase is inert there, only the plan matters
      return {
        phase: "writing" as const,
        plannedSlides: event.slides.map((s) => s.trim()).filter(Boolean),
      };
    }),
    beginBuild: assign(({ event }) => {
      if (event.type !== "BEGIN_BUILD") return {};
      return {
        deck: {
          title: event.title,
          subtitle: event.subtitle,
          slideCount: countSlides(event.slidesHtml),
        },
        outPath: event.outPath,
        errors: [],
      };
    }),
    buildDone: assign(({ event }) => {
      // onDone of buildService — output carries outPath evidence
      if (!("output" in event)) return {};
      return {
        outPath: (event as { output: BuildServiceOutput }).output.outPath,
      };
    }),
    buildFailed: assign(({ event }) => {
      // Build failures are always infra (template/IO) — attempt untouched.
      // ErrorActorEvent carries `error` (DoneActorEvent carries `output`).
      if (!("error" in event)) return {};
      return { errors: failureOf((event as { error: unknown }).error).errors };
    }),
    validateDone: assign(({ context }) => {
      // onDone of validateService; outPath evidence already in context
      // (set by buildDone) — recorded into builds history
      const outPath = context.outPath ?? "";
      return {
        builds: context.builds.includes(outPath)
          ? context.builds
          : [...context.builds, outPath],
        errors: [],
      };
    }),
    validateFailed: assign(({ context, event }) => {
      // ErrorActorEvent carries `error` (DoneActorEvent carries `output`)
      if (!("error" in event)) return {};
      const failure = failureOf((event as { error: unknown }).error);
      return {
        errors: failure.errors,
        // "deck" failures burn an attempt (fix loop capped); "infra"
        // failures do not — the content was never checked.
        validateAttempts:
          failure.cause === "deck"
            ? context.validateAttempts + 1
            : context.validateAttempts,
      };
    }),
    resetContext: assign(({ context }) => initialContext(context.limits)),
  },
}).createMachine({
  id: "slide-deck",
  context: ({ input }) =>
    initialContext(input?.limits ?? { maxValidateAttempts: 8 }),
  initial: "authoring",
  states: {
    // ONE authoring state — the ceremony (start/research/plan/write) is
    // optional announcements tracked as `phase` in context; per-phase
    // legality is the phase guards above (≡ the old idle/researching/
    // planning/writing handlers). Targetless transitions are pure
    // assigns — the state never exits.
    authoring: {
      on: {
        // START: fresh authoring only (phase null ≡ old idle); `done`
        // keeps its own START (newDeckStartLegal: new-deck semantics)
        START: { guard: "startLegal", actions: "start" },
        RESEARCH_DONE: { guard: "researchLegal", actions: "recordResearch" },
        // Replan mid-authoring: the plan is load-bearing (buildLegal checks
        // built ids against it), so changing it must stay legal here
        PLAN_DONE: { guard: "planLegal", actions: "recordPlan" },
        // Fast path: one event carries the content; phases are optional
        // announcements. The pipeline (build -> validate -> open) is what
        // the machine enforces, not the authoring ceremony.
        BEGIN_BUILD: {
          guard: "buildLegal",
          target: "building",
          actions: "beginBuild",
        },
        RESET: { actions: "resetContext" },
      },
    },
    building: {
      invoke: {
        src: "buildService",
        input: ({ event }) => {
          if (event.type !== "BEGIN_BUILD") {
            throw new Error(`building entered by ${event.type}`);
          }
          return {
            title: event.title,
            subtitle: event.subtitle,
            navHtml: event.navHtml,
            slidesHtml: event.slidesHtml,
            outPath: event.outPath,
            overwrite: event.overwrite,
          };
        },
        onDone: { target: "validating", actions: "buildDone" },
        onError: { target: "fixing", actions: "buildFailed" },
      },
      // RESET wins over the in-flight build: exiting the state stops the
      // invoked service; a late result has no handler in authoring and is dropped.
      on: {
        RESET: { target: "authoring", actions: "resetContext" },
      },
    },
    validating: {
      invoke: {
        src: "validateService",
        input: ({ context }) => {
          if (!context.outPath) {
            throw new Error(
              "validating without outPath — buildDone must set it",
            );
          }
          return { outPath: context.outPath };
        },
        onDone: { target: "done", actions: "validateDone" },
        onError: { target: "fixing", actions: "validateFailed" },
      },
      on: {
        RESET: { target: "authoring", actions: "resetContext" },
      },
    },
    fixing: {
      on: {
        // Retry loop: resubmit content (fixed) — guarded by buildLegal,
        // which caps failed deck validations until RESET
        BEGIN_BUILD: {
          guard: "buildLegal",
          target: "building",
          actions: "beginBuild",
        },
        // Replan mid-fix: phase-agnostic (≡ old fixing) — the plan is
        // load-bearing for the retry loop, whatever phase led here
        PLAN_DONE: { guard: "fixPlanLegal", actions: "recordPlan" },
        RESET: { target: "authoring", actions: "resetContext" },
      },
    },
    done: {
      on: {
        // Rebuild with tweaked content stays in the same workflow
        BEGIN_BUILD: {
          guard: "buildLegal",
          target: "building",
          actions: "beginBuild",
        },
        // New deck: fresh authoring (phase researching), build history kept
        START: {
          guard: "newDeckStartLegal",
          target: "authoring",
          actions: "start",
        },
        RESET: { target: "authoring", actions: "resetContext" },
      },
    },
  },
});
