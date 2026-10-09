import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";

import { prototypeReviewNotices, prototypeReviewSummary, withPrototypeReviewSummaries } from "./read";
import { prototypeRoundsSuperseded } from "./model";
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

const ids = (rounds: PrototypeReviewRound[]) => rounds.map(r => [r.id, prototypeRoundsSuperseded(rounds).get(r.id) ?? null]);

test("two rounds with the newer decided: nothing waits, and the older undecided round is superseded by the newer", () => {
  const rounds = [round("r-old", "Release notes links", "2026-10-02T00:00:00Z", false), round("r-new", "Release notes links, smaller arrows", "2026-10-03T00:00:00Z", true)];
  expect(prototypeReviewSummary(rounds)?.waitingReviewId).toBeNull();
  expect(prototypeReviewNotices([task(rounds)])).toEqual([]);
  expect(prototypeReviewNotices(withPrototypeReviewSummaries([task(rounds)]))).toEqual([]);
  expect(ids(rounds)).toEqual([["r-old", "r-new"], ["r-new", null]]);
});

test("the older round decided and a newer one undecided: the newer waits, nothing is superseded", () => {
  const rounds = [round("r-old", "Release notes links", "2026-10-02T00:00:00Z", true), round("r-new", "Release notes links, smaller arrows", "2026-10-03T00:00:00Z", false)];
  expect(prototypeReviewSummary(rounds)?.waitingReviewId).toBe("r-new");
  const [notice] = prototypeReviewNotices([task(rounds)]);
  expect(notice).toMatchObject({ reviewId: "r-new", roundTitle: "Release notes links, smaller arrows" });
  expect(ids(rounds)).toEqual([["r-old", null], ["r-new", null]]);
});

test("three rounds with the middle decided: only the newest waits, the oldest is superseded by the middle one", () => {
  const rounds = [round("r-1", "One", "2026-10-02T00:00:00Z", false), round("r-2", "Two", "2026-10-03T00:00:00Z", true), round("r-3", "Three", "2026-10-04T00:00:00Z", false)];
  expect(prototypeReviewSummary(rounds)?.waitingReviewId).toBe("r-3");
  expect(prototypeReviewNotices([task(rounds)]).map(notice => notice.reviewId)).toEqual(["r-3"]);
  expect(ids(rounds)).toEqual([["r-1", "r-2"], ["r-2", null], ["r-3", null]]);
});

test("a summary an older installation replicated, still naming a round a later decision retired, waits for nothing here", () => {
  const rounds = [round("r-old", "Release notes links", "2026-10-02T00:00:00Z", false), round("r-new", "Release notes links, smaller arrows", "2026-10-03T00:00:00Z", true)];
  const stale = { ...prototypeReviewSummary(rounds)!, waitingReviewId: "r-old" };
  const remote = { ...task([]), prototypeReviews: undefined, prototypeReviewReplica: { summary: stale, rounds: [] } } as BoardTask;
  expect(prototypeReviewNotices([remote])).toEqual([]);
  expect(withPrototypeReviewSummaries([remote])[0]!.prototypeReview?.waitingReviewId).toBeNull();
  expect(prototypeReviewNotices([{ ...task([]), prototypeReviews: undefined, prototypeReview: stale } as BoardTask])).toEqual([]);
});
