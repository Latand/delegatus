import type { TokenCounts, UsageRecord } from "./tokenUsage";
export const USAGE_NOW = Date.parse("2026-10-18T12:00:00Z");
export const USAGE_AT = "2026-10-17T12:00:00Z";
export const usageCounts = (n = 1): TokenCounts => ({ input: 10*n, cacheRead: 80*n, cacheWrite: 10*n, cacheWrite1h: 4*n, output: 20*n, reasoning: 5*n, requests: 1 });
export function claudeUsage(id: string, at = USAGE_AT, n = 1) {
  return { type: "assistant", timestamp: at, message: { id, model: "fixture-model", content: [{ type: "text", text: "private response text" }],
    usage: { input_tokens: 10*n, cache_read_input_tokens: 80*n, cache_creation_input_tokens: 10*n,
      cache_creation: { ephemeral_1h_input_tokens: 4*n }, output_tokens: 20*n, output_tokens_details: { thinking_tokens: 5*n }, speed: "standard" } } };
}
export function codexMeta(id: string, extra = {}) {
  return { timestamp: USAGE_AT, type: "session_meta", payload: { id, cwd: "/work/fixture", originator: "llv-structured-host", ...extra } };
}
export function codexUsage(thread: string, total = 120, at = USAGE_AT, legacy = false) {
  const usage = { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
  const cumulative = Object.fromEntries(Object.entries(usage).map(([k,v]) => [k, v * total/120]));
  return { timestamp: at, type: legacy ? "event_msg" : "token_usage_record", payload: legacy
    ? { type: "token_count", info: { total_token_usage: cumulative, last_token_usage: usage } }
    : { thread_id: thread, response_id: `response-${thread}-${total}`, usage, thread_token_usage: cumulative } };
}
export const usageRecord = (id: string, at = USAGE_NOW - 86_400_000): UsageRecord => ({ engine: "claude", id, at, model: "fixture-model", tier: "standard", counts: usageCounts() });
