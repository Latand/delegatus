/**
 * Issue #1362 — the composer's failed-delivery notice model.
 *
 * Pure: which settled failures fold into the one compact notice, what the
 * notice says at rest, and what expanding it reveals.
 */
import { expect, test } from "bun:test";

import { translate } from "@/lib/i18n";

import { deliveryAttemptGroups } from "./deliveryState";
import { deliveryNoticeRun, describeReceiptFailure, failureCauseKey } from "./deliveryNotice";
import type { RuntimeReceipt } from "./runtimeModel";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const HOST_DOWN = "structured spawn runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";

function receipt(overrides: Partial<RuntimeReceipt> & { operationId: string }): RuntimeReceipt {
  return {
    idempotencyKey: `key-${overrides.operationId}`,
    conversationId: "conversation_1362",
    kind: "send",
    status: "failed",
    reason: HOST_DOWN,
    text: "fix the failing test",
    at: "2026-08-31T10:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

test("#1362 a verbatim sentence splits into a terse cause and the remediation behind it", () => {
  const described = describeReceiptFailure(t, HOST_DOWN);
  expect(described.cause).toBe(t("receipt.cause.hostUnavailable"));
  expect(described.full).toBe(HOST_DOWN);
  expect(described.detail).toEqual({
    sentence: "structured spawn runtime host is unavailable",
    remediation: "start agent-log-viewer through its CLI and check the CLI log for the host startup failure",
  });
});

test("#1362 a known reason code reads as its human sentence and has nothing further to reveal", () => {
  const described = describeReceiptFailure(t, "dead-host");
  expect(described.cause).toBe(t("receipt.human.deadHost"));
  expect(described.full).toBe(t("receipt.human.deadHost"));
  expect(described.detail).toBeNull();
});

test("#1362 an unknown short reason is the cause itself; an absent reason has no cause", () => {
  expect(describeReceiptFailure(t, "quota-exceeded")).toEqual({ cause: "quota-exceeded", full: "quota-exceeded", detail: { sentence: "quota-exceeded", remediation: null } });
  expect(describeReceiptFailure(t, null)).toEqual({ cause: null, full: null, detail: null });
  expect(describeReceiptFailure(t, "   ")).toEqual({ cause: null, full: null, detail: null });
});

test("#1362 the cause key ignores casing, spacing, and which alias named a known code", () => {
  expect(failureCauseKey(HOST_DOWN)).toBe(failureCauseKey(`  Structured spawn RUNTIME host is unavailable;  ${"different remediation"}`));
  expect(failureCauseKey("dead-host")).toBe(failureCauseKey("host-dead"));
  expect(failureCauseKey("dead-host")).not.toBe(failureCauseKey(HOST_DOWN));
});

test("#1362 the run is the newest consecutive same-cause failures; older other causes stay behind it", () => {
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-a2", text: "second ask", at: "2026-08-31T10:00:03.000Z" }),
    receipt({ operationId: "op-a1", text: "first ask", at: "2026-08-31T10:00:02.000Z" }),
    receipt({ operationId: "op-b", text: "older ask", reason: "dead-host", at: "2026-08-31T10:00:01.000Z" }),
    receipt({ operationId: "op-a0", text: "oldest ask", at: "2026-08-31T10:00:00.000Z" }),
  ]);
  const run = deliveryNoticeRun(groups, []);
  expect(run).not.toBeNull();
  expect(run!.current.operationId).toBe("op-a2");
  expect(run!.causeKey).toBe(failureCauseKey(HOST_DOWN));
  expect(run!.attempts.map((attempt) => attempt.operationId)).toEqual(["op-a2", "op-a1"]);
  expect(run!.dismissIds).toEqual(["op-a2", "op-a1"]);
});

test("#1362 three retries of one message count as three attempts of one group", () => {
  const groups = deliveryAttemptGroups([2, 1, 0].map((second) =>
    receipt({ operationId: `op-retry-${second}`, at: `2026-08-31T10:00:0${second}.000Z` })));
  const run = deliveryNoticeRun(groups, [])!;
  expect(run.attempts).toHaveLength(3);
  expect(run.dismissIds).toEqual(["op-retry-2", "op-retry-1", "op-retry-0"]);
});

test("#1362 a group still moving is not a failure, and no failures means no notice", () => {
  const moving = deliveryAttemptGroups([
    receipt({ operationId: "op-queued", status: "queued", reason: null, at: "2026-08-31T10:00:05.000Z" }),
    receipt({ operationId: "op-stale", status: "rejected", reason: "stale-turn", at: "2026-08-31T10:00:04.000Z" }),
  ]);
  expect(deliveryNoticeRun(moving, [])).toBeNull();
  expect(deliveryNoticeRun([], [])).toBeNull();
});

test("#1362 textless failed sends join the run by time and cause", () => {
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-with-text", at: "2026-08-31T10:00:01.000Z" }),
  ]);
  const textless = [
    receipt({ operationId: "op-textless-new", text: null, at: "2026-08-31T10:00:02.000Z" }),
    receipt({ operationId: "op-textless-old", text: null, at: "2026-08-31T10:00:00.000Z" }),
  ];
  const run = deliveryNoticeRun(groups, textless)!;
  expect(run.current.operationId).toBe("op-textless-new");
  expect(run.attempts.map((attempt) => attempt.operationId)).toEqual(["op-textless-new", "op-with-text", "op-textless-old"]);
});

test("#1426 every single-clause verbatim reason remains available on expand", () => {
  for (const reason of ["recovery failed", "The connection to the structured recovery process was severed before the delivery acknowledgement could be recorded and the pending message remains unverified until the conversation can be opened again and its latest response checked"]) {
    expect(describeReceiptFailure(t, reason)).toEqual({
      cause: reason, full: reason, detail: { sentence: reason, remediation: null },
    });
  }
});

test("a Telegram refusal is one cause whatever wrapper carried it, said once in the interface language", () => {
  /* The send route and the queue's own drain wrap the same refusal
     differently. Read by first clause they were two causes, and the operator
     saw the same line twice. */
  const fromQueue = "structured host recovery failed: telegram MCP connector is not connected at launch";
  const fromSend = "conversation host was reclaimed; automatic resume did not establish a deliverable host: telegram MCP connector is not connected at launch";
  expect(failureCauseKey(fromQueue)).toBe(failureCauseKey(fromSend));
  const run = deliveryNoticeRun(deliveryAttemptGroups([
    receipt({ operationId: "op-t2", text: "second ask", reason: fromQueue, at: "2026-08-31T10:00:03.000Z" }),
    receipt({ operationId: "op-t1", text: "first ask", reason: fromSend, at: "2026-08-31T10:00:02.000Z" }),
  ]), []);
  expect(run!.attempts.map((attempt) => attempt.operationId)).toEqual(["op-t2", "op-t1"]);
  for (const lang of ["en", "uk"] as const) {
    const say = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(lang, key, params);
    /* The one-line row and the chip clip on a phone, so they carry the cause
       alone; what to do is the detail, which wraps and is read without hover. */
    const cause = translate(lang, "receipt.cause.telegramOff");
    const remedy = translate(lang, "receipt.remedy.telegramOff");
    const described = { cause, full: `${cause}. ${remedy}`, detail: { sentence: remedy, remediation: null }, saysWhatToDo: true };
    expect(describeReceiptFailure(say, fromQueue)).toEqual(described);
    expect(describeReceiptFailure(say, fromSend)).toEqual(described);
    expect(describeReceiptFailure(say, "structured host recovery failed: telegram MCP grant was revoked before launch")).toMatchObject({
      cause: translate(lang, "receipt.cause.telegramWithdrawn"),
      detail: { sentence: translate(lang, "receipt.remedy.telegramWithdrawn"), remediation: null },
    });
    /* A Codex account whose own settings define a server under the same name:
       the launch is refused, and the reason is said in the operator's words. */
    const taken = describeReceiptFailure(say, "structured host recovery failed: telegram MCP account definition conflicts with operator connector");
    expect(taken).toMatchObject({
      cause: translate(lang, "receipt.cause.telegramNameTaken"),
      detail: { sentence: translate(lang, "receipt.remedy.telegramNameTaken"), remediation: null },
    });
    expect(`${taken.cause} ${taken.detail?.sentence}`).not.toMatch(/MCP|connector|_/i);
    /* The action is said once, in the detail: the row and the chip carry none. */
    expect(`${translate(lang, "composer.deliveryFailed")} — ${cause}`).not.toMatch(/again|ще раз|знову/i);
    expect(`${cause} ${remedy}`).not.toMatch(/MCP|connector|_/i);
  }
  expect(failureCauseKey(fromQueue)).not.toBe(failureCauseKey("structured host recovery failed: telegram MCP grant was revoked before launch"));
});
