/*
 * The classifier call (docs/research/attention-classifier.md §2, §4): Jev
 * through OpenRouter's decisions endpoint, the request Celestia's antispam
 * Tier-0 makes, with the three `noul` statements the evaluation scored as
 * "Jev V2". The score is the highest of the three; the research chose 0.85.
 *
 * One request per message, a two-second timeout and no retry. Whatever goes
 * wrong is an error for the caller, which leaves the message unclassified.
 */

export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_TIMEOUT_MS = 2_000;
export const ASK_THRESHOLD = 0.85;
/** USD per input token; output is free (§2). */
export const JEV_INPUT_PRICE_USD = 0.042e-6;

/** The statements, word for word as the evaluation sent them (§4, "Jev V2").
    The fourth one it tried, the agent's own failure, changed nothing at the
    chosen threshold and is left out. */
export const ASK_QUESTIONS = {
  asks: {
    type: "noul",
    instructions: "The message asks the human operator a question or asks the operator to reply, choose, confirm or approve something.",
  },
  waiting: {
    type: "noul",
    instructions: "The agent says it is stopped, blocked or waiting and will not continue until the operator acts (a decision, permission, credentials, a login, a command only the operator can run).",
  },
  decision: {
    type: "noul",
    instructions: "The message presents options or a proposal and leaves the choice to the operator.",
  },
} as const;

type AskQuestion = keyof typeof ASK_QUESTIONS;

export interface JevVerdict {
  score: number;
  answers: Record<AskQuestion, number>;
  /** What the provider billed, in USD. */
  costUsd: number;
  inputTokens: number;
}

export class JevError extends Error {
  constructor(readonly code: "timeout" | "http" | "shape" | "network", message: string, readonly status: number | null = null) {
    super(message);
    this.name = "JevError";
  }
}

/** The redaction the evaluation applied before any text left the machine:
    addresses, key-shaped strings, long opaque tokens, home paths, and memory
    citation blocks. */
export function redactForClassifier(text: string): string {
  return text
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b(sk-[\w-]{10,}|gh[pousr]_\w{20,}|xox[\w-]{10,}|AIza[\w-]{20,}|ssh-(ed25519|rsa) [A-Za-z0-9+/=]{20,})/g, "<secret>")
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "<blob>")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~");
}

/** A long message goes as its first 1,000 and last 3,000 characters (§3). */
export function classifierText(text: string): string {
  const redacted = redactForClassifier(text).trim();
  return redacted.length <= 4_000 ? redacted : `${redacted.slice(0, 1_000)} … ${redacted.slice(-3_000)}`;
}

/** What a call for this text costs, by the token formula §1 measured; the
    cap is checked against it before the call. */
export function estimatedJevCostUsd(text: string): number {
  return (462 + 0.42 * classifierText(text).length) * JEV_INPUT_PRICE_USD;
}

function probability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export async function classifyWithJev(
  text: string,
  options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<JevVerdict> {
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state: { agent_message: classifierText(text) }, questions: ASK_QUESTIONS }),
      signal: AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new JevError("timeout", "the classifier did not answer in time");
    throw new JevError("network", "the classifier could not be reached");
  }
  if (!response.ok) throw new JevError("http", `the classifier answered ${response.status}`, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JevError("shape", "the classifier's answer is not JSON");
  }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const answers = record.answers && typeof record.answers === "object" ? record.answers as Record<string, unknown> : {};
  const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : {};
  const read = (name: AskQuestion) => {
    const answer = answers[name];
    return answer && typeof answer === "object" ? probability((answer as Record<string, unknown>).noul) : null;
  };
  const asks = read("asks");
  const waiting = read("waiting");
  const decision = read("decision");
  const cost = typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
  if (asks === null || waiting === null || decision === null || cost === null) {
    throw new JevError("shape", "the classifier's answer is missing a probability or its cost");
  }
  const inputTokens = typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  return { score: Math.max(asks, waiting, decision), answers: { asks, waiting, decision }, costUsd: cost, inputTokens };
}
