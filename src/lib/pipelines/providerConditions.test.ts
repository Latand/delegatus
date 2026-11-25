import { expect, test } from "bun:test";
import { classifyProviderCondition } from "./providerConditions";

for (const scope of ["session", "weekly", "Opus", "Sonnet", "Fable"]) {
  test(`classifies Claude ${scope} capacity`, () => {
    expect(classifyProviderCondition("claude", "rate_limit", `You've reached your ${scope} limit · resets 2:30pm`))
      .toMatchObject({ kind: "usage_limit", scope: scope.toLowerCase(), resetLabel: "resets 2:30pm" });
  });
}
for (const [engine, code, text, kind] of [
  ["claude", "server_error", "Failed to refresh OAuth token: retry in a minute", "transient"],
  ["claude", "overloaded", "busy", "transient"],
  ["claude", "rate_limit", "too many requests", "transient"],
  ["claude", "authentication_failed", "expired", "auth_required"],
  ["codex", "usage_limit_exceeded", "limit", "usage_limit"],
  ["codex", "unauthorized", "expired", "auth_required"],
  ["codex", "stream_disconnected", "stream ended", "transient"],
  ["codex", "other", "Selected model is at capacity. Please try a different model.", "transient"],
  ["codex", "other", "failed to load the session: invalid data", "other"],
  ["claude", "other", "failed to load workspace requirements: invalid data", "other"],
  ["codex", "unauthorized", "failed to load workspace requirements: invalid data", "auth_required"],
  ["codex", "turn_aborted", "interrupted", "turn_cut"],
  ["claude", "interrupted", "interrupted", "turn_cut"],
  ["claude", "invalid_request", "bad request", "other"],
] as const) {
  test(`classifies ${engine} ${code}`, () => expect(classifyProviderCondition(engine, code, text).kind).toBe(kind));
}


test("native Codex overload code retains capacity backoff even without English wording", () => {
  expect(classifyProviderCondition("codex", "server_overloaded", "Capacity is temporarily unavailable")).toMatchObject({ kind: "transient", label: "model at capacity" });
});

test("matches the Codex workspace requirements provider failure", () => {
  expect(classifyProviderCondition("codex", "other", "failed to load workspace requirements: invalid data"))
    .toMatchObject({ kind: "transient", label: "workspace requirements failure" });
});

test("distinguishes the Codex cybersecurity refusal from other provider errors", () => {
  const notice = "This content was flagged for possible cybersecurity risk";
  const refusal = { kind: "other", label: "Codex cybersecurity refusal" };
  expect(classifyProviderCondition("codex", "cyber_policy", "")).toMatchObject(refusal);
  expect(classifyProviderCondition("codex", "other", notice)).toMatchObject(refusal);
  expect(classifyProviderCondition("codex", null, `API Error: ${notice}. Review the request.`)).toMatchObject(refusal);
  expect(classifyProviderCondition("claude", "other", notice)).toMatchObject({ kind: "other", label: "provider error" });
  expect(classifyProviderCondition("codex", "other", `Unexpected response: "${notice}"`))
    .toMatchObject({ kind: "other", label: "provider error" });
  expect(classifyProviderCondition("codex", "stream_disconnected", notice)).toMatchObject({ kind: "transient", label: "transient provider error" });
  expect(classifyProviderCondition("codex", "usage_limit_exceeded", notice)).toMatchObject({ kind: "usage_limit" });
  expect(classifyProviderCondition("codex", "other", `failed to load workspace requirements: ${notice}`))
    .toMatchObject({ kind: "transient", label: "workspace requirements failure" });
});
