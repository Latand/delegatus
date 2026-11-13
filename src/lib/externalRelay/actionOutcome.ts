import type { ExternalRelayAnswer, ExternalRelayRequest, ToolCallResult } from "./protocol";
import { ExternalRelayError } from "./errors";

export type ActionOutcome = "done" | "not_done" | "verification_failed";
// Local declarations select a verifying read without extending the service wire.
// This read is an idempotent lookup through the original call, never a new action.
export const actionOutcomeReads: Readonly<Record<string, { read: "same_call"; label: { en: string; uk: string } }>> = Object.freeze({
  request_trigger_rule_update: { read: "same_call", label: { en: "trigger rule update", uk: "оновлення правила тригера" } },
});
export const ACTION_VERIFICATION_READS = 3;
export const ACTION_VERIFICATION_MS = 30_000;

export type ActionResolution = {
  result: ToolCallResult | null;
  outcome?: ActionOutcome;
  code?: string;
  output?: string;
  unknown?: boolean;
};
export function definiteActionOutcome(result: ToolCallResult): ActionOutcome | undefined {
  return result.status === "ok" ? "done" : result.status === "error" ? "not_done" : undefined;
}

async function withinDeadline<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** One bounded reconciliation for every declared action. The caller owns the
 * lease and exact wire identity; every read must recheck that authority. */
export async function establishActionOutcome(tool: string, read: (signal: AbortSignal, check: () => void, initial: boolean) => Promise<ToolCallResult>,
  signal: AbortSignal, runtime: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void>; budgetMs?: number; initial?: boolean },
): Promise<ActionResolution> {
  const budget = Math.max(0, Math.min(ACTION_VERIFICATION_MS, runtime.budgetMs ?? ACTION_VERIFICATION_MS));
  const deadline = runtime.now() + budget;
  const expired = new AbortController();
  const timer = setTimeout(() => expired.abort(), budget);
  const bounded = AbortSignal.any([signal, expired.signal]);
  const check = () => {
    if (runtime.now() >= deadline) expired.abort();
    bounded.throwIfAborted();
  };
  let reason = "no settled outcome";
  let delay = 1000;
  try {
    for (let attempt = runtime.initial ? -1 : 0; attempt < ACTION_VERIFICATION_READS; attempt++) {
      signal.throwIfAborted();
      if (runtime.now() >= deadline) { reason = "verification deadline expired"; break; }
      try {
        if (attempt >= 0) await withinDeadline(() => runtime.sleep(Math.min(delay, deadline - runtime.now()), bounded), bounded);
        bounded.throwIfAborted();
        if (runtime.now() >= deadline) { reason = "verification deadline expired"; break; }
        const result = await withinDeadline(() => read(bounded, check, attempt === -1), bounded);
        signal.throwIfAborted();
        // Timers may have been delayed by an event-loop stall. A late result
        // never counts as proof obtained inside this deadline.
        if (runtime.now() >= deadline || bounded.aborted) { reason = "verification deadline expired"; break; }
        const outcome = definiteActionOutcome(result);
        if (outcome) return { result, outcome };
        if (result.status === "denied" || result.status === "confirmation_pending") {
          reason = result.code ?? result.status; break;
        }
        reason = result.status;
        delay = (result.retry_after_s ?? 1) * 1000;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ExternalRelayError && [400, 401, 409, 413, 426].includes(error.status)) {
          if (attempt === -1 && [400, 401, 413, 426].includes(error.status))
            return { result: null, outcome: "not_done", code: error.code, output: "The call could not be completed." };
          reason = error.code; break;
        }
        reason = bounded.aborted || runtime.now() >= deadline ? "verification deadline expired" : "status read unavailable";
        if (bounded.aborted) break;
      }
    }
    return verificationFailed(tool, reason);
  } finally { clearTimeout(timer); }
}

export function verificationFailed(tool: string, reason: string): ActionResolution {
  return { result: null, unknown: true, outcome: "verification_failed", code: "verification_failed",
    output: `Action verification failed: the service's saved outcome for ${tool} could not be read (${reason}).` };
}

/** A group receives the established outcome even if the agent ignores its
 * result or fails to produce a final answer. Service output stays audience-bound. */
export function actionOutcomeAnswer(request: ExternalRelayRequest,
  results: readonly { tool: string; outcome?: ActionOutcome }[]): ExternalRelayAnswer | null {
  const outcomes = results.filter(result => result.outcome);
  if (!outcomes.length) return null;
  const source = request.input.request_text ?? request.input.conversation.find(message => message.id === request.input.respond_to)?.text ?? "";
  const ukrainian = /[а-яіїєґ]/iu.test(source);
  const text = outcomes.map(({ tool, outcome }) => {
    const label = Object.hasOwn(actionOutcomeReads, tool) ? actionOutcomeReads[tool]!.label[ukrainian ? "uk" : "en"] : tool;
    return outcome === "done" ? ukrainian ? `Виконано: ${label}.` : `Done: ${label}.`
      : outcome === "not_done" ? ukrainian ? `Не виконано: ${label}.` : `Not done: ${label}.`
        : ukrainian ? `Не вдалося перевірити результат дії «${label}»: збережений результат недоступний.`
          : `Verification failed for ${label}: the saved action outcome could not be read.`;
  }).join("\n");
  return { action: "reply", text: text.slice(0, request.answer.max_chars), reply_to: request.input.respond_to };
}
