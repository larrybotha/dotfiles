#!/usr/bin/env node
// Model-routing verdicts maintenance.
//
// Modes:
//   (default)      probe roster, rewrite assets/verdicts.json (revision), report
//   --full          default + probe every first-party catalog model
//   --status        read-only: cadence, live diff (fail-soft), catalog
//                  diff, telemetry re-rank flags, thinking-map record
//                  + managed-block drift (zero-spawn policy check via
//                  shared.mjs)
//   --live          read-only: live provider /models listing vs the
//                  store (store-only retired ids, live-only ids, roster
//                  absence) — fail-soft (no key / network); --status
//                  embeds the same diff
//   --lint          read-only: roster/verdicts/telemetry/store/class validation
//
// Flags:
//   --catalog <path>      override catalog location (default: paths.json)
//   --models-config <path>  override models config location
//   --telemetry <path>    override telemetry location
//   --auth <path>        override auth.json location (live-listing key)
//   Unknown flags or stray arguments exit 2 — a typo must never fall
//   through to a paid network refresh.
//
// Paths + probe command come from assets/paths.json (tracked; tilde
// paths; {provider}/{id} placeholders in probeCommand). The
// failure-class taxonomy is single-sourced in ./classes.mjs — shared
// with the rpc-delegate extension (file: dependency
// "model-routing-classes") — and --lint asserts pattern-set agreement
// and classifies one sample per class.
//
// Shared helpers + the managed-override policy (parseArgs,
// flattenCatalog, firstParty, runPool, managedOverridesPolicy) are
// single-sourced in ./shared.mjs — shared with ./derive.mjs (RPC
// get_state thinking-map derivation → assets/thinking-levels.json +
// the managed modelOverrides block in models.json); --lint validates
// that record against the roster and prefers it over the
// store+models.json merge estimate, and --status reports the policy
// drift (zero spawns) without rewriting anything.
//
// Roster (rankings, alternatives, never_delegate) lives in
// assets/roster.json (tracked). Verdicts + probed timestamps in
// assets/verdicts.json are per-machine (gitignored).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import {
	FAILURE_CLASSES,
	CLASS_DETECTION,
	PROBE_PATTERNS,
	DELEGATION_PATTERNS,
	PROBE_SAMPLES,
	DELEGATION_SAMPLES,
} from './classes.mjs';
import {
	expandTilde,
	flattenCatalog,
	firstParty,
	managedOverridesPolicy,
	parseArgs,
	readJson,
	runPool,
} from './shared.mjs';

const TIMEOUT_MS = 30_000;
const MAX_PARALLEL = 5;
// Fail-closed refresh: when at least this fraction of probes fail to
// *spawn* (ENOENT etc. — harness broken, not model state), abort without
// writing the verdicts. A failed refresh must never look like a clean one.
const SPAWN_ERROR_ABORT_FRACTION = 0.25;

const TELEMETRY_FAILURE_CLASSES = new Set(FAILURE_CLASSES);
// Probe-classifiable classes + the probe-only outcomes + retired
// (absent from the live /models listing — synthetic, never probed).
const VERDICT_VALUES = new Set(['reachable', 'indeterminate', 'retired', ...Object.keys(PROBE_PATTERNS)]);
// Hard classes: fresh probe truth always replaces any prior verdict.
// 'reachable' likewise; 'retired' (absent from the live listing) is
// hard truth too. 'indeterminate' (timeout/spawn-error/unmatched
// exit) is transient — hysteresis: never overwrites a prior verdict.
const HARD_VERDICTS = new Set(['reachable', 'retired', ...Object.keys(PROBE_PATTERNS)]);
// Hard keys: every row must carry them. Nullable keys: required only
// after their first appearance in the log — rows before adoption are
// legacy (summarized, not defects); rows after are writer regressions.
const TELEMETRY_HARD_KEYS = ['ts', 'provider', 'model', 'stopReason', 'artifactOk'];
const TELEMETRY_SOFT_KEYS = [
	'archetype', 'stallHit', 'failureClass', 'tokensIn', 'tokensOut',
	'costUsd', 'runSecs', 'note', 'source', 'artifactPolicy',
	'modelSource', 'agent',
];
// Provenance value written by the rpc-delegate writer. Re-rank flags
// count only writer rows; hand/legacy rows carry no source and are
// excluded from demotion flags.
const TELEMETRY_SOURCE = 'rpc-delegate';
// stopReason protocol values observed in live rows + machine.ts domain
// (error/aborted/pending fail; length/deferred surface as notes). Novel
// string values warn; malformed values are problems.
const STOP_REASON_DOMAIN = new Set(['stop', 'success', 'error', 'aborted', 'pending', 'length', 'deferred']);
const ARTIFACT_POLICIES = new Set(['stopReason', 'artifacts']);
// modelSource domain: where the resolved (provider, model) pair came from.
// null is allowed (resolution-failure rejections resolve no model).
const MODEL_SOURCES = new Set(['pinned', 'registry', 'default']);
const FLAG_MIN_ROWS = 3;
const CADENCE_ROWS = 50;
const CADENCE_DAYS = 30;
const VISION_ARCHETYPE = 'Vision (image input)';

const KNOWN_FLAGS = new Set(['--lint', '--status', '--live', '--full', '--catalog', '--models-config', '--telemetry', '--auth']);
const VALUE_FLAGS = new Set(['--catalog', '--models-config', '--telemetry', '--auth']);

// Failure substrings are evidence only on a non-zero exit: a probe
// exiting 0 whose output merely mentions a pattern (e.g. "free tier"
// prose) is reachable, not a failure.
function classifyVerdict(output, code, timedOut = false) {
	if (timedOut) return 'indeterminate';
	if (code === 0) return 'reachable';
	const s = output.toLowerCase();
	for (const [cls, subs] of Object.entries(PROBE_PATTERNS)) {
		if (subs.some((sub) => s.includes(sub))) return cls;
	}
	return 'indeterminate';
}

// Pure mirror of the extension's classifyFailure (same imported
// patterns; used by --lint to self-test the samples).
function classifyDelegation(hay) {
	for (const { cls, pattern } of DELEGATION_PATTERNS) {
		if (pattern.test(hay)) return cls;
	}
	return 'other';
}

// Live provider listing: GET <url> with the provider key (auth.json;
// '!'-prefixed key = shell command, executed — the resolved key never
// crosses stdout/logs). Store ⊇ live — a stale store keeps retired ids
// until pi refreshes it, so availability truth is the live list; an id
// absent from it is retired (no probe needed). Fail-soft at every
// step: no URL, no key, network error, non-200, empty data[] → the
// callers degrade to store-only behavior (fail open).
async function resolveProviderKey(provider, authPath) {
	let auth;
	try {
		auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
	} catch (e) {
		return { key: null, note: `auth.json unavailable (${e?.code === 'ENOENT' ? 'missing' : 'unparseable'}); --auth overrides the path` };
	}
	let key = auth?.[provider]?.key;
	if (typeof key !== 'string' || !key) {
		return { key: null, note: `no key for provider "${provider}" in auth.json` };
	}
	if (key.startsWith('!')) {
		try {
			const out = execSync(key.slice(1), { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
			key = out.split('\n').map((l) => l.trim()).filter(Boolean)[0] || null;
		} catch {
			return { key: null, note: 'key command failed (auth.json "!" resolution)' };
		}
		if (!key) return { key: null, note: 'key command produced no output' };
	}
	return { key, note: null };
}

async function fetchLiveModels(url, key) {
	const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = await res.json();
	const ids = (body?.data || []).map((m) => m?.id).filter((x) => typeof x === 'string');
	if (!ids.length) throw new Error('empty data[]');
	return new Set(ids);
}

// {ids, url, storeOnly, liveOnly} on success; {ids: null, note} on any
// failure (store-only callers degrade, retired detection fails open).
async function liveListing(paths, catalog) {
	const url = (paths.liveModels || {})[paths.defaultProvider];
	if (!url) return { ids: null, note: `no liveModels URL for provider "${paths.defaultProvider}" in paths.json` };
	const { key, note } = await resolveProviderKey(paths.defaultProvider, paths.auth);
	if (!key) return { ids: null, note };
	try {
		const ids = await fetchLiveModels(url, key);
		// store-only: first-party store ids the live list dropped
		// (retired) — scoped to the default provider (the listing is
		// per-provider; cross-provider ids are never another provider's
		// retirements). live-only: live ids the store has never seen.
		const storeOnly = catalog
			? Array.from(catalog.keys())
				.filter(firstParty)
				.filter((id) => catalog.get(id)?.provider === paths.defaultProvider)
				.filter((id) => !ids.has(id))
				.sort()
			: [];
		const liveOnly = catalog ? Array.from(ids).filter((id) => !catalog.has(id)).sort() : [];
		return { ids, url, storeOnly, liveOnly };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e ?? '');
		// Self-authored messages only (HTTP status / empty data[]); anything
		// else gets a fixed category — arbitrary exception text (URL, key
		// material) never reaches the report.
		const why = /^HTTP \d/.test(msg)
			? msg
			: msg === 'empty data[]'
				? 'empty data[]'
				: e?.name === 'TimeoutError' || e?.name === 'AbortError'
					? 'timeout'
					: e instanceof TypeError
						? 'network failure'
						: 'error (detail suppressed)';
		return { ids: null, note: `live fetch failed (${why})` };
	}
}

function probeModel(provider, id, cmdTemplate) {
	const [bin, ...rest] = cmdTemplate;
	const args = rest.map((t) => String(t).replaceAll('{provider}', provider).replaceAll('{id}', id));
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let done = false;
		let out = '';

		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			child.kill('SIGKILL');
			resolve({ id, provider, verdict: classifyVerdict(out, null, true), probed: new Date().toISOString(), output: out, code: null });
		}, TIMEOUT_MS);

		child.stdout.on('data', (d) => { out += d.toString(); });
		child.stderr.on('data', (d) => { out += d.toString(); });

		child.on('error', (err) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			out += `\n${String(err?.message || err)}`;
			// spawn failure (ENOENT etc.) — harness state, not model state
			resolve({ id, provider, verdict: 'indeterminate', probed: new Date().toISOString(), output: out, code: null, spawnError: true });
		});

		child.on('close', (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ id, provider, verdict: classifyVerdict(out, code, false), probed: new Date().toISOString(), output: out, code });
		});
	});
}

async function readTelemetry(file, validate = false) {
	const out = { rows: [], badRows: [], unknownClass: [], missingKeys: [], legacy: {}, stopReasonBad: [], stopReasonUnknown: [], badArtifactPolicy: [], badModelSource: [] };
	let txt;
	try {
		txt = await fs.readFile(file, 'utf8');
	} catch {
		return out;
	}
	const lines = txt.split('\n');
	const firstSeen = new Map();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			out.badRows.push({ line: i + 1, err: 'unparseable JSON' });
			continue;
		}
		out.rows.push(row);
		if (!validate) continue;
		for (const k of [...TELEMETRY_HARD_KEYS, ...TELEMETRY_SOFT_KEYS]) {
			if (k in row) {
				if (!firstSeen.has(k)) firstSeen.set(k, i + 1);
			} else if (TELEMETRY_HARD_KEYS.includes(k)) {
				out.missingKeys.push({ line: i + 1, missing: [k] });
			} else if (firstSeen.has(k)) {
				out.missingKeys.push({ line: i + 1, missing: [k] });
			} else {
				out.legacy[k] = (out.legacy[k] || 0) + 1;
			}
		}
		if (row.failureClass != null && !TELEMETRY_FAILURE_CLASSES.has(row.failureClass)) {
			out.unknownClass.push({ line: i + 1, value: row.failureClass });
		}
		if (row.stopReason != null) {
			if (typeof row.stopReason !== 'string' || !row.stopReason) {
				out.stopReasonBad.push({ line: i + 1, value: row.stopReason });
			} else if (!STOP_REASON_DOMAIN.has(row.stopReason)) {
				out.stopReasonUnknown.push({ line: i + 1, value: row.stopReason });
			}
		}
		if (row.artifactPolicy != null && !ARTIFACT_POLICIES.has(row.artifactPolicy)) {
			out.badArtifactPolicy.push({ line: i + 1, value: row.artifactPolicy });
		}
		if (row.modelSource != null && !MODEL_SOURCES.has(row.modelSource)) {
			out.badModelSource.push({ line: i + 1, value: row.modelSource });
		}
	}
	return out;
}

// artifactOk tri-state: true = artifacts collected and readable;
// false = artifacts declared but broken (real defect signal);
// null = artifact-less run (expected under artifactPolicy "stopReason"
// — prose deliverables — not a defect signal). Flags count only
// artifact-policy rows (true+false); null runs are reported separately.
// Re-rank statistics count writer rows only (source === TELEMETRY_SOURCE):
// pre-writer legacy and hand rows carry no source and must not mint
// demotion flags.
function telemetryStats(rows) {
	const writerRows = rows.filter((r) => r?.source === TELEMETRY_SOURCE);
	// spawn-enoent rows are harness failures (node/pi binary missing),
	// never model state — excluded from re-rank statistics entirely;
	// reported as a count so the harness issue stays visible.
	const harnessFailures = writerRows.filter((r) => r?.failureClass === 'spawn-enoent').length;
	const usable = writerRows.filter((r) => r?.failureClass !== 'spawn-enoent');
	const byModel = new Map();
	const byCell = new Map();
	const push = (map, key, r) => {
		let s = map.get(key);
		if (!s) {
			s = { n: 0, okTrue: 0, okFalse: 0, okNull: 0, stall: 0, failures: {} };
			map.set(key, s);
		}
		s.n += 1;
		if (r.artifactOk === true) s.okTrue += 1;
		else if (r.artifactOk === false) s.okFalse += 1;
		else s.okNull += 1;
		if (r.stallHit === true) s.stall += 1;
		if (r.failureClass) s.failures[r.failureClass] = (s.failures[r.failureClass] || 0) + 1;
	};
	for (const r of usable) {
		if (!r?.model) continue;
		push(byModel, r.model, r);
		if (r.archetype) push(byCell, `${r.archetype} x ${r.model}`, r);
	}
	return { byModel, byCell, harnessFailures };
}

function reRankFlags(stats) {
	const flags = [];
	const collect = (map) => {
		for (const [key, s] of map) {
			const artifactPolicyRows = s.okTrue + s.okFalse;
			if (s.okFalse >= 1 && artifactPolicyRows >= FLAG_MIN_ROWS) {
				flags.push({ key, ...s });
			}
		}
	};
	collect(stats.byModel);
	collect(stats.byCell);
	return flags;
}

function printFlags(flags) {
	console.log(`telemetry flags (re-rank review, writer rows only — min ${FLAG_MIN_ROWS} artifact-policy rows, >=1 broken): ${flags.length}`);
	for (const f of flags) {
		console.log(`  - ${f.key}: n=${f.n} artifactOk=true/false/null=${f.okTrue}/${f.okFalse}/${f.okNull} stall=${f.stall} failures=${JSON.stringify(f.failures)} -> demotion candidate`);
	}
}

function countRowsAfter(rows, afterIso) {
	if (!afterIso) return 0;
	const afterTs = Date.parse(afterIso);
	if (Number.isNaN(afterTs)) return 0;
	return rows.filter((r) => {
		const ts = Date.parse(r?.ts);
		return !Number.isNaN(ts) && ts > afterTs;
	}).length;
}

function daysSince(iso) {
	if (!iso) return 0;
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return 0;
	return Math.floor(ms / 86_400_000);
}

function lintRoster(roster, catalog, overrides, derived, problems, warnings) {
	const archetypes = new Set();
	const neverIds = new Set();
	for (const e of roster?.never_delegate || []) {
		if (!e?.id) {
			problems.push('roster: never_delegate entry missing id');
		} else if (neverIds.has(e.id)) {
			problems.push(`roster: duplicate never_delegate id "${e.id}"`);
		} else {
			neverIds.add(e.id);
		}
	}
	for (const a of roster?.archetypes || []) {
		if (!a.archetype) {
			problems.push('roster: archetypes entry missing archetype');
		} else if (archetypes.has(a.archetype)) {
			problems.push(`roster: duplicate archetype "${a.archetype}"`);
		} else {
			archetypes.add(a.archetype);
		}
		for (const [field, ids] of [['picks', a.picks || []], ['alt', a.alt || []]]) {
			for (const id of ids) {
				if (typeof id !== 'string' || !id) {
					problems.push(`roster: non-string id in "${a.archetype}".${field}`);
					continue;
				}
				if (neverIds.has(id)) {
					problems.push(`roster: id "${id}" in both never_delegate and "${a.archetype}".${field} — contradiction`);
				}
				const m = catalog.get(id);
				if (!m) {
					warnings.push(`roster: "${id}" (${a.archetype}.${field}) not in models-store — capability checks skipped`);
					continue;
				}
				const st = m.store || {};
				if (a.archetype === VISION_ARCHETYPE && !(st.input || []).includes('image')) {
					problems.push(`roster: vision pick "${id}" lacks image input modality (store.input)`);
				}
				// Effective-map check prefers the derived record (live RPC
				// get_state truth over the store+merge estimate); entries
				// absent or from a different provider fall back to the
				// estimate — a stale/foreign entry must not mask a risk.
				const dEntry = derived?.models?.[id];
				if (dEntry && dEntry.provider === m.provider) {
					if (dEntry.thinkingLevelMap && !('off' in dEntry.thinkingLevelMap)) {
						warnings.push(`roster: "${id}" derived effective thinkingLevelMap lacks "off" (thinking-map-400 risk, live get_state) — run scripts/derive.mjs to regenerate the managed patch`);
					}
				} else {
					const effMap = { ...(st.thinkingLevelMap || {}), ...((overrides[id] || {}).thinkingLevelMap || {}) };
					if (st.thinkingLevelMap && !('off' in effMap)) {
						warnings.push(`roster: "${id}" effective thinkingLevelMap lacks "off" (thinking-map-400 risk; store + modelOverrides estimate, not derived)`);
					}
				}
				const cost = st.cost || {};
				const free =
					typeof cost.input === 'number' && cost.input === 0 &&
					typeof cost.output === 'number' && cost.output === 0;
				if (free) {
					warnings.push(`roster: "${id}" cost-0 (free-tier-403 rule) — not a delegation candidate`);
				}
				if (st.reasoning === false) {
					warnings.push(`roster: "${id}" reasoning:false — not proven for tool loops`);
				}
			}
		}
	}
}

// Class taxonomy self-test: enum/detection coherence, probe↔delegation
// pattern-set agreement per shared class, one sample per class that
// classifies to itself under both classifiers.
function lintClasses(problems) {
	const classes = new Set(FAILURE_CLASSES);
	const probeClasses = new Set(Object.keys(PROBE_PATTERNS));

	for (const c of Object.keys(CLASS_DETECTION)) {
		if (!classes.has(c)) problems.push(`classes: CLASS_DETECTION key "${c}" not in FAILURE_CLASSES`);
	}
	for (const c of probeClasses) {
		if (!classes.has(c)) problems.push(`classes: PROBE_PATTERNS key "${c}" not in FAILURE_CLASSES`);
		const wantsProbe = (CLASS_DETECTION[c] || '').includes('probe');
		if (!wantsProbe) problems.push(`classes: "${c}" has PROBE_PATTERNS but CLASS_DETECTION lacks probe`);
	}
	for (const c of Object.keys(CLASS_DETECTION)) {
		if (CLASS_DETECTION[c].includes('probe') && !probeClasses.has(c)) {
			problems.push(`classes: "${c}" detection says probe but has no PROBE_PATTERNS entry`);
		}
	}
	for (const { cls } of DELEGATION_PATTERNS) {
		if (!classes.has(cls)) problems.push(`classes: DELEGATION_PATTERNS class "${cls}" not in FAILURE_CLASSES`);
	}

	// Pattern-set agreement per shared class (lowercased alternations).
	for (const c of probeClasses) {
		const entry = DELEGATION_PATTERNS.find((e) => e.cls === c);
		if (!entry) {
			problems.push(`classes: probe class "${c}" has no DELEGATION_PATTERNS entry`);
			continue;
		}
		const delegation = [...new Set(entry.pattern.source.split('|').map((a) => a.toLowerCase()))].sort().join('|');
		const probe = [...new Set(PROBE_PATTERNS[c])].sort().join('|');
		if (delegation !== probe) {
			problems.push(`classes: pattern sets disagree for "${c}": probe=[${probe}] delegation=[${delegation}]`);
		}
	}

	// Samples classify to their class.
	for (const [c, samples] of Object.entries(PROBE_SAMPLES)) {
		if (!probeClasses.has(c)) {
			problems.push(`classes: PROBE_SAMPLES key "${c}" is not a probe class`);
			continue;
		}
		for (const s of samples) {
			const got = classifyVerdict(s, 1, false);
			if (got !== c) problems.push(`classes: probe sample for "${c}" classifies as "${got}": ${JSON.stringify(s)}`);
		}
	}
	for (const [c, samples] of Object.entries(DELEGATION_SAMPLES)) {
		if (!classes.has(c)) {
			problems.push(`classes: DELEGATION_SAMPLES key "${c}" not in FAILURE_CLASSES`);
			continue;
		}
		for (const s of samples) {
			const got = classifyDelegation(s);
			if (got !== c) problems.push(`classes: delegation sample for "${c}" classifies as "${got}": ${JSON.stringify(s)}`);
		}
	}

	// Coverage: every class has samples on the routes it declares.
	for (const c of probeClasses) {
		if (!PROBE_SAMPLES[c]?.length) problems.push(`classes: probe class "${c}" has no PROBE_SAMPLES`);
	}
	for (const c of classes) {
		if (c !== 'other' && CLASS_DETECTION[c]?.includes('delegation') && !DELEGATION_SAMPLES[c]?.length) {
			problems.push(`classes: delegation class "${c}" has no DELEGATION_SAMPLES`);
		}
	}
	return { classCount: classes.size, probeCount: probeClasses.size, delegationCount: DELEGATION_PATTERNS.length };
}

async function lintAll(roster, rosterSet, paths, problems, warnings) {
	// Derived record (thinking-levels.json): missing degrades to a
	// warning (store+merge fallback in lintRoster); unparseable is a
	// problem — the record is the preferred truth and a corrupt one
	// must not read as absent.
	let derived = null;
	let derivedErr = null;
	try {
		derived = await readJson(paths.thinkingLevels);
	} catch (e) {
		derivedErr = e;
	}
	if (derivedErr && derivedErr?.code !== 'ENOENT') {
		problems.push('derive: assets/thinking-levels.json unparseable — fix or delete, then run scripts/derive.mjs');
	}
	// Catalog and models.json degrade independently: a missing
	// models.json skips only the modelOverrides merge (store-only
	// capability lint continues); a missing catalog skips capability
	// lint entirely.
	let catalog = new Map();
	let collisions = [];
	try {
		({ map: catalog, collisions } = flattenCatalog(await readJson(paths.catalog)));
	} catch (e) {
		warnings.push(`models-store.json unavailable (${e?.code === 'ENOENT' ? 'missing' : 'unparseable'}) — capability lint skipped; --catalog overrides the path`);
	}
	for (const c of collisions) {
		warnings.push(`catalog: id "${c.id}" listed under providers ${c.providers.join(' + ')} — first wins, provider ambiguous`);
	}
	let overrides = {};
	try {
		overrides = ((await readJson(paths.modelsConfig))?.providers?.[paths.defaultProvider]?.modelOverrides) || {};
	} catch (e) {
		warnings.push(`models.json unavailable (${e?.code === 'ENOENT' ? 'missing' : 'unparseable'}) — modelOverrides merge skipped; store-only checks continue`);
	}

	lintRoster(roster, catalog, overrides, derived, problems, warnings);

	let verdicts = null;
	try {
		verdicts = await readJson(paths.verdicts);
	} catch {
		problems.push('verdicts: assets/verdicts.json missing or unparseable — run scripts/check.mjs (default)');
	}
	if (verdicts) {
		if (typeof verdicts.revised !== 'string' || Number.isNaN(Date.parse(verdicts.revised))) {
			problems.push('verdicts: missing or invalid "revised" (ISO 8601 timestamp required)');
		}
		// Roster placement map: id -> sections ("archetype|picks",
		// "archetype|alt", "never|never"). A verdicts entry must sit in a
		// section the roster places its id in.
		const rosterPlaces = new Map();
		const place = (id, where) => {
			let s = rosterPlaces.get(id);
			if (!s) { s = new Set(); rosterPlaces.set(id, s); }
			s.add(where);
		};
		for (const a of roster?.archetypes || []) {
			for (const id of a.picks || []) place(id, `${a.archetype}|picks`);
			for (const id of a.alt || []) place(id, `${a.archetype}|alt`);
		}
		for (const e of roster?.never_delegate || []) place(e.id, 'never|never');

		const verdictIds = new Set();
		const seenAt = new Map(); // id -> Set(where) — duplicate detection
		const checkEntry = (e, where) => {
			if (!e?.id) {
				problems.push(`verdicts: entry without id in ${where}`);
				return;
			}
			verdictIds.add(e.id);
			let seen = seenAt.get(e.id);
			if (!seen) { seen = new Set(); seenAt.set(e.id, seen); }
			if (seen.has(where)) {
				problems.push(`verdicts: duplicate id "${e.id}" in ${where}`);
			} else {
				seen.add(where);
			}
			const places = rosterPlaces.get(e.id);
			if (!places) problems.push(`verdicts: id "${e.id}" (${where}) not in roster`);
			else if (!places.has(where)) problems.push(`verdicts: id "${e.id}" listed under ${where} but roster places it: ${[...places].join(', ')}`);
			if (!VERDICT_VALUES.has(e.verdict)) problems.push(`verdicts: id "${e.id}" bad verdict "${e.verdict}"`);
		};
		for (const [arche, row] of Object.entries(verdicts.archetypes || {})) {
			(row.picks || []).forEach((e) => checkEntry(e, `${arche}|picks`));
			(row.alt || []).forEach((e) => checkEntry(e, `${arche}|alt`));
		}
		for (const e of verdicts.never_delegate || []) checkEntry(e, 'never|never');

		// Archetype keys bidirectional: verdicts archetype sections ↔ roster archetypes.
		const rosterArchetypes = new Set((roster?.archetypes || []).map((a) => a.archetype));
		for (const arche of Object.keys(verdicts.archetypes || {})) {
			if (!rosterArchetypes.has(arche)) problems.push(`verdicts: archetype "${arche}" not in roster`);
		}
		for (const arche of rosterArchetypes) {
			if (!(verdicts.archetypes || {})[arche]) problems.push(`verdicts: roster archetype "${arche}" missing from verdicts`);
		}
		for (const id of rosterSet) {
			if (!verdictIds.has(id)) problems.push(`verdicts: roster id "${id}" missing from verdicts — refresh stale`);
		}

		// Catalog section (--full persistence): non-roster ids only.
		for (const [id, e] of Object.entries(verdicts.catalog || {})) {
			if (!e || typeof e !== 'object' || Array.isArray(e)) {
				problems.push(`verdicts: catalog entry "${id}" not an object`);
				continue;
			}
			if (rosterSet.has(id)) problems.push(`verdicts: catalog id "${id}" also in roster — belongs in archetype/never sections`);
			if (!VERDICT_VALUES.has(e.verdict)) problems.push(`verdicts: catalog id "${id}" bad verdict "${e.verdict}"`);
			if (catalog.size && !catalog.has(id)) warnings.push(`verdicts: catalog id "${id}" not in models-store — gone`);
		}
	}

	const tel = await readTelemetry(paths.telemetry, true);
	// Derived-record lint (assets/thinking-levels.json, scripts/derive.mjs):
	// shape, staleness, roster coverage. Per-id effective-map checks
	// live in lintRoster (derived record preferred, store+merge fallback).
	if (derived) {
		if (typeof derived.revised !== 'string' || Number.isNaN(Date.parse(derived.revised))) {
			problems.push('derive: thinking-levels.json missing or invalid "revised" (ISO 8601 timestamp required)');
		} else if (daysSince(derived.revised) >= CADENCE_DAYS) {
			warnings.push(`derive: record ${daysSince(derived.revised)}d old (>= ${CADENCE_DAYS}d) — re-run scripts/derive.mjs`);
		}
		if (!derived.models || typeof derived.models !== 'object' || Array.isArray(derived.models)) {
			problems.push('derive: "models" must be an object keyed by model id');
		} else {
			for (const [id, e] of Object.entries(derived.models)) {
				if (!e || typeof e !== 'object' || Array.isArray(e)) {
					problems.push(`derive: models["${id}"] not an object`);
				} else if (e.thinkingLevelMap != null && (typeof e.thinkingLevelMap !== 'object' || Array.isArray(e.thinkingLevelMap))) {
					problems.push(`derive: models["${id}"].thinkingLevelMap must be an object or null`);
				}
			}
			for (const id of rosterSet) {
				if (derived.models[id]) continue;
				const u = (derived.unavailable || []).find((x) => x?.id === id);
				warnings.push(u
					? `derive: roster id "${id}" derivation unavailable (${u.error || 'unknown'}) — re-run scripts/derive.mjs`
					: `derive: roster id "${id}" not in derived record — run scripts/derive.mjs`);
			}
		}
	} else if (!derivedErr) {
		warnings.push('derive: assets/thinking-levels.json missing — effective-map checks fall back to store+merge; run scripts/derive.mjs');
	}
	for (const b of tel.badRows) problems.push(`telemetry: line ${b.line}: ${b.err}`);
	for (const m of tel.missingKeys) problems.push(`telemetry: line ${m.line}: missing key(s) ${m.missing.join(', ')}`);
	for (const u of tel.unknownClass) problems.push(`telemetry: line ${u.line}: unknown failureClass "${u.value}"`);
	for (const b of tel.stopReasonBad) problems.push(`telemetry: line ${b.line}: stopReason must be a non-empty string (got ${JSON.stringify(b.value)})`);
	for (const u of tel.stopReasonUnknown) warnings.push(`telemetry: line ${u.line}: stopReason "${u.value}" outside known domain (${[...STOP_REASON_DOMAIN].join('|')}) — extend the domain if real`);
	for (const b of tel.badArtifactPolicy) problems.push(`telemetry: line ${b.line}: artifactPolicy must be "stopReason" or "artifacts" (got ${JSON.stringify(b.value)})`);
	for (const b of tel.badModelSource) problems.push(`telemetry: line ${b.line}: modelSource must be "pinned", "registry", or "default" (got ${JSON.stringify(b.value)})`);
	const legacy = Object.entries(tel.legacy).map(([k, n]) => `${k}=${n}`).join(', ');

	const cls = lintClasses(problems);

	console.log(`# check.mjs lint`);
	console.log(`telemetry rows: ${tel.rows.length}`);
	if (legacy) console.log(`legacy rows (field pre-adoption, tolerated): ${legacy}`);
	console.log(`class taxonomy: ${cls.classCount} classes; probe patterns ${cls.probeCount}; delegation patterns ${cls.delegationCount}; agreement + samples ok`);
	if (warnings.length) {
		console.log(`warnings: ${warnings.length}`);
		for (const w of warnings) console.log(`  - ${w}`);
	}
	if (problems.length) {
		console.log(`problems: ${problems.length}`);
		for (const p of problems) console.log(`  - ${p}`);
		process.exitCode = 1;
	} else {
		console.log('pass: roster/verdicts/telemetry/classes consistent');
	}
}

async function main() {
	const { flags, modes } = parseArgs(process.argv.slice(2), KNOWN_FLAGS, VALUE_FLAGS);
	const modeLint = modes.includes('--lint');
	const modeStatus = modes.includes('--status');
	const modeLive = modes.includes('--live');
	const full = modes.includes('--full');

	const scriptDir = path.dirname(new URL(import.meta.url).pathname);
	const skillDir = path.resolve(scriptDir, '..');
	const rosterPath = path.join(skillDir, 'assets/roster.json');

	const pathsCfg = await readJson(path.join(skillDir, 'assets/paths.json')); // missing = loud failure
	if (!Array.isArray(pathsCfg.probeCommand) || pathsCfg.probeCommand.length === 0) {
		console.error('paths.json: probeCommand must be a non-empty array');
		process.exit(1);
	}
	const paths = {
		catalog: flags.has('--catalog') ? expandTilde(flags.get('--catalog')) : expandTilde(pathsCfg.catalog),
		modelsConfig: flags.has('--models-config') ? expandTilde(flags.get('--models-config')) : expandTilde(pathsCfg.modelsConfig),
		telemetry: flags.has('--telemetry') ? expandTilde(flags.get('--telemetry')) : expandTilde(pathsCfg.telemetry),
		auth: flags.has('--auth') ? expandTilde(flags.get('--auth')) : expandTilde(pathsCfg.auth || '~/.pi/agent/auth.json'),
		liveModels: pathsCfg.liveModels || {},
		verdicts: path.join(skillDir, 'assets/verdicts.json'),
		thinkingLevels: path.join(skillDir, 'assets/thinking-levels.json'),
		defaultProvider: pathsCfg.defaultProvider || 'opencode',
		probeCommand: pathsCfg.probeCommand,
	};

	const roster = await readJson(rosterPath); // missing roster = loud failure
	const rosterSet = new Set([
		...(roster.archetypes || []).flatMap((a) => [...(a.picks || []), ...(a.alt || [])]),
		...(roster.never_delegate || []).map((x) => x.id),
	]);

	if (modeLint) {
		const problems = [];
		const warnings = [];
		await lintAll(roster, rosterSet, paths, problems, warnings);
		return;
	}

	let catalogFlat = null;
	let catalogErr = null;
	try {
		catalogFlat = flattenCatalog(await readJson(paths.catalog));
	} catch (e) {
		catalogErr = e;
	}
	const catalog = catalogFlat?.map ?? null;
	const collisions = catalogFlat?.collisions ?? [];
	const catalogIds = new Set(catalog ? Array.from(catalog.keys()).filter(firstParty) : []);
	// Retirement/listing scope: only ids the store lists under the default
	// provider — the liveModels URL is per-provider, so a cross-provider id
	// is never judged by another provider's listing (it keeps its probe
	// path, fail-open). Store-absent ids have no provider to check; the
	// default-provider listing decides them (the same assumption the probe
	// fallback makes).
	const onDefaultProvider = (id) =>
		!catalog || !catalog.has(id) || catalog.get(id).provider === paths.defaultProvider;

	let prior = null;
	try {
		prior = await readJson(paths.verdicts);
	} catch {}
	const priorCatalog = new Map(Object.entries(prior?.catalog || {}));
	// unprobed-new: first-party catalog ids outside the roster with NO
	// persisted catalog-section verdict — never probed/decided at all. A
	// prior 'indeterminate' was probed (inconclusively) — not unprobed.
	const unprobedNew = Array.from(catalogIds)
		.filter((id) => !rosterSet.has(id) && !priorCatalog.get(id))
		.sort();
	// Live provider listing — fetched for --live, --status, and refresh
	// (retired detection); --lint stays offline. Fail-soft: ids null on
	// any failure and every consumer degrades to store-only behavior.
	const live = await liveListing(paths, catalog);
	// 'gone' checks the unfiltered catalog map — a roster id listed under
	// any provider is present; firstParty filtering is for new-id discovery.
	// Live-aware: an id present in the live list (store lags behind it) is
	// not gone; live unavailable → store-only, as before.
	const gone = catalog
		? Array.from(rosterSet).filter((id) => !catalog.has(id) && !live.ids?.has(id)).sort()
		: [];

	if (modeLive) {
		console.log(`# check.mjs report (live — read-only)`);
		if (live.ids) {
			console.log(`live: ${live.url} — ${live.ids.size} ids (provider ${paths.defaultProvider})`);
			if (catalog) {
				console.log(`store diff (first-party): store-only=${live.storeOnly.length}, live-only=${live.liveOnly.length}`);
				if (live.storeOnly.length) console.log(`  store-only (retired — in store, absent live): ${live.storeOnly.join(', ')}`);
				if (live.liveOnly.length) console.log(`  live-only (in live, absent store): ${live.liveOnly.join(', ')}`);
			} else {
				console.log('store diff: skipped — catalog unavailable; --catalog overrides the path');
			}
			const rosterAbsent = Array.from(rosterSet)
				.filter((id) => onDefaultProvider(id) && !live.ids.has(id))
				.sort();
			if (rosterAbsent.length) console.log(`roster absent live (retired verdicts on next refresh): ${rosterAbsent.join(', ')}`);
		} else {
			console.log(`live: skipped — ${live.note}`);
		}
		console.log('no probes run, verdicts not written');
		return;
	}

	const tel = await readTelemetry(paths.telemetry);
	const stats = telemetryStats(tel.rows);
	const flagsOut = reRankFlags(stats);

	const rowsSince = countRowsAfter(tel.rows, prior?.revised || null);
	const ageDays = daysSince(prior?.revised || null);
	const cadenceDue = !prior || rowsSince >= CADENCE_ROWS || ageDays >= CADENCE_DAYS;

	if (modeStatus) {
		console.log(`# check.mjs report (status — read-only)`);
		console.log(`verdicts: ${paths.verdicts}`);
		console.log(prior?.revised
			? `revised: ${prior.revised} (${ageDays}d old)`
			: 'revised: (no verdicts — run default refresh)');
		// Live diff leads — store ⊇ live: a stale store keeps retired ids
		// (checkedAt age is a weak freshness signal; the live list is
		// availability truth). Fail-soft: no key / network degrades to
		// store-only output below.
		if (live.ids) {
			console.log(`live diff (${live.url}): live=${live.ids.size}, store-only=${live.storeOnly.length}, live-only=${live.liveOnly.length}`);
			if (live.storeOnly.length) console.log(`  store-only (retired — in store, absent live): ${live.storeOnly.join(', ')}`);
			if (live.liveOnly.length) console.log(`  live-only (in live, absent store): ${live.liveOnly.join(', ')}`);
			const neverRetired = (roster.never_delegate || [])
				.map((x) => x.id)
				.filter((id) => onDefaultProvider(id) && !live.ids.has(id));
			if (neverRetired.length) console.log(`  never_delegate absent live (retires on next refresh): ${neverRetired.join(', ')}`);
		} else {
			console.log(`live diff: skipped — ${live.note}`);
		}
		if (catalogErr) {
			console.log(`catalog diff: skipped — catalog unavailable (${catalogErr?.code === 'ENOENT' ? 'missing' : 'unparseable'}); --catalog overrides the path`);
		} else {
			console.log(`catalog diff (first-party): unprobed-new=${unprobedNew.length}, gone=${gone.length}`);
			if (unprobedNew.length) console.log(`  unprobed-new: ${unprobedNew.join(', ')}`);
			if (gone.length) console.log(`  gone: ${gone.join(', ')}`);
		}
		if (collisions.length) {
			console.log(`catalog id collisions (first provider wins): ${collisions.length}`);
			for (const c of collisions) console.log(`  - ${c.id}: ${c.providers.join(' + ')}`);
		}
		if (priorCatalog.size) console.log(`catalog verdicts persisted (verdicts catalog section, --full): ${priorCatalog.size}`);
		console.log(`cadence: rowsSinceLastRevision=${rowsSince}, daysSinceLastRevision=${ageDays}, due=${cadenceDue}`);

		// Thinking-map derivation state + managed-block drift. Zero
		// spawns — pure store/roster/models.json reads; the policy is
		// single-sourced in ./shared.mjs (derive.mjs is the writer,
		// --status the reporter; the two must never disagree). Missing
		// and corrupt files are reported distinctly — corruption must
		// never read as absence.
		let levels = null;
		let levelsErr = null;
		try {
			levels = await readJson(paths.thinkingLevels);
		} catch (e) {
			levelsErr = e;
		}
		if (levelsErr && levelsErr?.code !== 'ENOENT') {
			console.log('thinking maps: derived record unparseable — fix or delete, then run scripts/derive.mjs');
		} else if (!levels || levelsErr) {
			console.log('thinking maps: derived record missing — run scripts/derive.mjs');
		} else if (!levels.models || typeof levels.models !== 'object' || Array.isArray(levels.models)) {
			console.log('thinking maps: record malformed ("models" not an object) — re-run scripts/derive.mjs');
		} else if (typeof levels.revised !== 'string' || Number.isNaN(Date.parse(levels.revised))) {
			console.log('thinking maps: record "revised" invalid (ISO 8601 required) — re-run scripts/derive.mjs');
		} else {
			const lvlDays = daysSince(levels.revised);
			console.log(`thinking maps: record revised ${levels.revised} (${lvlDays}d old), ${Object.keys(levels.models).length} ids derived${lvlDays >= CADENCE_DAYS ? ' — stale, derive due' : ''}`);
			const notDerived = Array.from(rosterSet).filter((id) => !levels.models[id]);
			if (notDerived.length) {
				const errs = notDerived.map((id) => {
					const u = (levels.unavailable || []).find((x) => x?.id === id);
					return u ? `${id} (${u.error})` : id;
				});
				console.log(`  roster coverage: ${rosterSet.size - notDerived.length}/${rosterSet.size} (not derived: ${errs.join(', ')}) — run scripts/derive.mjs`);
			}
		}
		if (!catalog) {
			console.log('managed modelOverrides: drift check skipped — catalog unavailable');
		} else {
			let cfg = null;
			let cfgErr = null;
			try {
				cfg = await readJson(paths.modelsConfig);
			} catch (e) {
				cfgErr = e;
			}
			if (cfgErr && cfgErr?.code !== 'ENOENT') {
				console.log('managed modelOverrides: models.json unparseable — a derive run fails on it; fix the file');
			} else if (cfg !== null && (typeof cfg !== 'object' || Array.isArray(cfg))) {
				console.log('managed modelOverrides: models.json root malformed — a derive run fails on it; fix the file');
			} else {
				const priorManaged = cfg?.providers?.[paths.defaultProvider]?.modelOverrides ?? null;
			const policy = managedOverridesPolicy(rosterSet, catalog, priorManaged, paths.defaultProvider);
				const counts = ` (policy: ${Object.keys(policy.nextManaged).length} entries — ${Object.keys(policy.generated).length} generated, ${Object.keys(policy.retained).length} retained)`;
				if (policy.malformedPrior) console.log(`managed modelOverrides: block malformed (not an object) — a derive run replaces it${counts}`);
				else if (policy.drift) console.log(`managed modelOverrides: DRIFT — run scripts/derive.mjs${counts}`);
				else console.log(`managed modelOverrides: no drift${counts}`);
				for (const d of policy.dropped) console.log(`  - stale ${d.id}: ${d.reason} (a derive run drops it)`);
				for (const id of policy.replaced) console.log(`  - hand-edited entry for generated id "${id}" — a derive run overwrites it (canonical patch)`);
				for (const id of policy.nonCanonical) console.log(`  - non-canonical retained entry "${id}" — kept verbatim, reported`);
			}
		}

		printFlags(flagsOut);
		if (stats.harnessFailures) {
			console.log(`telemetry harness failures (spawn-enoent — excluded from re-rank stats): ${stats.harnessFailures}`);
		}
		console.log('no probes run, verdicts not written');
		return;
	}
	if (!catalog) throw catalogErr;

	// ---- refresh: probe, rewrite verdicts ----
	const probeIdsAll = full ? Array.from(catalogIds) : Array.from(rosterSet);
	// Retirement scope: see onDefaultProvider above.
	// Retired-by-listing: ids absent from the live /models listing are
	// fresh truth — no probe ($0), a synthetic hard 'retired' verdict.
	// Fail-open: no live (no key / network) probes everything as before.
	const retiredIds = live.ids
		? probeIdsAll.filter((id) => onDefaultProvider(id) && !live.ids.has(id))
		: [];
	// Everything not retired is probed — including cross-provider ids
	// (their provider listing was never fetched; fail open by probing).
	const retiredSet = new Set(retiredIds);
	const probeIds = probeIdsAll.filter((id) => !retiredSet.has(id));
	const probes = await runPool(
		probeIds,
		async (id) => probeModel(catalog.get(id)?.provider || paths.defaultProvider, id, paths.probeCommand),
		MAX_PARALLEL,
	);
	// Fail-closed: widespread spawn failures mean the probe harness is
	// broken (pi binary unresolvable) — abort without writing; a failed
	// refresh must be distinguishable from a clean one.
	const spawnErrors = probes.filter((p) => p.spawnError).length;
	if (spawnErrors > 0 && spawnErrors >= Math.ceil(probes.length * SPAWN_ERROR_ABORT_FRACTION)) {
		console.error(`refresh aborted: ${spawnErrors}/${probes.length} probes failed to spawn — probe harness broken; verdicts not written`);
		process.exit(1);
	}
	const verdictById = new Map(probes.map((p) => [p.id, p]));
	const priorVerdictById = new Map();
	for (const entry of prior?.never_delegate || []) priorVerdictById.set(entry.id, entry.verdict);
	for (const arche of Object.values(prior?.archetypes || {})) {
		for (const e of [...(arche.picks || []), ...(arche.alt || [])]) {
			priorVerdictById.set(e.id, e.verdict);
		}
	}
	for (const [id, e] of Object.entries(prior?.catalog || {})) priorVerdictById.set(id, e.verdict);

	const nowIso = new Date().toISOString();
	// Retired-by-listing: synthetic hard verdicts — the probe loop never
	// saw these ids (absent from the live /models listing).
	for (const id of retiredIds) verdictById.set(id, { id, verdict: 'retired', probed: nowIso });
	let retainedOnInconclusive = 0;
	// Hysteresis: a hard verdict (reachable or failure class) is fresh
	// truth and always wins. 'indeterminate' is transient (timeout /
	// spawn error / unmatched exit) — it never overwrites a prior verdict.
	const mark = (id, note) => {
		const probe = verdictById.get(id);
		const prev = priorVerdictById.get(id);
		let verdict;
		if (probe) {
			if (HARD_VERDICTS.has(probe.verdict)) {
				verdict = probe.verdict;
			} else if (prev) {
				verdict = prev;
				retainedOnInconclusive += 1;
			} else {
				verdict = 'indeterminate';
			}
		} else {
			verdict = prev || 'indeterminate';
		}
		const entry = { id, verdict, probed: probe?.probed || nowIso };
		if (note) entry.note = note;
		return entry;
	};

	const archetypes = {};
	for (const row of roster.archetypes || []) {
		archetypes[row.archetype] = {
			picks: row.picks.map((id) => mark(id)),
			alt: row.alt.map((id) => mark(id)),
		};
	}

	const never_delegate = (roster.never_delegate || []).map((entry) => mark(entry.id, entry.note));

	// --full persists non-roster first-party verdicts (verdicts catalog section) so
	// new-candidate state survives the run; retired ids persist too (synthetic
	// verdicts — F1 review: they must not vanish on a full run). A default
	// refresh retains the prior section verbatim (ids that moved into the
	// roster drop out). --status excludes catalog ids with any persisted
	// verdict from unprobed-new.
	const catalogSection = {};
	if (full) {
		for (const id of probeIdsAll) {
			if (rosterSet.has(id)) continue;
			catalogSection[id] = mark(id);
		}
	} else {
		for (const [id, e] of Object.entries(prior?.catalog || {})) {
			if (!rosterSet.has(id)) catalogSection[id] = e;
		}
	}

	const nextVerdicts = {
		revised: nowIso,
		provider: paths.defaultProvider,
		archetypes,
		never_delegate,
		catalog: catalogSection,
		notes: 'Roster: assets/roster.json (tracked, hand-curated). Verdicts + probed timestamps regenerated per machine by scripts/check.mjs. Rankings are priors (n=1 origin); telemetry flags (--status, min 3 writer rows) are the re-rank review path. Indeterminate probes retain prior verdicts (hysteresis). retired: id absent from the live /models listing (check.mjs --live; fail-open when the live list is unavailable). catalog: non-roster first-party verdicts from --full runs, retained on default refresh.',
	};

	const changedById = new Map();
	const nextEntries = [
		...never_delegate.map((x) => [x.id, x.verdict]),
		...Object.values(archetypes).flatMap((row) => [...row.picks, ...row.alt].map((x) => [x.id, x.verdict])),
		...(full ? Object.entries(catalogSection).map(([id, e]) => [id, e.verdict]) : []),
	];
	for (const [id, verdict] of nextEntries) {
		const prev = priorVerdictById.get(id);
		if (prev && prev !== verdict && !changedById.has(id)) changedById.set(id, { id, from: prev, to: verdict });
	}
	const changed = Array.from(changedById.values());

	await fs.mkdir(path.dirname(paths.verdicts), { recursive: true });
	// Atomic write: tmp + rename — no half-written verdicts on a mid-write crash.
	const tmpVerdicts = `${paths.verdicts}.tmp`;
	await fs.writeFile(tmpVerdicts, `${JSON.stringify(nextVerdicts, null, 2)}\n`, 'utf8');
	await fs.rename(tmpVerdicts, paths.verdicts);

	console.log(`# check.mjs report (refresh${full ? ', full' : ''})`);
	console.log(`probed: ${probes.length}${spawnErrors ? ` (spawn errors: ${spawnErrors})` : ''}`);
	if (retiredIds.length) console.log(`retired-by-live (absent from the live listing, no probe): ${retiredIds.length} (${retiredIds.join(', ')})`);
	console.log(`changed verdicts: ${changed.length}`);
	for (const c of changed) console.log(`  - ${c.id}: ${c.from} -> ${c.to}`);
	console.log(`retained priors on inconclusive probe (hysteresis): ${retainedOnInconclusive}`);
	console.log(`catalog diff (first-party): unprobed-new=${unprobedNew.length}, gone=${gone.length}`);
	if (unprobedNew.length) console.log(`  unprobed-new: ${unprobedNew.join(', ')}`);
	if (gone.length) console.log(`  gone: ${gone.join(', ')}`);
	if (collisions.length) {
		console.log(`catalog id collisions (first provider wins): ${collisions.length}`);
		for (const c of collisions) console.log(`  - ${c.id}: ${c.providers.join(' + ')}`);
	}
	if (full) console.log(`catalog section: ${Object.keys(catalogSection).length} non-roster verdicts persisted`);
	console.log(`cadence (vs prior revision): rowsSinceLastRevision=${rowsSince}, daysSinceLastRevision=${ageDays}, due=${cadenceDue}`);
	printFlags(flagsOut);
	if (stats.harnessFailures) {
		console.log(`telemetry harness failures (spawn-enoent — excluded from re-rank stats): ${stats.harnessFailures}`);
	}
	console.log(`verdicts written: ${paths.verdicts} (revised ${nowIso})`);
}

main().catch((err) => {
	console.error('operational failure:', err?.stack || err?.message || String(err));
	process.exit(1);
});
