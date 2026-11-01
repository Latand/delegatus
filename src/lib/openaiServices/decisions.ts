import { ASK_QUESTIONS, classifierText, classifyWithJev, JevError, JEV_TIMEOUT_MS, type JevVerdict } from "@/lib/asks/jev";
import type { ClassifierProvider } from "./policy";

export const DECISIONS_MODEL = "gpt-6-luna";
export const DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions";
export const DECISIONS_MAX_INPUT_PRICE_USD = 0.1375e-6;
type GroundedRequest = { state: unknown; questions: Record<string, { instructions: unknown; criteria?: unknown }> };
export function decisionsRequest(body: GroundedRequest) {
  return { model: DECISIONS_MODEL,
    input: [{ role: "user", content: [
      ...(typeof object(body.state).task === "string" ? [{ type: "input_text", text: object(body.state).task }] : []),
      { type: "input_json", data: body.state }] }],
    questions: Object.entries(body.questions).map(([name, question]) => ({ type: "predicate", name,
      instructions: typeof question.instructions === "string" && question.criteria === undefined ? question.instructions
        : JSON.stringify({ instructions: question.instructions, ...(question.criteria === undefined ? {} : { criteria: question.criteria }) }) })) };
}
export function askDecisionsRequest(text: string) {
  return { model: DECISIONS_MODEL, input: classifierText(text),
    questions: Object.entries(ASK_QUESTIONS).map(([name, value]) => ({ type: "predicate", name, instructions: value.instructions })) };
}
export function decisionsCostCeilingUsd(request: unknown, allowance = 4096): number {
  return (allowance + Buffer.byteLength(JSON.stringify(request))) * DECISIONS_MAX_INPUT_PRICE_USD;
}
export const askDecisionsCeilingUsd = (text: string) => decisionsCostCeilingUsd(askDecisionsRequest(text), 1024);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function decisionsUsage(value: unknown): { cost: number; inputTokens: number } | null {
  const usage = object(value), details = object(usage.input_tokens_details);
  const tokens = usage.input_tokens, cached = details.cached_tokens ?? 0, written = details.cache_write_tokens ?? 0;
  if (!count(tokens) || !count(cached) || !count(written) || cached + written > tokens) return null;
  return { cost: ((tokens - cached - written) * .10 + cached * .01 + written * .125) / 1e6, inputTokens: tokens };
}
export async function decideWithOpenAi(body: { questions: { name: string }[] }, options: { apiKey: string; signal: AbortSignal; fetch?: typeof fetch }) {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(DECISIONS_ENDPOINT, { method: "POST", redirect: "error", signal: options.signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new JevError(options.signal.aborted ? "timeout" : "network", "the classifier could not be reached"); }
  if (!response.ok) throw new JevError("http", `the classifier answered ${response.status}`, response.status);
  let parsed: unknown;
  try { parsed = await response.json(); }
  catch { throw new JevError(options.signal.aborted ? "timeout" : "shape", "the classifier's answer is unreadable", response.status); }
  const record = object(parsed), usage = decisionsUsage(record.usage);
  const fail = () => new JevError("shape", "the classifier's answer is invalid", response.status, usage?.cost ?? null);
  if (!usage || !Array.isArray(record.answers) || record.answers.length !== body.questions.length) throw fail();
  const expected = new Set(body.questions.map(row => row.name));
  const scores: Record<string, number> = {};
  for (const value of record.answers) {
    const row = object(value);
    if (row.type !== "predicate" || typeof row.name !== "string" || !expected.delete(row.name)
      || typeof row.probability !== "number" || !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1) throw fail();
    scores[row.name] = row.probability;
  }
  if (expected.size) throw fail();
  return { scores, ...usage };
}
export async function classifyWithDecisions(text: string, options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<JevVerdict> {
  const result = await decideWithOpenAi(askDecisionsRequest(text), { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS) });
  const { asks, waiting, decision } = result.scores;
  return { score: Math.max(asks, waiting, decision), answers: { asks, waiting, decision }, inputTokens: result.inputTokens, costUsd: result.cost };
}
export function classify(text: string, resolved: { provider: ClassifierProvider; apiKey: string }): Promise<JevVerdict> {
  return resolved.provider === "openai" ? classifyWithDecisions(text, resolved) : classifyWithJev(text, resolved);
}
