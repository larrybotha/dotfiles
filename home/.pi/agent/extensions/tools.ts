/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// Restore tool selection from the branch.
	//
	// Pi replays the transcript's tool changes (system messages carrying
	// toolsAdded/toolsRemoved) before session_start/session_tree fires, so the
	// live active set is already authoritative — including codemode, tool_search
	// and any tool_search loads. Those keep their codemode/deferred exposure, so
	// re-declaring them here would be wrong (and filtering by exposure would drop
	// the loads).
	//
	// The only state replay misses is a /tools toggle made after the last request
	// on the branch: that exists solely as a `tools-config` entry, because pi
	// writes tool changes lazily just before the next request. Apply it only when
	// it is newer than the branch's last system message.
	//
	// Known limitation: applying an unrecorded toggle calls setActiveTools, which
	// clears pi's pending (not-yet-registered) tool names if the new set drops an
	// active one. This only bites when a toggle lands while MCP servers are still
	// connecting, and only until the next request records it.
	function restoreFromBranch(ctx: ExtensionContext, reason?: string) {
		allTools = pi.getAllTools();

		// /reload keeps the live active set (plus pending); nothing to replay.
		if (reason === "reload") {
			enabledTools = new Set(pi.getActiveTools());
			return;
		}

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let lastSystemMessage = -1;
		let lastConfig = -1;
		let savedTools: string[] | undefined;

		for (let i = 0; i < branchEntries.length; i++) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message?.role === "system") {
				lastSystemMessage = i;
			} else if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					lastConfig = i;
					savedTools = data.enabledTools;
				}
			}
		}

		// Replay an unrecorded toggle. `savedTools` is a full getActiveTools()
		// snapshot taken when the toggle was made, so it already includes the
		// codemode/tool_search loads active at that point.
		if (savedTools && lastConfig > lastSystemMessage) {
			pi.setActiveTools(savedTools);
		}

		enabledTools = new Set(pi.getActiveTools());
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Resync first: tool_search may have loaded tools since restore
						enabledTools = new Set(pi.getActiveTools());
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (event, ctx) => {
		restoreFromBranch(ctx, event.reason);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
