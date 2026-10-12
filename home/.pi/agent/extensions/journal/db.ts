/**
 * Journal db — node:sqlite (DatabaseSync, built-in; no npm dep).
 *
 * IO executor side of the extension: owns the sqlite file at
 * extensions/journal/tmp/journal.db (gitignored via the global `tmp` ignore
 * rule; JOURNAL_DB_PATH overrides), the schema, and every query. The
 * machine never sees this module — the persist executor in index.ts
 * composes content (machine.ts pure fn) and calls insertEntry.
 *
 * Storage contract: a completed entry is a single markdown text field
 * (entries.content); template steps shape gathering only. Tags and entry
 * links are m:n through join tables; links are directional rows (from_id,
 * to_id) but read symmetrically — listing shows both directions.
 *
 * Templates are schemas written as content: templates.schema_json holds
 * the step definitions ({ steps: [{ name, prompt }] }), validated at
 * create time (journal_template_create tool) and revalidated at load
 * (machine START guard) — a hand-edited db row is rejected, not trusted.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	normalizeTags,
	type TemplateRecord,
	type TemplateStep,
	templateDefaultTagsViolation,
	templateDescriptionViolation,
	templateNameViolation,
	templateStepsViolation,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface EntryRecord {
	id: number;
	content: string;
	templateId: number | null;
	createdAt: string;
}

/** Entry as listed: preview + tags + links (both directions). */
export interface EntrySummary {
	id: number;
	createdAt: string;
	templateName: string | null;
	preview: string;
	tags: string[];
	linkedIds: number[];
}

export interface TagCount {
	name: string;
	count: number;
}

export interface LinkReport {
	created: number[];
	duplicates: number[];
	missing: number[];
	self: number[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS templates (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL DEFAULT '',
	schema_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	content TEXT NOT NULL,
	template_id INTEGER REFERENCES templates(id),
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS entry_tags (
	entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (entry_id, tag_id)
);
CREATE TABLE IF NOT EXISTS entry_links (
	from_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
	to_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
	PRIMARY KEY (from_id, to_id)
);
`;

/** Seed template — present from first db init so /journal add always works. */
const FREEFORM_SCHEMA = {
	steps: [{ name: "content", prompt: "Journal entry" }],
};

// ---------------------------------------------------------------------------
// Db
// ---------------------------------------------------------------------------

export class JournalDb {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
		this.seedFreeform();
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			/* idempotent shutdown */
		}
	}

	private seedFreeform(): void {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM templates")
			.get() as { n: number };
		if ((row?.n ?? 0) > 0) return;
		this.createTemplate(
			"freeform",
			"Single free-form markdown entry",
			FREEFORM_SCHEMA.steps as TemplateStep[],
		);
	}

	/** BEGIN … COMMIT with rollback on error — insert paths only. */
	private withTransaction<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const out = fn();
			this.db.exec("COMMIT");
			return out;
		} catch (e) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* connection already rolled back */
			}
			throw e;
		}
	}

	// --- templates -----------------------------------------------------------

	/** Parse a schema_json row into a TemplateRecord; strict on garbage. */
	private templateOf(row: {
		id: number;
		name: string;
		description: string;
		schema_json: string;
		created_at: string;
	}): TemplateRecord {
		let parsed: { steps?: unknown; defaultTags?: unknown };
		try {
			parsed = JSON.parse(row.schema_json);
		} catch {
			throw new Error(
				`template "${row.name}" (#${row.id}): schema_json is not valid JSON — recreate the template`,
			);
		}
		const violation =
			templateStepsViolation(parsed?.steps) ??
			templateDefaultTagsViolation(parsed?.defaultTags);
		if (violation !== null) {
			throw new Error(
				`template "${row.name}" (#${row.id}): ${violation} — recreate the template`,
			);
		}
		return {
			id: Number(row.id),
			name: row.name,
			description: row.description,
			steps: parsed.steps as TemplateStep[],
			defaultTags: Array.isArray(parsed?.defaultTags)
				? normalizeTags(parsed.defaultTags as string[])
				: [],
			createdAt: row.created_at,
		};
	}

	listTemplates(): TemplateRecord[] {
		const rows = this.db
			.prepare(
				"SELECT id, name, description, schema_json, created_at FROM templates ORDER BY name",
			)
			.all() as Array<{
			id: number;
			name: string;
			description: string;
			schema_json: string;
			created_at: string;
		}>;
		return rows.map((r) => this.templateOf(r));
	}

	getTemplateByName(name: string): TemplateRecord | null {
		const row = this.db
			.prepare(
				"SELECT id, name, description, schema_json, created_at FROM templates WHERE name = ?",
			)
			.get(name) as
			| {
					id: number;
					name: string;
					description: string;
					schema_json: string;
					created_at: string;
			  }
			| undefined;
		return row ? this.templateOf(row) : null;
	}

	/**
	 * Insert a template (schema written as content). Validates name,
	 * description, steps, and defaultTags (the same fns the
	 * journal_template_create tool and the machine START guard use) —
	 * defense in depth against a caller that skipped its precheck.
	 * Duplicate name → readable error. defaultTags are normalized here
	 * (single source — normalizeTags) and stored inside schema_json.
	 */
	createTemplate(
		name: string,
		description: string,
		steps: TemplateStep[],
		defaultTags: string[] = [],
	): TemplateRecord {
		const nameV = templateNameViolation(name);
		if (nameV) throw new Error(nameV);
		const descV = templateDescriptionViolation(description);
		if (descV) throw new Error(descV);
		const stepsV = templateStepsViolation(steps);
		if (stepsV) throw new Error(stepsV);
		const tagsV = templateDefaultTagsViolation(defaultTags);
		if (tagsV) throw new Error(tagsV);
		const normalizedTags = normalizeTags(defaultTags);
		const schema =
			normalizedTags.length > 0
				? { steps, defaultTags: normalizedTags }
				: { steps };
		const createdAt = new Date().toISOString();
		try {
			const r = this.db
				.prepare(
					"INSERT INTO templates (name, description, schema_json, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(name, description, JSON.stringify(schema), createdAt);
			return {
				id: Number(r.lastInsertRowid),
				name,
				description,
				steps,
				defaultTags: normalizedTags,
				createdAt,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("UNIQUE")) {
				throw new Error(
					`template name already exists: "${name}" — pick another name`,
				);
			}
			throw e;
		}
	}

	// --- entries ---------------------------------------------------------------

	/**
	 * Insert a composed entry + tags in one transaction. Tags are
	 * normalized here too (single source — normalizeTags), so a caller that
	 * skipped machine validation cannot write inconsistent rows.
	 * Returns { id, createdAt } — persist-service evidence.
	 */
	insertEntry(input: {
		templateId: number;
		content: string;
		tags: string[];
	}): { id: number; createdAt: string } {
		const createdAt = new Date().toISOString();
		return this.withTransaction(() => {
			const r = this.db
				.prepare(
					"INSERT INTO entries (content, template_id, created_at) VALUES (?, ?, ?)",
				)
				.run(input.content, input.templateId, createdAt) as {
				lastInsertRowid: number | bigint;
			};
			const id = Number(r.lastInsertRowid);
			for (const tag of normalizeTags(input.tags)) {
				this.db
					.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)")
					.run(tag);
				const tagRow = this.db
					.prepare("SELECT id FROM tags WHERE name = ?")
					.get(tag) as { id: number };
				this.db
					.prepare(
						"INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)",
					)
					.run(id, tagRow.id);
			}
			return { id, createdAt };
		});
	}

	getEntry(id: number): EntryRecord | null {
		const row = this.db
			.prepare("SELECT id, content, template_id, created_at FROM entries WHERE id = ?")
			.get(id) as
			| {
					id: number;
					content: string;
					template_id: number | null;
					created_at: string;
			  }
			| undefined;
		if (!row) return null;
		return {
			id: Number(row.id),
			content: row.content,
			templateId: row.template_id === null ? null : Number(row.template_id),
			createdAt: row.created_at,
		};
	}

	entryTags(id: number): string[] {
		const rows = this.db
			.prepare(
				"SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id = t.id WHERE et.entry_id = ? ORDER BY t.name",
			)
			.all(id) as Array<{ name: string }>;
		return rows.map((r) => r.name);
	}

	/** Linked entry ids, both directions (rows are directional, links are not). */
	entryLinks(id: number): number[] {
		const rows = this.db
			.prepare(
				"SELECT to_id AS other FROM entry_links WHERE from_id = ? UNION SELECT from_id AS other FROM entry_links WHERE to_id = ? ORDER BY other",
			)
			.all(id, id) as Array<{ other: number }>;
		return rows.map((r) => Number(r.other));
	}

	/**
	 * List entries newest-first with tags + links. Optional tag filter
	 * (exact name) and substring search on content (LIKE, escaped).
	 */
	listEntries(opts: {
		tag?: string;
		search?: string;
		limit?: number;
	}): { entries: EntrySummary[]; total: number } {
		const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
		const where: string[] = [];
		const params: Array<string | number> = [];
		if (opts.tag !== undefined && opts.tag.trim() !== "") {
			where.push(
				"e.id IN (SELECT et.entry_id FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE t.name = ?)",
			);
			params.push(opts.tag.trim().toLowerCase());
		}
		if (opts.search !== undefined && opts.search.trim() !== "") {
			where.push("e.content LIKE ? ESCAPE '\\'");
			params.push(`%${escapeLike(opts.search.trim())}%`);
		}
		const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
		const total = (
			this.db
				.prepare(`SELECT COUNT(*) AS n FROM entries e${whereSql}`)
				.all(...params) as Array<{ n: number }>
		)[0]?.n ?? 0;
		const rows = this.db
			.prepare(
				`SELECT e.id, e.content, e.template_id, e.created_at, t.name AS template_name
				 FROM entries e LEFT JOIN templates t ON t.id = e.template_id${whereSql}
				 ORDER BY e.id DESC LIMIT ?`,
			)
			.all(...params, limit) as Array<{
			id: number;
			content: string;
			template_id: number | null;
			created_at: string;
			template_name: string | null;
		}>;
		const entries: EntrySummary[] = rows.map((r) => ({
			id: Number(r.id),
			createdAt: r.created_at,
			templateName: r.template_name,
			preview: previewOf(r.content),
			tags: this.entryTags(Number(r.id)),
			linkedIds: this.entryLinks(Number(r.id)),
		}));
		return { entries, total: Number(total) };
	}

	// --- tags ----------------------------------------------------------------

	listTags(): TagCount[] {
		const rows = this.db
			.prepare(
				"SELECT t.name, COUNT(et.entry_id) AS count FROM tags t LEFT JOIN entry_tags et ON et.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name",
			)
			.all() as Array<{ name: string; count: number }>;
		return rows.map((r) => ({ name: r.name, count: Number(r.count) }));
	}

	// --- links (post-hoc, m:n) --------------------------------------------------

	/**
	 * Create directional links from one entry to others. A pair is a
	 * duplicate if it exists in EITHER direction (links read symmetrically);
	 * missing ids and self-links are skipped, not errors.
	 */
	linkEntries(fromId: number, toIds: number[]): LinkReport {
		const report: LinkReport = {
			created: [],
			duplicates: [],
			missing: [],
			self: [],
		};
		return this.withTransaction(() => {
			const fromExists = this.db
				.prepare("SELECT id FROM entries WHERE id = ?")
				.get(fromId);
			if (!fromExists) {
				report.missing.push(fromId);
				return report;
			}
			for (const toId of toIds) {
				if (toId === fromId) {
					report.self.push(toId);
					continue;
				}
				const toExists = this.db
					.prepare("SELECT id FROM entries WHERE id = ?")
					.get(toId);
				if (!toExists) {
					report.missing.push(toId);
					continue;
				}
				const either = this.db
					.prepare(
						"SELECT 1 FROM entry_links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)",
					)
					.get(fromId, toId, toId, fromId);
				if (either) {
					report.duplicates.push(toId);
					continue;
				}
				this.db
					.prepare("INSERT INTO entry_links (from_id, to_id) VALUES (?, ?)")
					.run(fromId, toId);
				report.created.push(toId);
			}
			return report;
		});
	}
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** First ~200 chars of content, whitespace-collapsed, for one-line listings. */
function previewOf(content: string): string {
	const flat = content.replace(/\s+/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** Escape LIKE wildcards in user search text (used with ESCAPE '\\'). */
function escapeLike(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
