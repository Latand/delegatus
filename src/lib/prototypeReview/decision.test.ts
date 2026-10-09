import { expect, test } from "bun:test";
import { prototypeDecisionText } from "./decision";
import { questions } from "./questionnaire.fixture";
import type { PrototypeReviewRound } from "./types";

const task = { id: "task-review", text: "Review layout\nDetails" };
const round = { title: "Before work", variants: [{ number: 1, name: "Compact" }, { number: 2, name: "Roomy" }] } as PrototypeReviewRound;
const comment = "  Keep these words.\nAnd this line.  ";
test("variants-only decision delivery stays byte for byte", () => {
  expect(prototypeDecisionText(task, round, { chosen: [1,2], comment })).toBe(`Prototype review decision\nTask: task-review — Review layout\nChosen: 1 — Compact, 2 — Roomy\n\nComment:\n${comment}\n\nEnd of prototype review decision.`);
});
test("question answers carry the exact labels, recommendation, other and comment", () => {
  const answers = [{ questionId: "place", options: [0] }, { questionId: "scope", options: [0,1] }, { questionId: "timing", options: [], other: true as const }];
  const text = prototypeDecisionText(task, { ...round, variants: [], questions }, { chosen: [], answers, comment });
  expect(text).toBe(`Prototype review decision\nTask: task-review — Review layout\nRound: Before work\n\nAnswers:\n1. Where should this live?\n   a) Existing review (recommended)\n2. Which surfaces? (several allowed)\n   a) Desktop (recommended)\n   b) Phone\n3. When should work start?\n   Other: see the comment\n\nComment:\n${comment}\n\nEnd of prototype review decision.`);
  expect(prototypeDecisionText(task, { ...round, questions }, { chosen: [], answers, comment })).toContain("Chosen: none");
  expect(prototypeDecisionText(task, { ...round, questions }, { chosen: [2], answers, comment })).toContain("Chosen: 2 — Roomy");
});
