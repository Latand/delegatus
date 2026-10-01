import { expect, test } from "bun:test";
import { taskWorkEvidence, workEvidenceLines, WORK_QUIET_AFTER_MS, type WorkerEvidence, type LaneEvidence } from "./evidence";
import { NOW } from "./testFixture";
const task = { id: "aabbccdd", status: "assigned" as const };
const at = (delta: number) => new Date(NOW - delta).toISOString();
const worker: WorkerEvidence = { conversationId: "fixture-worker", via: "assignment", lifecycle: "running", lastRecordAt: null };
const lane: LaneEvidence = { pipelineId: "fixture-lane", state: "running", branch: "fixture-branch", movedAt: null, branchCommitAt: null };
test("recent transcript, new branch commit and progressing attempts each prove work", () => {
  expect(taskWorkEvidence(task, [{ ...worker, lastRecordAt: at(60000) }], [], NOW).verdict).toBe("working");
  expect(taskWorkEvidence(task, [], [{ ...lane, branchCommitAt: at(60000) }], NOW).verdict).toBe("working");
  expect(taskWorkEvidence(task, [], [{ ...lane, movedAt: at(60000) }], NOW).verdict).toBe("working");
});
test("quiet running claim and finished worker under assigned task are findings", () => {
  const quiet = taskWorkEvidence(task, [{ ...worker, lastRecordAt: at(WORK_QUIET_AFTER_MS + 1) }], [lane], NOW);
  expect(quiet.verdict).toBe("quiet"); expect(workEvidenceLines([quiet], NOW)[0]).toContain("commit unread");
  expect(taskWorkEvidence(task, [{ ...worker, lifecycle: "gone" }], [{ ...lane, state: "completed" }], NOW).verdict).toBe("finished-open");
});
test("unknown evidence never claims a finished worker; idle rows omitted", () => {
  const unknown = taskWorkEvidence(task, [{ ...worker, lifecycle: "unknown" }], [], NOW);
  expect(unknown.verdict).toBe("idle"); expect(workEvidenceLines([unknown], NOW)).toEqual([]);
});
