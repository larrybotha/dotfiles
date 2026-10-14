/** Shared helpers for the model-routing scripts (check.mjs, derive.mjs).
 *  Single source — catalog flattening, first-party filtering, argument
 *  parsing, and the probe pool must never drift between the two.
 *  check.mjs --lint keeps both honest; edit here, both pick it up. */
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

// Keyed by model id (roster/matrix vocabulary); the first provider
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

// Canonical patch shape the managed block writes.
export const CANONICAL_PATCH = { thinkingLevelMap: { off: null } };

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
