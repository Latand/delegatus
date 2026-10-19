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
const { learnedRulesBlock, lessonRequest, stageLessons, projectView } = await import("@/lib/memory/roleStore");
const { parseLessons } = await import("@/lib/memory/roleStage");
const { lessonRequestLines } = await import("@/lib/memory/roleRender");
const { memoryProblemSignals } = await import("@/lib/memory/roleProblems");
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
    id: `p-lesson-${fixture}`, project: PROJECT, taskIds: [`task-${fixture}`],
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

function serviceAs(conversationId: string, replaced = false, record = pipeline()) {
  const bindings = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "agent", conversationId, role: null }),
    callerProject: () => PROJECT,
    authorizedSeats: () => [{ project: PROJECT, conversationId: "conversation_seat" }],
    reportStageCompletion: async () => ({
      pipelineId: record.id, stageId: conversationId === "conversation_fix" ? "fix" : "review", attempt: 1, replaced,
      report: { seq: 1, at: "2026-10-07T12:00:00.000Z", actor: { kind: "agent", role: null, conversationId }, verdict: { status: "pass", findings: [] }, summary: "done", provenance: { state: "pending", head: null, branch: "b", uncommitted: null, pullRequest: null, pullRequestState: "pending", outputs: [] }, calls: 1 },
    }),
    readPipelineRecord: () => record,
    getPipelines: () => ({ pipelines: [record] }),
  } as never);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  return { callTool: (...args: Parameters<typeof service.callTool>) => service.callTool(...args) as Promise<McpToolResult & Record<string, unknown>> };
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
  expect((fix.lessonRequest as string[]).join("\n")).toContain("- P1: empty input throws");
  const repeat = await call("conversation_fix", "stage_report", { verdict: "pass", summary: "fixed again" }, true);
  expect(repeat.lessonRequest).toBeUndefined();

  expect(await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", role: "reviewer", rule: RULE, why: "Review found an untested empty input path." } })).toMatchObject({ ok: false, details: { code: "LESSON_CLEAN_ROLE" } });
  const left = await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", rule: RULE, why: "Review failed on an untested empty path." } });
  expect(left).toMatchObject({ ok: true, stageId: "fix", left: [{ scope: `role:${PROJECT}:builder`, state: "active" }] });
  expect(learnedRulesBlock(PROJECT, "builder")).toContain(RULE);
});

test("a fix request quotes finding classes and asks for the rule needed before the first review", async () => {
  const record = pipeline();
  record.runs[0].attempts[0].verdict!.rankedFindings = [
    { severity: "P3", text: "The endpoint accepts a request without its required field. Another sentence." },
    { severity: "P1", text: "A failed successor can pass the promotion gate.\nDetails follow." },
    { severity: "P2", text: "The decision row clips at phone width in Ukrainian." },
  ];
  const response = await serviceAs("conversation_fix", false, record).callTool("stage_report", { clientRequestId: "finding-classes", verdict: "pass" });
  const lines = response.lessonRequest as string[];
  expect(lines.filter(line => /^- P\d:/.test(line))).toEqual([
    "- P1: A failed successor can pass the promotion gate.",
    "- P2: The decision row clips at phone width in Ukrainian.",
    "- P3: The endpoint accepts a request without its required field.",
  ]);
  const prompt = lines.join("\n");
  expect(prompt).toContain("before the first review");
  expect(prompt.indexOf("- rewrite:")).toBeLessThan(prompt.indexOf("- lesson:"));
  for (const clause of ["this specification alone", "finding was not a defect", "a gate every task runs now catches it", '"Existing rules cover it" is no reason', "No lesson may be about a task.", "choose the narrowest true level:", "- role on every project:", "- project: every role", "- machine: every role"]) expect(prompt).toContain(clause);
  for (const line of lessonRequestLines(null).filter(line => line.startsWith("No lesson may") || /^- (role|project|machine):|^- role on every project:/.test(line))) expect(lines).toContain(line);
  expect(lessonRequest(record.id, "fix", 1)?.taskId).toBe(record.taskIds[0]);
});

test("finding openings are bounded by sentences, first lines and Unicode code points", async () => {
  const record = pipeline();
  const long = "\u{10330}".repeat(300);
  record.runs[0].attempts[0].verdict!.rankedFindings = [
    { severity: "P1", text: long }, { severity: "P1", text: "One sentence. Another sentence." },
    { severity: "P2", text: "First line\nSecond line" },
    ...Array.from({ length: 4 }, (_, i) => ({ severity: "P3" as const, text: `Other finding ${i}` })),
  ];
  const result = await serviceAs("conversation_fix", false, record).callTool("stage_report", { clientRequestId: "bounded-findings", verdict: "pass" });
  const lines = result.lessonRequest as string[];
  expect(lines.filter(line => /^- P\d:/.test(line))).toHaveLength(5);
  expect(lines).toContain(`- P1: ${"\u{10330}".repeat(140)}…`);
  expect(lines).toContain("- P1: One sentence.");
  expect(lines).toContain("- P2: First line");
  expect(lines).toContain("- and 2 more, in your prompt");
});

test("legacy unranked findings are quoted; attempts without findings retain the default wording", async () => {
  const record = pipeline();
  record.runs[0].attempts[0].verdict = { status: "fail", findings: ["The saved shape omits a required property."] };
  const result = await serviceAs("conversation_fix", false, record).callTool("stage_report", { clientRequestId: "unranked-findings", verdict: "pass" });
  expect(result.lessonRequest).toContain("- unranked: The saved shape omits a required property.");
  expect(lessonRequestLines({ stageId: "review", findings: [] })).toEqual(lessonRequestLines(null));
  fixture += 1;
  const first = pipeline();
  first.runs[1].attempts[0].activatedBy = null;
  const initial = await serviceAs("conversation_fix", false, first).callTool("stage_report", { clientRequestId: "first-findings", verdict: "pass" });
  expect(initial.lessonRequest).toEqual(lessonRequestLines(null));
});

test("none is recorded under the attempt with its gate reason; the server does not judge prose", async () => {
  for (const none of ["The required schema gate now rejects this shape on every task.", "Existing rules cover it."]) {
    fixture += 1;
    const record = pipeline();
    await call("conversation_fix", "stage_report", { verdict: "pass" });
    expect(await call("conversation_fix", "leave_lesson", { none })).toMatchObject({ ok: true, none });
    expect(lessonRequest(record.id, "fix", 1)?.none).toBe(none);
    expect(stageLessons(PROJECT).find(row => row.pipelineId === record.id)).toMatchObject({ rules: [], none });
  }
});

test("a concrete problem answer is retained for the seat and never stored as a rule", async () => {
  const record = pipeline();
  const service = serviceAs("conversation_fix", false, record);
  const report = await service.callTool("stage_report", { clientRequestId: "problem-request", verdict: "pass" });
  expect((report.lessonRequest as string[]).join("\n")).toContain("- problem:");
  const problem = { statement: "The locale list in the instructions disagrees with the required locale gate.", evidence: "config/supported-locales.js lists six locales; the instructions list four." };
  const before = projectView(PROJECT).scopes.flatMap(scope => scope.active).length;
  const answer = await service.callTool("leave_lesson", { clientRequestId: "problem-answer", problem });
  expect(answer).toMatchObject({ ok: true, left: [], problem });
  expect(lessonRequest(record.id, "fix", 1)?.problem).toEqual(problem);
  const signal = memoryProblemSignals(PROJECT, []).find(signal => signal.label.includes(problem.statement))!;
  const read = await service.callTool("seat_tick_settings", { clientRequestId: "problem-read", project: PROJECT, verbose: true, problemId: signal.id });
  expect(read).toMatchObject({ ok: true, problem });
  expect(projectView(PROJECT).scopes.flatMap(scope => scope.active)).toHaveLength(before);
  expect(await service.callTool("leave_lesson", { clientRequestId: "problem-again", none: "No further lesson." })).toMatchObject({ ok: false, details: { code: "LESSON_LIMIT" } });
});

test("path-specific and defective rules are steered to problem without consuming the request", async () => {
  await call("conversation_fix", "stage_report", { verdict: "pass" });
  for (const rule of ["Size translation work from config/supported-locales.js before editing translations.", "The locale list is mismatched with the instructions.", "The persistence endpoint accepts requests without their required field."]) {
    const result = await call("conversation_fix", "leave_lesson", { lesson: { scope: "project", rule, why: "The locale gate rejected a missing language." } });
    expect(result).toMatchObject({ ok: false, details: { code: "LESSON_IS_PROBLEM" } });
  }
  const machine = await call("conversation_fix", "leave_lesson", { lesson: { scope: "machine", rule: "In this project, validate the pinned locale list before translation work.", why: "The local list differed from the required gate." } });
  expect(machine).toMatchObject({ ok: false, details: { code: "LESSON_WRONG_LEVEL" } });
  expect(await call("conversation_fix", "leave_lesson", { lesson: { scope: "role", rule: "When a locale list is mismatched, verify the authoritative list before changing translations.", why: "The locale gate rejected a missing language." } })).toMatchObject({ ok: true });
});

test("generic imperative checks can name a missing or broken state as their condition", () => {
  for (const rule of ["Check the retry path when a durable owner is missing.", "Verify the recovery boundary when a successor is broken.", "Never replay a write while its acknowledgement is missing."]) {
    expect(parseLessons({ lesson: { scope: "role", rule, why: "A missing owner exposed an unchecked recovery branch." } }, "builder").lessons).toHaveLength(1);
  }
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


test("every exact id in the rendered four-scope block can be rewritten through leave_lesson", async () => {
  const { roleMemoryCollection, learnedRulesSnapshot } = await import("@/lib/memory/roleStore");
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(previous!, "rendered-rewrites");
  const at = "2026-10-19T00:00:00.000Z";
  const scopes = [`role:${PROJECT}:builder`, "role:*:builder", `project:${PROJECT}`, "machine"];
  const ids = scopes.map((_, n) => `r_${String(n + 1).padStart(16, "0")}`);
  try {
    const store = roleMemoryCollection(true)!;
    store.boundedPatch(20, tx => {
      scopes.forEach((scope, n) => {
        tx.put({ kind: "scope", scope, revision: 1, active: [ids[n]], history: [] });
        tx.put({ kind: "rule", id: ids[n], scope, rule: `Verify durable ownership before replaying the ${["first", "second", "third", "fourth"][n]} operation.`, why: "An earlier owner retained a durable receipt.", state: "active", hints: [], source: { project: PROJECT, pipelineId: "seed", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_seed" }, createdAt: at, changedAt: at });
      });
    });
    const snapshot = learnedRulesSnapshot(PROJECT, "builder");
    const rendered = [...snapshot.block.matchAll(/^- \[([^\]]+)\]/gm)].map(match => match[1]);
    expect(rendered).toEqual(ids);
    expect(snapshot.rules.map(rule => rule.id)).toEqual(ids);
    for (const id of rendered) {
      fixture += 1;
      const service = serviceAs("conversation_fix");
      expect(await service.callTool("stage_report", { clientRequestId: `report-${id}`, verdict: "pass" })).toMatchObject({ ok: true });
      const rewrite = { id, rule: "Before replaying a durable operation, verify both its owner and its acknowledgement.", why: "A replay accepted a receipt from an earlier owner." };
      const before = store.get(`r:${id}`);
      const result = await service.callTool("leave_lesson", { clientRequestId: `rewrite-${id}`, rewrite });
      expect(result).toMatchObject({ ok: true, left: [{ id, action: "rewrite", scope: scopes[ids.indexOf(id)] }] });
      const updated = store.get(`r:${id}`);
      if (updated?.kind !== "rule") throw Error("missing rewritten rule");
      expect(updated.rule).toBe(rewrite.rule);
      expect(store.get(`r:${updated.versions![0]}`)).toMatchObject({ kind: "rule", rule: before?.kind === "rule" ? before.rule : "", versionOf: id });
    }
    // A near miss must fail without consuming the answer or guessing a write.
    fixture += 1;
    const service = serviceAs("conversation_fix");
    await service.callTool("stage_report", { clientRequestId: "near-report", verdict: "pass" });
    const rewrite = { id: ids[0].slice(0, -1), rule: "Check both durable ownership and operation identity before acknowledging a replay.", why: "The durable record belonged to another operation." };
    const miss = await service.callTool("leave_lesson", { clientRequestId: "near-rewrite", rewrite });
    expect(miss).toMatchObject({ ok: false, details: { code: "RULE_NOT_READABLE" } });
    if (miss.ok) throw Error("near miss unexpectedly accepted");
    expect(miss.error).toContain(ids[0]);
    expect(await service.callTool("leave_lesson", { clientRequestId: "corrected-rewrite", rewrite: { ...rewrite, id: ids[0] } })).toMatchObject({ ok: true, left: [{ id: ids[0] }] });
  } finally { process.env.LLV_STATE_DIR = previous; }
});


test("rewrite hints disclose only active rules in the caller's readable scopes", async () => {
  const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(previous!, "rewrite-authority");
  try {
    const store = roleMemoryCollection(true)!;
    const at = "2026-10-19T00:00:00.000Z";
    const cases = [
      { id: "r_1111111111111111", scope: `role:${PROJECT}:architect`, state: "active" as const },
      { id: "r_2222222222222222", scope: "role:foreign:builder", state: "active" as const },
      { id: "r_3333333333333333", scope: `role:${PROJECT}:builder`, state: "archived" as const },
      { id: "r_4444444444444444", scope: `role:${PROJECT}:builder`, state: "active" as const, versionOf: "r_5555555555555555" },
      { id: "r_6666666666666666", scope: `role:${PROJECT}:builder`, state: "active" as const, unlisted: true },
    ];
    store.boundedPatch(20, tx => {
      const groups = new Map<string, string[]>();
      for (const row of cases) {
        tx.put({ kind: "rule", ...row, rule: RULE, why: "An earlier replay ignored its durable owner.", hints: [], source: { project: PROJECT, pipelineId: "seed", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_seed" }, createdAt: at, changedAt: at });
        if (!row.unlisted) groups.set(row.scope, [...(groups.get(row.scope) ?? []), row.id]);
      }
      for (const [scope, active] of groups) tx.put({ kind: "scope", scope, revision: 1, active, history: [] });
    });
    fixture += 1;
    const record = pipeline();
    const service = serviceAs("conversation_fix", false, record);
    await service.callTool("stage_report", { clientRequestId: "authority-report", verdict: "pass" });
    for (const row of cases) for (const id of [row.id, row.id.slice(0, -1)]) {
      const result = await service.callTool("leave_lesson", { clientRequestId: `authority-${id}`, rewrite: { id, rule: "Verify both the durable owner and operation before accepting a replayed receipt.", why: "An earlier replay ignored its durable owner." } });
      expect(result).toMatchObject({ ok: false, details: { code: "RULE_NOT_READABLE" } });
      if (result.ok) throw Error("unreadable rewrite accepted");
      expect(result.error).not.toContain(row.id);
      expect(result.error).not.toContain("closest readable");
    }
    expect(lessonRequest(record.id, "fix", 1)?.rewrote).toBeUndefined();
    expect(await service.callTool("leave_lesson", { clientRequestId: "authority-none", none: "The existing authority guard covers this case." })).toMatchObject({ ok: true });
  } finally { process.env.LLV_STATE_DIR = previous; }
});
