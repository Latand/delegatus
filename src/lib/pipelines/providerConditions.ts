import type { RuntimeEngine } from "@/lib/agent/runtimeConfig";

export type ProviderCondition = {
  kind: "usage_limit" | "transient" | "auth_required" | "other" | "host_death" | "turn_cut";
  scope: string | null;
  resetLabel: string | null;
  label: string;
};

/** Call only for a provider error record, never an ordinary agent message. */
export function classifyProviderCondition(engine: RuntimeEngine, errorClass: string | null | undefined, text: string): ProviderCondition {
  const code = (errorClass ?? "").toLowerCase();
  if (["turn_aborted", "interrupted", "aborted"].includes(code)) {
    return { kind: "turn_cut", scope: null, resetLabel: null, label: "aborted stage turn" };
  }
  const limit = /^You've (?:hit|reached) your (.+?) limit\b/i.exec(text.trim());
  const scope = limit?.[1]?.toLowerCase().slice(0, 64) ?? null;
  const resetLabel = /resets\s+[^\n]+/i.exec(text)?.[0].slice(0, 160) ?? null;
  if ((engine === "claude" && code === "rate_limit" && limit)
    || (engine === "codex" && ["usage_limit", "usage_limit_exceeded"].includes(code))) {
    return { kind: "usage_limit", scope: scope ?? "usage", resetLabel, label: `${engine} ${scope ?? "usage"} limit` };
  }
  if (["authentication_failed", "unauthorized"].includes(code)
    || /OAuth session expired and could not be refreshed/i.test(text)) {
    return { kind: "auth_required", scope: null, resetLabel: null, label: "authentication required" };
  }
  const race = /Failed to refresh OAuth token|retry in a minute/i.test(text);
  if ((code === "server_error" && race) || ["overloaded", "rate_limit", "stream_disconnected", "stream_disconnect", "stream_connection_failed", "http_connection_failed"].includes(code)) {
    return { kind: "transient", scope: null, resetLabel: null, label: race ? "auth refresh race" : "transient provider error" };
  }
  return { kind: "other", scope: null, resetLabel: null, label: "provider error" };
}
