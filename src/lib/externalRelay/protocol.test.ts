import { expect, test } from "bun:test";
import { checkedAnswer, normalizePairCode, requestSchema } from "./protocol";
export const sampleRequest = {
  request_id: "rq_1",
  lease_id: "ls_Zq3vN8bY1xKp4LmT0aW9rE",
  kind: "answer",
  target_id: "target_1",
  claimed_at: "2026-09-28T12:00:01Z",
  liveness: {
    poll_freshness_s: 60,
    claim_window_s: 5,
    ack_window_s: 10,
    heartbeat_interval_s: 10,
    stall_window_s: 45,
  },
  input: {
    instructions: "Answer briefly",
    owner_instructions: null,
    documents: [],
    conversation: [
      {
        id: "m1",
        author: { key: "u1", name: "User", self: false },
        sent_at: "2026-09-28T12:00:00Z",
        text: "Hello",
        reply_to: null,
      },
    ],
    respond_to: "m1",
    request_text: null,
  },
  answer: { max_chars: 20, progress: "notes" },
} as const;
test("request limits and additive fields", () => {
  expect(
    requestSchema.safeParse({ ...sampleRequest, x_future: 1 }).success,
  ).toBe(true);
  expect(
    requestSchema.safeParse({
      ...sampleRequest,
      answer: { max_chars: 32001, progress: "notes" },
    }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...sampleRequest,
      input: {
        ...sampleRequest.input,
        documents: Array.from({ length: 21 }, () => ({
          title: "x",
          text: "y",
        })),
      },
    }).success,
  ).toBe(false);
});
test("answer checks and code normalization", () => {
  const request = requestSchema.parse(sampleRequest);
  expect(normalizePairCode("io-lL")).toBe("10-11");
  expect(
    checkedAnswer({ action: "reply", text: " ", reply_to: null }, request),
  ).toBeNull();
  expect(
    checkedAnswer(
      { action: "reply", text: "x".repeat(21), reply_to: null },
      request,
    ),
  ).toBeNull();
  expect(
    checkedAnswer(
      { action: "reply", text: "hello", reply_to: "foreign" },
      request,
    ),
  ).toEqual({ action: "reply", text: "hello", reply_to: null });
  expect(
    checkedAnswer(
      { action: "ignore", text: "discard", reply_to: "m1" },
      request,
    )?.text,
  ).toBe("");
});
