import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";

import { prototypeReviewNotices, prototypeReviewSummary, withPrototypeReviewSummaries } from "./read";
import type { PrototypeReviewRound } from "./types";

function round(id: string, title: string, createdAt: string, decided: boolean): PrototypeReviewRound {
  return {
    id, title, taskId: "task-links", project: "project-a", createdAt, source: { conversationId: null }, publicationKey: id, inputDigest: id,
    variants: [{ number: 1, name: "Arrows", description: "An arrow after every link.", frames: [], videos: [] }],
    ...(decided ? { decision: { chosen: [1], comment: "Smaller.", at: createdAt, delivery: { state: "sent" as const, clientMessageId: id, conversationId: null, text: "" } } } : {}),
  };
}

const task = (prototypeReviews: PrototypeReviewRound[]): BoardTask => ({
  id: "task-links", project: "project-a", status: "assigned", placement: "unplaced", text: "Repair old links in the release notes\nThe arrows are too large.",
  assignments: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", prototypeReviews,
}) as BoardTask;

test("the notice names the task, and the waiting round's own title rides second", () => {
  const [notice] = prototypeReviewNotices([task([round("r-1", "Release notes links", "2026-10-02T00:00:00Z", false)])]);
  expect(notice).toMatchObject({ title: "Repair old links in the release notes", roundTitle: "Release notes links", reviewId: "r-1" });
});

test("an undecided older round under a decided newer one keeps its own title, never the newer round's", () => {
  const rounds = [round("r-old", "Release notes links", "2026-10-02T00:00:00Z", false), round("r-new", "Release notes links, smaller arrows", "2026-10-03T00:00:00Z", true)];
  const [notice] = prototypeReviewNotices([task(rounds)]);
  expect(notice).toMatchObject({ title: "Repair old links in the release notes", roundTitle: "Release notes links", reviewId: "r-old" });
  /* The page's poll carries only the summary, which knows the latest title alone: the notice names the task and leaves the round unnamed. */
  const [polled] = prototypeReviewNotices(withPrototypeReviewSummaries([task(rounds)]));
  expect(prototypeReviewSummary(rounds)?.title).toBe("Release notes links, smaller arrows");
  expect(polled).toMatchObject({ title: "Repair old links in the release notes", reviewId: "r-old" });
  expect(polled!.roundTitle).toBeUndefined();
});
