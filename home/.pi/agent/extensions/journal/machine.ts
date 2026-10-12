/**
 * Journal machine — invoked persist service.
 *
 * Deterministic control flow for the journalling workflow:
 * - machine owns legality (phase order, step order, tag caps, attempt cap,
 *   state order) and runs the db write autonomously via an invoked service
 * (XState v5 `fromPromise`): one APPROVE event; the machine then drives
 * persist -> done without further model round-trips
 * - the executor owns IO (db.ts: sqlite insert of the composed entry) and
 * is injected via `machine.provide()` — machine.ts ships a typed stub only
 * (throwing "not wired"), so tests run without a db
 * - events come from the `/journal add` interactive flow (user answers via
 * dialogs; the command handler sends each answer as an event); the model
 * may only observe via journal_status and drive RESET via journal_reset
 * - illegal events are rejected (guards) with readable reasons surfaced by
 * the shared violation functions
 *
 * States (the authoring ceremony — template choice, steps, tags, review —
 * is ONE state, `authoring`: phases are tracked as `phase` in context
 * (null|writing|tagging|reviewing); what the machine enforces is the
 * gather -> approve -> persist pipeline):
 *   authoring -> persisting -> done
 *
 * Event flow (authoring events are phase-gated in context; the pipeline
 * event is state-gated):
 *   START {template}          authoring(phase null)|done -> authoring(phase writing)
 *                              (from done: NEW entry — authoring cleared,
 *                              lastEntry kept)
 *   STEP_DONE {stepName, content}
 *                              authoring(phase writing) -> authoring
 *                              (answer recorded; last step flips phase to
 *                              tagging — targetless, the state never exits)
 *   TAGS_DONE {tags}          authoring(phase tagging) -> authoring(phase reviewing)
 *                              (tags normalized: trim/lowercase/dedupe)
 *   APPROVE                   authoring(phase reviewing) -> persisting (invoke persistService)
 *     persistService ok       persisting -> done (entry id + createdAt evidence)
 *     persistService error    persisting -> authoring(phase reviewing, errors,
 *                              attempt +1 — retry APPROVE legal, capped)
 *   RESET                     any -> authoring (context cleared, phase null;
 *                              in-flight persist is stopped by state exit,
 *                              late results have no handler and are dropped)
 *
 * Storage contract (the whole point of the workflow): a completed entry is
 * a SINGLE markdown text field. Template steps shape gathering, not
 * storage — composeContent() folds step answers into one markdown blob
 * (single-step template: answer as-is; multi-step: `## name` sections,
 * empty answers skipped). Tags, entry links, and the timestamp live in
 * their own db tables; links are post-hoc only (journal_link tool), never
 * part of the gather flow.
 */
import { assign, fromPromise, setup } from "xstate";

import { normalizeServiceFailure } from "../_kit/machine-kit.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Template step definition — the user-facing structure for gathering input. */
export interface TemplateStep {
	/** Slug-like name — becomes the `## name` heading in composed markdown. */
	name: string;
	/** Prompt shown to the user as the editor dialog title. */
	prompt: string;
}

/** Template as persisted in db (schema_json content) — validated shapes only. */
export interface TemplateRecord {
	id: number;
	name: string;
	description: string;
	steps: TemplateStep[];
	/** Normalized default tags — suggested at the tagging step; blank input + confirm applies them. Empty = none. */
	defaultTags: string[];
	createdAt: string;
}

/** Persist service input — the full entry, derived from machine context. */
export interface JournalEntryContent {
	templateId: number;
	templateName: string;
	/** Ordered steps with the user's answer for each. */
	steps: Array<TemplateStep & { answer: string }>;
	/** Normalized tags (trim/lowercase/dedupe — normalizeTags output). */
	tags: string[];
}

export interface JournalLimits {
	maxPersistAttempts: number;
}

/**
 * Authoring ceremony phase — the gather flow position. The pipeline states
 * (persisting/done) do not change it.
 */
export type JournalPhase = "writing" | "tagging" | "reviewing";

export interface JournalContext {
	/** Ceremony phase; null ≡ fresh (nothing gathered — START legal). */
	phase: JournalPhase | null;
	template: {
		id: number;
		name: string;
		description: string;
		steps: TemplateStep[];
	} | null;
	/** Step answers keyed by step name — content lives in memory only. */
	answers: Record<string, string>;
	/** Normalized tags. */
	tags: string[];
	/** Last persisted entry (history — survives START of a new entry). */
	lastEntry: { id: number; createdAt: string } | null;
	/** Last problems (persist failures); cleared on success/START. */
	errors: string[];
	/** Failed persists — capped; cleared only by RESET. */
	persistAttempts: number;
	limits: JournalLimits;
}

export type JournalEvent =
	| { type: "START"; template: TemplateRecord }
	| { type: "STEP_DONE"; stepName: string; content: string }
	| { type: "TAGS_DONE"; tags: string[] }
	| { type: "APPROVE" }
	| { type: "RESET" };

export type PersistServiceInput = JournalEntryContent;
export interface PersistServiceOutput {
	id: number;
	createdAt: string;
}

export function initialContext(limits: JournalLimits): JournalContext {
	return {
		phase: null,
		template: null,
		answers: {},
		tags: [],
		lastEntry: null,
		errors: [],
		persistAttempts: 0,
		limits,
	};
}

// ---------------------------------------------------------------------------
// Pure validators — shared by guards, tools, and db revalidation (single
// source of truth; readable reasons surface directly in rejections)
// ---------------------------------------------------------------------------

export const MAX_TEMPLATE_STEPS = 16;
export const MAX_STEP_NAME_LEN = 64;
export const MAX_PROMPT_LEN = 200;
export const MAX_DESCRIPTION_LEN = 200;
export const MAX_STEP_CHARS = 200_000;
export const MAX_TAGS = 16;
export const MAX_TAG_INPUTS = 32;
export const MAX_TAG_CHARS = 128;

const STEP_NAME_RE = /^[a-z0-9-]+$/;

/** Template record name (the picker word) — slug-like, short. */
export function templateNameViolation(name: string): string | null {
	if (!name.trim()) return "template name is empty";
	if (name.length > MAX_STEP_NAME_LEN)
		return `template name too long (${name.length} > ${MAX_STEP_NAME_LEN} chars)`;
	if (!STEP_NAME_RE.test(name))
		return `template name must be lowercase letters, digits, hyphens (got "${name}")`;
	return null;
}

export function templateDescriptionViolation(
	description: string,
): string | null {
	if (description.length > MAX_DESCRIPTION_LEN)
		return `template description too long (${description.length} > ${MAX_DESCRIPTION_LEN} chars)`;
	return null;
}

/**
 * Template steps schema — the validation shared by journal_template_create
 * (create time) and START (load time — catches a hand-edited db). Strict
 * closed shape: { steps: [{ name, prompt }] }, no kind field (output is
 * always single-field markdown; every step is a multiline editor).
 */
export function templateStepsViolation(steps: unknown): string | null {
	if (!Array.isArray(steps)) return "steps must be an array";
	if (steps.length === 0)
		return "steps is empty — a template needs at least one step";
	if (steps.length > MAX_TEMPLATE_STEPS)
		return `too many steps (${steps.length} > ${MAX_TEMPLATE_STEPS})`;
	const seen = new Set<string>();
	for (const [i, raw] of steps.entries()) {
		const where = `step ${i + 1}`;
		if (typeof raw !== "object" || raw === null) {
			return `${where}: must be an object { name, prompt }`;
		}
		const step = raw as { name?: unknown; prompt?: unknown };
		if (typeof step.name !== "string") return `${where}: name must be a string`;
		if (!step.name.trim()) return `${where}: name is empty`;
		if (step.name.length > MAX_STEP_NAME_LEN)
			return `${where}: name too long (${step.name.length} > ${MAX_STEP_NAME_LEN} chars)`;
		if (!STEP_NAME_RE.test(step.name))
			return `${where}: name must be lowercase letters, digits, hyphens (got "${step.name}")`;
		if (seen.has(step.name))
			return `duplicate step name: ${step.name} (steps are keyed by name)`;
		seen.add(step.name);
		if (typeof step.prompt !== "string")
			return `${where}: prompt must be a string`;
		if (!step.prompt.trim())
			return `${where}: prompt is empty — it is shown as the editor title`;
		if (step.prompt.length > MAX_PROMPT_LEN)
			return `${where}: prompt too long (${step.prompt.length} > ${MAX_PROMPT_LEN} chars)`;
	}
	return null;
}

/**
 * Template defaultTags — optional schema field. Suggested at the tagging
 * step: blank tag input + template defaults → confirm dialog applies them
 * (option C: explicit intent every time, never silently applied).
 */
export function templateDefaultTagsViolation(defaultTags: unknown): string | null {
	if (defaultTags === undefined || defaultTags === null) return null; // optional
	if (!Array.isArray(defaultTags))
		return "defaultTags must be an array of strings";
	if (defaultTags.length > MAX_TAGS)
		return `too many defaultTags (${defaultTags.length} > ${MAX_TAGS})`;
	for (const t of defaultTags) {
		if (typeof t !== "string")
			return "defaultTags entries must be strings";
		if (!t.trim()) return "defaultTags entries must be non-empty";
		if (t.length > MAX_TAG_CHARS)
			return `defaultTag too long (${t.length} > ${MAX_TAG_CHARS} chars): "${t.slice(0, 32)}…"`;
	}
	return null;
}

/** Free-form tag normalization: trim, lowercase, drop empties, dedupe. */
export function normalizeTags(raw: string[]): string[] {
	const seen = new Set<string>();
	for (const t of raw) {
		const n = t.trim().toLowerCase();
		if (n) seen.add(n);
	}
	return [...seen];
}

/** Raw tag input validation (before normalization) — caps only. */
export function tagListViolation(raw: string[]): string | null {
	if (raw.length > MAX_TAG_INPUTS)
		return `too many tag inputs (${raw.length} > ${MAX_TAG_INPUTS})`;
	for (const t of raw) {
		if (t.length > MAX_TAG_CHARS)
			return `tag too long (${t.length} > ${MAX_TAG_CHARS} chars): "${t.slice(0, 32)}…"`;
	}
	const unique = normalizeTags(raw);
	if (unique.length > MAX_TAGS)
		return `too many unique tags (${unique.length} > ${MAX_TAGS})`;
	return null;
}

/** START: template record must carry a valid steps schema. */
export function startViolation(template: TemplateRecord): string | null {
	return templateStepsViolation(template.steps);
}

/** STEP_DONE: the step must be the next expected one; content size capped. */
export function stepViolation(
	ctx: JournalContext,
	stepName: string,
	content: string,
): string | null {
	if (!ctx.template) return "no template — START first";
	const expected = ctx.template.steps[Object.keys(ctx.answers).length];
	if (!expected) {
		return `all steps already answered — TAGS_DONE is next (tags: ${ctx.tags.length ? "some recorded" : "none yet"})`;
	}
	if (stepName !== expected.name) {
		return `step "${stepName}" is not next — expected "${expected.name}" (step ${Object.keys(ctx.answers).length + 1} of ${ctx.template.steps.length})`;
	}
	if (content.length > MAX_STEP_CHARS) {
		return `step content too large (${content.length} > ${MAX_STEP_CHARS} chars)`;
	}
	return null;
}

/** APPROVE: attempts capped; at least one non-empty answer. */
export function approveViolation(ctx: JournalContext): string | null {
	if (ctx.persistAttempts >= ctx.limits.maxPersistAttempts) {
		return `persist attempts exhausted (${ctx.persistAttempts}/${ctx.limits.maxPersistAttempts}) — /journal reset to start over`;
	}
	if (!ctx.template) return "no template — START first";
	const hasContent = ctx.template.steps.some(
		(s) => (ctx.answers[s.name] ?? "").trim().length > 0,
	);
	if (!hasContent) {
		return "every step answer is empty — an entry needs at least one non-empty step";
	}
	return null;
}

/**
 * Compose step answers into the single markdown content field — the
 * storage contract. Single-step template: answer as-is. Multi-step:
 * `## {name}` sections joined by blank lines; empty answers skipped.
 */
export function composeContent(
	steps: Array<{ name: string; answer: string }>,
): string {
	const multi = steps.length > 1;
	return steps
		.filter((s) => s.answer.trim().length > 0)
		.map((s) => (multi ? `## ${s.name}\n\n${s.answer.trim()}` : s.answer.trim()))
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers for executor evidence in events
// ---------------------------------------------------------------------------

export interface PersistServiceFailure {
	errors: string[];
}

/**
 * Normalize an unknown persist-service rejection into failure data. Every
 * persist failure is "infra" (db-side) — entry content was machine-validated
 * before APPROVE — so all causes collapse; only the errors matter.
 */
export function failureOf(output: unknown): PersistServiceFailure {
	return normalizeServiceFailure(output, {
		causes: ["infra"],
		defaultCause: "infra",
		nonShapedCause: "infra",
	});
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const journalMachine = setup({
	types: {
		context: {} as JournalContext,
		events: {} as JournalEvent,
		input: {} as { limits: JournalLimits } | undefined,
	},
	actors: {
		/**
		 * Typed stub only — the real executor (db.ts insert) is injected via
		 * `journalMachine.provide({ actors: ... })` (index.ts wires sqlite,
		 * test.ts wires stubs). Machine.ts stays IO-free; an unwired machine
		 * that enters `persisting` lands back in authoring with this error.
		 */
		persistService: fromPromise<PersistServiceOutput, PersistServiceInput>(
			async () => {
				throw new Error(
					"persistService not wired — machine.provide() must inject the db executor",
				);
			},
		),
	},
	guards: {
		// Ceremony legality lives in context (phase ≡ the old per-state
		// handlers); each guard = phase + content precheck. The pipeline
		// event (APPROVE) is phase-gated in authoring's reviewing case.
		startLegal: ({ context, event }) =>
			event.type === "START" &&
			// Fresh authoring only (phase null ≡ old idle); `done` keeps its
			// own START (newEntryStartLegal) — this guard never runs there.
			context.phase === null &&
			startViolation(event.template) === null,
		newEntryStartLegal: ({ event }) =>
			// START from done: a NEW entry begins whatever phase the finished
			// entry used — the start action clears the gather state, keeps
			// lastEntry history
			event.type === "START" && startViolation(event.template) === null,
		stepLegal: ({ context, event }) =>
			event.type === "STEP_DONE" &&
			// Writing phase only (≡ old writing state); ordering + caps in
			// the shared violation fn
			context.phase === "writing" &&
			stepViolation(context, event.stepName, event.content) === null,
		tagsLegal: ({ context, event }) =>
			event.type === "TAGS_DONE" &&
			// Tagging phase only (all steps answered)
			context.phase === "tagging" &&
			tagListViolation(event.tags) === null,
		approveLegal: ({ context, event }) =>
			event.type === "APPROVE" &&
			// Reviewing phase only (template + steps + tags recorded)
			context.phase === "reviewing" &&
			approveViolation(context) === null,
	},
	actions: {
		start: assign(({ event }) => {
			if (event.type !== "START") return {};
			// Phase writing ≡ old writing state (STEP_DONE legal). From `done`
			// this is a NEW entry: gather state cleared, lastEntry kept.
			return {
				phase: "writing" as const,
				template: {
					id: event.template.id,
					name: event.template.name,
					description: event.template.description,
					steps: event.template.steps,
				},
				answers: {},
				tags: [],
				errors: [],
			};
		}),
		recordStep: assign(({ context, event }) => {
			if (event.type !== "STEP_DONE") return {};
			const answers = { ...context.answers, [event.stepName]: event.content };
			// Last step flips the phase to tagging (targetless — authoring
			// never exits); TAGS_DONE becomes legal
			const done = context.template
				? Object.keys(answers).length >= context.template.steps.length
				: false;
			return {
				answers,
				phase: done ? ("tagging" as const) : context.phase,
			};
		}),
		recordTags: assign(({ event }) => {
			if (event.type !== "TAGS_DONE") return {};
			// Phase reviewing ≡ old reviewing state (APPROVE legal); tags
			// normalized once, here — everything downstream sees the same set
			return {
				phase: "reviewing" as const,
				tags: normalizeTags(event.tags),
			};
		}),
		beginPersist: assign(() => ({
			// Clear stale errors before the attempt (retry loop reads them)
			errors: [],
		})),
		persistDone: assign(({ event }) => {
			// onDone of persistService — output carries entry id + createdAt
			if (!("output" in event)) return {};
			const out = (event as { output: PersistServiceOutput }).output;
			return { lastEntry: { id: out.id, createdAt: out.createdAt } };
		}),
		persistFailed: assign(({ context, event }) => {
			// ErrorActorEvent carries `error` (DoneActorEvent carries `output`)
			if (!("error" in event)) return {};
			const failure = failureOf((event as { error: unknown }).error);
			return {
				errors: failure.errors,
				persistAttempts: context.persistAttempts + 1,
			};
		}),
		resetContext: assign(({ context }) => initialContext(context.limits)),
	},
}).createMachine({
	id: "journal",
	context: ({ input }) =>
		initialContext(input?.limits ?? { maxPersistAttempts: 4 }),
	initial: "authoring",
	states: {
		// ONE authoring state — the gather ceremony (template -> steps ->
		// tags -> review) is phase-gated in context; targetless transitions
		// are pure assigns — the state never exits.
		authoring: {
			on: {
				// START: fresh authoring only (phase null ≡ old idle); `done`
				// keeps its own START (newEntryStartLegal: new-entry semantics)
				START: { guard: "startLegal", actions: "start" },
				STEP_DONE: { guard: "stepLegal", actions: "recordStep" },
				TAGS_DONE: { guard: "tagsLegal", actions: "recordTags" },
				APPROVE: {
					guard: "approveLegal",
					target: "persisting",
					actions: "beginPersist",
				},
				RESET: { actions: "resetContext" },
			},
		},
		persisting: {
			invoke: {
				src: "persistService",
				input: ({ context }) => {
					if (!context.template) {
						throw new Error("persisting without template — START first");
					}
					return {
						templateId: context.template.id,
						templateName: context.template.name,
						steps: context.template.steps.map((s) => ({
							...s,
							answer: context.answers[s.name] ?? "",
						})),
						tags: context.tags,
					};
				},
				onDone: { target: "done", actions: "persistDone" },
				// Persist failures are db-side (infra): retry APPROVE legal
				// from authoring/phase reviewing, capped by approveLegal
				onError: { target: "authoring", actions: "persistFailed" },
			},
			// RESET wins over the in-flight persist: exiting the state stops
			// the invoked service; a late result has no handler in authoring
			// and is dropped.
			on: {
				RESET: { target: "authoring", actions: "resetContext" },
			},
		},
		done: {
			on: {
				// New entry: fresh gathering (phase writing), lastEntry kept
				START: {
					guard: "newEntryStartLegal",
					target: "authoring",
					actions: "start",
				},
				RESET: { target: "authoring", actions: "resetContext" },
			},
		},
	},
});
