import type { ClassifierContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { TypeSafeIntegrationError } from "./errors.js";

/** Default UTF-8 JSON byte budget for one evaluation request; the tool and the client share it. */
export const DEFAULT_MAX_INPUT_BYTES = 65_536;

/** Questions one request may ask. More than this needs `chunkEvaluationRequest`, which splits and fans out. */
export const DEFAULT_MAX_QUESTIONS = 32;

const instructions = Type.String({ description: "One judgment about the whole state, phrased as a question or a statement." });
const question = Type.Union([
  Type.Object({
    type: Type.Literal("bool", { description: "Yes or no: the probability the instructions hold." }),
    instructions,
    criteria: Type.Object({
      true: Type.String({ description: "What counts as yes." }),
      false: Type.String({ description: "What counts as no." }),
    }, { additionalProperties: false, description: "What counts as true and what counts as false." }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("choice", { description: "Pick one criteria label." }),
    instructions,
    criteria: Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.String(), {
      minProperties: 1,
      maxProperties: 64,
      description: "The options as a map from label to when it applies: { billing: \"Charges and payments\", other: \"None of these\" }. 1–64 entries.",
    }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("score", { description: "Rate against the ordered criteria levels." }),
    instructions,
    criteria: Type.Array(Type.String(), { minItems: 2, maxItems: 32, description: "Ordered rubric levels, lowest first: [\"neutral\", \"angry\"]. 2–32 levels." }),
  }, { additionalProperties: false }),
]);

/** The JSON schema used by both the Pi tool and the programmatic interface. */
export const evaluationSchema = Type.Object({
  state: Type.Record(Type.String(), Type.Unknown(), { description: "What to judge: a JSON object whose fields the questions name." }),
  questions: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), question, {
    minProperties: 1,
    maxProperties: DEFAULT_MAX_QUESTIONS,
    description: "Questions keyed by a short id, as an object map, not an array: { \"urgent\": { type: \"bool\", instructions: ... } }.",
  }),
}, { additionalProperties: false });

const usage = `Expected { state: <object>, questions: { <id>: { type: "bool", instructions, criteria: { true, false } } | { type: "choice", instructions, criteria: { label: description } } | { type: "score", instructions, criteria: [level0, level1, ...] } } }; 1–${DEFAULT_MAX_QUESTIONS} questions, Choice 1–64 options, Score 2–32 levels.`;

/** Paths and messages only; never the submitted values. */
function describeSchemaErrors(value: unknown): string {
  const details: string[] = [];
  for (const error of Errors(evaluationSchema, value)) {
    const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".") || "request";
    details.push(`${path.slice(0, 120)}: ${error.message}`);
    if (details.length === 3) break;
  }
  return details.join("; ");
}

/** Validate without including submitted content in validation errors. Prefer prepareEvaluationRequest(), which also accepts near-misses and enforces the byte budget. */
export function parseEvaluationRequest(value: unknown): ClassifierContext {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !isJsonSafe(value)) {
    throw new TypeSafeIntegrationError("validation", `Invalid evaluation request: state and questions must be plain JSON. ${usage}`);
  }
  if (!Check(evaluationSchema, value)) {
    throw new TypeSafeIntegrationError("validation", `Invalid evaluation request at ${describeSchemaErrors(value)}. ${usage}`);
  }
  return value as unknown as ClassifierContext;
}

function isJsonSafe(value: unknown): boolean {
  try {
    // Walk before schema validation to reject cycles and non-JSON values.
    // Object descriptors avoid executing getters while checking user data.
    const ancestors = new Set<object>();
    const walk = (item: unknown, depth: number): void => {
      if (depth > 64) throw new Error();
      if (item === null || typeof item === "string" || typeof item === "boolean") return;
      if (typeof item === "number" && Number.isFinite(item)) return;
      if (typeof item !== "object" || ancestors.has(item)) throw new Error();
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error();
      ancestors.add(item);
      if (Object.getOwnPropertySymbols(item).length) throw new Error();
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (Array.isArray(item) && key === "length") continue;
        if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new Error();
        // JSON serialization omits undefined object fields; array elements must remain JSON.
        if (descriptor.value === undefined && !Array.isArray(item)) continue;
        walk(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    };
    walk(value, 0);
    return true;
  } catch {
    return false;
  }
}

/** Null/undefined descriptions become empty strings; anything else is left for the schema to accept or reject. */
function description(value: unknown): unknown {
  return value === null || value === undefined ? "" : value;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Accept common near-misses from language models without loosening the schema itself. Prefer prepareEvaluationRequest(),
 * which applies this before validating. Legacy `noul` questions become `bool`; missing bool criteria become empty
 * strings rather than invented "Yes"/"No" text, because the criteria are sent to the classifier verbatim.
 */
export function normalizeEvaluationRequest(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const request = value as Record<string, unknown>;
  const questions = request.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions as Record<string, unknown>)) {
    if (!question || typeof question !== "object" || Array.isArray(question)) { normalized[id] = question; continue; }
    const { options, levels, choices, ...rest } = question as Record<string, unknown>;
    const item: Record<string, unknown> = { ...rest };
    if (item.criteria === undefined) {
      const alias = options ?? levels ?? choices;
      if (alias !== undefined) item.criteria = alias;
    }
    if (item.type === "noul") item.type = "bool";
    if (item.type === "bool") {
      const criteria = item.criteria;
      if (typeof criteria === "string") item.criteria = { true: criteria, false: "" };
      else if (criteria && typeof criteria === "object" && !Array.isArray(criteria)) {
        const map = criteria as Record<string, unknown>;
        item.criteria = { true: stringOrEmpty(map.true), false: stringOrEmpty(map.false) };
      } else {
        item.criteria = { true: "", false: "" };
      }
    }
    if (item.type === "choice") {
      const criteria = item.criteria;
      if (Array.isArray(criteria) && criteria.every(label => typeof label === "string" && label)) {
        item.criteria = Object.fromEntries((criteria as string[]).map(label => [label, ""]));
      } else if (criteria && typeof criteria === "object" && !Array.isArray(criteria)) {
        item.criteria = Object.fromEntries(Object.entries(criteria as Record<string, unknown>).map(([key, value]) => [key, description(value)]));
      }
    }
    if (item.type === "score" && Array.isArray(item.criteria)) {
      item.criteria = item.criteria.map(description);
    }
    normalized[id] = item;
  }
  return { ...request, questions: normalized };
}

export interface PrepareEvaluationOptions {
  /** UTF-8 JSON bytes of the serialized request. Default: DEFAULT_MAX_INPUT_BYTES. */
  maxInputBytes?: number;
}

/** One byte rule for every limit check: measure the serialized request and name the configured limit. */
export function assertWithinByteLimit(text: string, maxInputBytes: number): void {
  if (Buffer.byteLength(text, "utf8") > maxInputBytes) {
    throw new TypeSafeIntegrationError("validation", `Evaluation exceeds the ${maxInputBytes}-byte input limit.`);
  }
}

/**
 * The one admission rule: normalize known near-miss aliases, validate the schema and JSON-safety, then enforce the byte
 * budget — always in that order. The Pi tool, the playground, and client.evaluate() all pass through here, so what one
 * accepts the others accept.
 */
export function prepareEvaluationRequest(value: unknown, options: PrepareEvaluationOptions = {}): ClassifierContext {
  const validated = parseEvaluationRequest(normalizeEvaluationRequest(value));
  assertWithinByteLimit(JSON.stringify(validated), options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES);
  return validated;
}
