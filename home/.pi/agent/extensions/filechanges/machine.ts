// Edit-lifecycle machine for the filechanges extension.
// Machine owns registry legality (pending/baselines/tracked maps + event
// order); executors (index.ts) own IO (file reads/writes, session entries).
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

import { relative, resolve } from "node:path";
import { assign, setup } from "xstate";
import { createTwoFilesPatch } from "diff";

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

export type FileChangesRegistry = {
	pending: Map<string, PendingSnapshot>; // key: toolCallId
	baselines: Map<string, Baseline>; // key: relPath
	tracked: Map<string, TrackedFile>; // key: relPath
};

export function emptyRegistry(): FileChangesRegistry {
	return {
		pending: new Map(),
		baselines: new Map(),
		tracked: new Map(),
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
	for (const line of unifiedDiff.split("\n")) {
		if (
			line.startsWith("+++ ") ||
			line.startsWith("--- ") ||
			line.startsWith("@@")
		)
			continue;
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
	},
	guards: {
		startLegal: ({ context, event }) =>
			event.type === "TOOL_CALL_STARTED" && startViolation(context, event.toolCallId) === null,
		commitLegal: ({ context, event }) =>
			(event.type === "TOOL_CALL_SUCCEEDED" || event.type === "TOOL_CALL_FAILED") &&
			commitViolation(context, event.toolCallId) === null,
		recomputeLegal: ({ context, event }) =>
			event.type === "RECOMPUTE_DONE" && recomputeViolation(context, event.path) === null,
		noData: ({ context }) =>
			context.pending.size === 0 && context.baselines.size === 0 && context.tracked.size === 0,
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
		clearAll: assign(() => emptyRegistry()),
	},
}).createMachine({
	id: "fileChanges",
	context: () => emptyRegistry(),
	initial: "empty",
	states: {
		empty: {
			on: {
				TOOL_CALL_STARTED: { guard: "startLegal", target: "active", actions: "recordPending" },
				BASELINE: { target: "active", actions: "applyBaseline" },
				RECOMPUTE_DONE: { guard: "recomputeLegal", target: "active", actions: "applyRecompute" },
				UNTRACK: { actions: "removeTrackedPath" },
				CLEAR: { actions: "clearAll" },
			},
		},
		active: {
			always: [{ guard: "noData", target: "empty" }],
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
