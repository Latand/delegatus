import { expect, test } from "bun:test";

import type { PrototypeReviewSummary } from "@/lib/prototypeReview/types";

import { prototypeButtonState } from "./prototypeReviewStore";

/* The card button's five readings of a task's review summary. */

const waiting: PrototypeReviewSummary = { latestReviewId: "r2", waitingReviewId: "r2", title: "Layout", rounds: 2, createdAt: "2026-10-06T10:00:00.000Z" };
const decided = (delivery: NonNullable<PrototypeReviewSummary["decision"]>["delivery"]): PrototypeReviewSummary => ({
  latestReviewId: "r1", waitingReviewId: null, title: "Layout", rounds: 1, createdAt: "2026-10-06T10:00:00.000Z",
  decision: { chosen: [{ number: 2, name: "Dense" }], comment: "", at: "2026-10-06T11:00:00.000Z", delivery },
});

test("a task with no review draws no button", () => {
  expect(prototypeButtonState(undefined, new Set())).toBeNull();
});

test("a waiting round is ready until this browser has opened it, then opened", () => {
  expect(prototypeButtonState(waiting, new Set())).toBe("ready");
  expect(prototypeButtonState(waiting, new Set(["r2"]))).toBe("opened");
});

test("a newer round after a decision waits again, whatever was opened before", () => {
  expect(prototypeButtonState(waiting, new Set(["r1"]))).toBe("ready");
});

test("a decided review says so, and a message that did not arrive is marked", () => {
  expect(prototypeButtonState(decided("sent"), new Set())).toBe("decided");
  expect(prototypeButtonState(decided("no-orchestrator"), new Set())).toBe("decided");
  expect(prototypeButtonState(decided("pending"), new Set())).toBe("decided");
  expect(prototypeButtonState(decided("failed"), new Set())).toBe("unsent");
  expect(prototypeButtonState(decided("uncertain"), new Set())).toBe("unsent");
});
