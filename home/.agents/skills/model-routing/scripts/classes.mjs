/** Failure-class taxonomy — single source for the model-routing skill
 *  (scripts/check.mjs) and the rpc-delegate extension (imported as the
 *  `model-routing-classes` file: dependency from the extensions
 *  package.json). Edit here; both consumers pick changes up on next run.
 *
 *  PROBE_PATTERNS match lowercased combined probe stdout+stderr
 *  (check.mjs classifyVerdict). DELEGATION_PATTERNS match the
 *  extension's combined failure surfaces (classifyFailure); order
 *  matters — first match wins. Alternations must agree (lowercased)
 *  between the two sets for shared classes; check.mjs --lint enforces
 *  that plus one sample per class. */

export const FAILURE_CLASSES = Object.freeze([
	'thinking-map-400',
	'access-403',
	'endpoint-410',
	'free-tier-403',
	'param-400',
	'unavailable-400',
	'other',
]);

/** Detection route per class:
 *  - metadata:   models-store/models.json lint (never probe-classifiable)
 *  - probe:      probe output classification
 *  - delegation: rpc child failure surfaces (telemetry)
 *  `other` is the delegation-side fallback; probes never emit it. */
export const CLASS_DETECTION = Object.freeze({
	'thinking-map-400': 'metadata+delegation',
	'access-403': 'probe+delegation',
	'endpoint-410': 'probe+delegation',
	'free-tier-403': 'probe+delegation',
	'param-400': 'probe+delegation',
	'unavailable-400': 'probe+delegation',
	other: 'delegation',
});

/** Probe-side substrings (lowercase). First matching class wins. */
export const PROBE_PATTERNS = Object.freeze({
	'access-403': Object.freeze(['model access is disabled']),
	'endpoint-410': Object.freeze(['endpoint unavailable', 'has been deprecated', 'modeldeprecated']),
	'free-tier-403': Object.freeze(['freetiererror', 'free tier']),
	'param-400': Object.freeze(['does not support parameter', 'unsupported parameter', 'reasoningeffort']),
	'unavailable-400': Object.freeze(['model is unavailable']),
});

/** Delegation-side regexes. The extension's classifyFailure iterates
 *  these in order; first match wins. */
export const DELEGATION_PATTERNS = Object.freeze([
	Object.freeze({ cls: 'free-tier-403', pattern: /FreeTierError|free tier/i }),
	Object.freeze({ cls: 'access-403', pattern: /Model access is disabled/i }),
	Object.freeze({ cls: 'endpoint-410', pattern: /Endpoint unavailable|has been deprecated|ModelDeprecated/i }),
	Object.freeze({ cls: 'param-400', pattern: /does not support parameter|unsupported parameter|reasoningEffort/i }),
	Object.freeze({ cls: 'unavailable-400', pattern: /Model is unavailable/i }),
	Object.freeze({ cls: 'thinking-map-400', pattern: /thinking[^\n]{0,60}disabled|disabled[^\n]{0,60}thinking/i }),
]);

/** One sample per class; --lint classifies each and fails on mismatch. */
export const PROBE_SAMPLES = Object.freeze({
	'access-403': Object.freeze(['Error: Model access is disabled for gpt-5.6-sol']),
	'endpoint-410': Object.freeze([
		'Error: Endpoint unavailable for kimi-k2.7-code',
		'Error: Model exo-free has been deprecated.',
		'ModelDeprecated: kimi-k2.7-code',
	]),
	'free-tier-403': Object.freeze(['FreeTierError: the free tier is app-only']),
	'param-400': Object.freeze([
		'Error: model does not support parameter reasoningEffort',
		'Error: unsupported parameter temperature',
	]),
	'unavailable-400': Object.freeze(['Error: Model is unavailable']),
});

export const DELEGATION_SAMPLES = Object.freeze({
	'free-tier-403': Object.freeze(['FreeTierError: the free tier is app-only']),
	'access-403': Object.freeze(['Error: Model access is disabled for this account']),
	'endpoint-410': Object.freeze(['410: endpoint unavailable', 'ModelDeprecated: kimi-k2.7-code']),
	'param-400': Object.freeze(['request does not support parameter reasoningEffort']),
	'unavailable-400': Object.freeze(['Model is unavailable']),
	'thinking-map-400': Object.freeze(['400: thinking.type.disabled requires adaptive thinking']),
	other: Object.freeze(['Error: rate limit exceeded, retries exhausted']),
});
