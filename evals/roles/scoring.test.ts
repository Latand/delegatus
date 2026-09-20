import { expect, test } from "bun:test";

import { readDataset, score } from "./runner";
import type { TrialReceipt } from "./schema";

test("unrun trials never score as a pass and review head drift is a hard failure", () => {
  const cell = readDataset().cells[0];
  const receipt: TrialReceipt = { cellId: cell.id, clientRequestId: "id", payloadHash: "b".repeat(64), taskId: "canonical-role-prompt-evaluation", parentConversationId: "root", status: "planned", model: { requestedModel: cell.requestedModel, resolvedModel: cell.requestedModel, effort: cell.requestedEffort, runtimeVersion: "test", observedAt: "2026-09-20T00:00:00Z", admitted: true } };
  expect(score(receipt, { publicPass: true, hiddenPass: true, forbiddenFilesChanged: false, independentApproval: true }).verdict).toBe("incomplete");
  receipt.status = "completed";
  receipt.conversationId = "worker";
  receipt.launchId = "launch";
  receipt.candidateHead = "candidate";
  receipt.reviewedHead = "reviewed";
  receipt.publishedHead = "published";
  expect(score(receipt, { publicPass: true, hiddenPass: true, forbiddenFilesChanged: false, independentApproval: true }).reasons).toContain("reviewed head does not equal candidate and published head");
});
