import { expect, test } from "bun:test";

import type { PendingQuestion } from "@/lib/types";

import { nativeAnswerResolution } from "./nativeAnswer";

/* docs/design/attention-auto-resolve.md, acceptance 3: the seat answers a
   worker's native question or plan with the resolution the conversation's own
   question card sends. */

const question = (multiSelect = false): PendingQuestion => ({
  kind: "question", toolUseId: "toolu_q", transcriptPath: "/t/q.jsonl", pid: 1, paneTarget: null, askedAt: "2026-10-11T11:50:00.000Z",
  questions: [
    { question: "Which runner?", header: "Runner", multiSelect, options: [{ label: "Bigger", description: "", recommended: true }, { label: "Same", description: "", recommended: false }] },
  ],
});
const plan: PendingQuestion = { kind: "plan", toolUseId: "toolu_p", transcriptPath: "/t/p.jsonl", pid: 1, paneTarget: null, askedAt: "2026-10-11T11:50:00.000Z", plan: "Rebuild the index" };

test("options are chosen by number from 1, keyed by the question's text", () => {
  expect(nativeAnswerResolution(question(), { answers: [1] })).toEqual({ resolution: { behavior: "allow", updatedInput: { answers: { "Which runner?": "Bigger" } } }, label: "Bigger" });
  expect(nativeAnswerResolution(question(true), { answers: [[2, 1]] })).toMatchObject({ resolution: { updatedInput: { answers: { "Which runner?": "Same, Bigger" } } } });
  expect(nativeAnswerResolution(question(), { text: "Whichever is free" })).toMatchObject({ resolution: { updatedInput: { answers: { "Which runner?": "Whichever is free" } } } });
});

test("an answer that does not fit the question is refused", () => {
  expect(nativeAnswerResolution(question(), { answers: [[1, 2]] })).toHaveProperty("error");
  expect(nativeAnswerResolution(question(), { answers: [0] })).toHaveProperty("error");
  expect(nativeAnswerResolution(question(), { answers: [] })).toHaveProperty("error");
  expect(nativeAnswerResolution(question(), {})).toHaveProperty("error");
  expect(nativeAnswerResolution(plan, { answers: [1] })).toHaveProperty("error");
});

test("a plan is approved or rejected with what the agent is told", () => {
  expect(nativeAnswerResolution(plan, { approve: true })).toEqual({ resolution: { behavior: "allow" }, label: "approved" });
  expect(nativeAnswerResolution(plan, { approve: false, message: "Keep the old index" })).toEqual({ resolution: { behavior: "deny", message: "Keep the old index" }, label: "rejected" });
  expect(nativeAnswerResolution(plan, { approve: false })).toMatchObject({ resolution: { behavior: "deny" } });
});
