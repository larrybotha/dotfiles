#!/usr/bin/env node
// Read-only candidate order for routing. No probes, no writes.
//
// Usage:
//   node scripts/route.mjs
//   node scripts/route.mjs --archetype "Greenfield code / big feature"
//   node scripts/route.mjs --archetype "Vision (image input)" --needs-image
//   node scripts/route.mjs --archetype "Long-doc summarize / digest" --min-context 200000 --min-output 32000
//
// Order comes from roster.policy + modelMeta + verdicts.json + telemetry gate.
// Task-specific hard filters are only the flags supplied here; the skill's
// cost ceiling and corpus-specific checks remain agent-side.
import path from 'node:path';
import {
	expandTilde,
	flattenCatalog,
	hardFilter,
	orderCandidates,
	parseArgs,
	readJson,
	readJsonl,
	routingPolicy,
	telemetryStatsForPolicy,
} from './shared.mjs';

const KNOWN_FLAGS = new Set([
	'--archetype', '--catalog', '--telemetry', '--roster', '--verdicts',
	'--min-context', '--min-output', '--needs-image',
]);
const VALUE_FLAGS = new Set(['--archetype', '--catalog', '--telemetry', '--roster', '--verdicts', '--min-context', '--min-output']);

function resolvePath(value, fallback) {
	return value ? path.resolve(expandTilde(value)) : fallback;
}

function intFlag(flags, name) {
	const raw = flags.get(name);
	if (raw == null) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		console.error(`${name} must be a non-negative integer (got ${raw})`);
		process.exit(2);
	}
	return n;
}

function costText(cost) {
	if (!cost || typeof cost !== 'object') return 'cost=?';
	const input = typeof cost.input === 'number' ? cost.input : '?';
	const output = typeof cost.output === 'number' ? cost.output : '?';
	return `$${input}/$${output}`;
}

function printArchetype(a, verdicts, catalog, meta, gateStats, policy, opts) {
	const verdictRow = verdicts.archetypes?.[a.archetype];
	const verdictMap = new Map();
	for (const e of [...(verdictRow?.picks || []), ...(verdictRow?.alt || [])]) verdictMap.set(e.id, e.verdict);
	const ids = [...(a.picks || []), ...(a.alt || [])];
	const eligible = [];
	const excluded = [];
	for (const id of ids) {
		const verdict = verdictMap.get(id);
		if (!verdict) {
			excluded.push([id, 'no verdict — probe first or refresh']);
			continue;
		}
		if (verdict !== 'reachable') {
			excluded.push([id, `verdict: ${verdict}`]);
			continue;
		}
		const reason = hardFilter(catalog.get(id)?.store, opts);
		if (reason) {
			excluded.push([id, reason]);
			continue;
		}
		eligible.push(id);
	}
	console.log(`\n${a.archetype}`);
	if (!eligible.length) {
		console.log('  (no eligible candidates — filters/verdicts empty)');
	} else {
		const ordered = orderCandidates(eligible, { meta, stats: gateStats, policy });
		ordered.forEach((c, i) => {
			const st = catalog.get(c.id)?.store || {};
			const img = (st.input || []).includes('image') ? 'image' : 'text';
			const tier = policy.preference === 'roster-order'
				? (c.open ? 'open' : 'closed')
				: c.tier === 0 ? 'open-pass' : c.tier === 1 ? 'closed-pass' : 'gated';
			const gate = c.gate.ok ? 'gate=pass' : 'gate=FAIL';
			console.log(`  ${i + 1}. ${c.id} [${tier}] ${gate} — ctx=${st.contextWindow ?? '?'} max=${st.maxTokens ?? '?'} ${img} ${costText(st.cost)} (${c.gate.reason})`);
		});
	}
	for (const [id, reason] of excluded) console.log(`  - excluded ${id}: ${reason}`);
}

async function main() {
	const { flags, modes } = parseArgs(process.argv.slice(2), KNOWN_FLAGS, VALUE_FLAGS);
	for (const mode of modes) {
		if (mode !== '--needs-image') {
			console.error(`unknown mode: ${mode}`);
			process.exit(2);
		}
	}
	const opts = {
		minContext: intFlag(flags, '--min-context'),
		minOutput: intFlag(flags, '--min-output'),
		needsImage: modes.includes('--needs-image'),
	};

	const scriptDir = path.dirname(new URL(import.meta.url).pathname);
	const skillDir = path.resolve(scriptDir, '..');
	const pathsCfg = await readJson(path.join(skillDir, 'assets/paths.json'));
	const rosterPath = resolvePath(flags.get('--roster'), path.join(skillDir, 'assets/roster.json'));
	const verdictsPath = resolvePath(flags.get('--verdicts'), path.join(skillDir, 'assets/verdicts.json'));
	const catalogPath = resolvePath(flags.get('--catalog'), expandTilde(pathsCfg.catalog));
	const telemetryPath = resolvePath(flags.get('--telemetry'), expandTilde(pathsCfg.telemetry));

	const roster = await readJson(rosterPath);
	const verdicts = await readJson(verdictsPath);
	const { map: catalog } = flattenCatalog(await readJson(catalogPath));
	const rows = await readJsonl(telemetryPath);
	const policy = routingPolicy(roster);
	const gateStats = telemetryStatsForPolicy(rows, policy);
	const meta = roster.modelMeta && typeof roster.modelMeta === 'object' && !Array.isArray(roster.modelMeta) ? roster.modelMeta : {};

	const wanted = flags.get('--archetype');
	const archetypes = (roster.archetypes || []).filter((a) => !wanted || a.archetype === wanted);
	if (wanted && !archetypes.length) {
		console.error(`unknown archetype: ${wanted}`);
		console.error(`known: ${(roster.archetypes || []).map((a) => a.archetype).join(' | ')}`);
		process.exit(2);
	}

	console.log('# route.mjs — read-only candidate order');
	console.log(`policy: preference=${policy.preference}, fallback=${policy.fallback}, minArtifactRows=${policy.minArtifactRows}, maxBrokenRate=${policy.maxBrokenRate}, gateWindowDays=${policy.gateWindowDays}`);
	const filters = [];
	if (opts.minContext != null) filters.push(`min-context=${opts.minContext}`);
	if (opts.minOutput != null) filters.push(`min-output=${opts.minOutput}`);
	if (opts.needsImage) filters.push('needs-image');
	if (filters.length) console.log(`hard filters: ${filters.join(', ')}`);
	for (const a of archetypes) printArchetype(a, verdicts, catalog, meta, gateStats, policy, opts);
	console.log('\nlive retirement: not checked — run node scripts/check.mjs --live');
}

main().catch((err) => {
	console.error('operational failure:', err?.stack || err?.message || String(err));
	process.exit(1);
});
