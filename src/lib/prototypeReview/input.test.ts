import { expect, test } from "bun:test";
import { prototypePublishSchema, parsePrototypeInput } from "./input";

import { questions } from "./questionnaire.fixture";

test("questions-only publications validate the short questionnaire contract", () => {
  const input = { clientRequestId: "questions", title: "Before work", questions };
  expect(prototypePublishSchema.safeParse(input).success).toBe(true);
  expect(parsePrototypeInput(input)).toEqual(input);
  expect(parsePrototypeInput({ ...input, variants: [] }).variants).toEqual([]);
  const invalid = [
    { questions: questions.slice(0, 2) },
    { questions: Array.from({ length: 8 }, (_, i) => ({ ...questions[0], id: `q${i}` })) },
    { questions: questions.map(q => ({ ...q, options: q.options.slice(0, 1) })) },
    { questions: questions.map(q => ({ ...q, options: Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i}`, recommended: i === 0 })) })) },
    { questions: questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o, recommended: false })) })) },
    { questions: questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o, recommended: true })) })) },
    { questions: [questions[0], questions[0], questions[2]] },
    { questions: questions.map(q => ({ ...q, options: [{ label: "Same", recommended: true }, { label: "Same" }] })) },
    { dir: "/var/tmp/frames" },
    { questions: undefined },
    { questions: undefined, variants: [] },
  ];
  for (const patch of invalid) expect(() => parsePrototypeInput({ ...input, ...patch })).toThrow();
});
