import { afterEach, expect, spyOn, test } from "bun:test";
import { RESOURCE } from "./constants";
import { streamPlanResponse, unsupportedFields } from "./responses";
import { complete, stream, synth } from "./plan.fixture";

let calls = 0;
const body = { input: [{ role: "developer", content: "Answer briefly." }] };
const access = synth("access");
const http = (result: () => Response) => (async (url: string, init: RequestInit) => {
  calls++;
  expect(url).toBe(`${RESOURCE}/responses`);
  expect(init.redirect).toBe("error");
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${access}`);
  expect(new Headers(init.headers).get("openai-project")).toBeNull();
  expect(JSON.parse(String(init.body))).toMatchObject({ store: false, stream: true });
  return result();
}) as typeof fetch;
const attempt = (result: () => Response, options: Record<string, unknown> = body, onDelta?: (text: string) => void) =>
  streamPlanResponse(http(result), access, options, AbortSignal.timeout(1_000), onDelta);
afterEach(() => { calls = 0; });

test("the output is complete only after response.completed", async () => {
  const output = { output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] };
  const deltas: string[] = [];
  expect(await attempt(() => stream({ type: "response.output_text.delta", delta: "Done." }, complete(output)), { ...body, store: true, stream: false }, text => deltas.push(text))).toEqual(output);
  expect(deltas).toEqual(["Done."]);
  expect(calls).toBe(1);
});

test("unsupported capabilities and system items fail before fetch", async () => {
  for (const field of unsupportedFields) await expect(attempt(() => stream(), { ...body, [field]: null })).rejects.toThrow("request_invalid");
  await expect(attempt(() => stream(), { input: [{ type: "message", role: "system" }] })).rejects.toThrow("request_invalid");
  expect(calls).toBe(0);
});

test.each([
  ["subscription_sharing_usage_limit_exceeded", "plan_limit"],
  ["subscription_sharing_usage_unavailable", "retry_later"],
  ["subscription_sharing_user_unavailable", "retry_later"],
  ["subscription_sharing_user_not_eligible", "not_eligible"],
  ["subscription_sharing_unsupported_capability", "request_invalid"],
  ["subscription_sharing_route_not_supported", "policy_denied"],
  ["chatpass_v2_scope_not_authorized", "policy_denied"],
  ["chatpass_v2_invalid_authorization_context", "policy_denied"],
  ["subscription_sharing_invalid_user", "credential_rejected"],
])("%s maps from a failed stream", async (code, reason) => {
  await expect(attempt(() => stream({ type: "response.failed", response: { error: { code, param: "model" } } }))).rejects.toThrow(reason);
});

test.each([[401, "credential_rejected"], [403, "policy_denied"], [503, "retry_later"]] as const)("admission %i drops the diagnostic text", async (status, reason) => {
  const logs = spyOn(console, "info").mockImplementation(() => {});
  try {
    await expect(attempt(() => Response.json({ detail: access }, { status, headers: { "x-request-id": "request-fixture" } }))).rejects.toThrow(reason);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(access);
    expect(JSON.stringify(logs.mock.calls)).toContain("request-fixture");
  } finally { logs.mockRestore(); }
});

test("incomplete, early EOF, and oversized data fail without a completed result", async () => {
  await expect(attempt(() => stream({ type: "response.incomplete" }))).rejects.toThrow("interrupted");
  await expect(attempt(() => stream({ type: "response.output_text.delta", delta: "Incomplete" }))).rejects.toThrow("interrupted");
  await expect(attempt(() => new Response("x".repeat(4 * 1024 * 1024 + 1)))).rejects.toThrow("interrupted");
});
