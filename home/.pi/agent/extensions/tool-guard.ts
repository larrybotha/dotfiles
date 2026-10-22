/**
 * Tool guard — keeps human-facing tools out of scripts.
 *
 * `codemode` scripts can call any registered tool through `ctx.executeTool`,
 * including interactive ones. A picker or annotation tool invoked from a script
 * blocks on user input and holds one of the (at most two) codemode workers,
 * starving every other script in the process.
 *
 * Block nested calls to those tools and tell the caller to ask the user
 * instead. Top-level (model-issued) calls are untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tools that wait on a human and must never run inside a codemode script. */
const HUMAN_FACING_TOOLS = new Set(["browser_pick", "browser_annotate"]);

export default function toolGuardExtension(pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.parentToolCallId && HUMAN_FACING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason:
					`${event.toolName} is interactive and cannot be called from a script. ` +
					"Ask the user to run it, or have them trigger it directly.",
			};
		}
	});
}
