import { expect, test } from "bun:test";
import { seatTickInstructionReview, type SeatTickInstructionLine } from "./seatTickInstructions";

const now = Date.parse("2026-11-12T12:00:00Z");
const at = "2026-11-12T11:00:00Z";
const author = { kind: "manager" as const, project: "fixture", conversationId: "seat-fixture", seatEpoch: 7 };
const review = (lines: SeatTickInstructionLine[], instructionsReviewedAt?: string, finished = new Map<string, string>()) =>
  seatTickInstructionReview(lines, { project: "fixture", now, instructionsReviewedAt, finished });

test("age and unknown dates flag only the inherited seat block, and a review clears age", () => {
  const lines = [{ text: "Read the queue", author: null, at: null }, { text: "Operator standing instruction", author: { ...author, kind: "gateway" as const }, at: null }];
  expect(review(lines)).toContain("line 1");
  expect(review(lines)).not.toContain("line 2");
  expect(review(lines, at)).toBeUndefined();
  expect(review([{ text: "Read the queue", author, at: new Date(now - 3 * 86_400_000).toISOString() }])).toBeUndefined();
  expect(review([{ text: "Read the queue", author, at: new Date(now - 3 * 86_400_000 - 1).toISOString() }])).toContain("line 1");
});

for (const ref of ["ab12cd34", "task-fixture-done", "#1234"]) test(`finished ${ref} is flagged only after its last review`, () => {
  const lines = [{ text: `Wait for ${ref}`, author, at }];
  const finished = new Map([[ref, "2026-11-12T11:30:00Z"]]);
  expect(review(lines, undefined, finished)).toContain(`names ${ref}`);
  expect(review(lines, "2026-11-12T11:45:00Z", finished)).toBeUndefined();
  expect(review(lines)).toBeUndefined();
  expect(review([{ ...lines[0]!, author: { ...author, project: "elsewhere" } }], undefined, finished)).toBeUndefined();
  expect(review([{ ...lines[0]!, author: { ...author, kind: "gateway" } }], undefined, finished)).toBeUndefined();
});


test("future epochs and another writer in the current epoch cannot be reviewed as inherited lines", () => {
  for (const other of [{ ...author, seatEpoch: 8 }, { ...author, conversationId: "another-seat" }]) {
    expect(seatTickInstructionReview([{ text: "Old line", author: other, at: null }], { project: "fixture", now, seat: author, finished: new Map() })).toBeUndefined();
  }
});
