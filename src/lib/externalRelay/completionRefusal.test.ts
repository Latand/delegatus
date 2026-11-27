import { expect, spyOn, test } from "bun:test";
import { completionRefusal, answerTooLongNotice } from "./completionRefusal";
import { ExternalRelayError } from "./errors";
import { completeRelayRequest } from "./relayCompletion";
import { startTestRelay } from "./testRelay";
import type { PairedRelay } from "./store";
import type { ExternalRelayCompletion } from "./protocol";

test("refusal diagnostics keep only approved service vocabulary", () => {
  expect(answerTooLongNotice(20)).toBe("Answer too long.");
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

test("service message length reasons become fixed categories without parser text", () => {
  for (const [message, reason] of [
    ["rich_markdown answer exceeds the character limit: private parser input", "rich_limit_exceeded"],
    ["plain answer exceeds the length limit: private parser input", "plain_limit_exceeded"],
    ["answer too long: private parser input", "answer_too_long"],
    ["private parser input", "invalid_format"],
  ]) {
    expect(completionRefusal(new ExternalRelayError("invalid_format", 422, null, { error: { message } })))
      .toEqual({ status: 422, code: "invalid_format", reason });
  }
});

test("a rate-limited length notice retries the identical body", async () => {
  const sent: ExternalRelayCompletion[] = [];
  const refusals: unknown[] = [];
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    return sent.length === 1 ? { status: 422, body: { error: { code: "invalid_format" } } }
      : sent.length === 2 ? { status: 429, body: { error: { code: "rate_limited", retry_after_s: 0 } } } : { body: {} };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  const until = Date.now() + 5000;
  try {
    const result = await completeRelayRequest(relay, "rate_fixture", {
      lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: "я".repeat(7200), reply_to: null, format: "rich_markdown", buttons: [] },
    }, () => until, undefined, undefined, 4000, refusal => refusals.push(refusal));
    expect(result).toMatchObject({ delivery: "accepted", tooLong: true });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(sent[1]);
    expect(refusals).toEqual([{ status: 422, code: "invalid_format", reason: "invalid_format" }, { status: 429, code: "rate_limited", reason: "rate_limited" }]);
  } finally { await service.close(); }
});

test("a Markdown image marker in a fenced code sample does not block the length notice", async () => {
  const sent: ExternalRelayCompletion[] = [];
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    return sent.length === 1 ? { status: 422, body: { error: { code: "invalid_format", reason: "rich_limit_exceeded" } } } : { body: {} };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  const answer = ["```md", "x".repeat(7000), "```", "Example: ![literal]"].join("\n");
  try {
    const result = await completeRelayRequest(relay, "code_media_fixture", {
      lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: answer, reply_to: null, format: "rich_markdown", buttons: [] },
    }, () => Date.now() + 5000, undefined, undefined, 4000);
    expect(result).toMatchObject({ delivery: "accepted", tooLong: true, body: { answer: { text: answerTooLongNotice(4000) } } });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ outcome: "answered", answer: { text: answerTooLongNotice(4000) } });
    const notice = sent[1];
    if (!notice || notice.outcome !== "answered") throw new Error("expected an answered notice");
    expect(notice.answer).not.toHaveProperty("format");
    expect(answer).toContain("![literal]");
  } finally { await service.close(); }
});

test("an active attachment reference still refuses an invalid rich composition", async () => {
  const sent: ExternalRelayCompletion[] = [];
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    return { status: 422, body: { error: { code: "invalid_format", reason: "rich_limit_exceeded" } } };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  const answer = "whole text ".repeat(600) + "\n![](attachment:file1)";
  try {
    const result = await completeRelayRequest(relay, "active_media_fixture", {
      lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: answer, reply_to: null, format: "rich_markdown", buttons: [],
        attachments: [{ attachment_id: "file1", kind: "document" }] },
    }, () => Date.now() + 5000, undefined, undefined, 4000);
    expect(result).toMatchObject({ delivery: "refused", body: { outcome: "answered", answer: { text: answer } } });
    expect(sent).toHaveLength(1);
  } finally { await service.close(); }
});

test("a quoted tilde fence containing an attachment marker still gets a bounded notice", async () => {
  const sent: ExternalRelayCompletion[] = [];
  const refusals: unknown[] = [];
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    return sent.length === 1 ? { status: 422, body: { error: { code: "attachment_not_ready" } } }
      : sent.length === 2 ? { status: 422, body: { error: { code: "invalid_format", reason: "rich_limit_exceeded" } } } : { body: {} };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  const text = ["> ~~~md", "> ![](attachment:example)", "> ~~~", "", "x".repeat(7200)].join("\n");
  const original: Extract<ExternalRelayCompletion, { outcome: "answered" }> = { lease_id: "fixture", outcome: "answered", duration_ms: 1,
    answer: { action: "reply" as const, text, reply_to: null, format: "rich_markdown" as const, buttons: [],
      attachments: [{ attachment_id: "file1", kind: "document" }] } };
  try {
    const result = await completeRelayRequest(relay, "quoted_fence_media", original, () => Date.now() + 5000,
      undefined, undefined, 4000, refusal => refusals.push(refusal));
    expect(result).toMatchObject({ delivery: "accepted", tooLong: true, body: { answer: { text: answerTooLongNotice(4000) } } });
    expect(original.answer.text).toBe(text);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatchObject({ answer: { text } });
    const stripped = sent[1];
    if (!stripped || stripped.outcome !== "answered") throw new Error("expected the attachment-stripped answer");
    expect(stripped.answer).not.toHaveProperty("attachments");
    expect(sent[2]).toMatchObject({ answer: { text: answerTooLongNotice(4000) } });
    const notice = sent[2];
    if (!notice || notice.outcome !== "answered") throw new Error("expected the plain length notice");
    expect(notice.answer).not.toHaveProperty("attachments");
    expect(refusals).toEqual([
      { status: 422, code: "attachment_not_ready", reason: "attachment_not_ready" },
      { status: 422, code: "invalid_format", reason: "rich_limit_exceeded" },
    ]);
  } finally { await service.close(); }
});

for (const [status, code] of [[415, "unsupported_format"], [400, "malformed"], [422, "invalid_format"]] as const) {
  test(`attachment removal permits a bounded notice after ${status} ${code}`, async () => {
    const sent: ExternalRelayCompletion[] = [];
    const refusals: unknown[] = [];
    const service = await startTestRelay((_request, body) => {
      sent.push(body as ExternalRelayCompletion);
      return sent.length === 1 ? { status: 422, body: { error: { code: "attachment_not_ready" } } }
        : sent.length === 2 ? { status, body: { error: { code, reason: "rich_limit_exceeded", message: "private parser input" } } } : { body: {} };
    });
    const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
    const text = "whole answer ".repeat(600);
    const original: Extract<ExternalRelayCompletion, { outcome: "answered" }> = { lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text, reply_to: null, format: "rich_markdown", buttons: [], attachments: [{ attachment_id: "file1", kind: "document" }] } };
    try {
      const result = await completeRelayRequest(relay, "attachment_format_refusal", original, () => Date.now() + 5000,
        undefined, undefined, 4000, refusal => refusals.push(refusal));
      expect(result).toMatchObject({ delivery: "accepted", tooLong: true, body: { outcome: "answered", answer: { text: answerTooLongNotice(4000) } } });
      expect(original.answer.text).toBe(text);
      expect(sent).toHaveLength(3);
      expect(sent[1]).toMatchObject({ outcome: "answered", answer: { text } });
      expect(sent[2]).toMatchObject({ outcome: "answered", answer: { text: answerTooLongNotice(4000) } });
      expect(refusals).toEqual([
        { status: 422, code: "attachment_not_ready", reason: "attachment_not_ready" },
        { status, code, reason: "rich_limit_exceeded" },
      ]);
      expect(JSON.stringify(refusals)).not.toContain("private parser input");
    } finally { await service.close(); }
  });
}

test("attachment removal keeps a short answer unchanged after a format refusal", async () => {
  const sent: ExternalRelayCompletion[] = [];
  const downgrades: unknown[] = [];
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    return sent.length === 1 ? { status: 422, body: { error: { code: "attachment_not_ready" } } }
      : sent.length === 2 ? { status: 422, body: { error: { code: "invalid_format", reason: "unsupported_format" } } } : { body: {} };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  const original: Extract<ExternalRelayCompletion, { outcome: "answered" }> = { lease_id: "fixture", outcome: "answered", duration_ms: 1,
    answer: { action: "reply", text: "Done.", reply_to: null, format: "rich_markdown", buttons: [], attachments: [{ attachment_id: "file1", kind: "document" }] } };
  try {
    const result = await completeRelayRequest(relay, "attachment_short_answer", original, () => Date.now() + 5000,
      undefined, undefined, 4000, undefined, undefined, refusal => downgrades.push(refusal));
    expect(result).toEqual({ delivery: "accepted", body: { ...original, answer: { action: "reply", text: "Done.", reply_to: null, format: "plain", buttons: [] } } });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ outcome: "answered", answer: { text: "Done.", format: "plain" } });
    expect(sent[2]).not.toMatchObject({ answer: { text: answerTooLongNotice(4000) } });
    expect(downgrades).toEqual([
      { status: 422, code: "attachment_not_ready", reason: "attachment_not_ready" },
      { status: 422, code: "invalid_format", reason: "unsupported_format" },
    ]);
    expect(result).not.toHaveProperty("downgrade");
  } finally { await service.close(); }
});

for (const [status, code] of [[415, "invalid_format"], [400, "malformed"], [422, "invalid_format"]] as const)
  test(`a refused plain fallback ends after three recorded refusals (${status})`, async () => {
    const sent: ExternalRelayCompletion[] = [];
    const refusals: unknown[] = [];
    const log = spyOn(console, "error").mockImplementation(() => {});
    const service = await startTestRelay((_request, body) => {
      sent.push(body as ExternalRelayCompletion);
      if (sent.length === 1) return { status: 422, body: { error: { code: "attachment_not_ready" } } };
      if (sent.length === 2) return { status: 422, body: { error: { code: "invalid_format" } } };
      return { status, body: { error: { code } } };
    });
    const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
    const original: ExternalRelayCompletion = { lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: "Done.", reply_to: null, format: "rich_markdown", buttons: [], attachments: [{ attachment_id: "file1", kind: "document" }] } };
    try {
      const result = await completeRelayRequest(relay, "plain_refused", original, () => sent.length >= 3 ? 0 : Date.now() + 5000,
        undefined, undefined, 4000, refusal => refusals.push(refusal));
      expect(result.delivery).toBe("refused");
      expect(sent).toHaveLength(3);
      expect(sent[0]).toEqual(original);
      expect(sent[2]).toMatchObject({ outcome: "answered", answer: { text: "Done.", format: "plain", buttons: [] } });
      expect(refusals).toEqual([
        { status: 422, code: "attachment_not_ready", reason: "attachment_not_ready" },
        { status: 422, code: "invalid_format", reason: "invalid_format" },
        { status, code, reason: code },
      ]);
    } finally { log.mockRestore(); await service.close(); }
  });

test("an empty ignore keeps its existing invalid-format behavior", async () => {
  const sent: ExternalRelayCompletion[] = [];
  const downgrades: unknown[] = [];
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    return sent.length === 1 ? { status: 422, body: { error: { code: "invalid_format" } } } : { body: {} };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  const until = Date.now() + 5000;
  try {
    const result = await completeRelayRequest(relay, "ignore_fixture", {
      lease_id: "fixture", outcome: "answered", duration_ms: 1,
      answer: { action: "ignore", text: "", reply_to: null, format: "rich_markdown", buttons: [] },
    }, () => until, undefined, undefined, 4000, undefined, undefined, refusal => downgrades.push(refusal));
    expect(result).toEqual({ body: { lease_id: "fixture", outcome: "failed", reason: "invalid_answer", detail: null }, delivery: "accepted" });
    expect(downgrades).toEqual([{ status: 422, code: "invalid_format", reason: "invalid_format" }]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty("answer");
  } finally { await service.close(); }
});

for (const status of [415, 422] as const) test(`format downgrade ${status} retains DM task fallback text`, async () => {
  const sent: ExternalRelayCompletion[] = [];
  const attempts = new Map<string, number>();
  const service = await startTestRelay((_request, body) => {
    sent.push(body as ExternalRelayCompletion);
    const count = (attempts.get(_request.url ?? "") ?? 0) + 1;
    attempts.set(_request.url ?? "", count);
    return count === 1 ? { status, body: { error: { code: status === 422 ? "invalid_format" : "unsupported_format" } } } : { body: {} };
  });
  const relay = { api_base: `${service.origin}/v1`, credential: "fixture", limits: { max_response_bytes: 1048576 } } as PairedRelay;
  try {
    const fallbacks = [
      { id: "link", text: "Task created.\nhttps://board.example.invalid/#task=fixture",
        parts: { buttons: [[{ text: "Open", url: "https://board.example.invalid/#task=fixture" }]] } },
      { id: "choice", text: "Which project should receive this task? Choose a project and resend the request with that project name.",
        parts: { choice_buttons: { message_id: "prompt", expires_at: new Date(Date.now() + 60_000).toISOString(), rows: [[{ text: "Atlas", value: "a".repeat(64) }]] } } },
    ];
    for (const fallback of fallbacks) {
      const before = sent.length;
      const result = await completeRelayRequest(relay, `dm_${fallback.id}_${status}`, { lease_id: "fixture", outcome: "answered", duration_ms: 1,
        answer: { action: "reply", text: fallback.text, reply_to: "message", format: "rich_markdown", buttons: [], ...fallback.parts } },
      () => Date.now() + 5000);
      expect(result.delivery).toBe("accepted");
      expect(sent[before + 1]).toMatchObject({ answer: { format: "plain", text: fallback.text } });
    }
  } finally { await service.close(); }
});
