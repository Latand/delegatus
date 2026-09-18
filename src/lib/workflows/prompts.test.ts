import { expect, test } from "bun:test";

import type { Round } from "@/lib/flows/types";

import { buildWorkflow, normalizeTemplate } from "./store";
import { fixerKickoff, prBody, stageKickoff } from "./prompts";
import type { Workflow } from "./types";

const TEMPLATE = normalizeTemplate({
  name: "fullstack",
  verify: "bun test && bun run build",
  stages: [
    { kind: "implement", agent: { engine: "codex", model: null, effort: "xhigh" }, scope: "Backend/API: server logic" },
    { kind: "implement", agent: { engine: "claude", model: "fable", effort: null }, scope: "UI/frontend: components" },
    { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: "xhigh" } },
  ],
})!;

function makeWorkflow(): Workflow {
  return buildWorkflow({
    id: "wf123456",
    name: "fullstack",
    task: "Add dark mode to the settings page",
    project: "repo",
    repoDir: "/home/user/proj/repo",
    template: TEMPLATE,
    mode: "auto",
    now: "2026-07-05T00:00:00.000Z",
  });
}

test("stage 0 kickoff carries the brief, the scope, the verify hint and the marker rule", () => {
  const wf = makeWorkflow();
  const prompt = stageKickoff(wf, 0);
  expect(prompt).toContain("Add dark mode to the settings page");
  expect(prompt).toContain("Backend/API: server logic");
  expect(prompt).toContain("bun test && bun run build");
  expect(prompt).toContain("STAGE_DONE: <one-line note for the next stage>");
  expect(prompt).not.toContain("Notes from the stages");
});

test("later stages receive the prior stages' STAGE_DONE notes", () => {
  const wf = makeWorkflow();
  wf.stageRuns[0] = { ...wf.stageRuns[0]!, doneAt: "2026-07-05T01:00:00.000Z", doneNote: "API lives in src/api/theme.ts" };
  const prompt = stageKickoff(wf, 1);
  expect(prompt).toContain("Notes from the stages already finished");
  expect(prompt).toContain("Stage 1 (Backend/API: server logic): API lives in src/api/theme.ts");
  expect(prompt).toContain("UI/frontend: components");
});

test("a stage finished without a note still threads through readably", () => {
  const wf = makeWorkflow();
  wf.stageRuns[0] = { ...wf.stageRuns[0]!, doneAt: "2026-07-05T01:00:00.000Z", doneNote: null };
  expect(stageKickoff(wf, 1)).toContain("Stage 1 (Backend/API: server logic): done, no note left");
});

test("fixer kickoff adds the FIXED/REJECTED protocol and every stage note", () => {
  const wf = makeWorkflow();
  wf.stageRuns[0] = { ...wf.stageRuns[0]!, doneAt: "t", doneNote: "backend note" };
  wf.stageRuns[1] = { ...wf.stageRuns[1]!, doneAt: "t", doneNote: "ui note" };
  const prompt = fixerKickoff(wf);
  expect(prompt).toContain("backend note");
  expect(prompt).toContain("ui note");
  expect(prompt).toContain("FIXED");
  expect(prompt).toContain("REJECTED — <reason>");
  expect(prompt).toContain("REVIEW_READY: <one-line note>");
});

test("prBody folds the brief, stage notes and rounds into the PR", () => {
  const wf = makeWorkflow();
  wf.stageRuns[0] = { ...wf.stageRuns[0]!, doneAt: "t", doneNote: "backend note" };
  const rounds = [
    { n: 1, verdict: "REQUEST_CHANGES", findingsCount: 3 },
    { n: 2, verdict: "APPROVE", findingsCount: 0 },
  ] as Round[];
  const body = prBody(wf, rounds);
  expect(body).toContain("Add dark mode to the settings page");
  expect(body).toContain("Stage 1 (Backend/API): backend note");
  expect(body).toContain("Round 1: REQUEST_CHANGES (3 findings)");
  expect(body).toContain("Round 2: APPROVE");
  expect(body.trim().endsWith("🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBe(true);
});
