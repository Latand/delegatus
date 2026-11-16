import { expect, spyOn, test } from "bun:test";
import { completionRefusal, answerTooLongNotice } from "./completionRefusal";
import { ExternalRelayError } from "./errors";
import { completeRelayRequest } from "./relayCompletion";
import { startTestRelay } from "./testRelay";
import type { PairedRelay } from "./store";
import type { ExternalRelayCompletion } from "./protocol";

test("refusal diagnostics keep only approved service vocabulary", () => {
  expect(answerTooLongNotice(32)).toBe("Answer too long to deliver.");
  expect(answerTooLongNotice(9)).toBe("Too long.");
  expect(answerTooLongNotice(1)).toBeNull();
  for (const error of [{ reason: "secret parser text" }, { reason: { text: "private input" } }]) {
    expect(completionRefusal(new ExternalRelayError("secret-code", 422, null, { error }))).toEqual({
      status: 422, code: "unrecognized_service_code", reason: "redacted_service_reason",
    });
  }
  expect(completionRefusal(new ExternalRelayError("invalid_format", 422, null, { error: [{ reason: "rich_limit_exceeded" }] })))
    .toEqual({ status: 422, code: "invalid_format", reason: "rich_limit_exceeded" });
  expect(completionRefusal(new ExternalRelayError("malformed", Infinity))).toEqual({ status: 0, code: "malformed", reason: "malformed" });
  expect(answerTooLongNotice(32)).toBe("Answer too long to deliver.");
  expect(answerTooLongNotice(1)).toBeNull();
});

for (const [status, code] of [[422, "invalid_format"], [400, "malformed"], [415, "invalid_format"], [413, "too_large"]] as const) {
  for (const rejectNotice of [false, true]) test(`length refusal ${status}, notice refused=${rejectNotice}`, async () => {
    const sent: ExternalRelayCompletion[] = [];
    const refusals: unknown[] = [];
    const log = spyOn(console, "error").mockImplementation(() => {});
    const service = await startTestRelay((_request, body) => {
      sent.push(body as ExternalRelayCompletion);
      return sent.length === 1 || rejectNotice ? { status, body: { error: { code, reason: "answer_too_long", message: "private input" } } } : { body: {} };
    });
    const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
    const body: ExternalRelayCompletion = { lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: "я".repeat(7200), reply_to: "m1", format: "rich_markdown", buttons: [] } };
    const until = Date.now() + 5000;
    try {
      const result = await completeRelayRequest(relay, "length_fixture", body, () => until, undefined, undefined, 4000, refusal => refusals.push(refusal));
      expect(sent).toHaveLength(2);
      expect(result).toMatchObject({ delivery: rejectNotice ? "refused" : "accepted", tooLong: true,
        body: { outcome: "answered", answer: { text: answerTooLongNotice(4000), reply_to: "m1" } } });
      expect(body.answer.text).toHaveLength(7200);
      expect(refusals).toEqual(Array(rejectNotice ? 2 : 1).fill({ status, code, reason: "answer_too_long" }));
      expect(log.mock.calls.filter(call => call[0] === "External relay completion refused")).toHaveLength(refusals.length);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private input");
    } finally { log.mockRestore(); await service.close(); }
  });
}

test("owner authority revoked after refusal prevents the replacement reply", async () => {
  const sent: ExternalRelayCompletion[] = [];
  let allowed = true;
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    return sent.length === 1 ? { status: 422, body: { error: { code: "invalid_format" } } } : { body: {} };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  const until = Date.now() + 5000;
  try {
    const result = await completeRelayRequest(relay, "revoked_fixture", {
      lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: "я".repeat(7200), reply_to: null, format: "rich_markdown", buttons: [] },
    }, () => until, () => allowed, undefined, 4000, () => { allowed = false; });
    expect(result).toMatchObject({ body: { outcome: "failed", reason: "cancelled" }, delivery: "accepted" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty("answer");
  } finally { await service.close(); }
});
