// Edit-lifecycle machine for the filechanges extension.
// Machine owns registry legality (pending/baselines/tracked maps + event
// order); executors (index.ts) own IO (file reads/writes, session entries).
//
// Flat machine: one `registry` state (the former empty/active pair
// collapsed — it discriminated legality for nothing: commitLegal needs a
// pending, recomputeLegal needs a baseline, and neither can exist on an
// empty registry, so the empty state's trimmed event table and the
// `always: noData -> empty` self-normalization were pure ceremony costing a
// duplicated transition table). All events live in one table; legality is
// unchanged (empty-context commit/recompute fall to the same guards).
//
// The session custom entries ARE the persisted event log — BASELINE / CLEAR /
// UNTRACK replay 1:1 — so branch restore is event replay, not snapshot
// restore. RECOMPUTE_DONE carries executor-computed diff entries (diffs need
// current file content = IO); the machine only records or forgets them.
//
// Legality (pure validators — single source of truth for guards + prechecks):
// - duplicate toolCallId on TOOL_CALL_STARTED  → rejected (registry integrity)
// - TOOL_CALL_SUCCEEDED/FAILED without pending → rejected (orphan result;
//   e.g. a CLEAR mid-flight, or result for a tool_call we never saw)
// - RECOMPUTE_DONE for path without baseline    → rejected (orphan recompute)
// UNTRACK/CLEAR stay idempotent-legal (replay tolerance).
// Tracking cap (breaker): TOOL_CALL_STARTED for a NEW path is rejected when
// baselines are at maxTracked (default 256, env FILECHANGES_MAX_TRACKED) —
// untrack or clear the log to make room. BASELINE (restore replay) stays
// legal past the cap (replay tolerance); re-editing a tracked path stays
// legal (no registry growth).

import { relative, resolve } from "node:path";
import { assign, setup } from "xstate";
import { createTwoFilesPatch } from "diff";

import { envLimit } from "../_kit/machine-kit.ts";

export type Baseline = {
	path: string; // relPath key
	absPath: string;
	originalContent: string | null; // null => file did not exist (created)
	createdAt: number;
};

export type TrackedFile = {
	path: string;
	absPath: string;
	displayPath: string;
	originalContent: string | null;
	currentContent: string;
	diff: string;
	added: number;
	removed: number;
	kind: "new" | "edited";
	updatedAt: number;
};

export type PendingSnapshot = {
	toolCallId: string;
	path: string; // relPath key
	absPath: string;
	before: string | null;
};

export type FileChangesEvent =
	| {
			type: "TOOL_CALL_STARTED";
			toolCallId: string;
			path: string;
			absPath: string;
			before: string | null;
	  }
	| { type: "TOOL_CALL_SUCCEEDED"; toolCallId: string; timestamp: number }
	| { type: "TOOL_CALL_FAILED"; toolCallId: string }
	| { type: "RECOMPUTE_DONE"; path: string; entry: TrackedFile | null }
	| {
			type: "BASELINE";
			path: string;
			absPath: string;
			originalContent: string | null;
			createdAt: number;
	  }
	| { type: "UNTRACK"; path: string }
	| {
			type: "CLEAR";
			reason: "accept" | "decline" | "replay";
			timestamp: number;
	  };

export interface FileChangesLimits {
	/** Max simultaneously tracked files (baselines) — registry growth bound. */
	maxTracked: number;
}

export const DEFAULT_LIMITS: FileChangesLimits = {
	maxTracked: envLimit("FILECHANGES_MAX_TRACKED", 256),
};

export type FileChangesRegistry = {
	pending: Map<string, PendingSnapshot>; // key: toolCallId
	baselines: Map<string, Baseline>; // key: relPath
	tracked: Map<string, TrackedFile>; // key: relPath
	limits: FileChangesLimits;
};

export function emptyRegistry(
	limits: FileChangesLimits = DEFAULT_LIMITS,
): FileChangesRegistry {
	return {
		pending: new Map(),
		baselines: new Map(),
		tracked: new Map(),
		limits,
	};
}

// ---- pure helpers (shared with executors) ----

function stripAtPrefix(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

export function normalizeToolPath(
	cwd: string,
	raw: string,
): { absPath: string; relPath: string } {
	const cleaned = stripAtPrefix(raw);
	const absPath = resolve(cwd, cleaned);
	// Use relative path for storage/UI when possible. If it escapes cwd, keep the cleaned input.
	const rel = relative(cwd, absPath);
	const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleaned;
	return { absPath, relPath };
}

export function patchFromBaseline(
	displayPath: string,
	original: string | null,
	current: string,
): string {
	return createTwoFilesPatch(
		displayPath,
		displayPath,
		original ?? "",
		current,
		"",
		"",
		{ context: 3 },
	);
}

export function countDiffLines(unifiedDiff: string): {
	added: number;
	removed: number;
} {
	let added = 0;
	let removed = 0;
	// header region (--- a/x, +++ b/x, file labels) only exists before the
	// first hunk: a removed line whose content starts with "-- " diffs as
	// "--- flag…" and must still count as removed (in-hunk), not as a header
	let inHunks = false;
	for (const line of unifiedDiff.split("\n")) {
		if (line.startsWith("@@")) {
			inHunks = true;
			continue;
		}
		if (!inHunks) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

// ---- pure validators: shared by guards and executor prechecks ----

export function startViolation(
	registry: FileChangesRegistry,
	toolCallId: string,
): string | null {
	if (registry.pending.has(toolCallId)) {
		return `duplicate toolCallId "${toolCallId}" — tool_call seen twice without a result; ignoring the second snapshot to protect registry integrity`;
	}
	return null;
}

/** Breaker: new-path tracking is rejected at maxTracked baselines — the
 *  registry cannot grow without bound. An already-tracked path stays legal
 *  (re-edits do not grow the registry); UNTRACK/CLEAR make room. */
export function trackViolation(
	registry: FileChangesRegistry,
	path: string,
): string | null {
	if (registry.baselines.size >= registry.limits.maxTracked && !registry.baselines.has(path)) {
		return `tracking cap reached (${registry.baselines.size}/${registry.limits.maxTracked} tracked files) — "${path}" is not tracked, so its edits cannot be reverted; untrack a file or clear the log (/filechanges) to make room`;
	}
	return null;
}

export function commitViolation(
	registry: FileChangesRegistry,
	toolCallId: string,
): string | null {
	if (!registry.pending.has(toolCallId)) {
		return `orphan tool result "${toolCallId}" — no pending snapshot (result after CLEAR, or tool_call was never seen); refusing to touch baselines`;
	}
	return null;
}

export function recomputeViolation(
	registry: FileChangesRegistry,
	path: string,
): string | null {
	if (!registry.baselines.has(path)) {
		return `orphan recompute for "${path}" — no baseline (baseline was untracked or cleared mid-flight)`;
	}
	return null;
}

// ---- machine ----

export const fileChangesMachine = setup({
	types: {
		context: {} as FileChangesRegistry,
		events: {} as FileChangesEvent,
		input: {} as { limits?: FileChangesLimits } | undefined,
	},
	guards: {
		startLegal: ({ context, event }) =>
			event.type === "TOOL_CALL_STARTED" &&
			startViolation(context, event.toolCallId) === null &&
			trackViolation(context, event.path) === null,
		commitLegal: ({ context, event }) =>
			(event.type === "TOOL_CALL_SUCCEEDED" || event.type === "TOOL_CALL_FAILED") &&
			commitViolation(context, event.toolCallId) === null,
		recomputeLegal: ({ context, event }) =>
			event.type === "RECOMPUTE_DONE" && recomputeViolation(context, event.path) === null,
	},
	actions: {
		recordPending: assign(({ context, event }) => {
			if (event.type !== "TOOL_CALL_STARTED") return {};
			return {
				pending: new Map(context.pending).set(event.toolCallId, {
					toolCallId: event.toolCallId,
					path: event.path,
					absPath: event.absPath,
					before: event.before,
				}),
			};
		}),
		// Commit: drop pending; first successful edit/write of a path creates
		// its baseline from the pending `before` snapshot.
		commitPending: assign(({ context, event }) => {
			if (event.type !== "TOOL_CALL_SUCCEEDED") return {};
			const pending = context.pending.get(event.toolCallId);
			if (!pending) return {};
			const nextPending = new Map(context.pending);
			nextPending.delete(event.toolCallId);
			if (context.baselines.has(pending.path)) {
				return { pending: nextPending };
			}
			return {
				pending: nextPending,
				baselines: new Map(context.baselines).set(pending.path, {
					path: pending.path,
					absPath: pending.absPath,
					originalContent: pending.before,
					createdAt: event.timestamp,
				}),
			};
		}),
		dropPending: assign(({ context, event }) => {
			if (event.type !== "TOOL_CALL_FAILED") return {};
			const nextPending = new Map(context.pending);
			nextPending.delete(event.toolCallId);
			return { pending: nextPending };
		}),
		applyRecompute: assign(({ context, event }) => {
			if (event.type !== "RECOMPUTE_DONE") return {};
			const nextTracked = new Map(context.tracked);
			if (event.entry === null) nextTracked.delete(event.path);
			else nextTracked.set(event.path, event.entry);
			return { tracked: nextTracked };
		}),
		applyBaseline: assign(({ context, event }) => {
			if (event.type !== "BASELINE") return {};
			return {
				baselines: new Map(context.baselines).set(event.path, {
					path: event.path,
					absPath: event.absPath,
					originalContent: event.originalContent,
					createdAt: event.createdAt,
				}),
			};
		}),
		removeTrackedPath: assign(({ context, event }) => {
			if (event.type !== "UNTRACK") return {};
			const nextBaselines = new Map(context.baselines);
			const nextTracked = new Map(context.tracked);
			nextBaselines.delete(event.path);
			nextTracked.delete(event.path);
			return { baselines: nextBaselines, tracked: nextTracked };
		}),
		clearAll: assign(({ context }) => emptyRegistry(context.limits)),
	},
}).createMachine({
	id: "fileChanges",
	context: ({ input }) => emptyRegistry(input?.limits),
	initial: "registry",
	states: {
		registry: {
			on: {
				TOOL_CALL_STARTED: { guard: "startLegal", actions: "recordPending" },
				TOOL_CALL_SUCCEEDED: { guard: "commitLegal", actions: "commitPending" },
				TOOL_CALL_FAILED: { guard: "commitLegal", actions: "dropPending" },
				RECOMPUTE_DONE: { guard: "recomputeLegal", actions: "applyRecompute" },
				BASELINE: { actions: "applyBaseline" },
				UNTRACK: { actions: "removeTrackedPath" },
				CLEAR: { actions: "clearAll" },
			},
		},
	},
});
