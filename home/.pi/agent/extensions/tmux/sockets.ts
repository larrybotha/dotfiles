// Socket specs and external pane-target grammar for the tmux extension.
// Mirrors executors/lib.sh `resolve_socket` / `resolve_pane`. Kept out of
// index.ts so test.ts can import it without running the extension's
// top-level viz wiring.

export type SocketSpec = "pi" | "default" | "current";

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Map a user socket spec to the whitelist. Empty/whitespace -> "pi".
 *  Absolute paths and anything else are rejected (same-uid trust model;
 *  `default` and `current` are the only non-pi sockets). */
export function normalizeSocket(raw?: string): Validation<SocketSpec> {
	const s = (raw ?? "").trim();
	if (s === "" || s === "pi") return { ok: true, value: "pi" };
	if (s === "default") return { ok: true, value: "default" };
	if (s === "current") {
		if (!process.env.TMUX) {
			return {
				ok: false,
				reason: 'socket "current" requested but $TMUX is unset — use pi|default',
			};
		}
		return { ok: true, value: "current" };
	}
	return { ok: false, reason: `invalid socket "${s}" — use pi|default|current` };
}

// control characters never reach tmux -t; pane text is otherwise printable
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Syntax-only validation of a pane target: `sess`, `sess:win`,
 *  `sess:win.pane`, or `%id`. tmux forbids ':' and '.' in session names, so
 *  the composed keys are unambiguous (session groups are caught at
 *  resolution time). Resolution (existence, ambiguity) happens in
 *  `resolve_pane` / the capture executor. */
export function validateTarget(raw: string): Validation<string> {
	const t = raw.trim();
	if (t === "") return { ok: false, reason: "empty target" };
	if (t.length > 256) {
		return { ok: false, reason: `target too long (max 256): ${t.slice(0, 40)}…` };
	}
	if (CONTROL_RE.test(t)) {
		return { ok: false, reason: "invalid target — control characters" };
	}
	if (t.startsWith("%")) {
		if (!/^%[0-9]+$/.test(t)) return { ok: false, reason: `invalid pane id "${t}"` };
		return { ok: true, value: t };
	}
	if (!/^[^:.]+(?::[^:.]+(?:\.[^:.]+)?)?$/.test(t)) {
		return {
			ok: false,
			reason: `invalid target "${t}" — use sess, sess:win.pane, or %id`,
		};
	}
	return { ok: true, value: t };
}

/** External listing/reads default on; TMUX_EXTERNAL_READ=0 disables both the
 *  tmux_status external section and external tmux_capture. */
export function externalReadEnabled(): boolean {
	return process.env.TMUX_EXTERNAL_READ !== "0";
}
