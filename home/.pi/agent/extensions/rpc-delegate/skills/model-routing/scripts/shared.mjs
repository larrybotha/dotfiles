/** Shared helpers for the model-routing scripts (check.mjs, derive.mjs).
 *  Single source — catalog flattening, first-party filtering, argument
 *  parsing, and the probe pool must never drift between the two.
 *  check.mjs --lint keeps both honest; edit here, both pick it up. */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Unknown flags or stray arguments exit 2 — a typo must never fall
// through to a paid network refresh (check.mjs) or a models.json write
// (derive.mjs).
export function parseArgs(argv, knownFlags, valueFlags) {
	const flags = new Map();
	const modes = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) {
			console.error(`unexpected argument: ${a}`);
			process.exit(2);
		}
		if (!knownFlags.has(a)) {
			console.error(`unknown flag: ${a} (known: ${[...knownFlags].join(' ')})`);
			process.exit(2);
		}
		if (valueFlags.has(a)) {
			const val = argv[i + 1];
			if (!val || val.startsWith('--')) {
				console.error(`${a} requires a value`);
				process.exit(2);
			}
			flags.set(a, val);
			i++;
		} else {
			modes.push(a);
		}
	}
	return { flags, modes };
}

export function expandTilde(p) {
	if (typeof p !== 'string') return p;
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

export async function readJson(file) {
	const txt = await fs.readFile(file, 'utf8');
	return JSON.parse(txt);
}

// Lenient JSONL readers shared by route.mjs and the rpc-delegate fallback
// path. check.mjs keeps its validating reader separate (it reports bad lines).
export async function readJsonl(file) {
	try {
		const txt = await fs.readFile(file, 'utf8');
		const rows = [];
		for (const line of txt.split('\n')) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line));
			} catch {}
		}
		return rows;
	} catch {
		return [];
	}
}

export function readJsonlSync(file) {
	try {
		const rows = [];
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line));
			} catch {}
		}
		return rows;
	} catch {
		return [];
	}
}

// Keyed by model id (roster/verdicts vocabulary); the first provider
// listing wins on a cross-provider id collision (reported, not silent).
export function flattenCatalog(store) {
	const map = new Map();
	const collisions = [];
	for (const [providerKey, value] of Object.entries(store || {})) {
		for (const model of value?.models || []) {
			const provider = model.provider || providerKey;
			const prev = map.get(model.id);
			if (prev) {
				if (prev.provider !== provider) collisions.push({ id: model.id, providers: [prev.provider, provider] });
				continue;
			}
			map.set(model.id, { id: model.id, provider, store: model });
		}
	}
	return { map, collisions };
}

// First-party ids may carry version dots (gpt-5.3-codex, jev-1.13);
// marketplace aliases carry namespace dots (us.anthropic.claude-opus-5-5,
// amazon.nova-lite-v1:0). A dot followed by a digit is a version, by a
// letter a namespace.
export const firstParty = (id) => {
	const i = id.indexOf('.');
	return i === -1 || /[0-9]/.test(id[i + 1] || '');
};

export async function runPool(items, worker, maxParallel) {
	const results = [];
	let i = 0;
	async function next() {
		const idx = i++;
		if (idx >= items.length) return;
		results[idx] = await worker(items[idx]);
		await next();
	}
	const workers = Array.from({ length: Math.min(maxParallel, items.length) }, () => next());
	await Promise.all(workers);
	return results;
}

// Key-sorted, order-insensitive JSON — canonical compare for drift
// detection (models.json managed block).
export function canonicalJson(v) {
	if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
	if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
	return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}


// Task-independent capability filter shared by route.mjs and fallback
// selection. Cost ceilings and corpus-specific checks remain caller-side.
export function hardFilter(store, { minContext = null, minOutput = null, needsImage = false } = {}) {
	if (!store) return 'not in models-store';
	if (store.maxTokens == null) return 'maxTokens absent';
	if (store.reasoning == null) return 'reasoning absent';
	if (store.reasoning === false) return 'reasoning:false — not proven for tool loops';
	if (minContext != null && !(typeof store.contextWindow === 'number' && store.contextWindow >= minContext)) {
		return `contextWindow ${store.contextWindow ?? '?'} < ${minContext}`;
	}
	if (minOutput != null && !(typeof store.maxTokens === 'number' && store.maxTokens >= minOutput)) {
		return `maxTokens ${store.maxTokens ?? '?'} < ${minOutput}`;
	}
	if (needsImage && !(store.input || []).includes('image')) return 'no image input';
	return null;
}

// Fallback selection shared by the rpc-delegate extension and tests. Inputs
// are already-loaded data; no file IO. Returns the next eligible candidate in
// policy order, or null. Only open models escalate (open-first policy).
export function pickFallback({
	roster,
	verdicts,
	catalog,
	telemetryRows = [],
	policy,
	archetype,
	currentModel,
	attempted = new Set(),
	needsImage = false,
}) {
	if (!archetype || !currentModel) return null;
	const p = policy ?? routingPolicy(roster);
	if (p.preference !== 'open-first' || p.fallback !== 'frontier') return null;
	const meta = roster?.modelMeta && typeof roster.modelMeta === 'object' && !Array.isArray(roster.modelMeta) ? roster.modelMeta : {};
	if (meta[currentModel]?.weights !== 'open') return null;
	const a = (roster?.archetypes || []).find((x) => x?.archetype === archetype);
	if (!a) return null;
	const verdictRow = verdicts?.archetypes?.[archetype];
	const verdictMap = new Map();
	for (const e of [...(verdictRow?.picks || []), ...(verdictRow?.alt || [])]) {
		if (typeof e?.id === 'string' && typeof e?.verdict === 'string') verdictMap.set(e.id, e.verdict);
	}
	const ids = [...(a.picks || []), ...(a.alt || [])].filter(
		(id) => typeof id === 'string' && !attempted.has(id) && verdictMap.get(id) === 'reachable',
	);
	const eligible = ids.filter((id) => {
		const m = catalog.get(id);
		return m != null && hardFilter(m.store, { needsImage }) == null;
	});
	const stats = telemetryStatsForPolicy(telemetryRows, p);
	const ordered = orderCandidates(eligible, { meta, stats, policy: p });
	for (const candidate of ordered) {
		const provider = catalog.get(candidate.id)?.provider;
		if (provider) return { provider, model: candidate.id };
	}
	return null;
}

// Canonical patch shape the managed block writes.
export const CANONICAL_PATCH = { thinkingLevelMap: { off: null } };

// ---- routing policy + telemetry gate (single source) ----

export const TELEMETRY_SOURCE = 'rpc-delegate';
export const WEIGHTS_DOMAIN = new Set(['open', 'closed']);
export const PREFERENCE_DOMAIN = new Set(['open-first', 'roster-order']);
export const FALLBACK_DOMAIN = new Set(['frontier', 'none']);
export const VISION_ARCHETYPE = 'Vision (image input)';
export const DEFAULT_ROUTING_POLICY = Object.freeze({
	preference: 'roster-order',
	fallback: 'frontier',
	minArtifactRows: 3,
	maxBrokenRate: 0.1,
	gateWindowDays: 30,
});

// Effective policy for routing/reporting. Lint validates the raw object; this
// helper only chooses fallbacks so route/status still work on a broken roster.
export function routingPolicy(roster) {
	const p = roster?.policy;
	const policy = { ...DEFAULT_ROUTING_POLICY };
	if (!p || typeof p !== 'object' || Array.isArray(p)) return policy;
	if (PREFERENCE_DOMAIN.has(p.preference)) policy.preference = p.preference;
	if (FALLBACK_DOMAIN.has(p.fallback)) policy.fallback = p.fallback;
	if (Number.isInteger(p.minArtifactRows) && p.minArtifactRows >= 1) policy.minArtifactRows = p.minArtifactRows;
	if (typeof p.maxBrokenRate === 'number' && Number.isFinite(p.maxBrokenRate) && p.maxBrokenRate >= 0 && p.maxBrokenRate <= 1) {
		policy.maxBrokenRate = p.maxBrokenRate;
	}
	if (Number.isInteger(p.gateWindowDays) && p.gateWindowDays >= 1) policy.gateWindowDays = p.gateWindowDays;
	return policy;
}

// Writer rows only; spawn-enoent is harness state, not model state. An
// optional sinceMs window is used by the routing gate so old breaks age out;
// re-rank flags call this without a window (all-time review evidence).
export function telemetryStats(rows, { sinceMs = null } = {}) {
	const writerRows = (rows || []).filter((r) => r?.source === TELEMETRY_SOURCE);
	const harnessFailures = writerRows.filter((r) => r?.failureClass === 'spawn-enoent').length;
	const usable = writerRows.filter((r) => {
		if (r?.failureClass === 'spawn-enoent') return false;
		if (sinceMs == null) return true;
		const ts = Date.parse(r?.ts);
		return !Number.isNaN(ts) && ts >= sinceMs;
	});
	const byModel = new Map();
	const byCell = new Map();
	const push = (map, key, r) => {
		let s = map.get(key);
		if (!s) {
			s = { n: 0, okTrue: 0, okFalse: 0, okNull: 0, stall: 0, failures: {}, costSum: 0, costN: 0, runSum: 0, runN: 0 };
			map.set(key, s);
		}
		s.n += 1;
		if (r.artifactOk === true) s.okTrue += 1;
		else if (r.artifactOk === false) s.okFalse += 1;
		else s.okNull += 1;
		if (r.stallHit === true) s.stall += 1;
		if (r.failureClass) s.failures[r.failureClass] = (s.failures[r.failureClass] || 0) + 1;
		if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) {
			s.costSum += r.costUsd;
			s.costN += 1;
		}
		if (typeof r.runSecs === 'number' && Number.isFinite(r.runSecs)) {
			s.runSum += r.runSecs;
			s.runN += 1;
		}
	};
	for (const r of usable) {
		if (!r?.model) continue;
		push(byModel, r.model, r);
		if (r.archetype) push(byCell, `${r.archetype} x ${r.model}`, r);
	}
	return { byModel, byCell, harnessFailures };
}

export function telemetryStatsForPolicy(rows, policy) {
	const days = Number.isInteger(policy?.gateWindowDays) ? policy.gateWindowDays : DEFAULT_ROUTING_POLICY.gateWindowDays;
	return telemetryStats(rows, { sinceMs: Date.now() - days * 86_400_000 });
}

// Symmetric quality gate: the same test applies to open and closed models.
// Untested/under-tested candidates keep their slot; once a candidate has
// enough artifact-policy rows, its broken rate must stay within budget.
export function qualityGate(stats, policy) {
	if (!stats) return { ok: true, reason: 'untested — gate pass' };
	const artifactRows = stats.okTrue + stats.okFalse;
	if (artifactRows < policy.minArtifactRows) {
		return { ok: true, reason: `under-tested — gate pass (${artifactRows}/${policy.minArtifactRows} artifact rows)` };
	}
	const rate = artifactRows ? stats.okFalse / artifactRows : 0;
	if (rate > policy.maxBrokenRate) {
		return {
			ok: false,
			reason: `quality-gated (${stats.okFalse}/${artifactRows} broken, ${(rate * 100).toFixed(1)}% > ${(policy.maxBrokenRate * 100).toFixed(1)}%)`,
		};
	}
	return { ok: true, reason: `eligible (${stats.okFalse}/${artifactRows} broken)` };
}

// Order eligible ids: open + gate-pass first, closed + gate-pass second, then
// everything gated in roster order. `roster-order` ignores the gate entirely.
export function orderCandidates(ids, { meta = {}, stats = null, policy }) {
	const byModel = stats?.byModel || new Map();
	const rank = new Map(ids.map((id, i) => [id, i]));
	const rows = ids.map((id) => {
		const gate = qualityGate(byModel.get(id), policy);
		const open = meta?.[id]?.weights === 'open';
		return { id, open, gate, tier: gate.ok ? (open ? 0 : 1) : 2, rank: rank.get(id) };
	});
	rows.sort((a, b) => policy.preference === 'open-first'
		? (a.tier - b.tier || a.rank - b.rank)
		: (a.rank - b.rank));
	return rows;
}

// Managed modelOverrides policy — single source for derive.mjs (the
// writer) and check.mjs --status (the drift report; zero RPC spawns).
// The two must never drift apart; both import this.
//
// generated: roster ids on the default provider whose store
// thinkingLevelMap exists but lacks an "off" key → the canonical
// patch {thinkingLevelMap: {off: null}}. Overrides apply per provider —
// a patch written under the default provider never reaches a model
// listed under another one — so cross-provider ids are excluded.
// retained: prior managed entries (not generated) that still satisfy
// the patch condition (id in catalog on the default provider, store
// map still lacks "off") — kept verbatim.
// dropped: prior entries that no longer satisfy it, each with its
// reason (a derive run removes them).
// replaced: prior entries for generated ids whose shape differs from
// the canonical patch (hand edits inside the managed block) — a
// derive run overwrites them; reported, never silent.
// nonCanonical: retained entries whose shape differs from the
// canonical patch — kept verbatim, reported.
// nextManaged: the block a derive run would write (generated wins
// collisions; ids sorted).
// drift: true when the current block (priorManaged; null = absent)
// differs from nextManaged — or is absent while nextManaged is
// non-empty, or is malformed. Never true for an empty policy + absent
// block (nothing to write).
// malformedPrior: priorManaged present but not a plain object
// (string/array/number) — replaced wholesale by a derive run.
export function managedOverridesPolicy(rosterSet, catalog, priorManaged, defaultProvider) {
	const onProvider = (id) => (catalog.get(id)?.provider || defaultProvider) === defaultProvider;
	const isCanonical = (e) => canonicalJson(e) === canonicalJson(CANONICAL_PATCH);
	const generated = {};
	for (const id of rosterSet) {
		if (!onProvider(id)) continue;
		const st = catalog.get(id)?.store || {};
		if (st.thinkingLevelMap && !('off' in st.thinkingLevelMap)) generated[id] = { thinkingLevelMap: { off: null } };
	}
	const hasPrior = priorManaged != null && typeof priorManaged === 'object' && !Array.isArray(priorManaged);
	const retained = {};
	const dropped = [];
	const replaced = [];
	const nonCanonical = [];
	for (const [id, entry] of Object.entries(hasPrior ? priorManaged : {})) {
		if (generated[id]) {
			if (!isCanonical(entry)) replaced.push(id);
			continue;
		}
		const m = catalog.get(id);
		if (!m) dropped.push({ id, reason: 'not in catalog' });
		else if (!onProvider(id)) dropped.push({ id, reason: `listed under another provider (${m.provider})` });
		else if (!m.store?.thinkingLevelMap) dropped.push({ id, reason: 'store map gone (no thinking)' });
		else if ('off' in m.store.thinkingLevelMap) dropped.push({ id, reason: 'store map gained "off"' });
		else {
			retained[id] = entry;
			if (!isCanonical(entry)) nonCanonical.push(id);
		}
	}
	const nextManaged = {};
	for (const id of [...new Set([...Object.keys(retained), ...Object.keys(generated)])].sort()) {
		nextManaged[id] = generated[id] ?? retained[id];
	}
	const drift = hasPrior
		? canonicalJson(priorManaged) !== canonicalJson(nextManaged)
		: Object.keys(nextManaged).length > 0;
	return { generated, retained, dropped, replaced, nonCanonical, nextManaged, drift, malformedPrior: priorManaged != null && !hasPrior };
}
