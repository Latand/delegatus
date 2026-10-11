import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* leave_lesson and the lesson request on stage_report, through the MCP service
   with the server's own attribution stubbed; the state directory is private. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-leave-lesson-"));
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
/* stage_report asks for a pipelines tick; this suite's own controller answers it, so nothing reaches a running Viewer. */
afterAll(registerPipelineTick(async () => {}));
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, MCP_TOOL_NAMES, MemoryMcpReceiptStore, MUTATING_MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS } = await import("./server");
const { learnedRulesBlock } = await import("@/lib/memory/roleStore");
const { parseLessons } = await import("@/lib/memory/roleStage");
type Pipeline = import("@/lib/pipelines/types").Pipeline;
type McpToolResult = import("./server").McpToolResult;

const PROJECT = "lesson-mcp";
const RULE = "When a change adds a branch for empty input, write the test for that branch in the same commit.";

test("a lesson answer is exactly one of none, rewrite or one lesson", () => {
  const lesson = { scope: "role" as const, rule: RULE, why: "Review failed on an untested empty input path." };
  expect(parseLessons({ lesson }, "builder").lessons).toEqual([lesson]);
  expect(parseLessons({ none: "Existing guidance covers this stage." }, "builder").none).toBeTruthy();
  expect(parseLessons({ rewrite: { id: "r_example", rule: RULE, why: lesson.why } }, "builder").rewrite?.id).toBe("r_example");
  for (const args of [{}, { none: "Covered", lesson }, { lesson, rewrite: { id: "r_example", ...lesson } }, { lessons: [lesson] }]) {
    expect(() => parseLessons(args, "builder")).toThrow(/exactly one/i);
  }
});

test("task identifiers are refused without consuming the request, and a second accepted answer is refused", async () => {
  fixture += 1;
  const report = await call("conversation_fix", "stage_report", { verdict: "pass" });
  const prompt = (report.lessonRequest as string[]).join("\n");
  expect(prompt).toContain("different task");
  expect(prompt).toContain("narrowest true level");
  for (const old of ["one to three", "at least one lesson is better", "Start there"]) expect(prompt).not.toContain(old);
  const spans = ["#42", "PR 42", "pull request 42", "issue 42", "pull/42", "issues/42", "a1b2c3d", "r_ab12", "conversation_trial", ["12345678", "1234", "1234", "1234", "123456789012"].join("-")];
  for (const span of spans) {
    const response = await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", rule: `Check the durable acknowledgement after ${span} before replaying the operation.`, why: "A previous receipt belonged to an earlier owner." } });
    expect(response).toMatchObject({ ok: false, details: { code: "LESSON_ABOUT_ONE_TASK" } });
  }
  expect(learnedRulesBlock(PROJECT, "builder")).not.toContain("Check the durable acknowledgement after");
  expect(await call("conversation_fix", "leave_lesson", { none: "The existing guidance covers the stage." })).toMatchObject({ ok: true });
  expect(await call("conversation_fix", "leave_lesson", { none: "No new guidance." })).toMatchObject({ ok: false, details: { code: "LESSON_LIMIT" } });
});

function pipeline(): Pipeline {
  const attempt = (n: number, conversationId: string, extra: object = {}) => ({
    n, state: "running", conversationId, effectiveRole: { roleId: null }, verdict: null, ...extra,
  });
  return {
    id: `p-lesson-${fixture}`, project: PROJECT,
    stages: [
      { id: "review", kind: "run", prompt: "Review", next: null, onFail: { to: "fix", maxRounds: 1 }, effectiveRole: { roleId: "reviewer" } },
      { id: "fix", kind: "run", prompt: "Fix", next: null, effectiveRole: { roleId: "builder" } },
    ],
    runs: [
      { stageId: "review", attempts: [attempt(1, "conversation_review", { state: "failed", effectiveRole: { roleId: "reviewer" }, verdict: { status: "fail", findings: ["P1 — empty input throws"], rankedFindings: [{ severity: "P1", text: "empty input throws" }] } })] },
      { stageId: "fix", attempts: [attempt(1, "conversation_fix", { effectiveRole: { roleId: "builder" }, activatedBy: { stageId: "review", attempt: 1, edge: "fail" } })] },
    ],
  } as unknown as Pipeline;
}

function serviceAs(conversationId: string, replaced = false) {
  const record = pipeline();
  const bindings = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "agent", conversationId, role: null }),
    reportStageCompletion: async () => ({
      pipelineId: record.id, stageId: conversationId === "conversation_fix" ? "fix" : "review", attempt: 1, replaced,
      report: { seq: 1, at: "2026-10-07T12:00:00.000Z", actor: { kind: "agent", role: null, conversationId }, verdict: { status: "pass", findings: [] }, summary: "done", provenance: { state: "pending", head: null, branch: "b", uncommitted: null, pullRequest: null, pullRequestState: "pending", outputs: [] }, calls: 1 },
    }),
    readPipelineRecord: () => record,
    getPipelines: () => ({ pipelines: [record] }),
  } as never);
  return createMcpToolService(bindings, new MemoryMcpReceiptStore());
}

let fixture = 0;
beforeEach(() => { fixture += 1; });
let request = 0;
const call = (conversationId: string, tool: "stage_report" | "leave_lesson", args: Record<string, unknown>, replaced = false) =>
  serviceAs(conversationId, replaced).callTool(tool, { clientRequestId: `lesson-${request += 1}`, ...args }) as Promise<McpToolResult & Record<string, unknown>>;

test("leave_lesson is a registered, mutating tool with a bounded schema", () => {
  expect(MCP_TOOL_NAMES).toContain("leave_lesson");
  expect(MUTATING_MCP_TOOL_NAMES.has("leave_lesson")).toBe(true);
  expect(TOOL_INPUT_SCHEMAS.leave_lesson.safeParse({ clientRequestId: "x", lesson: { scope: "role", rule: RULE, why: "w" } }).success).toBe(true);
  expect(TOOL_INPUT_SCHEMAS.leave_lesson.safeParse({ clientRequestId: "x", lesson: { scope: "team", rule: RULE, why: "w" } }).success).toBe(false);
});

test("an accepted fix report asks for a lesson naming the handed findings, and leave_lesson stores an abstract rule", async () => {
  const review = await call("conversation_review", "stage_report", { verdict: "fail", findings: [{ severity: "P1", text: "empty input throws" }] });
  expect(review.ok).toBe(true);
  expect(review.lessonRequest).toBeUndefined();
  expect(await call("conversation_review", "leave_lesson", { lesson: { scope: "project", rule: RULE, why: "w" } })).toMatchObject({ ok: false, details: { code: "LESSON_CLEAN_STAGE" } });

  expect(await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", rule: RULE, why: "w" } })).toMatchObject({ ok: false, details: { code: "LESSON_NOT_REQUESTED" } });
  const fix = await call("conversation_fix", "stage_report", { verdict: "pass", summary: "fixed" });
  expect(fix.ok).toBe(true);
  expect(Array.isArray(fix.lessonRequest)).toBe(true);
  expect((fix.lessonRequest as string[]).join("\n")).toContain("handed 1 finding from stage review (P1 ×1)");
  const repeat = await call("conversation_fix", "stage_report", { verdict: "pass", summary: "fixed again" }, true);
  expect(repeat.lessonRequest).toBeUndefined();

  expect(await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", role: "reviewer", rule: RULE, why: "Review found an untested empty input path." } })).toMatchObject({ ok: false, details: { code: "LESSON_CLEAN_ROLE" } });
  const left = await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", rule: RULE, why: "Review failed on an untested empty path." } });
  expect(left).toMatchObject({ ok: true, stageId: "fix", left: [{ scope: `role:${PROJECT}:builder`, state: "active" }] });
  expect(learnedRulesBlock(PROJECT, "builder")).toContain(RULE);
});

test("text limits count Unicode code points in the schema and in the store alike", async () => {
  /* A Gothic letter: a supplementary character that is a letter, so a rule of them is words. */
  const wide = (n: number) => "\u{10330}".repeat(n);
  const schema = TOOL_INPUT_SCHEMAS.leave_lesson;
  const lesson = (rule: string, why = "w") => ({ clientRequestId: "x", lesson: { scope: "role", rule, why } });
  /* 151 supplementary characters are 302 UTF-16 units and well within 300 code points. */
  expect(schema.safeParse(lesson(wide(151))).success).toBe(true);
  expect(schema.safeParse(lesson(wide(300))).success).toBe(true);
  expect(schema.safeParse(lesson(wide(301))).success).toBe(false);
  expect(schema.safeParse(lesson(RULE, wide(160))).success).toBe(true);
  expect(schema.safeParse(lesson(RULE, wide(161))).success).toBe(false);
  expect(schema.safeParse({ clientRequestId: "x", none: wide(160) }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "x", none: wide(161) }).success).toBe(false);
  expect(parseLessons({ lesson: { scope: "role", rule: wide(300), why: wide(160) } }, "builder").lessons).toHaveLength(1);
  expect(() => parseLessons({ lesson: { scope: "role", rule: wide(301), why: "w" } }, "builder")).toThrow(/at most|1–300|20–300/);
  /* Symbols alone are no words to recognise the rule by. */
  expect(() => parseLessons({ lesson: { scope: "role", rule: "\u{1F600}".repeat(40), why: wide(160) } }, "builder")).toThrow(/letters or digits/);

  /* A fresh request for this test: each accepted answer consumes its attempt. */
  fixture += 1;
  await call("conversation_fix", "stage_report", { verdict: "pass" });
  const over = await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", rule: wide(301), why: "w" } });
  expect(over.ok).toBe(false);
  const atCap = await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", rule: wide(300), why: wide(160) } });
  expect(atCap).toMatchObject({ ok: true, stageId: "fix" });
  expect(learnedRulesBlock(PROJECT, "builder")).toContain(wide(300));
});
