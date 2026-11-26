import type { OperatorAskRecord, OperatorAsksFileV1 } from "./store";

/*
 * A synthetic asks store shaped like the one on a busy installation
 * (2026-11-12: 1.5 MB, 1,000 asks, 5,000 seen messages, 5,000 scores, revision
 * 24,055). Every id, path, title and gist is invented.
 */
export function syntheticOperatorAsks(now: Date, sizes = { asks: 1_000, seen: 5_000, scores: 5_000 }): OperatorAsksFileV1 {
  const asks: OperatorAskRecord[] = Array.from({ length: sizes.asks }, (_, index) => ({
    id: `ask-${index.toString(16).padStart(24, "0")}`,
    subject: `conversation-${index % 300}`,
    conversationId: `conversation-${index % 300}`,
    path: `/srv/agents/.codex/sessions/2026/11/rollout-${String(index % 300).padStart(6, "0")}.jsonl`,
    project: `repo-${(index % 13).toString(16).padStart(32, "0")}`,
    role: index % 3 === 0 ? "builder" : "reviewer",
    title: `Synthetic lane ${index % 300}`,
    messageId: `claude:message-${index}`,
    messageAt: now.getTime() - (sizes.asks - index) * 60_000,
    gist: `An invented question that waits for the operator to choose between two options, number ${index}, with enough words to be a typical gist of an ask line in the report log.`,
    score: 0.6 + (index % 40) / 100,
    recordedAt: new Date(now.getTime() - (sizes.asks - index) * 60_000 + 5_000).toISOString(),
  }));
  const seen = Array.from({ length: sizes.seen }, (_, index) => `conversation-${index % 300}:claude:message-${index}-${"x".repeat(40)}`);
  const scores = Object.fromEntries(Array.from({ length: sizes.scores }, (_, index) => [index.toString(16).padStart(64, "0"), (index % 100) / 100]));
  return {
    schemaVersion: 1,
    revision: 24_055,
    spend: { month: now.toISOString().slice(0, 7), usd: 3.217, calls: 1_204, capped: 2 },
    seen,
    scores,
    asks,
  };
}
