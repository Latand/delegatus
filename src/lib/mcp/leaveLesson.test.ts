import { afterAll, expect, test } from "bun:test";
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

function pipeline(): Pipeline {
  const attempt = (n: number, conversationId: string, extra: object = {}) => ({
    n, state: "running", conversationId, effectiveRole: { roleId: null }, verdict: null, ...extra,
  });
  return {
    id: "p-lesson", project: PROJECT,
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

let request = 0;
const call = (conversationId: string, tool: "stage_report" | "leave_lesson", args: Record<string, unknown>, replaced = false) =>
  serviceAs(conversationId, replaced).callTool(tool, { clientRequestId: `lesson-${request += 1}`, ...args }) as Promise<McpToolResult & Record<string, unknown>>;

test("leave_lesson is a registered, mutating tool with a bounded schema", () => {
  expect(MCP_TOOL_NAMES).toContain("leave_lesson");
  expect(MUTATING_MCP_TOOL_NAMES.has("leave_lesson")).toBe(true);
  expect(TOOL_INPUT_SCHEMAS.leave_lesson.safeParse({ clientRequestId: "x", lessons: [{ scope: "role", rule: RULE, why: "w" }] }).success).toBe(true);
  expect(TOOL_INPUT_SCHEMAS.leave_lesson.safeParse({ clientRequestId: "x", lessons: [{ scope: "team", rule: RULE, why: "w" }] }).success).toBe(false);
});

test("an accepted fix report asks for a lesson naming the handed findings, and leave_lesson stores an abstract rule", async () => {
  const review = await call("conversation_review", "stage_report", { verdict: "fail", findings: [{ severity: "P1", text: "empty input throws" }] });
  expect(review.ok).toBe(true);
  expect(review.lessonRequest).toBeUndefined();
  expect(await call("conversation_review", "leave_lesson", { lessons: [{ scope: "project", rule: RULE, why: "w" }] })).toMatchObject({ ok: false, details: { code: "LESSON_CLEAN_STAGE" } });

  expect(await call("conversation_fix", "leave_lesson", { lessons: [{ scope: "role", rule: RULE, why: "w" }] })).toMatchObject({ ok: false, details: { code: "LESSON_NOT_REQUESTED" } });
  const fix = await call("conversation_fix", "stage_report", { verdict: "pass", summary: "fixed" });
  expect(fix.ok).toBe(true);
  expect(Array.isArray(fix.lessonRequest)).toBe(true);
  expect((fix.lessonRequest as string[]).join("\n")).toContain("handed 1 finding from stage review (P1 ×1)");
  const repeat = await call("conversation_fix", "stage_report", { verdict: "pass", summary: "fixed again" }, true);
  expect(repeat.lessonRequest).toBeUndefined();

  expect(await call("conversation_fix", "leave_lesson", { lessons: [{ scope: "role", role: "reviewer", rule: RULE, why: "w" }] })).toMatchObject({ ok: false, details: { code: "LESSON_CLEAN_ROLE" } });
  const left = await call("conversation_fix", "leave_lesson", { lessons: [{ scope: "role", rule: RULE, why: "Review failed on an untested empty path." }] });
  expect(left).toMatchObject({ ok: true, stageId: "fix", left: [{ scope: `role:${PROJECT}:builder`, state: "active" }] });
  expect(learnedRulesBlock(PROJECT, "builder")).toContain(RULE);
});

test("text limits count Unicode code points in the schema and in the store alike", async () => {
  const emoji = (n: number) => "\u{1F600}".repeat(n);
  const schema = TOOL_INPUT_SCHEMAS.leave_lesson;
  const lesson = (rule: string, why = "w") => ({ clientRequestId: "x", lessons: [{ scope: "role", rule, why }] });
  /* 151 supplementary characters are 302 UTF-16 units and well within 300 code points. */
  expect(schema.safeParse(lesson(emoji(151))).success).toBe(true);
  expect(schema.safeParse(lesson(emoji(300))).success).toBe(true);
  expect(schema.safeParse(lesson(emoji(301))).success).toBe(false);
  expect(schema.safeParse(lesson(RULE, emoji(160))).success).toBe(true);
  expect(schema.safeParse(lesson(RULE, emoji(161))).success).toBe(false);
  expect(schema.safeParse({ clientRequestId: "x", none: emoji(160) }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "x", none: emoji(161) }).success).toBe(false);
  expect(parseLessons({ lessons: [{ scope: "role", rule: emoji(300), why: emoji(160) }], none: emoji(160) }, "builder").lessons).toHaveLength(1);
  expect(() => parseLessons({ lessons: [{ scope: "role", rule: emoji(301), why: "w" }] }, "builder")).toThrow(/at most|1–300|20–300/);

  /* Through the real service: the fix attempt was asked for a lesson by the test above. */
  const over = await call("conversation_fix", "leave_lesson", { lessons: [{ scope: "role", rule: emoji(301), why: "w" }] });
  expect(over.ok).toBe(false);
  const atCap = await call("conversation_fix", "leave_lesson", { lessons: [{ scope: "role", rule: emoji(300), why: emoji(160) }] });
  expect(atCap).toMatchObject({ ok: true, stageId: "fix" });
  expect(learnedRulesBlock(PROJECT, "builder")).toContain(emoji(300));
});
