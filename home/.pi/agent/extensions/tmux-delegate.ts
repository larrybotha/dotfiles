/**
 * Tmux Delegate Extension
 *
 * Delegate tasks to a pi instance running in an isolated tmux session.
 * Results come from declared artifact files — not terminal output —
 * keeping the parent context clean.
 *
 * Usage:
 *   delegate_task(task="Refactor auth module", artifacts=["src/auth.py"])
 *
 * Key design:
 * - pi runs inside tmux, not as a direct subprocess
 * - Artifacts are file paths, not pane captures
 * - Sessions auto-cleanup unless monitor=true
 * - Status updates streamed while waiting
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, Spacer } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_TIMEOUT = 300;
const POLL_INTERVAL_MS = 500;
const STATUS_UPDATE_MS = 5000;
const MAX_ARTIFACT_SIZE = 50 * 1024; // 50KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArtifactEntry {
	path: string;
	content: string;
	missing: boolean;
	truncated?: boolean;
}

interface DelegateDetails {
	status: "success" | "error" | "timeout" | "running" | "aborted";
	sessionId: string;
	socketPath: string;
	artifacts: ArtifactEntry[];
	summary: string;
	stderr: string;
	exitCode: number | null;
	monitor: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSocketDir(): string {
	return (
		process.env.AGENT_TMUX_SOCKET_DIR ??
		path.join(process.env.TMPDIR ?? "/tmp", "agent-tmux-sockets")
	);
}

/** Resolve the pi binary the same way the subagent extension does. */
function resolvePiBinary(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}

function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

function truncateContent(
	content: string,
	maxBytes: number,
): { content: string; truncated: boolean } {
	if (content.length <= maxBytes) return { content, truncated: false };
	return {
		content: content.slice(0, maxBytes) + "\n… [truncated]",
		truncated: true,
	};
}

function killSession(socket: string, session: string): void {
	try {
		execSync(
			`tmux -S ${shellQuote(socket)} kill-session -t ${shellQuote(session)} 2>/dev/null`,
		);
	} catch {
		/* already dead */
	}
}

function cleanup(files: (string | null | undefined)[]): void {
	for (const f of files) {
		if (f) {
			try {
				fs.unlinkSync(f);
			} catch {
				/* ignore */
			}
		}
	}
}

function makeDetails(
	status: DelegateDetails["status"],
	sessionId: string,
	socketPath: string,
	artifacts: ArtifactEntry[],
	summary: string,
	exitCode: number | null,
	monitor: boolean,
	stderr = "",
): DelegateDetails {
	return { status, sessionId, socketPath, artifacts, summary, exitCode, monitor, stderr };
}

async function readArtifacts(
	paths: string[],
	workingDir: string,
): Promise<ArtifactEntry[]> {
	const results: ArtifactEntry[] = [];
	for (const p of paths) {
		const fullPath = path.isAbsolute(p) ? p : path.join(workingDir, p);
		try {
			if (!fs.existsSync(fullPath)) {
				results.push({ path: p, content: "", missing: true });
			} else {
				const raw = fs.readFileSync(fullPath, "utf-8");
				const { content, truncated } = truncateContent(raw, MAX_ARTIFACT_SIZE);
				results.push({ path: p, content, missing: false, truncated });
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			results.push({ path: p, content: `Read error: ${msg}`, missing: false });
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Result text (for content field)
// ---------------------------------------------------------------------------

function buildResultText(
	status: string,
	summary: string,
	artifacts: ArtifactEntry[],
	sessionId: string,
	socketPath: string,
	monitor: boolean,
	stderr: string,
): string {
	let text = `## delegate_task — ${status}\n\n${summary}`;

	if (artifacts.length > 0) {
		text += "\n\n### Artifacts\n";
		for (const a of artifacts) {
			if (a.missing) {
				text += `\n- ✗ \`${a.path}\` (missing)`;
			} else {
				const lines = a.content.split("\n").length;
				text += `\n- ✓ \`${a.path}\` (${lines} lines)`;
				if (a.truncated) text += " (truncated)";
			}
		}
	}

	if (monitor && status !== "timeout" && status !== "aborted") {
		text += `\n\n### Session\n\nAttach: \`tmux -S "${socketPath}" attach -t ${sessionId}\``;
	}

	if (stderr) {
		text += `\n\n### Stderr\n\n\`\`\`\n${stderr.slice(0, 1000)}\n\`\`\``;
	}

	return text;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "delegate_task",
		label: "Delegate",
		description: [
			"Delegate a task to a pi instance running in an isolated tmux session.",
			"Results are read from declared artifact files — not terminal output — keeping context clean.",
			"Sessions are cleaned up automatically unless monitor=true.",
		].join(" "),
		parameters: Type.Object({
			task: Type.String({
				description: "Task description for the delegated pi instance. Be specific about expected output files.",
			}),
			cwd: Type.Optional(
				Type.String({ description: "Working directory (defaults to current session cwd)" }),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Max seconds to wait (default 300)" }),
			),
			artifacts: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"File paths to collect as results (relative to cwd or absolute)",
				}),
			),
			monitor: Type.Optional(
				Type.Boolean({
					description:
						"Keep session alive after completion for attach/debug (default false)",
				}),
			),
			agentPrompt: Type.Optional(
				Type.String({
					description: "Additional system prompt text to append for the delegated instance",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const {
				task,
				cwd: taskCwd,
				timeout = DEFAULT_TIMEOUT,
				artifacts = [],
				monitor = false,
				agentPrompt,
			} = params;

			const workingDir = taskCwd ?? ctx.cwd;
			const socketDir = getSocketDir();
			const sessionId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const socketPath = path.join(socketDir, "agent.sock");

			// Ensure socket directory exists
			fs.mkdirSync(socketDir, { recursive: true });

			// Temp file base
			const tmpBase = path.join(os.tmpdir(), `pi-delegate-${sessionId}`);
			const signalFile = `${tmpBase}-signal`;
			const stderrFile = `${tmpBase}-stderr`;
			const taskFile = `${tmpBase}-task.md`;
			const scriptFile = `${tmpBase}-run.sh`;
			const promptFile = agentPrompt ? `${tmpBase}-prompt.md` : null;

			// Write task to temp file (no shell escaping needed — file content)
			const taskContent = [
				"# Delegated Task",
				"",
				task,
				"",
				"## Instructions",
				"- Complete the task using available tools (read, write, edit, bash, grep, find, ls)",
				"- Write all output to the artifact file paths specified by the caller",
				"- When done, simply exit",
			].join("\n");
			fs.writeFileSync(taskFile, taskContent, "utf-8");

			// Write optional agent prompt
			if (promptFile) {
				fs.writeFileSync(promptFile, agentPrompt, "utf-8");
			}

			// Build pi command — uses task file content via heredoc to avoid
			// shell escaping issues with complex prompts.
			const piBin = resolvePiBinary();
			const piCmd = [
				shellQuote(piBin.command),
				...piBin.args.map(shellQuote),
				"--no-session",
				"-p",
				// Read task from file at runtime — avoids any escaping issues
				`"$(cat ${shellQuote(taskFile)})"`,
			].join(" ");

			// Build runner script
			const scriptLines = [
				"#!/usr/bin/env bash",
				`cd ${shellQuote(workingDir)}`,
				`export AGENT_TMUX_SOCKET_DIR=${shellQuote(socketDir)}`,
			];
			if (promptFile) {
				scriptLines.push(
					`${piCmd} --append-system-prompt ${shellQuote(promptFile)} 2>${shellQuote(stderrFile)}`,
				);
			} else {
				scriptLines.push(
					`${piCmd} 2>${shellQuote(stderrFile)}`,
				);
			}
			scriptLines.push(`echo $? > ${shellQuote(signalFile)}`);

			fs.writeFileSync(scriptFile, scriptLines.join("\n"), { mode: 0o755 });

			// --- Create tmux session ---
			try {
				execSync(
					`tmux -S ${shellQuote(socketPath)} -f /dev/null new -d -s ${shellQuote(sessionId)} -n shell -- bash ${shellQuote(scriptFile)}`,
				);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				cleanup([taskFile, scriptFile, promptFile]);
				return {
					content: [{ type: "text", text: `Failed to create tmux session: ${msg}` }],
					details: makeDetails("error", sessionId, socketPath, [], msg, null, monitor),
					isError: true,
				};
			}

			// --- Poll for completion ---
			const deadline = Date.now() + timeout * 1000;
			let exitCode: number | null = null;
			let timedOut = false;
			let lastStatusUpdate = Date.now();
			const startTime = Date.now();

			while (Date.now() < deadline) {
				// Abort signal
				if (signal?.aborted) {
					killSession(socketPath, sessionId);
					cleanup([signalFile, stderrFile, taskFile, scriptFile, promptFile]);
					return {
						content: [
							{
								type: "text",
								text: `Delegation aborted after ${Math.round((Date.now() - startTime) / 1000)}s`,
							},
						],
						details: makeDetails(
							"aborted",
							sessionId,
							socketPath,
							[],
							"Aborted by user",
							null,
							monitor,
						),
						isError: true,
					};
				}

				// Check signal file
				if (fs.existsSync(signalFile)) {
					try {
						const raw = fs.readFileSync(signalFile, "utf-8").trim();
						const code = parseInt(raw, 10);
						if (!isNaN(code)) {
							exitCode = code;
							break;
						}
					} catch {
						// file might be mid-write
					}
				}

				// Stream status update
				if (onUpdate && Date.now() - lastStatusUpdate > STATUS_UPDATE_MS) {
					const elapsed = Math.round((Date.now() - startTime) / 1000);
					onUpdate({
						content: [
							{ type: "text", text: `Running… (${elapsed}s / ${timeout}s)` },
						],
						details: makeDetails(
							"running",
							sessionId,
							socketPath,
							[],
							"",
							null,
							monitor,
						),
					});
					lastStatusUpdate = Date.now();
				}

				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			}

			// Timeout
			if (exitCode === null) {
				timedOut = true;
				killSession(socketPath, sessionId);
			}

			// --- Collect results ---
			const artifactResults = await readArtifacts(artifacts, workingDir);

			let stderr = "";
			try {
				stderr = fs.readFileSync(stderrFile, "utf-8").trim();
			} catch {
				/* no stderr */
			}

			const collected = artifactResults.filter((a) => !a.missing).length;
			const missing = artifactResults.filter((a) => a.missing);
			let summary = `Collected ${collected}/${artifacts.length} artifacts.`;
			if (missing.length > 0) {
				summary += ` Missing: ${missing.map((a) => a.path).join(", ")}.`;
			}

			const status = timedOut
				? "timeout"
				: exitCode === 0
					? "success"
					: "error";

			// Cleanup temp files
			cleanup([signalFile, stderrFile, taskFile, scriptFile, promptFile]);

			// Kill session unless monitor mode (or already killed on timeout)
			if (!monitor && !timedOut) {
				killSession(socketPath, sessionId);
			}

			const resultText = buildResultText(
				status,
				summary,
				artifactResults,
				sessionId,
				socketPath,
				monitor,
				stderr,
			);

			return {
				content: [{ type: "text", text: resultText }],
				details: makeDetails(
					status,
					sessionId,
					socketPath,
					artifactResults,
					summary,
					exitCode,
					monitor,
					stderr,
				),
				isError: status !== "success",
			};
		},

		// --- Collapsed call rendering ---
		renderCall(args, theme) {
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}…`
					: args.task
				: "…";
			const cwdLabel = args.cwd ? ` in ${path.basename(args.cwd)}` : "";
			const timeoutLabel = args.timeout ? ` (${args.timeout}s)` : "";
			let text =
				theme.fg("toolTitle", theme.bold("delegate_task ")) +
				theme.fg("dim", preview + cwdLabel + timeoutLabel);
			if (args.monitor) text += theme.fg("warning", " [monitor]");
			return new Text(text, 0, 0);
		},

		// --- Result rendering ---
		renderResult(result, { expanded }, theme) {
			const d = result.details as DelegateDetails | undefined;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}

			const icon =
				d.status === "success"
					? theme.fg("success", "✓")
					: d.status === "timeout"
						? theme.fg("warning", "⏱")
						: d.status === "aborted"
							? theme.fg("warning", "⊘")
							: theme.fg("error", "✗");

			if (expanded) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("delegate_task"))} — ${d.status}`,
						0,
						0,
					),
				);

				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Summary ───"), 0, 0));
				container.addChild(new Markdown(d.summary, 0, 0));

				if (d.artifacts.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Artifacts ───"), 0, 0));
					for (const a of d.artifacts) {
						if (a.missing) {
							container.addChild(
								new Text(theme.fg("warning", `✗ ${a.path} (missing)`), 0, 0),
							);
						} else {
							const lines = a.content.split("\n").length;
							container.addChild(
								new Text(
									theme.fg("accent", `✓ ${a.path}`) +
										theme.fg("dim", ` (${lines} lines)`),
									0,
									0,
								),
							);
							container.addChild(new Markdown(a.content, 0, 0));
						}
					}
				}

				if (d.stderr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Stderr ───"), 0, 0));
					container.addChild(
						new Text(theme.fg("error", d.stderr.slice(0, 500)), 0, 0),
					);
				}

				if (
					d.monitor &&
					(d.status === "running" || d.status === "success")
				) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							theme.fg("warning", "Session alive: ") +
								theme.fg(
									"dim",
									`tmux -S "${d.socketPath}" attach -t ${d.sessionId}`,
								),
							0,
							0,
						),
					);
				}

				return container;
			}

			// Collapsed
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("delegate_task"))} — ${d.status}`;
			const collected = d.artifacts.filter((a) => !a.missing).length;
			if (collected > 0) text += ` · ${collected} artifact(s)`;
			const missingCount = d.artifacts.filter((a) => a.missing).length;
			if (missingCount > 0)
				text += theme.fg("warning", ` · ${missingCount} missing`);
			if (d.monitor) text += theme.fg("warning", " [monitor]");
			text += `\n${theme.fg("dim", d.summary)}`;
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
