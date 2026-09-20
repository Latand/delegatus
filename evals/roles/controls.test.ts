import { expect, test } from "bun:test";

import { readDataset, score } from "./runner";
import type { TrialReceipt } from "./schema";

function completed(): TrialReceipt {
  const cell = readDataset().cells[0];
  return { cellId: cell.id, clientRequestId: "control", payloadHash: "a".repeat(64), taskId: "canonical-role-prompt-evaluation", parentConversationId: "root", conversationId: "worker", launchId: "launch", status: "completed", candidateHead: "head", reviewedHead: "head", publishedHead: "head", model: { requestedModel: cell.requestedModel, resolvedModel: cell.requestedModel, effort: cell.requestedEffort, runtimeVersion: "test", observedAt: "2026-09-20T00:00:00Z", admitted: true } };
}

test("correct control passes and deterministic negative controls fail", () => {
  expect(score(completed(), { publicPass: true, hiddenPass: true, forbiddenFilesChanged: false, independentApproval: true })).toMatchObject({ verdict: "pass" });
  expect(score(completed(), { publicPass: false, hiddenPass: true, forbiddenFilesChanged: false, independentApproval: true }).verdict).toBe("fail");
  expect(score(completed(), { publicPass: true, hiddenPass: true, forbiddenFilesChanged: true, independentApproval: true }).reasons).toContain("forbidden file changed");
});
