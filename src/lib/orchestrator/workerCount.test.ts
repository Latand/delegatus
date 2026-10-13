import { expect, test } from "bun:test";
import { projectWorkerCounts } from "./workerCount";

test("running lanes and independent seat children count once; idle lanes and deputies do not", () => {
  const counts = projectWorkerCounts({
    pipelines: () => [
      { project: "one", state: "running" }, { project: "one", state: "provisioning" },
      ...["paused", "draft", "needs_review", "needs_decision"].map(state => ({ project: "one", state })),
      { project: "one", state: "running", dismissedAt: "today" }, { project: "two", state: "running" },
    ],
    seats: () => [{ project: "one", conversationId: "seat-one" }, { project: "two", conversationId: "seat-two" }],
    children: () => [
      { conversationId: "child", parentConversationId: "seat-one", pipeline: false, deputy: false },
      { conversationId: "child", parentConversationId: "seat-one", pipeline: false, deputy: false },
      { conversationId: "stage", parentConversationId: "seat-one", pipeline: true, deputy: false },
      { conversationId: "deputy", parentConversationId: "seat-one", pipeline: false, deputy: true },
      { conversationId: "old", parentConversationId: "retired-seat", pipeline: false, deputy: false },
    ],
  });
  expect(counts.byProject.get("one")).toBe(3);
  expect(counts.byProject.get("two")).toBe(1);
  expect(counts.machine).toBe(4);
});
