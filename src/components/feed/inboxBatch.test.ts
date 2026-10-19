import { expect, test } from "bun:test";
import { fixtureInboxBatch } from "@/lib/runtime/fixtures/inboxBatch";
import { claudeMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import type { ClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import type { RegistryFile } from "@/lib/agent/registry";
import { createFeedSession } from "./parse";

test("seat inbox parser splits a combined row only from its part evidence", async () => {
  const subject = await import("./parse");
  expect(subject.splitInboxBatchFeed).toBeFunction();
  const batch = fixtureInboxBatch([{ id: "one", text: "exact operator", operator: true }, { id: "two", text: "exact relay" }]);
  const ledger = { load: () => [{ entry: batch, delivered: true, engineMessageId: "batch-uuid", disposition: "turn-started" }] } as unknown as ClaudeDeliveryLedger;
  const messages = claudeMessageProvenance("/fixtures/session.jsonl", { ledger, registrySnapshot: () => ({ deliveryOperationOwners: {} } as RegistryFile) });
  const feed = createFeedSession({ engine: "claude", fmt: "claude", showSvc: true, lineFilter: "" }).feed([JSON.stringify({ type: "user", uuid: "batch-uuid", promptSource: "sdk", timestamp: "2026-10-17T06:00:00Z", message: { role: "user", content: batch.content!.text } })], 0, false);
  const split = subject.splitInboxBatchFeed(feed, id => messages[id]?.parts);
  expect(split.items.map(e => e.item.kind === "sysmsg" ? e.item.text : "unexpected")).toEqual(["exact operator", "exact relay"]);
  expect(subject.splitInboxBatchFeed(feed, () => undefined)).toBe(feed);
});
