import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierAnswer, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, ClassifierQuestion } from "@earendil-works/pi-ai";
import type { BatchEvaluation, BatchOptions } from "./batch.js";
import { evaluateAll, evaluateMany } from "./batch.js";
import { TypeSafeIntegrationError, safeError } from "./errors.js";
import { DEFAULT_MAX_INPUT_BYTES, prepareEvaluationRequest } from "./schema.js";
import { DEFAULT_USD_PER_MTOK, capsFromEnvironment, estimateUsd, mergeCaps, openUsageLedger } from "./usage.js";
import type { BlockedCap, SpendCaps, UsageLedger, UsageReport } from "./usage.js";

export interface TypeSafeOptions {
  /** Defaults to PI_TYPESAFE_MODEL, then DEFAULT_MODEL. `<provider>/<id>`, split at the first slash. */
  model?: string;
  /** Per request. Default: 15 seconds. No automatic retries. */
  timeoutMs?: number;
  /** UTF-8 JSON bytes, including state/questions. Default: 64 KiB. Not a token limit. */
  maxInputBytes?: number;
  /** Attempts per client instance, including failed network requests. Default: 20. */
  maxRequests?: number;
  /** Requests per local day, counted across processes and restarts. Unlimited by default. */
  maxRequestsPerDay?: number;
  /** Input tokens per local day. Unlimited by default. */
  maxInputTokensPerDay?: number;
  /** Estimated spend per local day, in US dollars. Unlimited by default. */
  maxUsdPerDay?: number;
  /** Price used for the cost estimate and the USD cap. Default: DEFAULT_USD_PER_MTOK. */
  usdPerMTok?: number;
  /** The usage ledger; defaults to the store next to Pi's auth.json. Injected by tests. */
  ledger?: UsageLedger;
}
export interface EvaluationOptions { signal?: AbortSignal }
export type Evaluation = ClassifierResult & { readonly elapsedMs: number };

/** Session counters for one client instance, plus the cost estimate they add up to. */
export interface UsageSnapshot {
  readonly requestsStarted: number;
  readonly requestsSucceeded: number;
  readonly requestsFailed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedUsd: number;
}

/** Session counters, today's persisted counters, the caps in force, and the cap that is currently reached. */
export interface SpendReport {
  readonly session: UsageSnapshot;
  readonly today: UsageReport;
  readonly caps: SpendCaps;
  readonly usdPerMTok: number;
  readonly blocked?: BlockedCap;
}

export interface TypeSafe {
  evaluate(request: ClassifierContext, options?: EvaluationOptions): Promise<Evaluation>;
  /** Several requests with bounded concurrency; answers, usage, and model merged. Never throws. */
  evaluateMany(requests: readonly ClassifierContext[], options?: BatchOptions): Promise<BatchEvaluation>;
  /** One state, any number of questions: chunk to the per-request limit, then fan out. Never throws. */
  evaluateAll(request: ClassifierContext, options?: BatchOptions & { maxQuestions?: number }): Promise<BatchEvaluation>;
  /** This client's session counters. */
  getUsage(): UsageSnapshot;
  /** Session counters, today's persisted totals, and the caps that stop the next request. */
  getSpend(): SpendReport;
}

/** Default attempts per client instance; the extension quotes the same number in its consent copy. */
export const DEFAULT_MAX_REQUESTS = 20;

/** Fixed default classifier. Override with PI_TYPESAFE_MODEL=<provider>/<id>. */
export const DEFAULT_MODEL = "opencode/jev-1.13";

/** The configured classifier id, or the fixed default. No model is inferred from submitted content. */
export function resolveModelId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_TYPESAFE_MODEL?.trim();
  return configured || DEFAULT_MODEL;
}

/** Split `<provider>/<id>` at the first slash. Fails closed on a malformed id. */
export function splitModelId(id: string): { provider: string; id: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new TypeSafeIntegrationError("configuration", `PI_TYPESAFE_MODEL must be <provider>/<id>; got ${JSON.stringify(id)}.`);
  }
  return { provider: id.slice(0, slash), id: id.slice(slash + 1) };
}

const CAP_LABELS: Record<BlockedCap["cap"], string> = {
  requestsPerDay: "daily request cap",
  inputTokensPerDay: "daily input-token cap",
  usdPerDay: "daily spend cap",
};

function capsDescription(caps: SpendCaps): string {
  const parts = [
    caps.maxRequests === undefined ? undefined : `${caps.maxRequests} per session`,
    caps.maxRequestsPerDay === undefined ? undefined : `${caps.maxRequestsPerDay} requests per day`,
    caps.maxInputTokensPerDay === undefined ? undefined : `${caps.maxInputTokensPerDay} input tokens per day`,
    caps.maxUsdPerDay === undefined ? undefined : `$${caps.maxUsdPerDay} per day`,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? `Caps: ${parts.join(", ")}.` : "No request or spend caps are set.";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeSafeIntegrationError("configuration", `${label} must be a positive safe integer.`);
  }
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeSafeIntegrationError("configuration", `${label} must be a positive number.`);
  }
  return value;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** The core answer shape is checked against the question that produced it; a mismatch is not a judgment. */
function validAnswer(question: ClassifierQuestion, answer: ClassifierAnswer | undefined): boolean {
  if (!answer) return false;
  if (question.type === "bool") return answer.type === "bool" && probability(answer.probability);
  if (question.type === "score") return answer.type === "score" && Number.isFinite(answer.score) && probability(answer.confidence);
  if (question.type !== "choice" || answer.type !== "choice") return false;
  if (!probability(answer.confidence) || typeof answer.choice !== "string") return false;
  const keys = Object.keys(question.criteria);
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).length !== keys.length) return false;
  if (keys.some(key => !probability(probabilities[key]))) return false;
  return keys.includes(answer.choice);
}

function validResult(result: ClassifierResult, request: ClassifierContext): boolean {
  const ids = Object.keys(request.questions);
  const answers = result.answers;
  if (!answers || Object.keys(answers).length !== ids.length) return false;
  return ids.every(id => validAnswer(request.questions[id] as ClassifierQuestion, answers[id]));
}

/** One short, single-line, body-free reason. Provider bodies never reach the UI or the agent. */
function safeStopMessage(stopReason: ClassifierResult["stopReason"], message: string | undefined): string {
  const base = stopReason === "aborted"
    ? "TypeSafe request cancelled; an already submitted request may still be billed."
    : "TypeSafe did not return a judgment.";
  if (!message) return base;
  const line = (message.split(/\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ").trim();
  if (!line || line.length > 200 || /[{}<>]/.test(line)) return base;
  return `${base} ${line}`;
}

function tokensOf(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A governance wrapper around Pi core's classifier support, independent of the transport. */
export function createTypeSafe(ctx: ExtensionContext, options: TypeSafeOptions = {}): TypeSafe {
  const timeout = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
  const maxInputBytes = positiveInteger(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, "maxInputBytes");
  const maxRequests = positiveInteger(options.maxRequests ?? DEFAULT_MAX_REQUESTS, "maxRequests");
  const usdPerMTok = positiveNumber(options.usdPerMTok ?? DEFAULT_USD_PER_MTOK, "usdPerMTok");
  const caps = mergeCaps({
    maxRequests,
    ...(options.maxRequestsPerDay === undefined ? {} : { maxRequestsPerDay: positiveInteger(options.maxRequestsPerDay, "maxRequestsPerDay") }),
    ...(options.maxInputTokensPerDay === undefined ? {} : { maxInputTokensPerDay: positiveInteger(options.maxInputTokensPerDay, "maxInputTokensPerDay") }),
    ...(options.maxUsdPerDay === undefined ? {} : { maxUsdPerDay: positiveNumber(options.maxUsdPerDay, "maxUsdPerDay") }),
  }, capsFromEnvironment());

  // Resolve exactly one classifier. Never fall back to an arbitrary one: a wrong judge is worse than no judge.
  const modelId = options.model ?? resolveModelId();
  const { provider, id } = splitModelId(modelId);
  const model = ctx.modelRegistry.findOfType("classifier", provider, id) as ClassifierModel<ClassifierApi> | undefined;
  if (!model) {
    throw new TypeSafeIntegrationError("configuration", `No classifier model "${modelId}" is registered. Set PI_TYPESAFE_MODEL to an available <provider>/<id>.`);
  }

  const ledger = options.ledger ?? openUsageLedger({ usdPerMTok });
  const usage = { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0 };

  const snapshot = (): UsageSnapshot => ({ ...usage, estimatedUsd: estimateUsd(usage.inputTokens, usdPerMTok) });
  const blocked = (): BlockedCap | undefined => (usage.requestsStarted >= maxRequests ? undefined : ledger.blocked(caps));
  const count = (input: number, output: number) => {
    usage.inputTokens += tokensOf(input);
    usage.outputTokens += tokensOf(output);
  };

  const typesafe: TypeSafe = {
    getUsage: snapshot,
    getSpend: () => {
      const reached = blocked();
      return {
        session: snapshot(),
        today: ledger.today(),
        caps,
        usdPerMTok,
        ...(reached === undefined ? {} : { blocked: reached }),
      };
    },
    async evaluate(input: ClassifierContext, callOptions: EvaluationOptions = {}): Promise<Evaluation> {
      const request = prepareEvaluationRequest(input, { maxInputBytes });
      if (callOptions.signal?.aborted) throw new TypeSafeIntegrationError("aborted", "TypeSafe request cancelled before submission.");
      if (usage.requestsStarted >= maxRequests) {
        throw new TypeSafeIntegrationError("budget", `TypeSafe request limit reached (${maxRequests} attempts per client instance). ${capsDescription(caps)}`);
      }
      const reached = ledger.blocked(caps);
      if (reached) {
        // Name the cap, the used amount, and the day, so a long run stops loudly instead of burning tokens unnoticed.
        throw new TypeSafeIntegrationError("budget", `TypeSafe ${CAP_LABELS[reached.cap]} reached (${reached.used} of ${reached.limit} on ${reached.day}); no request was submitted. Requests resume after the local day rolls over, or raise the cap deliberately.`);
      }
      // Snapshot before awaiting so later mutations cannot change the request or validation.
      usage.requestsStarted += 1;
      ledger.recordStart();
      const start = performance.now();
      const result = await ctx.modelRegistry.classify(model, request, {
        ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
        maxRetries: 0,
        timeoutMs: timeout,
      });
      const elapsedMs = Math.round(performance.now() - start);
      if (result.stopReason !== "stop") {
        // The request was submitted, so it counts even when it fails; billed tokens count too.
        usage.requestsFailed += 1;
        count(result.usage?.input ?? 0, result.usage?.output ?? 0);
        ledger.recordFailure(result.usage?.input ?? 0, result.usage?.output ?? 0);
        const code = result.stopReason === "aborted" ? "aborted" : "response";
        throw new TypeSafeIntegrationError(code, safeStopMessage(result.stopReason, result.errorMessage));
      }
      if (!validResult(result, request)) {
        usage.requestsFailed += 1;
        count(result.usage?.input ?? 0, result.usage?.output ?? 0);
        ledger.recordFailure(result.usage?.input ?? 0, result.usage?.output ?? 0);
        throw new TypeSafeIntegrationError("response", "TypeSafe returned an unexpected answer or usage format.");
      }
      usage.requestsSucceeded += 1;
      count(result.usage?.input ?? 0, result.usage?.output ?? 0);
      ledger.recordSuccess(result.usage?.input ?? 0, result.usage?.output ?? 0);
      return { ...result, elapsedMs };
    },
    evaluateMany: (requests, batchOptions = {}) => evaluateMany(typesafe, requests, batchOptions),
    evaluateAll: (request, batchOptions = {}) => evaluateAll(typesafe, request, batchOptions),
  };
  return typesafe;
}
