/**
 * journal extension — machine-driven journalling workflow over sqlite.
 *
 * The workflow lives in an XState machine (machine.ts): the `/journal add`
 * command drives an interactive gather flow (template select -> one editor
 * dialog per template step -> tags -> save confirm), sending each user
 * answer as a machine event; APPROVE invokes the persist service, which
 * writes the composed single-field markdown entry (+ tags, timestamp) to
 * the sqlite db via db.ts. No model round-trips mid-flow — the user writes
 * the content. A cancelled dialog PAUSES the flow: gathered answers stay
 * in the machine context; a later /journal add continues (or starts over),
 * /journal reset discards. The model observes (journal_status) and manages
 * templates and links through tools:
 *
 *   journal_read            — query entries / entry / tags / templates
 *                             (tag + substring filters, previews)
 *   journal_template_create — write a template schema to the db (steps
 *                             validated; strict closed shape)
 *   journal_link            — post-hoc m:n links between entries
 *   journal_status          — snapshot + allowed next steps
 *   journal_reset           — clear the workflow state; discarding answers
 *                             in progress / a mid-save asks the user first
 *
 * Storage contract: a completed entry is a single markdown text field —
 * template steps shape gathering, composeContent() folds them at persist
 * time. Links are post-hoc only. The db is directory-local to this
 * extension: tmp/journal.db (gitignored), JOURNAL_DB_PATH overrides.
 *
 * Machine-touching tool results (journal_status / journal_reset) carry the
 * persisted snapshot, so workflow state follows the conversation branch
 * (rewind/branch-safe; mid-flow answers are memory-only by design).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createActor, fromPromise, waitFor, type Actor } from "xstate";
import { envLimit } from "../_kit/machine-kit.ts";
import { JournalDb, type LinkReport } from "./db.ts";
import {
	approveViolation,
	composeContent,
	type JournalContext,
	type JournalEvent,
	type JournalLimits,
	journalMachine,
	nextStepIndex,
	type PersistServiceInput,
	type PersistServiceOutput,
	type TemplateRecord,
	type TemplateStep,
	templateDefaultTagsViolation,
	templateDescriptionViolation,
	templateNameViolation,
	templateStepsViolation,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LIMITS: JournalLimits = {
	maxPersistAttempts: envLimit("JOURNAL_MAX_PERSIST_ATTEMPTS", 4),
};
/** Persist settle timeout — a sqlite insert is fast; generous backstop. */
const SETTLE_TIMEOUT_MS = envLimit("JOURNAL_SETTLE_TIMEOUT_MS", 30_000);

// Extension root = this file's dir (index.ts lives in extensions/journal/)
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(
	process.env.JOURNAL_DB_PATH ?? join(EXT_DIR, "tmp", "journal.db"),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PersistedSnapshot = {
	context?: JournalContext;
	value?: unknown;
	status?: unknown;
};

type JournalDetails = {
	action: "read" | "template_create" | "link" | "status" | "reset";
	state?: string;
	templateId?: number;
	entryId?: number;
	rejected?: string;
	error?: string;
	snapshot?: unknown;
};

/** Structural slice of the command context the add-flow needs (UI dialogs). */
type JournalUiCtx = {
	hasUI: boolean;
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		confirm: (
			title: string,
			message: string,
		) => Promise<boolean>;
		input: (
			title: string,
			placeholder?: string,
		) => Promise<string | undefined>;
		editor: (title: string, prefill?: string) => Promise<string | undefined>;
		notify: (message: string, kind?: "info" | "warning" | "error") => void;
	};
};

// ---------------------------------------------------------------------------
// Db (lazy singleton — no long-lived resource in the factory)
// ---------------------------------------------------------------------------

let db: JournalDb | null = null;

function getDb(): JournalDb {
	if (!db) db = new JournalDb(DB_PATH);
	return db;
}

// ---------------------------------------------------------------------------
// Actor management
// ---------------------------------------------------------------------------

/** Wire the machine's persist slot to the db executor (machine.ts ships the stub). */
export const wiredMachine = journalMachine.provide({
	actors: {
		persistService: fromPromise<PersistServiceOutput, PersistServiceInput>(
			async ({ input }) => {
				// Compose at the IO boundary: single markdown field into sqlite
				const content = composeContent(input.steps);
				return getDb().insertEntry({
					templateId: input.templateId,
					content,
					tags: input.tags,
				});
			},
		),
	},
});

let actor: Actor<typeof wiredMachine> | null = null;

/** Single actor-creation site — fresh input or persisted-snapshot restore. */
function createJournalActor(
	opts: { input: { limits: JournalLimits } } | { snapshot: unknown },
): Actor<typeof wiredMachine> {
	const a = createActor(wiredMachine, {
		input: "input" in opts ? opts.input : undefined,
		// XState's persisted-snapshot type is internal; snapshots passed here
		// come from getPersistedSnapshot() of this same machine — one cast at
		// this boundary.
		snapshot: "snapshot" in opts ? (opts.snapshot as never) : undefined,
	});
	a.start();
	actor = a;
	return a;
}

function freshActor(): Actor<typeof wiredMachine> {
	return createJournalActor({ input: { limits: LIMITS } });
}

function getActor(): Actor<typeof wiredMachine> {
	if (!actor) freshActor();
	return actor!;
}

function stateValue(): string {
	const snap = getActor().getSnapshot() as unknown as PersistedSnapshot;
	return String(snap.value ?? snap.status);
}

/** State label for model/user-facing text: authoring names its phase. */
function stateLabel(c: JournalContext): string {
	const v = stateValue();
	return v === "authoring" && c.phase ? `authoring (${c.phase})` : v;
}

/**
 * Serialize journal tool bodies (single machine, persist in flight):
 * without a lock, concurrent tool calls interleave events — the machine
 * drops the second caller's events while both tools report success.
 */
let toolChain: Promise<unknown> = Promise.resolve();
function withToolLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = toolChain.then(fn, fn);
	toolChain = next.catch(() => {});
	return next;
}

/**
 * Session reset telemetry — lives outside the machine so RESET cannot clear
 * it. Process-lifetime only: not branch-restored, session restart starts a
 * clean count. Enforced nowhere; surfaced in statusLine.
 */
const sessionStats = { resets: 0 };

/** Machine-touching tool names — reconstruct scans for their snapshots. */
const SNAPSHOT_TOOLS = new Set(["journal_status", "journal_reset"]);

/** Restore workflow state from the last journal tool result on this branch. */
function reconstructState(ctx: {
	sessionManager: { getBranch: () => Array<any> };
}) {
	for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
		const entry = ctx.sessionManager.getBranch()[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || !SNAPSHOT_TOOLS.has(msg.toolName))
			continue;
		const details = msg.details as JournalDetails | undefined;
		const snap = details?.snapshot as PersistedSnapshot | undefined;
		if (snap?.context) {
			createJournalActor({ snapshot: details!.snapshot });
			return;
		}
	}
	actor = null;
}

// ---------------------------------------------------------------------------
// Formatting (model/user-facing)
// ---------------------------------------------------------------------------

const text = (t: string) => [{ type: "text" as const, text: t }];

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function statusLine(c: JournalContext): string {
	const parts = [`Machine state: ${stateLabel(c)}.`];
	// session reset telemetry — survives RESET
	if (sessionStats.resets > 0) parts.push(`Resets this session: ${sessionStats.resets}.`);
	if (c.template) {
		const answered = Object.keys(c.answers).length;
		parts.push(
			`Template: ${c.template.name} (${answered}/${c.template.steps.length} steps answered).`,
		);
	}
	if (c.tags.length > 0) parts.push(`Tags: ${c.tags.join(", ")}.`);
	if (c.lastEntry)
		parts.push(`Last entry: #${c.lastEntry.id} at ${c.lastEntry.createdAt}.`);
	parts.push(
		`Failed persists: ${c.persistAttempts}/${c.limits.maxPersistAttempts}.`,
	);
	return parts.join(" ");
}

/** Allowed next steps, derived from the CURRENT machine state + phase. */
function allowedNext(): string {
	const v = stateValue();
	if (v === "authoring") {
		const phase = getActor().getSnapshot().context.phase;
		switch (phase) {
			case null:
				return "Allowed next: /journal add (gather + persist an entry).";
			case "writing":
			case "tagging":
				return "Allowed next: /journal add (continue the paused entry, or start a new one after a discard confirm), or /journal reset (discard it).";
			case "reviewing":
				return "Allowed next: /journal add (save/retry the pending entry), or /journal reset (discard).";
		}
	}
	switch (v) {
		case "persisting":
			return "Allowed next: none — the persist service is in flight; wait for it to settle.";
		case "done":
			return "Allowed next: /journal add (new entry), or /journal reset.";
		default:
			return `Allowed next (state ${v}): /journal status.`;
	}
}

/**
 * Persisted snapshot for tool-result details, slimmed: answers dropped
 * (memory-only content — a reconstructed machine degrades honestly: APPROVE
 * rejects "every step answer is empty" instead of persisting a stub),
 * errors capped + truncated, everything else is bounded meta.
 */
function slimSnapshot(snapshot: unknown): unknown {
	const slim = JSON.parse(JSON.stringify(snapshot)) as PersistedSnapshot;
	const c = slim?.context;
	if (c) {
		c.answers = {};
		c.tags = c.tags.slice(0, 16);
		c.errors = c.errors.slice(0, 10).map((e) => String(e).slice(0, 400));
		if (c.template) {
			c.template.description = String(c.template.description).slice(0, 200);
		}
	}
	return slim;
}

function detailsFor(
	action: JournalDetails["action"],
	extra: Partial<JournalDetails> = {},
): JournalDetails {
	return {
		action,
		state: stateValue(),
		...extra,
	};
}

// ---------------------------------------------------------------------------
// The /journal add interactive flow (user-driven; zero model round-trips)
// ---------------------------------------------------------------------------

/**
 * Pause the flow — the machine context keeps every gathered answer; no
 * RESET is sent. A cancelled dialog, or a machine-rejected event (dropped;
 * context untouched), leaves a resumable state: a later /journal add
 * offers continue-or-start-over, /journal reset discards.
 */
function pauseFlow(ctx: JournalUiCtx, why: string): void {
	ctx.ui.notify(
		`Journal paused — ${why}. /journal add to continue, /journal reset to discard`,
		"info",
	);
}

/** Send APPROVE, wait for the persist service to settle, report the outcome. */
async function persistAndReport(ctx: JournalUiCtx): Promise<void> {
	const snap = getActor().getSnapshot();
	if (!snap.can({ type: "APPROVE" })) {
		const reason =
			approveViolation(snap.context) ??
			`not legal from state \`${stateLabel(snap.context)}\` — a persist is in flight`;
		ctx.ui.notify(`Journal save rejected: ${reason}`, "error");
		return;
	}
	getActor().send({ type: "APPROVE" });
	try {
		await waitFor(getActor(), (s) => s.matches("done") || s.matches("authoring"), {
			timeout: SETTLE_TIMEOUT_MS,
		});
	} catch {
		ctx.ui.notify(
			`Journal persist still in flight after ${Math.round(SETTLE_TIMEOUT_MS / 1000)}s — /journal status`,
			"warning",
		);
		return;
	}
	const s = getActor().getSnapshot();
	if (s.matches("done")) {
		const e = s.context.lastEntry;
		ctx.ui.notify(
			`Journal entry #${e?.id ?? "?"} saved${s.context.tags.length > 0 ? ` — tags: ${s.context.tags.join(", ")}` : ""}`,
			"info",
		);
		return;
	}
	// authoring again: either the persist failed, or APPROVE was dropped
	if (s.context.errors.length > 0) {
		ctx.ui.notify(
			`Journal persist failed: ${s.context.errors.join("; ").slice(0, 300)} — rerun /journal add to retry`,
			"error",
		);
	} else {
		ctx.ui.notify(
			"Journal APPROVE was dropped (state changed mid-flight) — /journal status",
			"warning",
		);
	}
}

/**
 * Destructive-discard warning for a model-triggered journal_reset: answered
 * steps are memory-only and a silent drop is unrecoverable. Null when
 * nothing user-authored is at risk (idle / authoring phase null / done).
 */
function resetDiscardWarning(c: JournalContext): string | null {
	const v = stateValue();
	if (v === "persisting")
		return "an entry the user approved is mid-save — resetting drops the save";
	if (v === "authoring" && c.phase !== null)
		return `an entry is in progress (${progressText(c)}) — answered steps are memory-only and unrecoverable`;
	return null;
}

/** Progress text for the mid-flow discard confirm. */
function progressText(c: JournalContext): string {
	if (!c.template) return "no template";
	const answered = Object.keys(c.answers).length;
	const where =
		c.phase === "writing"
			? `${answered}/${c.template.steps.length} steps answered`
			: c.phase === "tagging"
				? "steps done, tags pending"
				: "awaiting save";
	return `template ${c.template.name}, ${where}`;
}

/**
 * Template defaultTags for a resumed entry's tagging phase — the context
 * keeps the template START carried (defaultTags dropped there), so look
 * the record up by id. [] when the row is gone or the db errors:
 * suggestions are cosmetic, never flow-blocking.
 */
function templateDefaults(templateId: number): string[] {
	try {
		return (
			getDb().listTemplates().find((t) => t.id === templateId)?.defaultTags ??
			[]
		);
	} catch {
		return [];
	}
}

/**
 * One editor dialog per remaining step (from `fromIndex` — nextStepIndex
 * on resume, 0 on a fresh entry), sending STEP_DONE per answer. False =
 * paused: a cancelled dialog or a machine-rejected event (dropped;
 * context untouched) — every gathered answer stays, the flow can rerun.
 */
async function gatherSteps(
	ctx: JournalUiCtx,
	template: { steps: TemplateStep[] },
	fromIndex: number,
): Promise<boolean> {
	for (const [i, step] of template.steps.entries()) {
		if (i < fromIndex) continue; // already answered — resume skips
		const answer = await ctx.ui.editor(
			`Journal (${i + 1}/${template.steps.length}): ${step.prompt}`,
		);
		if (answer === undefined) {
			pauseFlow(
				ctx,
				`paused at step ${i + 1}/${template.steps.length} ("${step.name}")`,
			);
			return false;
		}
		const s = getActor().getSnapshot();
		if (!s.can({ type: "STEP_DONE", stepName: step.name, content: answer })) {
			pauseFlow(ctx, `machine rejected step "${step.name}" — /journal status`);
			return false;
		}
		getActor().send({ type: "STEP_DONE", stepName: step.name, content: answer });
	}
	return true;
}

/**
 * Tags dialog + TAGS_DONE. False = paused (cancelled dialog or machine
 * rejection). Blank input + template defaults → one confirm (option C —
 * explicit intent, never silently applied).
 */
async function gatherTags(
	ctx: JournalUiCtx,
	defaults: string[],
): Promise<boolean> {
	// Placeholder shows the template's defaultTags first, then existing db
	// tags as suggestions; the machine normalizes whatever is sent.
	let existingNames: string[] = [];
	try {
		existingNames = getDb().listTags().map((t) => t.name);
	} catch {
		/* suggestions are cosmetic — never block the flow */
	}
	const suggestionParts: string[] = [];
	if (defaults.length > 0)
		suggestionParts.push(`blank: ${defaults.join(", ")}`);
	if (existingNames.length > 0)
		suggestionParts.push(`existing: ${existingNames.slice(0, 8).join(", ")}`);
	const rawTags = await ctx.ui.input(
		"Journal: tags (comma-separated, blank for none)",
		suggestionParts.length > 0
			? suggestionParts.join(" · ")
			: "e.g. work, deep-focus",
	);
	if (rawTags === undefined) {
		pauseFlow(ctx, "paused at tags");
		return false;
	}
	let tagInput = rawTags
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (tagInput.length === 0 && defaults.length > 0) {
		const useDefaults = await ctx.ui.confirm(
			"Journal: no tags entered — use this template's default tags?",
			defaults.join(", "),
		);
		if (useDefaults) tagInput = [...defaults];
	}

	const snap = getActor().getSnapshot();
	if (!snap.can({ type: "TAGS_DONE", tags: tagInput })) {
		pauseFlow(ctx, "machine rejected the tags — /journal status");
		return false;
	}
	getActor().send({ type: "TAGS_DONE", tags: tagInput });
	return true;
}

/**
 * Review confirm — the composed single-field markdown the db will store —
 * then APPROVE + persist. Declining discards: explicit intent, like the
 * old flow.
 */
async function reviewAndPersist(ctx: JournalUiCtx): Promise<void> {
	const c = getActor().getSnapshot().context;
	if (!c.template) {
		pauseFlow(ctx, "machine lost the template — /journal status");
		return;
	}
	const composed = composeContent(
		c.template.steps.map((s) => ({
			name: s.name,
			answer: c.answers[s.name] ?? "",
		})),
	);
	const preview = [
		`template: ${c.template.name}`,
		c.tags.length > 0 ? `tags: ${c.tags.join(", ")}` : "tags: none",
		"",
		composed.length > 1500 ? `${composed.slice(0, 1500)}\n…` : composed,
	].join("\n");
	const save = await ctx.ui.confirm("Journal: save this entry?", preview);
	if (!save) {
		getActor().send({ type: "RESET" });
		ctx.ui.notify("Journal entry discarded", "info");
		return;
	}
	await persistAndReport(ctx);
}

/**
 * Continue a paused entry: re-open dialogs from the machine context's
 * phase — writing: editors from the first unanswered step; tagging: the
 * tags dialog; reviewing: straight to review + persist. The context holds
 * every gathered answer; no events are replayed.
 */
async function resumeEntry(ctx: JournalUiCtx): Promise<void> {
	const c = getActor().getSnapshot().context;
	if (!c.template || c.phase === null) {
		// phase-gated by the caller; defensive — state changed mid-dialog
		pauseFlow(ctx, "no resumable entry in the machine — /journal status");
		return;
	}
	const template = c.template;
	const defaults = templateDefaults(template.id);
	if (c.phase === "writing") {
		if (!(await gatherSteps(ctx, template, nextStepIndex(c)))) return;
		if (!(await gatherTags(ctx, defaults))) return;
	} else if (c.phase === "tagging") {
		if (!(await gatherTags(ctx, defaults))) return;
	}
	await reviewAndPersist(ctx);
}

/**
 * The gather flow: template select -> editor per step -> tags -> review
 * confirm -> APPROVE -> persist. Every user answer becomes a machine event;
 * illegal transitions (a bug or a concurrent change) pause the flow
 * honestly (event dropped, state kept) instead of forcing state.
 */
async function runAddFlow(ctx: JournalUiCtx): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/journal add needs interactive dialogs — run it in the TUI (or an RPC client that forwards dialogs)",
			"error",
		);
		return;
	}

	// Failed-persist retry path: phase reviewing + errors means APPROVE
	// already ran and the db write failed — offer the retry first.
	let snap = getActor().getSnapshot();
	if (
		snap.matches("authoring") &&
		snap.context.phase === "reviewing" &&
		snap.context.errors.length > 0
	) {
		const retry = await ctx.ui.confirm(
			"Journal: last entry failed to persist. Retry saving it?",
			snap.context.errors.join("\n").slice(0, 500),
		);
		if (retry) {
			await persistAndReport(ctx);
			return;
		}
		getActor().send({ type: "RESET" });
	} else if (snap.matches("authoring") && snap.context.phase !== null) {
		// Paused entry: continue or start over — never silently drop answers
		const resumeOptions = [
			`Continue — ${progressText(snap.context)}`,
			"Start over — discard it and pick a template",
		];
		const resumePick = await ctx.ui.select(
			"Journal: an entry is in progress",
			resumeOptions,
		);
		if (resumePick === undefined) {
			ctx.ui.notify("Journal flow kept as-is — /journal status", "info");
			return;
		}
		if (resumePick === resumeOptions[0]) {
			await resumeEntry(ctx);
			return;
		}
		getActor().send({ type: "RESET" });
	}

	// 1. Template choice (from the db — seeded with `freeform`)
	let templates: TemplateRecord[];
	try {
		templates = getDb().listTemplates();
	} catch (e) {
		ctx.ui.notify(`Journal db error: ${msg(e)}`, "error");
		return;
	}
	if (templates.length === 0) {
		ctx.ui.notify(
			"No templates in the db — create one with journal_template_create",
			"error",
		);
		return;
	}
	const options = templates.map(
		(t) =>
			`${t.name} — ${t.description || "(no description)"} · ${t.steps.length} step${t.steps.length === 1 ? "" : "s"}`,
	);
	const pick = await ctx.ui.select("Journal: choose a template", options);
	if (pick === undefined) {
		ctx.ui.notify("Journal aborted — no template chosen", "info");
		return;
	}
	const template = templates[options.indexOf(pick)] ?? templates[0];

	snap = getActor().getSnapshot();
	if (!snap.can({ type: "START", template })) {
		ctx.ui.notify(
			`Journal start rejected (machine state \`${stateLabel(snap.context)}\`) — /journal status`,
			"error",
		);
		return;
	}
	getActor().send({ type: "START", template });

	// 2-5. Steps -> tags -> review -> persist (shared with resumeEntry)
	if (!(await gatherSteps(ctx, template, 0))) return;
	if (!(await gatherTags(ctx, template.defaultTags))) return;
	await reviewAndPersist(ctx);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const SUBCOMMANDS: { value: string; description: string }[] = [
	{
		value: "add",
		description:
			"gather + persist an entry (interactive; a cancelled dialog pauses — rerun to continue)",
	},
	{ value: "status", description: "show workflow state" },
	{ value: "reset", description: "clear workflow state" },
	{ value: "list", description: "recent entries (one line each)" },
	{ value: "templates", description: "list templates + steps" },
];

/** Tab completion for '/journal <subcommand>'. */
function createJournalAutocomplete(
	current: AutocompleteProvider,
): AutocompleteProvider {
	return {
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol);
			const m = /^\/journal ?([a-z]*)$/.exec(before);
			if (!m)
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const typed = m[1] ?? "";
			const items: AutocompleteItem[] = SUBCOMMANDS.filter((s) =>
				s.value.startsWith(typed),
			).map((s) => ({
				value: s.value,
				label: s.value,
				description: s.description,
			}));
			if (items.length === 0)
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: typed };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		if (
			ctx.mode === "tui" &&
			typeof (ctx.ui as never as { addAutocompleteProvider?: unknown })
				.addAutocompleteProvider === "function"
		) {
			ctx.ui.addAutocompleteProvider((current) =>
				createJournalAutocomplete(current),
			);
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
	});
	pi.on("session_shutdown", async () => {
		db?.close();
		db = null;
	});

	// --- read tool ------------------------------------------------------------

	pi.registerTool({
		name: "journal_read",
		label: "Journal read",
		description:
			"Read the journal sqlite db: entries (latest-first previews with tags, links, template), a single entry's full markdown content, tag counts, or template schemas. " +
			'what=entries (default) supports tag="work" (exact tag filter), search="substring" (content search), limit (default 20, max 100); what=entry requires id.',
		parameters: Type.Object({
			what: Type.Optional(
				Type.Union(
					[
						Type.Literal("entries"),
						Type.Literal("entry"),
						Type.Literal("tags"),
						Type.Literal("templates"),
					],
					{
						description:
							"What to read: entries (list), entry (one full entry), tags (counts), templates (schemas). Default entries.",
					},
				),
			),
			id: Type.Optional(
				Type.Number({ description: "Entry id (required for what=entry)" }),
			),
			tag: Type.Optional(
				Type.String({ description: "Filter entries by exact tag name" }),
			),
			search: Type.Optional(
				Type.String({ description: "Substring search in entry content" }),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max entries returned (default 20, max 100)",
				}),
			),
		}),

		async execute(_toolCallId, params) {
			return withToolLock(async () => {
				const what = params.what ?? "entries";
				try {
					if (what === "entries") {
						const { entries, total } = getDb().listEntries({
							tag: params.tag,
							search: params.search,
							limit: params.limit,
						});
						const filters = [
							params.tag ? `tag: ${params.tag}` : null,
							params.search ? `search: "${params.search}"` : null,
						]
							.filter(Boolean)
							.join(", ");
						if (entries.length === 0) {
							return {
								content: text(
									`No journal entries match${filters ? ` (${filters})` : ""}.`,
								),
								details: detailsFor("read"),
							};
						}
						const lines = entries.map((e) => {
							const bits = [
								`#${e.id} · ${e.createdAt.slice(0, 10)}`,
								e.templateName ? `template: ${e.templateName}` : null,
								e.tags.length > 0 ? `tags: ${e.tags.join(", ")}` : null,
								e.linkedIds.length > 0
									? `links: ${e.linkedIds.map((id) => `#${id}`).join(" ")}`
									: null,
							]
								.filter(Boolean)
								.join(" · ");
							return `${bits}\n  ${e.preview}`;
						});
						return {
							content: text(
								`Journal entries — ${entries.length} shown of ${total}${filters ? ` (${filters})` : ""}:\n\n${lines.join("\n\n")}`,
							),
							details: detailsFor("read"),
						};
					}
					if (what === "entry") {
						if (params.id === undefined) {
							return {
								content: text(
									"journal_read what=entry requires id — pass the entry id.",
								),
								details: detailsFor("read", { rejected: "entry id missing" }),
							};
						}
						const entry = getDb().getEntry(params.id);
						if (!entry) {
							return {
								content: text(`No journal entry with id ${params.id}.`),
								details: detailsFor("read"),
							};
						}
						const tags = getDb().entryTags(entry.id);
						const links = getDb().entryLinks(entry.id);
						const tpl = entry.templateId
							? getDb().listTemplates().find((t) => t.id === entry.templateId)
							: null;
						const head = [
							`Journal entry #${entry.id} · ${entry.createdAt}`,
							tpl ? `template: ${tpl.name}` : null,
							tags.length > 0 ? `tags: ${tags.join(", ")}` : null,
							links.length > 0
								? `links: ${links.map((id) => `#${id}`).join(" ")}`
								: null,
						]
							.filter(Boolean)
							.join("\n");
						return {
							content: text(`${head}\n\n${entry.content}`),
							details: detailsFor("read", { entryId: entry.id }),
						};
					}
					if (what === "tags") {
						const tags = getDb().listTags();
						return {
							content: text(
								tags.length === 0
									? "No tags in the journal db yet."
									: `Journal tags:\n${tags.map((t) => `${t.name} (${t.count})`).join("\n")}`,
							),
							details: detailsFor("read"),
						};
					}
					// what === "templates"
					const templates = getDb().listTemplates();
					return {
						content: text(
							templates.length === 0
								? "No templates in the journal db — create one with journal_template_create."
								: `Journal templates:\n\n${templates
										.map(
											(t) =>
												`${t.name} — ${t.description || "(no description)"} · ${t.steps.length} step${t.steps.length === 1 ? "" : "s"}${t.defaultTags.length > 0 ? ` · default tags: ${t.defaultTags.join(", ")}` : ""}\n${t.steps.map((s) => `  ${s.name}: ${s.prompt}`).join("\n")}`,
										)
										.join("\n\n")}`,
						),
						details: detailsFor("read"),
					};
				} catch (e) {
					return {
						content: text(`Journal db error: ${msg(e)}`),
						details: detailsFor("read", { error: msg(e) }),
						isError: true,
					};
				}
			});
		},

		renderCall(args) {
			const what = args.what ?? "entries";
			return new Text(
				`journal_read ${what}${args.id !== undefined ? ` #${args.id}` : ""}`,
				0,
				0,
			);
		},
		renderResult(result) {
			const details = result.details as JournalDetails | undefined;
			if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
			return new Text("✓ read", 0, 0);
		},
	});

	// --- template create tool ---------------------------------------------------

	pi.registerTool({
		name: "journal_template_create",
		label: "Journal template create",
		description:
			"Create a journal template — a schema written as content to the db, used by /journal add. Steps shape gathering: each step is one editor dialog (name becomes the `## name` markdown section of the composed entry; prompt is shown as the dialog title). " +
			"A single-step template persists the answer as-is (the freeform contract); a multi-step template composes `## name` sections, skipping empty answers. " +
			"Validation is strict: name lowercase-slug (unique), 1-16 steps, step names unique slugs, prompts non-empty; defaultTags optional (max 16, applied only after a blank-input confirm).",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Template name — lowercase letters, digits, hyphens (shown in the picker)",
			}),
			description: Type.Optional(
				Type.String({
					description: "Short description shown in the template picker",
				}),
			),
			steps: Type.Array(
				Type.Object({
					name: Type.String({
						description:
							"Step name — lowercase slug; becomes the markdown section heading",
					}),
					prompt: Type.String({
						description: "Prompt shown to the user as the editor dialog title",
					}),
				}),
				{
					description:
						"Ordered steps — one editor dialog each; answers compose into the single markdown entry",
					minItems: 1,
					maxItems: 16,
				},
			),
			defaultTags: Type.Optional(
				Type.Array(Type.String(), {
						description:
							"Default tags suggested at the tagging step — blank tag input asks whether to apply them (never silently)",
						maxItems: 16,
					}),
			),
		}),

		async execute(_toolCallId, params) {
			return withToolLock(async () => {
				const violation =
					templateNameViolation(params.name) ??
					templateDescriptionViolation(params.description ?? "") ??
					templateStepsViolation(params.steps) ??
					templateDefaultTagsViolation(params.defaultTags);
				if (violation) {
					return {
						content: text(
							`Template rejected: ${violation}`,
						),
						details: detailsFor("template_create", { rejected: violation }),
					};
				}
				try {
					const t = getDb().createTemplate(
						params.name,
						params.description ?? "",
						params.steps,
						params.defaultTags ?? [],
					);
					return {
						content: text(
							`Template created: ${t.name} (id ${t.id}, ${t.steps.length} steps${t.defaultTags.length > 0 ? `, default tags: ${t.defaultTags.join(", ")}` : ""}) — usable via /journal add.\nSteps:\n${t.steps.map((s) => `  ${s.name}: ${s.prompt}`).join("\n")}`,
						),
						details: detailsFor("template_create", { templateId: t.id }),
					};
				} catch (e) {
					return {
						content: text(`Template rejected: ${msg(e)}`),
						details: detailsFor("template_create", { rejected: msg(e) }),
					};
				}
			});
		},

		renderCall(args) {
			return new Text(
				`journal_template_create "${args.name ?? ""}" (${args.steps?.length ?? 0} steps)`,
				0,
				0,
			);
		},
		renderResult(result) {
			const details = result.details as JournalDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text(`✓ template #${details?.templateId ?? ""}`, 0, 0);
		},
	});

	// --- link tool ---------------------------------------------------------------

	pi.registerTool({
		name: "journal_link",
		label: "Journal link",
		description:
			"Create many-to-many links between journal entries, post-hoc. Links are symmetric for reads (both directions shown by journal_read) — a pair already linked in either direction is skipped as a duplicate. Missing ids and self-links are skipped, not errors.",
		parameters: Type.Object({
			fromId: Type.Number({ description: "Entry id to link from" }),
			toIds: Type.Array(Type.Number(), {
				description: "Entry ids to link to (m:n)",
			}),
		}),

		async execute(_toolCallId, params) {
			return withToolLock(async () => {
				try {
					const report: LinkReport = getDb().linkEntries(
						params.fromId,
						params.toIds,
					);
					if (report.missing.includes(params.fromId)) {
						return {
							content: text(
								`No journal entry with id ${params.fromId} — no links created.`,
							),
							details: detailsFor("link", { rejected: `entry #${params.fromId} missing` }),
						};
					}
					const parts = [
						report.created.length > 0
							? `created: ${report.created.map((id) => `#${id}`).join(", ")}`
							: null,
						report.duplicates.length > 0
							? `duplicates skipped: ${report.duplicates.map((id) => `#${id}`).join(", ")}`
							: null,
						report.missing.length > 0
							? `missing skipped: ${report.missing.map((id) => `#${id}`).join(", ")}`
							: null,
						report.self.length > 0
							? `self skipped: ${report.self.map((id) => `#${id}`).join(", ")}`
							: null,
					].filter(Boolean);
					return {
						content: text(
							`Links from #${params.fromId}: ${parts.length > 0 ? parts.join("; ") : "nothing to do (all targets already linked)"}`,
						),
						details: detailsFor("link", { entryId: params.fromId }),
					};
				} catch (e) {
					return {
						content: text(`Journal db error: ${msg(e)}`),
						details: detailsFor("link", { error: msg(e) }),
						isError: true,
					};
				}
			});
		},

		renderCall(args) {
			return new Text(
				`journal_link #${args.fromId ?? ""} -> ${args.toIds?.map((id) => `#${id}`).join(" ") ?? ""}`,
				0,
				0,
			);
		},
		renderResult(result) {
			const details = result.details as JournalDetails | undefined;
			if (details?.error) return new Text(`✗ ${details.error}`, 0, 0);
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text("✓ linked", 0, 0);
		},
	});

	// --- status / reset ---------------------------------------------------------

	pi.registerTool({
		name: "journal_status",
		label: "Journal status",
		description:
			"Show the journal workflow state (machine snapshot, current template progress, tags, last entry).",
		parameters: Type.Object({}),

		async execute() {
			return withToolLock(async () => {
				const c = getActor().getSnapshot().context;
				return {
					content: text(
						`${statusLine(c)}\n${c.errors.length > 0 ? `Last errors:\n${c.errors.join("\n")}\n` : ""}${allowedNext()}`,
					),
					details: detailsFor("status", {
						snapshot: slimSnapshot(getActor().getPersistedSnapshot()),
					}),
				};
			});
		},

		renderCall() {
			return new Text("journal_status", 0, 0);
		},
		renderResult() {
			return new Text(
				`✓ ${stateLabel(getActor().getSnapshot().context)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "journal_reset",
		label: "Journal reset",
		description:
			"Clear the journal workflow state machine and start over. " +
			"Discarding an entry in progress (answered steps, pending save) requires user confirmation; " +
			"with no UI available, the reset is blocked.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, execCtx) {
			// Confirm gate runs before withToolLock: a dialog must not block
			// other journal tools. RESET is legal from any state, so a state
			// change during the dialog only alters what gets cleared.
			const gate = resetDiscardWarning(getActor().getSnapshot().context);
			if (gate) {
				const ui = execCtx as unknown as JournalUiCtx | undefined;
				if (!ui || !ui.hasUI) {
					return {
						content: text(
							`Journal reset blocked — ${gate}. Answers are memory-only and unrecoverable; ` +
								"no UI is available to confirm the discard. Ask the user to run /journal reset (or /journal add to continue the entry).",
						),
					details: detailsFor("reset", { rejected: "no UI to confirm discard" }),
				};
				}
				const discard = await ui.ui.confirm(
					"Journal: model requested reset — discard the entry in progress?",
					gate,
				);
				if (!discard) {
						return {
							content: text(
								`Journal reset declined — the entry in progress was kept.\n${statusLine(getActor().getSnapshot().context)}\n${allowedNext()}`,
						),
						details: detailsFor("reset", { rejected: "user declined" }),
					};
				}
			}
			return withToolLock(async () => {
				const c = getActor().getSnapshot().context;
				const prior = `template ${c.template ? `"${c.template.name}"` : "none"}, ${Object.keys(c.answers).length} steps answered, tags ${c.tags.length}, last entry ${c.lastEntry ? `#${c.lastEntry.id}` : "none"}, failed persists ${c.persistAttempts}/${c.limits.maxPersistAttempts}, machine state ${stateLabel(c)}`;
				getActor().send({ type: "RESET" });
				sessionStats.resets++; // survives RESET
				return {
					content: text(
						`Journal state cleared (was: ${prior}).\n${statusLine(getActor().getSnapshot().context)}`,
					),
				details: detailsFor("reset", {
						snapshot: slimSnapshot(getActor().getPersistedSnapshot()),
					}),
				};
			});
		},

		renderCall() {
			return new Text("journal_reset", 0, 0);
		},
		renderResult(result) {
			const details = result.details as JournalDetails | undefined;
			if (details?.rejected) return new Text(`✗ ${details.rejected}`, 0, 0);
			return new Text("✓ reset", 0, 0);
		},
	});

	// --- command ----------------------------------------------------------------

	pi.registerCommand("journal", {
		description:
			"Journal workflow: add (interactive entry) | status | reset | list (recent entries) | templates",
		handler: async (args, ctx) => {
			const uictx = ctx as unknown as JournalUiCtx;
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

			if (sub === "add") {
				await runAddFlow(uictx);
				return;
			}
			if (sub === "reset") {
				// user-typed command — explicit intent, no confirm gate; still counted
				getActor().send({ type: "RESET" });
				sessionStats.resets++;
				uictx.ui.notify("Journal state cleared", "info");
				return;
			}
			if (sub === "list") {
				try {
					const { entries, total } = getDb().listEntries({ limit: 10 });
					uictx.ui.notify(
						entries.length === 0
							? "No journal entries yet — /journal add"
							: `Journal entries (latest ${entries.length} of ${total}):\n${entries
									.map(
										(e) =>
											`#${e.id} · ${e.createdAt.slice(0, 10)}${e.tags.length > 0 ? ` · ${e.tags.join(", ")}` : ""} · ${e.preview}`,
									)
									.join("\n")}`,
						"info",
					);
				} catch (e) {
					uictx.ui.notify(`Journal db error: ${msg(e)}`, "error");
				}
				return;
			}
			if (sub === "templates") {
				try {
					const templates = getDb().listTemplates();
					uictx.ui.notify(
						templates.length === 0
							? "No templates — create one with journal_template_create"
							: `Journal templates:\n${templates
									.map(
										(t) =>
											`${t.name} — ${t.description || "(no description)"} (${t.steps.length} step${t.steps.length === 1 ? "" : "s"})${t.defaultTags.length > 0 ? ` · default tags: ${t.defaultTags.join(", ")}` : ""}\n${t.steps.map((s) => `  ${s.name}: ${s.prompt}`).join("\n")}`,
									)
									.join("\n")}`,
						"info",
					);
				} catch (e) {
					uictx.ui.notify(`Journal db error: ${msg(e)}`, "error");
				}
				return;
			}
			// default (bare /journal or /journal status): state + guidance
			const c = getActor().getSnapshot().context;
			uictx.ui.notify(`${statusLine(c)}\n${allowedNext()}`, "info");
		},
	});
}
