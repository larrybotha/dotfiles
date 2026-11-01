#!/usr/bin/env node
// Routing policy tests — run with:
//   node scripts/routing.test.mjs
import assert from 'node:assert/strict';
import {
	DEFAULT_ROUTING_POLICY,
	orderCandidates,
	hardFilter,
	pickFallback,
	qualityGate,
	routingPolicy,
	telemetryStats,
	telemetryStatsForPolicy,
} from './shared.mjs';

function row({ model, ok = true, ts = '2026-11-01T00:00:00Z' }) {
	return {
		ts,
		source: 'rpc-delegate',
		provider: 'opencode',
		model,
		stopReason: 'stop',
		artifactOk: ok,
		artifactPolicy: 'artifacts',
		failureClass: null,
		stallHit: false,
		archetype: 'Code review / judgment / rubric',
		costUsd: 1,
		runSecs: 10,
		note: '',
	};
}

const policy = {
	...DEFAULT_ROUTING_POLICY,
	preference: 'open-first',
	minArtifactRows: 3,
	maxBrokenRate: 0.1,
	gateWindowDays: 30,
};
const meta = {
	'open-good': { weights: 'open' },
	'open-bad': { weights: 'open' },
	'closed-good': { weights: 'closed' },
	'closed-bad': { weights: 'closed' },
};
const rowsFor = (model, broken) => Array.from({ length: 4 }, (_, i) => row({ model, ok: i >= broken }));
const stats = telemetryStats([
	...rowsFor('open-good', 0),
	...rowsFor('closed-good', 0),
	...rowsFor('open-bad', 1),
	...rowsFor('closed-bad', 1),
]);

// Under-tested candidates keep their slot; once judged, the same gate applies
// to open and closed models.
const oneBroken = telemetryStats([row({ model: 'x', ok: false })]).byModel.get('x');
assert.equal(qualityGate(oneBroken, policy).ok, true, 'under-tested should pass');
const closedBad = stats.byModel.get('closed-bad');
const openBad = stats.byModel.get('open-bad');
assert.equal(qualityGate(closedBad, policy).ok, false, 'closed bad rate must gate');
assert.equal(qualityGate(openBad, policy).ok, false, 'open bad rate must gate');

// open + pass, closed + pass, then all gated in roster order.
const ids = ['closed-bad', 'open-bad', 'open-good', 'closed-good'];
assert.deepEqual(
	orderCandidates(ids, { meta, stats, policy }).map((c) => c.id),
	['open-good', 'closed-good', 'closed-bad', 'open-bad'],
);

// roster-order is the legacy escape hatch and ignores the gate for sorting.
assert.deepEqual(
	orderCandidates(ids, { meta, stats, policy: { ...policy, preference: 'roster-order' } }).map((c) => c.id),
	ids,
);

// Invalid policy fields fall back to defaults rather than silently reaching
// route/status with zeros.
const defaults = routingPolicy({ policy: { preference: 'bogus', minArtifactRows: 0, gateWindowDays: 0, maxBrokenRate: 2 } });
assert.equal(defaults.preference, DEFAULT_ROUTING_POLICY.preference);
assert.equal(defaults.minArtifactRows, DEFAULT_ROUTING_POLICY.minArtifactRows);
assert.equal(defaults.gateWindowDays, DEFAULT_ROUTING_POLICY.gateWindowDays);
assert.equal(defaults.maxBrokenRate, DEFAULT_ROUTING_POLICY.maxBrokenRate);

// The gate window ages rows out; re-rank stats remain all-time when called
// without a window.
const old = Array.from({ length: 4 }, () => row({ model: 'open-good', ok: false, ts: '2020-01-01T00:00:00Z' }));
const windowed = telemetryStatsForPolicy(old, policy);
assert.equal(windowed.byModel.has('open-good'), false, 'old rows must leave the gate window');
assert.equal(qualityGate(windowed.byModel.get('open-good'), policy).ok, true);
assert.equal(telemetryStats(old).byModel.get('open-good').n, 4, 'all-time stats keep old rows');


// Fallback selection: shared eligibility + open-only escalation.
const fallbackStore = (extra = {}) => ({ maxTokens: 10, reasoning: true, contextWindow: 10_000, input: ['text'], ...extra });
const fallbackRoster = {
	policy,
	modelMeta: {
		'open-bad': { weights: 'open' },
		'open-good': { weights: 'open' },
		'open-null': { weights: 'open' },
		'closed-good': { weights: 'closed' },
	},
	archetypes: [{ archetype: 'A', picks: ['closed-good'], alt: ['open-bad', 'open-good', 'open-null'] }],
};
const fallbackVerdicts = {
	archetypes: {
		A: {
			picks: [{ id: 'closed-good', verdict: 'reachable' }],
			alt: [
				{ id: 'open-bad', verdict: 'reachable' },
				{ id: 'open-good', verdict: 'reachable' },
				{ id: 'open-null', verdict: 'reachable' },
			],
		},
	},
};
const fallbackCatalog = new Map([
	['closed-good', { provider: 'p', store: fallbackStore() }],
	['open-bad', { provider: 'p', store: fallbackStore() }],
	['open-good', { provider: 'p', store: fallbackStore() }],
	// Matches route.mjs hardFilter: absent reasoning is NOT eligible.
	['open-null', { provider: 'p', store: fallbackStore({ reasoning: null }) }],
]);

assert.equal(hardFilter(fallbackStore({ reasoning: null }), {}), 'reasoning absent');
assert.deepEqual(
	pickFallback({
		roster: fallbackRoster,
		verdicts: fallbackVerdicts,
		catalog: fallbackCatalog,
		archetype: 'A',
		currentModel: 'open-bad',
		attempted: new Set(['open-bad']),
	}),
	{ provider: 'p', model: 'open-good' },
	'open fallback excludes attempted + reasoning-null candidates',
);
assert.equal(
	pickFallback({
		roster: { ...fallbackRoster, policy: { ...policy, fallback: 'none' } },
		verdicts: fallbackVerdicts,
		catalog: fallbackCatalog,
		archetype: 'A',
		currentModel: 'open-bad',
		attempted: new Set(['open-bad']),
	}),
	null,
	'fallback:none disables escalation',
);
assert.equal(
	pickFallback({
		roster: fallbackRoster,
		verdicts: fallbackVerdicts,
		catalog: fallbackCatalog,
		archetype: 'A',
		currentModel: 'closed-good',
		attempted: new Set(['closed-good']),
	}),
	null,
	'closed model never escalates',
);
assert.equal(
	pickFallback({
		roster: fallbackRoster,
		verdicts: fallbackVerdicts,
		catalog: fallbackCatalog,
		archetype: 'A',
		currentModel: 'open-bad',
		attempted: new Set(['open-bad']),
		needsImage: true,
	}),
	null,
	'image filter applies to fallback',
);

console.log('✓ routing: symmetric gate, open-first tiers, roster-order fallback, gate window reset, shared fallback pick');
