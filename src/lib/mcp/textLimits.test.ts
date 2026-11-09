import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, MCP_TOOL_NAMES, type McpToolBindings } from "./server";
import { viewerMcpBindings } from "./bindings";
import { parseLessons } from "@/lib/memory/roleStage";
import { normalizeStageCompletion } from "@/lib/pipelines/verdict";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { taskRevision } from "@/lib/tasks/revision";
import type { BoardTask, TaskHold } from "@/lib/tasks/types";
import type { LessonInput } from "@/lib/memory/roleTypes";

const now = "2026-11-01T10:00:00.000Z";
const task: BoardTask = { id: "limit-task", project: "fixture", text: "Keep complete context", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now };
const scalarText = (length: number) => "я".repeat(16) + "🧭".repeat(length - 16);
const unitText = (length: number) => "🧭".repeat(Math.floor(length / 2)) + (length % 2 ? "я" : "");

async function protocol(run: (client: Client, dispatched: Array<{ name: string; args: Record<string, unknown> }>) => Promise<void>, overrides: Partial<McpToolBindings> = {}) {
  const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async (args: Record<string, unknown>) => { dispatched.push({ name, args }); return {}; }])) as McpToolBindings;
  const server = createViewerMcpServer(createMcpToolService({ ...bindings, ...overrides }, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "text-limit-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client, dispatched); }
  finally { await client.close(); await server.close(); }
}

const lesson = { scope: "project", rule: "Before replaying work, verify the current receipt and preserve its original identity.", why: "The earlier request had an uncertain delivery result." } satisfies LessonInput;
const form = { title: "Choose a direction", questions: [{ id: "direction", text: "Which direction should proceed?", options: [{ label: "Proceed", recommended: true }, { label: "Wait" }] }] };

test.each([
  ["leave_lesson", "lesson.rule", 300, (value: string) => ({ lesson: { ...lesson, rule: value } }), scalarText],
  ["leave_lesson", "lesson.why", 160, (value: string) => ({ lesson: { ...lesson, why: value } }), scalarText],
  ["leave_lesson", "rewrite.rule", 300, (value: string) => ({ rewrite: { id: "r_original", rule: value, why: lesson.why } }), scalarText],
  ["leave_lesson", "rewrite.why", 160, (value: string) => ({ rewrite: { id: "r_original", rule: lesson.rule, why: value } }), scalarText],
  ["leave_lesson", "none", 160, (value: string) => ({ none: value }), scalarText],
  ["leave_lesson", "problem.statement", 300, (value: string) => ({ problem: { statement: value, evidence: "Observed the stored outcome." } }), scalarText],
  ["leave_lesson", "problem.evidence", 1000, (value: string) => ({ problem: { statement: "The stored result is missing.", evidence: value } }), scalarText],
  ["stage_report", "summary", 2000, (value: string) => ({ verdict: "pass", summary: value }), unitText],
  ["stage_report", "result", 160, (value: string) => ({ verdict: "pass", result: value }), unitText],
  ["stage_report", "blockedReason", 2000, (value: string) => ({ verdict: "fail", blocked: true, blockedReason: value }), unitText],
  ["stage_report", "findings.0.text", 1995, (value: string) => ({ verdict: "fail", findings: [{ severity: "P1", text: value }] }), unitText],
  ["publish_prototype_review", "questions.0.text", 300, (value: string) => ({ ...form, questions: [{ ...form.questions[0], text: value }] }), scalarText],
  ["publish_prototype_review", "questions.0.options.0.label", 120, (value: string) => ({ ...form, questions: [{ ...form.questions[0], options: [{ label: value, recommended: true }, { label: "Wait" }] }] }), scalarText],
  ["pipeline_action", "answer", 12000, (value: string) => ({ pipelineId: "fixture", action: "resolve-decision", answer: value, expectedStageId: "build", expectedAttempt: 1, expectedRevision: "a".repeat(64) }), unitText],
  ["update_task", "note", 280, (value: string) => ({ taskId: task.id, note: value }), unitText],
  ["update_task", "details", 20000, (value: string) => ({ taskId: task.id, details: value }), unitText],
  ["update_task", "hold.note", 200, (value: string) => ({ taskId: task.id, hold: { kind: "external", note: value } }), unitText],
  ["update_task", "hold.ref", 500, (value: string) => ({ taskId: task.id, hold: { kind: "external", ref: value } }), unitText],
  ["update_task", "steps.0.id", 40, (value: string) => ({ taskId: task.id, steps: [{ id: value, text: "Verify", state: "open" }] }), (length: number) => "a".repeat(length)],
  ["update_task", "steps.0.ref", 200, (value: string) => ({ taskId: task.id, steps: [{ id: "verify", text: "Verify", state: "open", ref: value }] }), unitText],
  ["seat_tick_settings", "monitorPrompt", 16000, (value: string) => ({ monitorPrompt: value }), unitText],
  ["curate_rules", "rewrite.0.rule", 300, (value: string) => ({ action: "apply", scopes: [{ scope: "machine", revision: 0, order: [] }], rewrite: [{ id: "r_original", rule: value, why: lesson.why, note: "Keep the full invariant." }] }), scalarText],
  ["curate_rules", "rewrite.0.why", 160, (value: string) => ({ action: "apply", scopes: [{ scope: "machine", revision: 0, order: [] }], rewrite: [{ id: "r_original", rule: lesson.rule, why: value, note: "Keep the full invariant." }] }), scalarText],
  ["curate_rules", "rewrite.0.note", 1000, (value: string) => ({ action: "apply", scopes: [{ scope: "machine", revision: 0, order: [] }], rewrite: [{ id: "r_original", rule: lesson.rule, why: lesson.why, note: value }] }), unitText],
] as const)("%s refuses %s one over %i before dispatch and accepts a corrected retry", async (name, field, max, argsFor, text) => {
  await protocol(async (client, dispatched) => {
    const exact = await client.callTool({ name, arguments: { clientRequestId: "exact", ...argsFor(text(max)) } });
    expect(exact.isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
    const refused = await client.callTool({ name, arguments: { clientRequestId: "over", ...argsFor(text(max + 1)) } });
    expect(refused.isError).toBe(true);
    const error = JSON.stringify(refused.content);
    for (const part of [...field.split("."), String(max), `actual length is ${max + 1}`]) expect(error).toContain(part);
    expect(dispatched).toHaveLength(1);
    const corrected = await client.callTool({ name, arguments: { clientRequestId: "corrected", ...argsFor(text(max)) } });
    expect(corrected.isError).not.toBe(true);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]!.args).toEqual({ clientRequestId: "corrected", ...argsFor(text(max)) });
  });
});

test("discovery exposes normalized bounds, existing UTF-16 units and guard dependencies", async () => {
  await protocol(async client => {
    const listed = (await client.listTools()).tools;
    const schema = (name: string) => listed.find(tool => tool.name === name)!.inputSchema;
    const lessonField = schema("leave_lesson").properties!.lesson as { properties: Record<string, Record<string, unknown>> };
    expect(lessonField.properties.rule).toMatchObject({ "x-length-unit": "Unicode code points", "x-normalized-minLength": 20, "x-normalized-maxLength": 300 });
    const stageSummary = schema("stage_report").properties!.summary;
    expect(stageSummary).toMatchObject({ maxLength: 2000, "x-length-unit": "Unicode code points", "x-normalized-length-unit": "UTF-16 code units", "x-normalized-maxLength": 2000 });
    expect(schema("update_task").dependentRequired).toMatchObject({ expectedProject: ["expectedRevision"], expectedRevision: ["expectedProject"] });
    expect(schema("pipeline_action").allOf).toMatchObject([{ then: { required: ["answer", "expectedStageId", "expectedAttempt", "expectedRevision"] } }]);
  });
});

test("missing fields, invalid enums and optional null roles refuse before dispatch", async () => {
  await protocol(async (client, dispatched) => {
    for (const [name, args, field] of [
      ["get_task", { id: "fixture" }, "taskId"],
      ["leave_lesson", { lesson: { ...lesson, role: null } }, "role"],
      ["leave_lesson", { lesson: { ...lesson, scope: "global" } }, "scope"],
      ["pipeline_action", { pipelineId: "fixture", action: "restart" }, "action"],
    ] as const) {
      const result = await client.callTool({ name, arguments: { clientRequestId: `invalid-${field}`, ...args } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(field);
    }
    expect(dispatched).toEqual([]);
    expect((await client.callTool({ name: "leave_lesson", arguments: { clientRequestId: "omitted-role", lesson } })).isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
  });
});

test("lesson normalization and code-point bounds agree between protocol and domain", async () => {
  const args = { lesson: { ...lesson, rule: ` \n${scalarText(300)}  `, why: ` ${scalarText(160)}\n ` } };
  const parsed = parseLessons(args, "builder");
  expect(parsed.lessons[0]).toEqual({ ...lesson, rule: scalarText(300), why: scalarText(160) });
  await protocol(async (client, dispatched) => {
    expect((await client.callTool({ name: "leave_lesson", arguments: { clientRequestId: "padded", ...args } })).isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
  });
  for (const [field, max] of [["rule", 300], ["why", 160]] as const) {
    expect(() => parseLessons({ lesson: { ...lesson, [field]: scalarText(max + 1) } }, "builder"))
      .toThrow(`${field} must be ${field === "rule" ? "20" : "1"}–${max} normalized Unicode code points; actual length is ${max + 1}`);
  }
});

test("lesson recognisability counts NFKC letters without rewriting stored provenance", () => {
  const exact = "ﬃ".repeat(5) + "a";
  const parsed = parseLessons({ lesson: { ...lesson, why: exact } }, "builder");
  expect(parsed.lessons[0]!.why).toBe(exact);
  expect(() => parseLessons({ lesson: { ...lesson, why: "ﬃ".repeat(5) } }, "builder"))
    .toThrow("why needs at least 16 letters or digits after NFKC matching normalization; it has 15");
});

test("declared task whitespace normalization admits padded exact limits without dropping content", async () => {
  const note = unitText(280), details = unitText(20000);
  const args = { taskId: task.id, note: ` \n${note}\t `, details: ` \n${details}\t ` };
  await protocol(async (client, dispatched) => {
    expect((await client.callTool({ name: "update_task", arguments: { clientRequestId: "padded-task", ...args } })).isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args.note).toBe(args.note);
    expect(dispatched[0]!.args.details).toBe(args.details);
  });
  const stored = patchTask([task], task.id, args, now);
  expect(stored).toMatchObject({ ok: true, task: { note: { text: note }, details } });
});

test.each([["statement", 300], ["evidence", 1000]] as const)("problem domain preserves %s at its code-point maximum", (field, max) => {
  const problem = { statement: "The stored result is missing.", evidence: "Observed an absent stored row.", [field]: scalarText(max) };
  expect(parseLessons({ problem }, "builder").problem).toEqual(problem);
  expect(() => parseLessons({ problem: { ...problem, [field]: scalarText(max + 1) } }, "builder"))
    .toThrow(`problem.${field} must be 1–${max} normalized Unicode code points; actual length is ${max + 1}`);
});

test.each(["expectedProject", "expectedRevision"] as const)("update_task requires paired %s before dispatch", async missing => {
  await protocol(async (client, dispatched) => {
    const guarded = { taskId: task.id, note: "Review in progress", expectedProject: "fixture", expectedRevision: "a".repeat(64) };
    const incomplete: Record<string, unknown> = { ...guarded };
    delete incomplete[missing];
    const refused = await client.callTool({ name: "update_task", arguments: { clientRequestId: "missing", ...incomplete } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(missing);
    expect(dispatched).toEqual([]);
    expect((await client.callTool({ name: "update_task", arguments: { clientRequestId: "paired", ...guarded } })).isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
  });
});

test("paired task guards from a production create admit one write and reject stale or incomplete updates", () => {
  const created = createTask([], { project: "fixture", text: "Keep guarded context", placement: "unplaced", dueAt: "2026-12-01T10:00:00.000Z", dueTz: "UTC" }, [], { now: () => now, id: () => "guarded-task" });
  if (!created.ok) throw Error(created.error);
  const before = structuredClone(created.task);
  const guards = { expectedProject: created.task.project, expectedRevision: taskRevision(created.task) };
  for (const missing of ["expectedProject", "expectedRevision"] as const) {
    const incomplete: Record<string, unknown> = { ...guards, note: "Reviewing the current state" };
    delete incomplete[missing];
    expect(patchTask(created.tasks, created.task.id, incomplete, now)).toMatchObject({ ok: false, field: missing });
    expect(created.task).toEqual(before);
  }
  const accepted = patchTask(created.tasks, created.task.id, { ...guards, note: "Reviewing the current state" }, now);
  if (!accepted.ok) throw Error(accepted.error);
  expect(accepted.task.note?.text).toBe("Reviewing the current state");
  expect(patchTask(accepted.tasks, created.task.id, { ...guards, note: "Stale write" }, now)).toMatchObject({ ok: false, code: "TASK_REVISION_MISMATCH" });
  expect(patchTask(created.tasks, created.task.id, { ...guards, expectedProject: "other-project", note: "Wrong project" }, now)).toMatchObject({ ok: false, code: "TASK_PROJECT_MISMATCH" });
  expect(created.task).toEqual(before);
});

test.each(["answer", "expectedStageId", "expectedAttempt", "expectedRevision"])("resolve-decision requires %s before dispatch", async missing => {
  await protocol(async (client, dispatched) => {
    const complete = { pipelineId: "fixture", action: "resolve-decision", answer: "Continue", expectedStageId: "build", expectedAttempt: 1, expectedRevision: "a".repeat(64) };
    const incomplete: Record<string, unknown> = { ...complete };
    delete incomplete[missing];
    const refused = await client.callTool({ name: "pipeline_action", arguments: { clientRequestId: "missing", ...incomplete } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(missing);
    expect(dispatched).toEqual([]);
    expect((await client.callTool({ name: "pipeline_action", arguments: { clientRequestId: "complete", ...complete } })).isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
  });
});

test.each([
  ["note", 280, (value: string) => ({ note: value })],
  ["details", 20000, (value: string) => ({ details: value })],
  ["text", 6000, (value: string) => ({ text: value })],
  ["steps.0.text", 120, (value: string) => ({ steps: [{ id: "check", text: value, state: "open" }] })],
  ["steps.0.ref", 200, (value: string) => ({ steps: [{ id: "check", text: "Verify", state: "open", ref: value }] })],
  ["summary.headline", 120, (value: string) => ({ summary: { headline: value, text: "The result is complete." } })],
  ["summary.text", 600, (value: string) => ({ summary: { headline: "Result", text: value } })],
  ["summary.left", 200, (value: string) => ({ summary: { headline: "Result", text: "The result is complete.", left: value } })],
] as const)("task writer preserves %s at %i and refuses one over atomically", (field, max, argsFor) => {
  const accepted = patchTask([task], task.id, argsFor(unitText(max)), now);
  expect(accepted.ok).toBe(true);
  const refused = patchTask([task], task.id, argsFor(unitText(max + 1)), now);
  expect(refused.ok).toBe(false);
  if (refused.ok) throw Error("accepted an overage");
  for (const part of [field, String(max), `actual length is ${max + 1}`, "UTF-16 code units"]) expect(refused.error).toContain(part);
  expect(task).not.toHaveProperty("note");
});

test("checklist count at twenty is preserved and twenty-one is refused with its count", async () => {
  const steps = Array.from({ length: 21 }, (_, index) => ({ id: `check-${index}`, text: "Verify", state: "open" }));
  expect(patchTask([task], task.id, { steps: steps.slice(0, 20) }, now)).toMatchObject({ ok: true, task: { steps: steps.slice(0, 20) } });
  const refused = patchTask([task], task.id, { steps }, now);
  expect(refused).toMatchObject({ ok: false, field: "steps" });
  if (refused.ok) throw Error("accepted an overage");
  expect(refused.error).toContain("actual count is 21");
  await protocol(async (client, dispatched) => {
    const over = await client.callTool({ name: "update_task", arguments: { clientRequestId: "too-many-steps", taskId: task.id, steps } });
    expect(over.isError).toBe(true);
    for (const part of ["steps", "20", "actual count is 21"]) expect(JSON.stringify(over.content)).toContain(part);
    expect(dispatched).toEqual([]);
    const corrected = await client.callTool({ name: "update_task", arguments: { clientRequestId: "twenty-steps", taskId: task.id, steps: steps.slice(0, 20) } });
    expect(corrected.isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
  });
});

test.each(["note", "ref"] as const)("hold %s survives create, patch, nested step and store without clipping", field => {
  const max = field === "note" ? 200 : 500;
  // A supplementary scalar straddles the old slice boundary on the refused input.
  const exact = "я".repeat(max - 2) + "🧭";
  const over = "я".repeat(max - 1) + "🧭";
  const holder = (value: string) => ({ kind: "external", note: "After dependency clears", ref: "dependency", [field]: value } satisfies Pick<TaskHold, "kind" | "note" | "ref">);
  const writers = [
    (value: string) => createTask([], { project: "fixture", text: "Wait for dependency", placement: "unplaced", hold: holder(value) }, [], { now: () => now, id: () => "created" }),
    (value: string) => patchTask([task], task.id, { hold: holder(value) }, now),
    (value: string) => patchTask([task], task.id, { steps: [{ id: "dependency", text: "Wait", state: "open", hold: holder(value) }] }, now),
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hold-length-"));
  try {
    for (const writer of writers) {
      const accepted = writer(exact);
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) throw Error(accepted.error);
      const file = path.join(directory, "tasks.json");
      saveTasks(accepted.tasks, file);
      const stored = loadTasks(file)[0]!;
      expect((stored.hold ?? stored.steps?.[0]?.hold)?.[field]).toBe(exact);
      const refused = writer(over);
      expect(refused).toMatchObject({ ok: false });
      if (refused.ok) throw Error("accepted an overage");
      expect(refused.error).toContain(`hold.${field}`);
      expect(refused.error).toContain(String(max));
      expect(refused.error).toContain(`actual length is ${max + 1}`);
      expect(loadTasks(file)).toEqual([stored]);
    }
    const file = path.join(directory, "legacy.json");
    saveTasks([{ ...task, hold: { ...holder(over), since: now, by: "operator" } }], file);
    expect(loadTasks(file)[0]!.hold?.[field]).toBe(over);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a stored opaque hold reference reaches the production get_task protocol response in full", async () => {
  const ref = "a1b2c3d4" + "e".repeat(56);
  const created = createTask([], { project: "fixture", text: "Wait for the exact reference", placement: "unplaced", hold: { kind: "external", note: "After verification", ref }, dueAt: "2026-12-01T10:00:00.000Z", dueTz: "UTC" }, [], { now: () => now, id: () => "hold-reference" });
  if (!created.ok) throw Error(created.error);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hold-protocol-"));
  try {
    const file = path.join(directory, "tasks.json");
    saveTasks(created.tasks, file);
    const rows = loadTasks(file);
    const control = { get: async () => { throw Error("unexpected network read"); }, post: async () => { throw Error("unexpected network write"); } };
    const bindings = viewerMcpBindings(undefined, control, {
      taskSelectionSource: () => null, pipelineSelectionSource: () => null,
      listTaskRecords: () => rows, listPipelineRecords: () => [],
    } as never);
    await protocol(async client => {
      const result = await client.callTool({ name: "get_task", arguments: { taskId: created.task.id } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, task: { hold: { ref } } });
    }, { get_task: bindings.get_task });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each([["summary", 2000], ["result", 160], ["blockedReason", 2000]] as const)("stage domain refuses %s without silent truncation", (field, max) => {
  const base = field === "blockedReason" ? { verdict: "fail", blocked: true } : { verdict: "pass" };
  expect(normalizeStageCompletion({ ...base, [field]: unitText(max) })).not.toHaveProperty("error");
  const refused = normalizeStageCompletion({ ...base, [field]: unitText(max + 1) });
  expect(refused).toMatchObject({ code: "STAGE_REPORT_INVALID" });
  if (!("error" in refused)) throw Error("accepted an overage");
  expect(refused.error).toContain(field);
  expect(refused.error).toContain(String(max));
  expect(refused.error).toContain(`actual length is ${max + 1}`);
});

test.each([undefined, "receipt-query"])("wrong send receipt family is diagnostic and non-retryable with key %s", async clientRequestId => {
  const control = { get: async () => { throw Error("unexpected network read"); }, post: async () => { throw Error("unexpected network write"); } };
  const service = createMcpToolService(viewerMcpBindings(undefined, control), new MemoryMcpReceiptStore());
  const result = await service.callTool("message_receipt", { operationId: "pipeline_fixture", ...(clientRequestId ? { clientRequestId } : {}) });
  expect(result).toMatchObject({ ok: false, code: "OPERATION_UNKNOWN", retryable: false });
  if (result.ok) throw Error("unknown receipt was accepted");
  expect(result.error).toContain("operationId");
  expect(result.error).toContain("absence here does not prove no effect");
});

test.each([
  { status: 400, code: "PIPELINE_INVALID_FIELD", field: "expectedRevision", error: "expectedRevision belongs to another action" },
  { status: 409, code: "STAGE_CHANGED", field: "expectedAttempt", error: "the current attempt changed; read the stage again" },
])("pipeline adapter preserves deterministic $code refusal and original-key replay", async refusal => {
  const seen: unknown[] = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    attentionAuthority: () => ({ kind: "root", conversationId: "conversation_fixture" }),
    patchPipeline: async (_id: string, request: unknown) => { seen.push(request); return refusal; },
  } as never);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const args = { clientRequestId: "guard-refused", pipelineId: "fixture", action: "skip-stage", expectedRevision: "a".repeat(64) };
  expect(await service.callTool("pipeline_action", args)).toMatchObject({ ok: false, code: refusal.code, retryable: false, details: { field: refusal.field } });
  expect(await service.callTool("pipeline_action", args)).toMatchObject({ ok: false, replayed: true, retryable: false });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ action: args.action, expectedRevision: args.expectedRevision });
  expect(await service.callTool("pipeline_action", { ...args, expectedRevision: "b".repeat(64) })).toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(seen).toHaveLength(1);
});
