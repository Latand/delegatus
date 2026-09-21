import { describe, expect, test } from "bun:test";

import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";

import type { RuntimeReceipt } from "../runtime/runtimeModel";
import { UNCONFIRMED_RECEIPT_PREFIX } from "./messageRow";
import type { OutboxEntry } from "./outbox";
import { localSubmissionJoin, submissionNamesItsDelivery } from "./submissionJoin";

const entry = (id: string, extra: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id, text: "words", images: 0, at: 1, state: "delivering", ...extra,
});

const receipt = (operationId: string, idempotencyKey: string) =>
  ({ operationId, idempotencyKey, conversationId: "conversation_join", kind: "send", status: "delivered" }) as unknown as RuntimeReceipt;

describe("the browser's own join from a record's marker to its row", () => {
  test("names a submission from its admission id and from its receipt alike", () => {
    const join = localSubmissionJoin([
      entry("key-admitted", { operationId: "operation-admitted" }),
      /* A receipt arrived for a key whose HTTP answer never named an operation. */
      entry("key-receipt-only", { deliveryReceipt: receipt("operation-receipt", "key-receipt-only") }),
    ]);
    expect(join.get(deliveryDedupToken("operation-admitted"))).toBe("key-admitted");
    expect(join.get(deliveryDedupToken("operation-receipt"))).toBe("key-receipt-only");
  });

  test("a retry's fresh operation still names the one submission", () => {
    const join = localSubmissionJoin([
      entry("key-retried", { operationId: "operation-first", deliveryReceipt: receipt("operation-second", "key-retried") }),
    ]);
    expect(join.get(deliveryDedupToken("operation-first"))).toBe("key-retried");
    expect(join.get(deliveryDedupToken("operation-second"))).toBe("key-retried");
  });

  test("a send the browser was never told about names nothing, and says so", () => {
    const lost = entry("key-lost", { state: "failed", deliveryUncertain: true });
    const placeholder = entry("key-placeholder", {
      deliveryReceipt: receipt(`${UNCONFIRMED_RECEIPT_PREFIX}key-placeholder`, "key-placeholder"),
    });
    expect(localSubmissionJoin([lost, placeholder]).size).toBe(0);
    expect(submissionNamesItsDelivery(lost)).toBe(false);
    /* The composer's own placeholder names no server operation at all. */
    expect(submissionNamesItsDelivery(placeholder)).toBe(false);
    expect(submissionNamesItsDelivery(entry("key-admitted", { operationId: "operation-admitted" }))).toBe(true);
  });
});
