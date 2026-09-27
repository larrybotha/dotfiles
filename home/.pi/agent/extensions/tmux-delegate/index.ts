/**
 * Tmux delegate extension — state-machine-enforced delegation lifecycle.
 *
 * Delegate tasks to a pi instance running in an isolated tmux session.
 * Results are read from declared artifact files — not terminal output —
 * keeping the parent context clean.
 *
 * The machine (machine.ts) owns the lifecycle: begin → spawn →
 * exit | session-dead | deadline | kill → collect. Executors (executors/,
 * plain node scripts with one-line JSON contracts) own IO: spawn, probe,
 * collect, kill, cleanup. The tool is thin: it validates params with the
 * machine's pure validators, runs executors, and sends events carrying
 * executor evidence.
 *
 * One actor per delegate_task call — transient, like the call. Tool results
 * are built from the machine snapshot; there is no ad-hoc status enum
 * (statusOf() maps state value → status).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, Spacer } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createActor, type Actor } from "xstate";
import {
	delegateMachine,
	paramsViolation,
	statusOf,
	type ArtifactEntry,
	type DelegateContext,
} from "./machine.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 300;
const POLL_INTERVAL_MS = 500;
const STATUS_UPDATE_MS = 5000;

// Executors are an implementation detail (swap by replacing scripts with the
// same JSON contract) — machine and tools untouched.
const EXEC_DIR =
	process.env.TMUX_DELEGATE_EXEC_DIR ??
	path.join(homedir(), ".pi/agent/extensions/tmux-delegate/executors");
const SPAWN = path.join(EXEC_DIR, "spawn.mjs");
const PROBE = path.join(EXEC_DIR, "probe.mjs");
const KILL = path.join(EXEC_DIR, "kill.mjs");
const COLLECT = path.join(EXEC_DIR, "collect.mjs");
const CLEANUP = path.join(EXEC_DIR, "cleanup.mjs");
const EXECUTOR_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DelegateDetails {
	status: "success" | "error" | "timeout" | "running" | "aborted";
	sessionId: string;
	socketPath: string;
	artifacts: ArtifactEntry[];
	summary: string;
	stderr: string;
	exitCode: number | null;
	monitor: boolean;
	rejected?: string;
}

interface SpawnFiles {
	signalFile: string;
	stderrFile: string;
	taskFile: string;
	scriptFile: string;
	promptFile: string | null;
}

// ---------------------------------------------------------------------------
// Helpers (IO stays in executors; these are glue only)
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);

// Every executor emits { ok: true, ... } | { ok: false, error }
type ExecutorOk<T> = T & { ok: true };
type ExecutorResult<T> = ExecutorOk<T> | { ok: false; error: string };

async function runExecutor<T extends object>(script: string, input: unknown): Promise<ExecutorResult<T>> {
	try {
		const { stdout } = await execFileP(process.execPath, [script, JSON.stringify(input)], {
			timeout: EXECUTOR_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout.trim());
		if (
			parsed &&
			typeof parsed === "object" &&
			(parsed as { ok?: unknown }).ok === true
		) {
			return parsed as ExecutorOk<T>;
		}
		return {
			ok: false,
			error: `executor ${path.basename(script)}: unexpected output: ${stdout.trim().slice(0, 200)}`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `executor ${path.basename(script)}: ${msg}` };
	}
}

function getSocketDir(): string {
	return (
		process.env.AGENT_TMUX_SOCKET_DIR ??
		path.join(process.env.TMPDIR ?? "/tmp", "agent-tmux-sockets")
	);
}

/** Resolve the pi binary the same way the subagent extension does.
 *  Must run inside the pi process (process.argv points at pi here). */
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

// ---------------------------------------------------------------------------
// Tool result builders — from machine snapshot only
// ---------------------------------------------------------------------------

function detailsFromSnapshot(a: Actor<typeof delegateMachine>): DelegateDetails {
	const snap = a.getSnapshot();
	const c: DelegateContext = snap.context;
	// failureDetail (spawn error / died-without-signal) leads the summary;
	// collected artifact summary follows when present
	const summary = c.failureDetail
		? `${c.failureDetail}${c.summary ? `\n\n${c.summary}` : ""}`
		: c.summary;
	return {
		status: statusOf(String(snap.value)),
		sessionId: c.sessionId,
		socketPath: c.socketPath,
		artifacts: c.artifacts,
		summary,
		stderr: c.stderr,
		exitCode: c.exitCode,
		monitor: c.monitor,
	};
}

function buildResultText(
	status: string,
	summary: string,
	artifacts: ArtifactEntry[],
	sessionId: string,
	socketPath: string,
	monitor: boolean,
	stderr: string,
	exitCode: number | null,
): string {
	let text = `## delegate_task — ${status}\n\n${summary}`;

	// exit code matters to model-in-the-loop automation (1 vs 137 vs …) —
	// surface it in the model-visible text, not only structured details
	if (status === "error" && exitCode !== null && exitCode !== 0) {
		text += `\nExit code: ${exitCode}`;
	}

	if (artifacts.length > 0) {
		text += "\n\n### Artifacts\n";
		for (const a of artifacts) {
			if (a.missing) {
				text += `\n- ✗ \`${a.path}\` (missing)`;
			} else if (a.readError) {
				text += `\n- ✗ \`${a.path}\` (read error: ${a.readError})`;
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

function resultFromSnapshot(a: Actor<typeof delegateMachine>, rejected?: string) {
	const d = detailsFromSnapshot(a);
	if (rejected) d.rejected = rejected;
	const text = buildResultText(
		d.status,
		d.summary,
		d.artifacts,
		d.sessionId,
		d.socketPath,
		d.monitor,
		d.stderr,
		d.exitCode,
	);
	return {
		content: [{ type: "text" as const, text }],
		details: d,
		isError: d.status !== "success",
	};
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
					description: "File paths to collect as results (relative to cwd or absolute)",
				}),
			),
			monitor: Type.Optional(
				Type.Boolean({
					description: "Keep session alive after completion for attach/debug (default false)",
				}),
			),
			agentPrompt: Type.Optional(
				Type.String({ description: "Additional system prompt text to append for the delegated instance" }),
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

			// Precheck — machine validator, single source of truth (the guard
			// rejects the same event, so no actor is created for an illegal delegation)
			const violation = paramsViolation(task, timeout, artifacts);
			if (violation) {
				return {
					content: [{ type: "text", text: `Rejected: ${violation}` }],
					details: {
						status: "error",
						sessionId: "",
						socketPath: "",
						artifacts: [],
						summary: violation,
						stderr: "",
						exitCode: null,
						monitor,
						rejected: violation,
					},
					isError: true,
				};
			}

			const a = createActor(delegateMachine);
			a.start();

			const sessionId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const socketDir = getSocketDir();
			const socketPath = path.join(socketDir, "agent.sock");

			a.send({
				type: "BEGIN_DELEGATION",
				sessionId,
				socketPath,
				task,
				monitor,
				timeoutSecs: timeout,
				workingDir,
				artifactPaths: artifacts,
			});

			// --- Spawn (executor IO → SPAWN_OK | SPAWN_FAIL; failure self-cleans) ---
			const spawn = await runExecutor<{ sessionId: string; socketPath: string; files: SpawnFiles }>(SPAWN, {
				sessionId,
				socketDir,
				workingDir,
				task,
				agentPrompt: agentPrompt ?? null,
				parentPid: process.pid,
				timeoutSecs: timeout,
				pi: resolvePiBinary(),
			});

			if (!spawn.ok) {
				a.send({ type: "SPAWN_FAIL", error: spawn.error });
				return resultFromSnapshot(a);
			}
			const files: SpawnFiles = spawn.files;
			a.send({ type: "SPAWN_OK" });

			// --- Poll (probe IO → EXIT_SEEN | SESSION_DEAD | DEADLINE_HIT | KILL) ---
			const deadline = Date.now() + timeout * 1000;
			const startTime = Date.now();
			let lastStatusUpdate = Date.now();
			let ended = false;

			while (Date.now() < deadline) {
				if (signal?.aborted) {
					await runExecutor(KILL, { socketPath, sessionId });
					a.send({ type: "KILL" });
					ended = true;
					break;
				}

				const probe = await runExecutor<{ done: boolean; exitCode: number | null; alive: boolean }>(PROBE, {
					signalFile: files.signalFile,
					socketPath,
					sessionId,
				});

				if (probe.ok) {
					if (probe.done) {
						a.send({ type: "EXIT_SEEN", exitCode: probe.exitCode ?? 1 });
						ended = true;
						break;
					}
					if (!probe.alive) {
						// died without writing the signal file — readable error, not a slow timeout
						a.send({ type: "SESSION_DEAD" });
						ended = true;
						break;
					}
				}
				// executor failure: treated as not-done/alive — a persistent failure is
				// caught by the deadline and lands in `timeout`

				if (onUpdate && Date.now() - lastStatusUpdate > STATUS_UPDATE_MS) {
					const elapsed = Math.round((Date.now() - startTime) / 1000);
					onUpdate({
						content: [{ type: "text", text: `Running… (${elapsed}s / ${timeout}s)` }],
						details: detailsFromSnapshot(a),
					});
					lastStatusUpdate = Date.now();
				}

				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			}

			if (!ended) {
				// Deadline — kill immediately (bash may be mid-write; collect after)
				await runExecutor(KILL, { socketPath, sessionId });
				a.send({ type: "DEADLINE_HIT" });
			}

			// --- Collect (executor IO → COLLECT_DONE; legal in terminal states only) ---
			const snapStatus = statusOf(String(a.getSnapshot().value));
			if (snapStatus !== "aborted") {
				const collect = await runExecutor<{ artifacts: ArtifactEntry[]; stderr: string }>(COLLECT, {
					artifactPaths: artifacts,
					workingDir,
					stderrFile: files.stderrFile,
				});

				if (collect.ok) {
					a.send({ type: "COLLECT_DONE", artifacts: collect.artifacts, stderr: collect.stderr });
				} else {
					// collect failed — surface the reason as stderr, no artifacts
					a.send({ type: "COLLECT_DONE", artifacts: [], stderr: collect.error });
				}
			}
			// aborted: user cancelled — no artifact read (legacy behavior)

			// --- Cleanup + kill policy ---
			await runExecutor(CLEANUP, { files: Object.values(files) });
			if (!monitor) {
				// idempotent — timeout/abort paths already killed
				await runExecutor(KILL, { socketPath, sessionId });
			}

			return resultFromSnapshot(a);
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
				container.addChild(new Markdown(d.summary, 0, 0, getMarkdownTheme()));

				if (d.artifacts.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Artifacts ───"), 0, 0));
					for (const a of d.artifacts) {
						if (a.missing) {
							container.addChild(
								new Text(theme.fg("warning", `✗ ${a.path} (missing)`), 0, 0),
							);
						} else if (a.readError) {
							container.addChild(
								new Text(
									theme.fg("warning", `✗ ${a.path} (read error: ${a.readError})`),
									0,
								),
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
							container.addChild(new Markdown(a.content, 0, 0, getMarkdownTheme()));
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

				if (d.monitor && (d.status === "running" || d.status === "success")) {
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
			const collected = d.artifacts.filter((a) => !a.missing && !a.readError).length;
			if (collected > 0) text += ` · ${collected} artifact(s)`;
			const missingCount = d.artifacts.filter((a) => a.missing).length;
			if (missingCount > 0) text += theme.fg("warning", ` · ${missingCount} missing`);
			if (d.monitor) text += theme.fg("warning", " [monitor]");
			text += `\n${theme.fg("dim", d.summary)}`;
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
