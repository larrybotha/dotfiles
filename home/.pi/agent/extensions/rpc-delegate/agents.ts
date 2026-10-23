/**
 * User-level agent registry for rpc-delegate.
 *
 * Discovery is deliberately narrow: one directory (`~/.pi/agent/agents/`),
 * `*.md` files, YAML frontmatter + body. No project scope, no trust gate.
 * Every per-file failure mode is contained: the offending file is skipped
 * (`skipped`, surfaced as a warning) and the rest of the registry stays
 * usable. The one fatal-to-call condition is a duplicate `name`, reported to
 * the caller rather than resolved last-wins (nondeterminism).
 *
 * The body becomes the child's appended system prompt. It is validated at
 * load (NUL bytes, 32 KiB cap) so a spawn never throws on a bad registry
 * entry; the resolved prompt is validated again in index.ts because a
 * call-side `agentPrompt` can also carry the payload.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Byte cap for an agent body (and, downstream, any resolved prompt). */
export const MAX_AGENT_BODY_BYTES = 32 * 1024;

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** Required whenever `model` is set (registry-only rule). */
	provider?: string;
	model?: string;
	/** Trimmed body; null when blank. */
	systemPrompt: string | null;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	/** Fatal-to-call: duplicate `name` across files (ambiguous resolution).
	 *  The caller rejects — never last-wins. */
	errors: string[];
	/** Per-file problems (bad name, NUL, oversized, model without provider,
	 *  malformed frontmatter) — the offending file is skipped, the rest of the
	 *  registry stays usable. Surfaced as warnings, never fatal. */
	skipped: string[];
	/** Non-fatal notes (ignored keys). */
	warnings: string[];
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs
 * a real YAML parser, so any scalar or collection can appear here.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	provider?: unknown;
	model?: unknown;
	extensions?: unknown;
	maxDepth?: unknown;
};

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names. Both
 * spellings are valid YAML:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * Anything else yields no tools rather than throwing — a single bad file
 * must not take down the registry.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Default registry directory: `~/.pi/agent/agents/`. */
export function defaultAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

/**
 * Load every valid agent from `dir`. The directory is injectable so tests can
 * point at a fixture tree; production callers use the default.
 */
export function loadAgentsFromDir(dir: string = defaultAgentsDir()): AgentDiscoveryResult {
	const agents: AgentConfig[] = [];
	const errors: string[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];
	const byName = new Map<string, string>();

	if (!fs.existsSync(dir)) return { agents, errors, skipped, warnings };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		errors.push(`cannot read agents directory ${dir}: ${errText(err)}`);
		return { agents, errors, skipped, warnings };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		// Regular files and symlinks. A symlink to a directory passes this
		// check but readFileSync throws EISDIR — caught below.
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue; // unreadable / dangling symlink / symlink-to-dir
		}

		// parseFrontmatter already strips a BOM and normalizes newlines; do it
		// here too so the body we store is byte-stable regardless of parser
		// behavior changes.
		content = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			const parsed = parseFrontmatter<AgentFrontmatter>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch (err) {
			skipped.push(`${entry.name}: malformed frontmatter (${errText(err)})`);
			continue;
		}

		const name = optionalString(frontmatter.name);
		const description = optionalString(frontmatter.description);
		// Missing name/description: not an agent, silently skipped (upstream
		// parity — other markdown in the dir is not necessarily an agent).
		if (!name || !description) continue;

		if (!AGENT_NAME_RE.test(name)) {
			skipped.push(`${entry.name}: invalid agent name "${name}" (must match ${AGENT_NAME_RE})`);
			continue;
		}

		const previous = byName.get(name);
		if (previous) {
			errors.push(
				`agent \`${name}\` defined in ${path.basename(previous)} and ${path.basename(filePath)}`,
			);
			continue;
		}

		const provider = optionalString(frontmatter.provider);
		const model = optionalString(frontmatter.model);
		// A model-only pin is invalid: the pair must resolve atomically, and a
		// provider-less model silently inherits the child's default provider.
		if (model && !provider) {
			skipped.push(`${entry.name}: model requires provider in agent frontmatter`);
			continue;
		}

		if (frontmatter.extensions !== undefined) {
			warnings.push(`${entry.name}: frontmatter key "extensions" is ignored for registry agents`);
		}
		if (frontmatter.maxDepth !== undefined) {
			warnings.push(`${entry.name}: frontmatter key "maxDepth" is ignored for registry agents`);
		}

		const trimmed = body.trim();
		if (trimmed.includes("\0")) {
			skipped.push(`${entry.name}: agent body contains a NUL byte`);
			continue;
		}
		const bytes = Buffer.byteLength(trimmed, "utf8");
		if (bytes > MAX_AGENT_BODY_BYTES) {
			skipped.push(
				`${entry.name}: agent body is ${bytes} bytes (max ${MAX_AGENT_BODY_BYTES})`,
			);
			continue;
		}

		byName.set(name, filePath);
		agents.push({
			name,
			description,
			tools: parseToolList(frontmatter.tools),
			provider,
			model,
			systemPrompt: trimmed.length > 0 ? trimmed : null,
			filePath,
		});
	}

	agents.sort((a, b) => a.name.localeCompare(b.name));
	return { agents, errors, skipped, warnings };
}

/** One-line agent list for tool descriptions. Newlines collapsed, each
 *  description length-capped, count-capped. */
export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	const text = listed
		.map((a) => {
			const desc = a.description.replace(/\s+/g, " ").trim().slice(0, 120);
			return `${a.name}: ${desc}`;
		})
		.join("; ");
	return { text, remaining };
}
