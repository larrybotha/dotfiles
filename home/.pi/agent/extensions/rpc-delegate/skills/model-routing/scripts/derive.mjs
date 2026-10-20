#!/usr/bin/env node
// Model-routing thinking-map derivation + managed modelOverrides.
//
// Modes:
//   (default)  derive the effective thinkingLevelMap for every roster
//              + first-party catalog id via RPC `get_state` (spawn +
//              handshake only — zero tokens, ~1-2 s per model), persist
//              assets/thinking-levels.json (per-machine, gitignored),
//              and regenerate the skill-managed
//              providers.<defaultProvider>.modelOverrides block in
//              models.json.
//   --dry-run  no writes; report what a default run would write;
//              exit 1 on models.json drift (stale or missing block).
//
// Write order (a default run): derivation pass first — every fail-
// closed abort (spawn-fraction, zero-derived) happens before any
// write; then the managed block (if drifting); then re-derivation of
// the ids the block newly patched — get_state must observe the
// post-write world, or the persisted record would describe a
// pre-patch one; then the record. Fail-closed abort = nothing
// written, prior record preserved.
//
// Ownership split (models.json):
//   - user-managed: everything except the managed block — local
//     provider definitions (e.g. ollama) and all other provider blocks
//     are preserved verbatim. Deleting models.json entirely is user
//     loss on those blocks (documented); the script recreates the file
//     with the managed block only. A non-object root or an unparseable
//     file is never clobbered (loud failure).
//   - skill-managed: providers.<defaultProvider>.modelOverrides — a
//     generated artifact. Policy (generated / retained / dropped /
//     replaced / nonCanonical / drift) is single-sourced in
//     ./shared.mjs with check.mjs --status (the drift reporter); the
//     two must never disagree. Deleting the block self-heals on the
//     next run; regeneration is idempotent (canonical compare).
//
// Flags:
//   --catalog <path>        override catalog location (default paths.json)
//   --models-config <path>  override models config location
//   --dry-run               read-only; no writes; exit 1 on drift
//   Unknown flags or stray arguments exit 2 — a typo must never reach
//   a models.json write.
//
// RPC spawn template comes from assets/paths.json `rpcCommand`
// ({provider}/{id} placeholders; tilde paths). stdout is parsed with
// strict LF framing (never Node readline — U+2028/U+2029 are valid
// inside JSON strings); a child's final record without a trailing LF
// is drained at close. EPIPE on a dead child's stdin is swallowed (the
// close listener owns the verdict). check.mjs --lint validates the
// persisted record against the roster.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
const EXIT_GRACE_MS = 5_000;
const MAX_PARALLEL = 5;
const SPAWN_ERROR_ABORT_FRACTION = 0.25;
const KNOWN_FLAGS = new Set(['--dry-run', '--catalog', '--models-config']);
const VALUE_FLAGS = new Set(['--catalog', '--models-config']);

const missing = (e) => e?.code === 'ENOENT';

// Atomic write: tmp (pid-suffixed, never colliding between concurrent
// runs) + rename. The target is realpath-resolved first — a symlinked
// models.json keeps its link; the real file behind it is replaced.
async function atomicWriteJson(file, obj) {
	let target = file;
	try {
		target = await fs.realpath(file);
	} catch (e) {
		if (!missing(e)) throw e;
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
	await fs.rename(tmp, target);
	return target;
}

// One RPC child: spawn, get_state, extract the effective
// thinkingLevelMap (store + modelOverrides merge — the only zero-token
// channel that reflects the merged map; --list-models shows yes/no,
// --print probes clamp silently).
function deriveModel(provider, id, cmdTemplate) {
	const [bin, ...rest] = cmdTemplate;
	const args = rest.map((t) => String(t).replaceAll('{provider}', provider).replaceAll('{id}', id));
	return new Promise((resolve) => {
		const cmdId = 'tl-1';
		const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let done = false;
		let buf = '';
		let stderrTail = '';

		const finish = (result) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try { child.stdin?.end(); } catch {}
			// Orderly shutdown was requested via stdin end; SIGKILL after a
			// grace so lingering children never accumulate. get_state has
			// no side effects — nothing is lost.
			const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, EXIT_GRACE_MS);
			kill.unref?.();
			resolve({ id, provider, ts: new Date().toISOString(), ...result });
		};

		const timer = setTimeout(() => {
			finish({ verdict: 'timeout', error: `no get_state response within ${TIMEOUT_MS}ms (stderr: ${stderrTail.slice(-300) || 'none'})` });
		}, TIMEOUT_MS);
		timer.unref?.();

		// EPIPE on a child that died before the write lands — the close
		// listener owns the verdict; an unhandled stream 'error' would
		// otherwise crash the whole run.
		child.stdin?.on('error', () => {});

		child.on('error', (err) => {
			// pre-spawn failure (ENOENT etc.) — harness state, not model state
			finish({ verdict: 'spawn-error', error: String(err?.message || err), spawnError: true });
		});

		// One record. Returns true when it settled the child.
		const onRecord = (lineRaw) => {
			let line = lineRaw;
			if (line.endsWith('\r')) line = line.slice(0, -1);
			if (!line.trim()) return false;
			let rec;
			try { rec = JSON.parse(line); } catch { return false; }
			if (rec?.id !== cmdId || rec.type !== 'response') return false;
			if (rec.success !== true) {
				finish({ verdict: 'rejected', error: String(rec.error || 'get_state failed') });
				return true;
			}
			const model = rec.data?.model;
			if (!model || typeof model !== 'object') {
				finish({ verdict: 'no-model', error: 'get_state returned no model object' });
				return true;
			}
			const tlm = model.thinkingLevelMap;
			finish({ verdict: 'ok', thinkingLevelMap: tlm && typeof tlm === 'object' && !Array.isArray(tlm) ? tlm : null });
			return true;
		};

		// LF framing only — U+2028/U+2029 are valid inside JSON strings.
		child.stdout?.on('data', (d) => {
			buf += d.toString();
			let i;
			while ((i = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (onRecord(line)) return;
			}
		});

		// 'close' (not 'exit'): stdio drained first, so a fast-exiting
		// child's final record is seen; leftover buf without a trailing
		// LF is drained once.
		child.on('close', (code) => {
			if (done) return;
			if (buf.trim()) onRecord(buf);
			if (done) return;
			finish({ verdict: 'exited', error: `child exited before responding (code ${code ?? 'null'}, stderr: ${stderrTail.slice(-300) || 'none'})` });
		});

		child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-800); });

		// Send immediately — the pipe buffers until the child boots; no
		// boot-race to win.
		try {
			child.stdin.write(`${JSON.stringify({ id: cmdId, type: 'get_state' })}\n`);
		} catch (err) {
			finish({ verdict: 'spawn-error', error: String(err?.message || err), spawnError: true });
		}
	});
}

async function main() {
	const { flags, modes } = parseArgs(process.argv.slice(2), KNOWN_FLAGS, VALUE_FLAGS);
	const dryRun = modes.includes('--dry-run');

	const scriptDir = path.dirname(new URL(import.meta.url).pathname);
	const skillDir = path.resolve(scriptDir, '..');
	const pathsCfg = await readJson(path.join(skillDir, 'assets/paths.json')); // missing = loud failure
	if (!Array.isArray(pathsCfg.rpcCommand) || pathsCfg.rpcCommand.length === 0) {
		console.error('paths.json: rpcCommand must be a non-empty array');
		process.exit(1);
	}
	const defaultProvider = pathsCfg.defaultProvider || 'opencode';
	const paths = {
		catalog: flags.has('--catalog') ? expandTilde(flags.get('--catalog')) : expandTilde(pathsCfg.catalog),
		modelsConfig: flags.has('--models-config') ? expandTilde(flags.get('--models-config')) : expandTilde(pathsCfg.modelsConfig),
		thinkingLevels: path.join(skillDir, 'assets/thinking-levels.json'),
	};

	const roster = await readJson(path.join(skillDir, 'assets/roster.json')); // missing = loud failure
	const rosterSet = new Set([
		...((roster.archetypes || []).flatMap((a) => [...(a.picks || []), ...(a.alt || [])])),
		...(roster.never_delegate || []).map((x) => x.id),
	]);

	const { map: catalog, collisions } = flattenCatalog(await readJson(paths.catalog)); // missing = loud failure
	for (const c of collisions) {
		console.error(`catalog: id "${c.id}" listed under providers ${c.providers.join(' + ')} — first wins, provider ambiguous`);
	}
	const firstPartyIds = Array.from(catalog.keys()).filter(firstParty);
	const deriveIds = [...new Set([...rosterSet, ...firstPartyIds])].sort();
	const providerOf = (id) => catalog.get(id)?.provider || defaultProvider;

	console.log(`# derive.mjs report (derive${dryRun ? ', dry-run' : ''})`);
	console.log(`derive set: ${deriveIds.length} (roster ${rosterSet.size}, catalog first-party ${firstPartyIds.length})`);

	// ---- models.json read + managed-block policy ----
	// Needs no spawns (store + roster + prior block only), so the drift
	// verdict is known before any child boots.
	let curCfg = null;
	try {
		curCfg = await readJson(paths.modelsConfig);
	} catch (e) {
		if (!missing(e)) throw e; // unparseable models.json is never clobbered
	}
	// null root = absent-but-valid (recreate path); any other non-object
	// root is a corrupt file — loud failure, never written.
	if (curCfg !== null && (typeof curCfg !== 'object' || Array.isArray(curCfg))) {
		throw new Error(`models.json root is not an object (${Array.isArray(curCfg) ? 'array' : typeof curCfg}) — fix the file; never clobbered`);
	}
	const priorManaged = curCfg?.providers?.[defaultProvider]?.modelOverrides ?? null;
	const policy = managedOverridesPolicy(rosterSet, catalog, priorManaged, defaultProvider);
	const { generated, retained, dropped, replaced, nonCanonical, nextManaged } = policy;
	const modelsJsonDrift = policy.drift;
	const recreate = !curCfg && modelsJsonDrift;

	// ---- derivation pass 1 (pre-write truth) ----
	const results = await runPool(
		deriveIds,
		async (id) => deriveModel(providerOf(id), id, pathsCfg.rpcCommand),
		MAX_PARALLEL,
	);

	// Fail-closed: widespread spawn failures mean the harness is broken;
	// zero-derived means the same by another route (all timeouts /
	// exits / rejections). Either aborts without a write — a failed
	// derivation must never look like a clean one, and the prior record
	// is preserved.
	const spawnErrors = results.filter((r) => r.spawnError).length;
	if (spawnErrors > 0 && spawnErrors >= Math.ceil(results.length * SPAWN_ERROR_ABORT_FRACTION)) {
		console.error(`derive aborted: ${spawnErrors}/${results.length} children failed to spawn — harness broken; nothing written`);
		process.exit(1);
	}

	const byId = new Map(results.map((r) => [r.id, r]));
	const models = {};
	const unavailable = [];
	for (const id of deriveIds) {
		const r = byId.get(id);
		if (r?.verdict === 'ok') {
			models[id] = { provider: r.provider, derived: r.ts, thinkingLevelMap: r.thinkingLevelMap };
		} else if (r) {
			unavailable.push({ id, provider: r.provider, error: r.error });
		}
	}
	const mapPresent = Object.values(models).filter((m) => m.thinkingLevelMap).length;

	if (Object.keys(models).length === 0 && deriveIds.length > 0) {
		console.error(`derive aborted: 0/${deriveIds.length} ids derived (all timeouts/exits/rejections) — harness broken or account-wide failure; nothing written, prior record preserved`);
		process.exit(1);
	}

	console.log(`derived ok: ${Object.keys(models).length}/${deriveIds.length} (thinkingLevelMap present: ${mapPresent}, absent: ${Object.keys(models).length - mapPresent})`);
	if (unavailable.length) {
		console.log(`unavailable: ${unavailable.length}`);
		for (const u of unavailable) console.log(`  - ${u.id} (${u.provider}): ${u.error}`);
	}
	if (spawnErrors) console.log(`spawn errors: ${spawnErrors}`);

	console.log(`managed modelOverrides: generated=${Object.keys(generated).length}${Object.keys(generated).length ? ` [${Object.keys(generated).sort().join(', ')}]` : ''}, retained=${Object.keys(retained).length}${Object.keys(retained).length ? ` [${Object.keys(retained).sort().join(', ')}]` : ''}, dropped=${dropped.length}${replaced.length ? `, replaced hand-edited=${replaced.length} [${replaced.sort().join(', ')}]` : ''}${nonCanonical.length ? `, non-canonical retained (verbatim)=${nonCanonical.length} [${nonCanonical.sort().join(', ')}]` : ''}${policy.malformedPrior ? ', block malformed — replaced wholesale' : ''}`);
	for (const d of dropped) console.log(`  - dropped ${d.id}: ${d.reason}`);
	console.log(`models.json: ${dryRun ? (modelsJsonDrift ? 'DRIFT' : 'no drift') : (recreate ? 'recreated with managed block only (user-managed provider blocks lost — local providers are not the skill\'s to regenerate)' : modelsJsonDrift ? 'managed block rewritten (user blocks untouched)' : 'unchanged')}`);

	if (dryRun) {
		if (modelsJsonDrift) {
			console.log('dry-run: models.json drift (managed block stale, missing-with-content, or malformed) — default run would write; exit 1');
			process.exit(1);
		}
		console.log('dry-run: no drift — default run would only refresh thinking-levels.json');
		return;
	}

	// ---- writes (atomic: realpath tmp + rename) ----
	if (modelsJsonDrift) {
		const nextCfg = structuredClone(curCfg ?? {});
		nextCfg.providers = { ...(nextCfg.providers ?? {}) };
		nextCfg.providers[defaultProvider] = { ...(nextCfg.providers[defaultProvider] ?? {}) };
		nextCfg.providers[defaultProvider].modelOverrides = nextManaged;
		await atomicWriteJson(paths.modelsConfig, nextCfg);
	}

	// ---- derivation pass 2 (post-write truth) ----
	// Pass 1 spawned against the pre-write world; ids the block newly
	// patched (or will patch) must be re-read, or the record would
	// describe pre-patch maps. Failures are reported, not fatal — the
	// pass-1 entry stays (true for the world it observed) and the next
	// run verifies.
	const patchIds = Object.keys(nextManaged).filter((id) => {
		const m = models[id];
		return !m || (m.thinkingLevelMap && !('off' in m.thinkingLevelMap));
	});
	let reDerived = 0;
	let reFailed = [];
	if (modelsJsonDrift && patchIds.length) {
		const reResults = await runPool(
			patchIds,
			async (id) => deriveModel(providerOf(id), id, pathsCfg.rpcCommand),
			MAX_PARALLEL,
		);
		for (const r of reResults) {
			if (r?.verdict === 'ok') {
				models[r.id] = { provider: r.provider, derived: r.ts, thinkingLevelMap: r.thinkingLevelMap };
				reDerived += 1;
			} else {
				reFailed.push(r?.id);
			}
		}
	}
	if (modelsJsonDrift) {
		console.log(`post-write re-derivation (patch-affected ids): ${reDerived}/${patchIds.length} re-read${reFailed.length ? `, failed (pass-1 entries retained): ${reFailed.join(', ')}` : ''}`);
	}

	const nowIso = new Date().toISOString();
	const record = {
		revised: nowIso,
		provider: defaultProvider,
		models,
		unavailable,
		notes: 'Effective thinkingLevelMap per model id, derived live via RPC get_state (spawn + handshake, zero tokens) by scripts/derive.mjs. Per-machine, gitignored. thinkingLevelMap null = model has no map (no thinking, no 400 risk). unavailable entries carry the spawn/timeout/rejection error. Patch-affected ids are re-derived after the models.json write so entries reflect post-patch state. check.mjs --lint prefers this record over the store+modelOverrides estimate.',
	};
	await atomicWriteJson(paths.thinkingLevels, record);

	console.log(`thinking-levels.json written: ${paths.thinkingLevels} (revised ${nowIso})`);
}

main().catch((err) => {
	console.error('operational failure:', err?.stack || err?.message || String(err));
	process.exit(1);
});
