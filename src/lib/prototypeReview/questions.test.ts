import { expect, test } from "bun:test";
import { normalizePrototypeAnswers, recommendedAnswers } from "./questions";
import { questions } from "./questionnaire.fixture";

const skipped = (questionId: string) => ({ questionId, options: [], skipped: true as const });
test("skipped questions need no choice or comment and keep the questionnaire order", () => {
  const answers = recommendedAnswers(questions); answers[1] = skipped("scope");
  expect(normalizePrototypeAnswers(questions, [...answers].reverse(), "")).toEqual(answers);
  expect(normalizePrototypeAnswers(questions, questions.map(q => skipped(q.id)), "")).toEqual(questions.map(q => skipped(q.id)));
  const other = recommendedAnswers(questions); other[2] = skipped("timing");
  expect(normalizePrototypeAnswers(questions, other, "")).toEqual(other);
});
test.each([
  { options: [0] }, { other: true }, { customText: "Already settled" }, { skipped: false },
])("a skipped question refuses a competing answer: %j", invalid => {
  const answers = recommendedAnswers(questions); const answer = { ...skipped("place"), ...invalid };
  expect(() => normalizePrototypeAnswers(questions, [answer, ...answers.slice(1)], "", true)).toThrow();
});
test("pre-change answers normalize byte for byte", () => {
  const answers = [{ questionId: "place", options: [1] }, { questionId: "scope", options: [0, 1] }, { questionId: "timing", options: [], other: true }];
  expect(JSON.stringify(normalizePrototypeAnswers(questions, answers, "After lunch"))).toBe(JSON.stringify(answers));
});
