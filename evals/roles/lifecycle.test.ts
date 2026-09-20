import { expect, test } from "bun:test";

import { ingest, plan, readDataset, recover } from "./runner";
import type { ModelEvidence, TrialReceipt } from "./schema";

const admitted: ModelEvidence = { requestedModel: "gpt-5.6-luna", resolvedModel: "gpt-5.6-luna", effort: "high", runtimeVersion: "runtime", observedAt: "2026-09-20T00:00:00Z", admitted: true };

test("planning exports one Viewer request without dispatch and rejects unresolved identity", () => {
  const dataset = readDataset();
  const head = "a".repeat(40);
  expect(plan(dataset, [], [], head)).toBeNull();
  const output = plan(dataset, [], [admitted], head);
  expect(output?.payload).toMatchObject({ allowSubagents: false, mode: "fresh", noDispatch: true });
  expect(() => plan(dataset, [], [admitted], "floating")).toThrow("exact harness head");
});

test("receipt recovery preserves original identity and cannot change model pins", () => {
  const dataset = readDataset();
  const receipt: TrialReceipt = { cellId: "quota-window-A", clientRequestId: "original-key", payloadHash: "c".repeat(64), taskId: "canonical-role-prompt-evaluation", parentConversationId: "root", status: "unknown", model: admitted };
  expect(ingest(dataset, receipt)).toEqual(receipt);
  expect(recover(dataset, [], receipt)).toEqual([receipt]);
  expect(recover(dataset, [receipt], receipt)).toEqual([receipt]);
  expect(() => recover(dataset, [receipt], { ...receipt, payloadHash: "d".repeat(64) })).toThrow("receipt recovery changed original request");
  receipt.model.requestedModel = "gpt-6-astra";
  expect(() => ingest(dataset, receipt)).toThrow("receipt changed the requested model or effort");
});
