/**
 * machine-kit — shared pure helpers for the XState-machine extensions.
 *
 * The flat machines (tmux/machine.ts, filechanges/machine.ts,
 * mermaid/machine.ts, slide-deck/machine.ts) each re-implement the same
 * behavior-identical scaffolding around their own domain logic. This kit
 * holds only those shared pieces — same role as _viz/viz-kit.ts (shared
 * inspector transport), but for machine guts: pure helpers, no IO, no
 * XState imports, no timers, and no dependency on any extension or its
 * types.
 *
 * Kit rules:
 *   - nothing here owns policy: env-var NAMES, default values, and
 *     user-facing cause words ("diagram" / "deck" / "infra") are caller
 *     vocabulary and stay in the machines — the kit is parameterized
 *     around them;
 *   - extracted only from behavior-identical duplications; callers wrap,
 *     not fork.
 *
 * Residents:
 *   - envLimit(name, fallback) — integer env-var limit parsing.
 *     Users: tmux/machine.ts DEFAULT_LIMITS (TMUX_MAX_SESSIONS,
 *     TMUX_MAX_PROMPT_WAITS, TMUX_MAX_WAIT_ATTEMPTS) and
 *     filechanges/machine.ts DEFAULT_LIMITS (FILECHANGES_MAX_TRACKED).
 *     Machines call it at module load — same evaluation time as the local
 *     helpers it replaced (envLimit itself reads process.env at call
 *     time; it is pure otherwise).
 *   - normalizeServiceFailure(output, opts) — invoked-service failure
 *     normalizer. Users: mermaid/machine.ts and slide-deck/machine.ts,
 *     each wrapped in its local failureOf() so the machine's public
 *     failure type and cause names stay put; the kit is cause-agnostic
 *     (generic TCause). The two machines disagree on exactly one input
 *     class — a shaped rejection whose cause is missing/unknown — and the
 *     opts make that disagreement explicit:
 *       mermaid passes defaultCause = "diagram" (back-compat: a causeless
 *         rejection still reported its errors, so the errors are kept and
 *         only the cause defaults to the source side);
 *       slide-deck passes defaultCause = null (strict: only a shaped
 *         failure carrying a KNOWN cause is trusted — anything else is
 *         treated like a non-shaped rejection, message-extracted with
 *         nonShapedCause "infra", because the content was never checked).
 */
// (no imports — nothing here needs one)

/**
 * Read a positive-integer limit from an environment variable.
 *
 * Contract:
 *   - unset or "" → fallback
 *   - garbage (non-numeric, whitespace, NaN) → fallback (Number() semantics)
 *   - non-finite (±Infinity), negative, or zero → fallback
 *   - positive finite → Math.floor'd integer (2.9 → 2)
 */
export function envLimit(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Caller's cause vocabulary + fallback policy for normalizeServiceFailure. */
export interface NormalizeServiceFailureOpts<TCause extends string> {
  /** Every cause a shaped failure may legally carry — the passthrough set. */
  causes: readonly TCause[];
  /**
   * Cause for a shaped rejection ({ errors } array) whose `cause` is
   * missing or not in `causes`. Non-null: keep the rejection's errors and
   * only substitute the cause. null: no default — treat it like a
   * non-shaped rejection (message extraction, `nonShapedCause`).
   */
  defaultCause: TCause | null;
  /** Cause for any non-shaped rejection (Error, string, number, nullish…). */
  nonShapedCause: TCause;
}

/**
 * Normalize an unknown invoked-service rejection into { errors, cause }
 * routing data. Contract (input class → output):
 *   - shaped (typeof object, non-null, `.errors` array) with a cause in
 *     `opts.causes` → passthrough: errors mapped through String, cause kept
 *   - shaped with a missing/unknown cause → `opts.defaultCause` non-null:
 *     errors kept (mapped through String), cause substituted; null: same
 *     treatment as non-shaped (below)
 *   - anything else → message extraction — Error.message if present, else
 *     String(output), nullish → "service failed" — with `opts.nonShapedCause`
 *
 * Cause names are the caller's user-facing words; this function knows none.
 */
export function normalizeServiceFailure<TCause extends string>(
  output: unknown,
  opts: NormalizeServiceFailureOpts<TCause>,
): { errors: string[]; cause: TCause } {
  const { causes, defaultCause, nonShapedCause } = opts;
  const out = output as { errors: unknown[]; cause?: unknown };
  if (
    typeof output === "object" &&
    output !== null &&
    Array.isArray(out.errors)
  ) {
    const known = causes.find((c) => c === out.cause);
    if (known !== undefined) {
      return { errors: out.errors.map((e) => String(e)), cause: known };
    }
    if (defaultCause !== null) {
      return { errors: out.errors.map((e) => String(e)), cause: defaultCause };
    }
  }
  // Non-shaped rejection (or an untrusted shape): never a deliberate
  // service failure — extract whatever message it carries.
  return {
    errors: [
      String(
        (output as Error | undefined)?.message ?? output ?? "service failed",
      ),
    ],
    cause: nonShapedCause,
  };
}
