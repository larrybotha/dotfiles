/**
 * Mermaid validate-gated render machine.
 *
 * Deterministic control flow for the diagram workflow:
 * - machine owns legality (validation-first rule, stale-source rule via
 *   path+hash evidence, failed-attempt cap, state order)
 * - executors (skill's Docker scripts + file IO in index.ts) do IO
 * - the model may only send legal events via tools; illegal events are rejected
 *
 * Event flow (two-phase per action, evidence in events):
 *   BEGIN_VALIDATE           -> (Docker ascii.sh)  -> VALIDATE_DONE {path, hash, ok, errors}
 *   BEGIN_RENDER {path,hash}-> (Docker svg.sh)    -> RENDER_DONE  {ok, outPath, error}
 *   BEGIN_EMBED  {path,hash}-> (file IO)          -> EMBED_DONE   {ok, target, error}
 *   RESET -> drafting (context cleared)
 *
 * The validation-first rule mirrors web-search's known-link rule: render and
 * embed are only legal for the exact source (path + content hash) that last
 * passed validation. A change to the diagram invalidates the pass —
 * re-validate. Embedding is idempotent-safe: same source marker in the target
 * is replaced, not duplicated (executor behavior; machine only records).
 */
import { assign, setup } from "xstate";

export type ValidatedSource = { path: string; hash: string };

export interface MermaidLimits {
	maxValidateAttempts: number;
}

export interface MermaidContext {
	/** Source that last passed validation (abs path + content hash). */
	validated: ValidatedSource | null;
	/** Last problems (validation errors / render or embed failure); cleared on success. */
	errors: string[];
	/** Failed validations — capped separately from successes. */
	validateAttempts: number;
	/** Successful SVG render output paths. */
	renders: string[];
	/** Successful embed target paths. */
	embeds: string[];
	limits: MermaidLimits;
}

export type MermaidEvent =
	| { type: "BEGIN_VALIDATE" }
	| { type: "VALIDATE_DONE"; path: string; hash: string; ok: boolean; errors: string[] }
	| { type: "BEGIN_RENDER"; path: string; hash: string; outPath: string }
	| { type: "RENDER_DONE"; ok: boolean; outPath: string; error: string | null }
	| { type: "BEGIN_EMBED"; path: string; hash: string; target: string }
	| { type: "EMBED_DONE"; ok: boolean; target: string; error: string | null }
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
		return `validation attempts exhausted (${ctx.validateAttempts}/${ctx.limits.maxValidateAttempts} failed validations) — the diagram keeps failing; mermaid_reset to start over or write a fresh diagram file`;
	}
	return null;
}

function sourceMismatch(ctx: MermaidContext, path: string, hash: string): string | null {
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

export function renderViolation(ctx: MermaidContext, path: string, hash: string): string | null {
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

export const mermaidMachine = setup({
	types: {
		context: {} as MermaidContext,
		events: {} as MermaidEvent,
		input: {} as { limits: MermaidLimits } | undefined,
	},
	guards: {
		validateLegal: ({ context }) => validateViolation(context) === null,
		renderLegal: ({ context, event }) =>
			event.type === "BEGIN_RENDER" && renderViolation(context, event.path, event.hash) === null,
		embedLegal: ({ context, event }) =>
			event.type === "BEGIN_EMBED" &&
			embedViolation(context, event.path, event.hash, event.target) === null,
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
			return {
				validated: null,
				errors: event.errors,
				validateAttempts: context.validateAttempts + 1,
			};
		}),
		applyRender: assign(({ context, event }) => {
			if (event.type !== "RENDER_DONE") return {};
			if (event.ok) {
				return {
					renders: context.renders.includes(event.outPath)
						? context.renders
						: [...context.renders, event.outPath],
					errors: [],
				};
			}
			return { errors: [event.error ?? "render failed"] };
		}),
		applyEmbed: assign(({ context, event }) => {
			if (event.type !== "EMBED_DONE") return {};
			if (event.ok) {
				return {
					embeds: context.embeds.includes(event.target)
						? context.embeds
						: [...context.embeds, event.target],
					errors: [],
				};
			}
			return { errors: [event.error ?? "embed failed"] };
		}),
		resetContext: assign(({ context }) => initialContext(context.limits)),
	},
}).createMachine({
	id: "mermaid",
	context: ({ input }) =>
		initialContext(input?.limits ?? { maxValidateAttempts: 8 }),
	initial: "drafting",
	states: {
		drafting: {
			on: {
				BEGIN_VALIDATE: { guard: "validateLegal", target: "validating" },
			},
		},
		validating: {
			on: {
				VALIDATE_DONE: [
					{ guard: ({ event }) => event.type === "VALIDATE_DONE" && event.ok, target: "validated", actions: "applyValidation" },
					{ target: "fixing", actions: "applyValidation" },
				],
			},
		},
		fixing: {
			on: {
				BEGIN_VALIDATE: { guard: "validateLegal", target: "validating" },
				RESET: { target: "drafting", actions: "resetContext" },
			},
		},
		validated: {
			on: {
				BEGIN_VALIDATE: { guard: "validateLegal", target: "validating" },
				BEGIN_RENDER: { guard: "renderLegal", target: "rendering" },
				BEGIN_EMBED: { guard: "embedLegal", target: "validated", actions: [] },
				EMBED_DONE: { actions: "applyEmbed" },
				RESET: { target: "drafting", actions: "resetContext" },
			},
		},
		rendering: {
			on: {
				RENDER_DONE: [
					{ guard: ({ event }) => event.type === "RENDER_DONE" && event.ok, target: "rendered", actions: "applyRender" },
					{ target: "fixing", actions: "applyRender" },
				],
				RESET: { target: "drafting", actions: "resetContext" },
			},
		},
		rendered: {
			on: {
				BEGIN_VALIDATE: { guard: "validateLegal", target: "validating" },
				BEGIN_RENDER: { guard: "renderLegal", target: "rendering" },
				BEGIN_EMBED: { guard: "embedLegal", target: "rendered", actions: [] },
				EMBED_DONE: { actions: "applyEmbed" },
				RESET: { target: "drafting", actions: "resetContext" },
			},
		},
	},
});
