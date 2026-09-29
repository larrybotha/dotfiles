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
import { createActor, fromPromise, waitFor, type Actor } from "xstate";
import {
	type CollectServiceInput,
	type CollectServiceOutput,
	delegateMachine,
	type MonitorServiceInput,
	type MonitorServiceOutput,
	paramsViolation,
	type SpawnServiceInput,
	type SpawnServiceOutput,
	statusOf,
	type ArtifactEntry,
	type DelegateContext,
	type SpawnFiles,
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
// (SpawnFiles moved to machine.ts — the spawn service output carries it)

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
// Wired machine — real services around the executors (machine.ts ships
// typed stubs; test.ts wires controlled stubs — slide-deck pattern). The
// machine drives the whole lifecycle: spawn → monitor (poll loop, deadline
// kill) → collect; the tool is thin (precheck → BEGIN → wait → hygiene).
// ---------------------------------------------------------------------------

/** Spawn executor wrapper. On abort (KILL during spawning — exiting
 *  `spawning` aborted this actor): best-effort kill the session (it may
 *  not exist yet; the tool's post-settle kill pass closes the race), then
 *  throw — the machine is already in `aborted`; the late result drops. */
async function runSpawnExecutor(
	input: SpawnServiceInput,
	signal: AbortSignal,
): Promise<SpawnServiceOutput> {
	const spawn = await runExecutor<SpawnServiceOutput>(SPAWN, {
		sessionId: input.sessionId,
		socketDir: input.launch.socketDir,
		workingDir: input.workingDir,
		task: input.task,
		agentPrompt: input.launch.agentPrompt,
		parentPid: input.launch.parentPid,
		timeoutSecs: input.timeoutSecs,
		pi: input.launch.pi,
	});
	if (!spawn.ok) throw new Error(spawn.error);
	if (signal.aborted) {
		await runExecutor(KILL, { socketPath: input.socketPath, sessionId: input.sessionId });
		throw new Error("spawn aborted");
	}
	return spawn;
}

/** Monitor executor wrapper — the poll loop the tool used to own. Probe
 *  every POLL_INTERVAL_MS: done → exit outcome, not-alive → dead (readable
 *  error, not a slow timeout), deadline → kill then timeout outcome. On
 *  abort: kill the session, throw (machine already `aborted`). A persistent
 *  probe failure is treated as not-done/alive and caught by the deadline. */
async function runMonitorExecutor(
	input: MonitorServiceInput,
	signal: AbortSignal,
): Promise<MonitorServiceOutput> {
	const kill = () => runExecutor(KILL, { socketPath: input.socketPath, sessionId: input.sessionId });
	const deadline = Date.now() + input.timeoutSecs * 1000;
	while (Date.now() < deadline) {
		if (signal.aborted) {
			await kill();
			throw new Error("monitor aborted");
		}
		const probe = await runExecutor<{ done: boolean; exitCode: number | null; alive: boolean }>(PROBE, {
			signalFile: input.files.signalFile,
			socketPath: input.socketPath,
			sessionId: input.sessionId,
		});
		if (probe.ok) {
			if (probe.done) return { kind: "exit", exitCode: probe.exitCode ?? 1 };
			if (!probe.alive) return { kind: "dead" };
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	// deadline — kill immediately (bash may be mid-write; collect follows)
	await kill();
	return { kind: "deadline" };
}

/** Collect executor wrapper: reads artifacts + stderr; failures throw (the
 *  machine's collectFailed records them as empty artifacts + error stderr). */
async function runCollectExecutor(input: CollectServiceInput): Promise<CollectServiceOutput> {
	const collect = await runExecutor<CollectServiceOutput>(COLLECT, {
		artifactPaths: input.artifactPaths,
		workingDir: input.workingDir,
		stderrFile: input.stderrFile ?? "",
	});
	if (!collect.ok) throw new Error(collect.error);
	return collect;
}

export const wiredMachine = delegateMachine.provide({
	actors: {
		spawnService: fromPromise<SpawnServiceOutput, SpawnServiceInput>(({ input, signal }) =>
			runSpawnExecutor(input, signal),
		),
		monitorService: fromPromise<MonitorServiceOutput, MonitorServiceInput>(({ input, signal }) =>
			runMonitorExecutor(input, signal),
		),
		collectService: fromPromise<CollectServiceOutput, CollectServiceInput>(
			({ input }) => runCollectExecutor(input),
		),
	},
});

// ---------------------------------------------------------------------------
// Tool result builders — from machine snapshot only
// ---------------------------------------------------------------------------

function detailsFromSnapshot(a: Actor<typeof wiredMachine>): DelegateDetails {
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

function resultFromSnapshot(a: Actor<typeof wiredMachine>, rejected?: string) {
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

			const a = createActor(wiredMachine);
			a.start();

			const sessionId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const socketDir = getSocketDir();
			const socketPath = path.join(socketDir, "agent.sock");

			// Abort always wins: the tool's signal → KILL (legal in spawning
			// and running — exiting either aborts the invoked service, which
			// kills the tmux session best-effort). A late KILL after terminal
			// is dropped by the machine.
			const startTime = Date.now();
			signal?.addEventListener("abort", () => a.send({ type: "KILL" }), { once: true });

			a.send({
				type: "BEGIN_DELEGATION",
				sessionId,
				socketPath,
				task,
				monitor,
				timeoutSecs: timeout,
				workingDir,
				artifactPaths: artifacts,
				// spawn params flow through the event into the service input
				// (never into the snapshot — content-through-events pattern)
				launch: {
					socketDir,
					agentPrompt: agentPrompt ?? null,
					parentPid: process.pid,
					pi: resolvePiBinary(),
				},
			});

			// Progress: tool-side UX (machine-driven IO; the monitor service
			// stays pure IO — no onUpdate plumbing through service inputs)
			const progress = onUpdate
				? setInterval(() => {
						const elapsed = Math.round((Date.now() - startTime) / 1000);
						onUpdate({
							content: [{ type: "text", text: `Running… (${elapsed}s / ${timeout}s)` }],
							details: detailsFromSnapshot(a),
						});
					}, STATUS_UPDATE_MS)
				: null;

			// Wait for the machine to drive itself out: spawn (≤15s) + monitor
			// (≤ timeoutSecs) + collect (≤15s). Spawn-fail `error` has no
			// collect — settled once terminal; every other terminal waits for
			// the collected flag.
			let settled: boolean;
			try {
				await waitFor(
					a,
					(s) =>
						s.matches("aborted") ||
						((s.matches("success") || s.matches("error") || s.matches("timeout")) &&
							(s.context.files === null || s.context.collected)),
					{ timeout: timeout * 1000 + 45_000 },
				);
				settled = true;
			} catch {
				settled = false;
			} finally {
				if (progress) clearInterval(progress);
			}
			if (!settled) {
				// honest state — the machine keeps driving in the background
				return {
					content: [
						{
							type: "text",
							text: `Delegation still in flight (${statusOf(String(a.getSnapshot().value))}) after ${Math.round((Date.now() - startTime) / 1000)}s — the machine continues in the background; check the session: tmux -S "${socketPath}" list-sessions`,
						},
					],
					details: detailsFromSnapshot(a),
					isError: true,
				};
			}

			// --- Cleanup + kill policy (tool-side hygiene; executors
			// idempotent — deadline/abort paths already killed) ---
			const files = a.getSnapshot().context.files;
			if (files) {
				await runExecutor(CLEANUP, { files: Object.values(files) });
				if (!monitor) {
					await runExecutor(KILL, { socketPath, sessionId });
				}
			}
			// spawn-fail (files null): the session self-cleans — nothing to do

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
