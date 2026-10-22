import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* leave_lesson for the operator's own root conversation (slice 4 of
   docs/design/memory-source-switch.md), through the MCP service with the
   server's attribution and registry proof stubbed; state is private. */
const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "operator-lesson-"));
let state = 0;
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(sandbox, `state-${++state}`); fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true }); });
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { roleMemoryCollection, projectView, learnedRulesBlock } = await import("@/lib/memory/roleStore");
const { chooseSource, SOURCE_STATES, sourceTurnsEnginesOff } = await import("@/lib/memory/fixtures/source");
type Pipeline = import("@/lib/pipelines/types").Pipeline;

const project = "operator-lessons";
const conversationId = "conversation_operator";
const rule = "Check the pinned acceptance criteria before reporting completed work.";
const why = "The operator corrected a result that skipped one acceptance item.";
const lesson = (scope: string, text = rule, role?: string) => ({ lesson: { scope, rule: text, why, ...(role ? { role } : {}) } });

function service(options: { kind?: string; role?: string | null; operator?: boolean; pipelines?: Pipeline[]; seats?: unknown[] } = {}) {
  return createMcpToolService(viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: options.kind ?? "agent", conversationId, role: options.role ?? null }),
    authorizedSeats: () => options.seats ?? [],
    operatorConversation: (id: string) => options.operator === false || id !== conversationId ? null : { project },
    listPipelineRecords: () => options.pipelines ?? [],
  } as never), new MemoryMcpReceiptStore());
}
let request = 0;
const call = (args: Record<string, unknown>, api = service()) => api.callTool("leave_lesson", { clientRequestId: `operator-${++request}`, ...args });

test("in Delegatus mode the operator's root conversation leaves project and machine rules with origin operator", async () => {
  chooseSource("active");
  expect(await call(lesson("project"))).toMatchObject({ ok: true, project, roleId: null, left: [{ scope: `project:${project}`, state: "active" }] });
  const machineRule = "Pin a closed control port before running any suite on this machine.";
  expect(await call(lesson("machine", machineRule))).toMatchObject({ ok: true, left: [{ scope: "machine" }] });
  const rules = (roleMemoryCollection()?.snapshot() ?? []).filter(row => row.kind === "rule");
  expect(rules.map(row => row.kind === "rule" ? row.source : null)).toEqual([
    { origin: "operator", project, roleId: null, fixRound: false, conversationId },
    { origin: "operator", project, roleId: null, fixRound: false, conversationId },
  ]);
  expect((roleMemoryCollection()?.snapshot() ?? []).filter(row => row.kind === "request")).toEqual([]);
  expect(learnedRulesBlock(project, null)).toContain(rule);
  expect(projectView(project).scopes.find(scope => scope.scope === `project:${project}`)?.active[0]?.stageId).toBe("operator");
});

test("the operator's conversation is refused at role scope, for declines, problems and usage", async () => {
  chooseSource("draining");
  const before = roleMemoryCollection()?.snapshot() ?? [];
  for (const [args, code] of [
    [lesson("role"), "LESSON_WRONG_LEVEL"],
    [lesson("role", rule, "builder"), "LESSON_WRONG_LEVEL"],
    [{ none: "Nothing new to keep." }, "LESSON_INVALID"],
    [{ problem: { statement: "The activity signal is broken.", evidence: "A working transcript was reported stalled." } }, "LESSON_IS_PROBLEM"],
    [{ ...lesson("project"), applied: ["r_00000000000000a1"] }, "RULE_NOT_DELIVERED"],
    [lesson("project", "Before reporting issue 42, inspect recent transcript activity."), "LESSON_ABOUT_ONE_TASK"],
  ] as const) expect(await call(args)).toMatchObject({ ok: false, details: { code } });
  expect(roleMemoryCollection()?.snapshot() ?? []).toEqual(before);
});

test("the operator rewrites only the project and machine rules it reads", async () => {
  chooseSource("active");
  await call(lesson("project"));
  const id = projectView(project).scopes.find(scope => scope.scope === `project:${project}`)!.active[0]!.id;
  expect(await call({ rewrite: { id, rule: "Check every pinned acceptance criterion before reporting completed work.", why } })).toMatchObject({ ok: true, left: [{ id, action: "rewrite" }] });
  roleMemoryCollection(true)!.boundedPatch(4, tx => {
    tx.put({ kind: "rule", id: "r_00000000000000b1", scope: `role:${project}:builder`, rule: "Write the failing test before changing the code.", why, state: "active", hints: [],
      source: { project, pipelineId: "seed", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "seed" }, createdAt: "2026-10-22T00:00:00.000Z", changedAt: "2026-10-22T00:00:00.000Z" });
    tx.put({ kind: "scope", scope: `role:${project}:builder`, revision: 1, active: ["r_00000000000000b1"], history: [] });
  });
  expect(await call({ rewrite: { id: "r_00000000000000b1", rule, why } })).toMatchObject({ ok: false, details: { code: "RULE_NOT_READABLE" } });
});

test.each([...SOURCE_STATES])("in %s the operator path admits only Delegatus mode", async source => {
  chooseSource(source);
  const result = await call(lesson("project"));
  if (sourceTurnsEnginesOff(source)) expect(result).toMatchObject({ ok: true });
  else {
    expect(result).toMatchObject({ ok: false, details: { code: "LESSON_NOT_AN_ATTEMPT" } });
    expect(roleMemoryCollection()?.snapshot() ?? []).toEqual([]);
  }
});

test("a delegated worker, a role-bearing caller and an unseated root without registry proof stay refused", async () => {
  chooseSource("active");
  expect(await call(lesson("project"), service({ operator: false }))).toMatchObject({ ok: false, details: { code: "LESSON_NOT_AN_ATTEMPT" } });
  expect(await call(lesson("project"), service({ role: "builder" }))).toMatchObject({ ok: false, details: { code: "LESSON_NOT_AN_ATTEMPT" } });
  expect(await call(lesson("project"), service({ kind: "gateway", operator: false }))).toMatchObject({ ok: false, details: { code: "LESSON_NOT_A_SEAT" } });
  expect(await call(lesson("project"), service({ kind: "manager" }))).toMatchObject({ ok: false, details: { code: "LESSON_NOT_A_SEAT" } });
  expect(roleMemoryCollection()?.snapshot() ?? []).toEqual([]);
  expect(await call(lesson("project"), service({ kind: "gateway" }))).toMatchObject({ ok: true, left: [{ scope: `project:${project}` }] });
});

function stagePipeline(roleId: string, stage: { kind: string; onFail?: unknown } = { kind: "run" }): Pipeline {
  return {
    id: `p-${roleId}`, project, taskIds: ["task"],
    stages: [{ id: "work", prompt: "Work", next: null, effectiveRole: { roleId }, ...stage }],
    runs: [{ stageId: "work", attempts: [{ n: 1, state: "running", conversationId, effectiveRole: { roleId }, verdict: null }] }],
  } as unknown as Pipeline;
}

test("a stage without a request and a clean stage are still refused in Delegatus mode", async () => {
  chooseSource("active");
  expect(await call(lesson("project"), service({ pipelines: [stagePipeline("builder")] }))).toMatchObject({ ok: false, details: { code: "LESSON_NOT_REQUESTED" } });
  expect(await call(lesson("project"), service({ pipelines: [stagePipeline("reviewer")] }))).toMatchObject({ ok: false, details: { code: "LESSON_CLEAN_STAGE" } });
  expect(await call(lesson("project"), service({ pipelines: [stagePipeline("builder", { kind: "run", onFail: { to: "fix", maxRounds: 1 } })] }))).toMatchObject({ ok: false, details: { code: "LESSON_CLEAN_STAGE" } });
  expect(roleMemoryCollection()?.snapshot() ?? []).toEqual([]);
});

test("a designated seat keeps its own path in Delegatus mode", async () => {
  chooseSource("active");
  const api = service({ kind: "manager", role: "orchestrator", seats: [{ project, conversationId, path: null }] });
  expect(await call(lesson("role"), api)).toMatchObject({ ok: true, roleId: "orchestrator", left: [{ scope: `role:${project}:orchestrator` }] });
});
