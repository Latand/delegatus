import { expect, test } from "bun:test";
import { normalizePendingQuestions, pendingQuestionFrom } from "./permissionRequests";

const since = "2026-09-30T05:15:00.000Z";

test("native question metadata survives persistence with its answer binding", () => {
  const question = pendingQuestionFrom("request-one", {
    tool_name: "AskUserQuestion", tool_use_id: "toolu_one",
    input: { questions: [{ question: "Which scope?", multiSelect: true, options: [{ label: "All" }, { label: "Small (Recommended)" }] }] },
  }, since)!;
  expect(question).toEqual({ id: "request-one", toolUseId: "toolu_one", tool: "AskUserQuestion",
    questions: [{ prompt: "Which scope?", options: ["Small (Recommended)", "All"], multiSelect: true }], since });
  expect(normalizePendingQuestions(JSON.parse(JSON.stringify([question])))).toEqual([question]);
});

test("malformed requests and permission tools cannot become native questions", () => {
  for (const value of [null, [], {}, { tool_name: "Bash", input: { questions: [{ question: "Retry?" }] } },
    { tool_name: "AskUserQuestion", input: { questions: [null, {}, { question: " " }] } }]) {
    expect(pendingQuestionFrom("request-one", value, since)).toBeNull();
  }
  expect(normalizePendingQuestions([null, {}, { id: "q", tool: "Bash", since, questions: [] },
    { id: "q", tool: "AskUserQuestion", since, questions: [null, {}] }])).toEqual([]);
});

test("question prompts and choices stay bounded on the host and registry paths", () => {
  const raw = { tool_name: "AskUserQuestion", input: { questions: Array.from({ length: 9 }, () => ({
    question: "q".repeat(600), options: [null, {}, ...Array.from({ length: 9 }, () => ({ label: "a".repeat(300) }))],
  })) } };
  const question = pendingQuestionFrom("request-one", raw, since)!;
  expect(question.questions).toHaveLength(7);
  expect(question.questions[0]!.prompt).toHaveLength(512);
  expect(question.questions[0]!.options).toHaveLength(4);
  expect(question.questions[0]!.options.every(option => option.length === 256)).toBe(true);
  const persisted = normalizePendingQuestions([{ ...question, questions: Array.from({ length: 9 }, () => ({ prompt: "q".repeat(600),
    options: Array(9).fill("a".repeat(300)),
  })) }])[0]!;
  expect(persisted.questions).toHaveLength(7);
  expect(persisted.questions[0]!.prompt).toHaveLength(512);
  expect(persisted.questions[0]!.options).toHaveLength(6);
  expect(persisted.questions[0]!.options.every(option => option.length === 256)).toBe(true);
});
