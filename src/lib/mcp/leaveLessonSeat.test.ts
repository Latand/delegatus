import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "seat-lesson-"));
let state = 0;
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(sandbox, `state-${++state}`); });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { learnedRulesBlock, roleMemoryCollection, projectView } = await import("@/lib/memory/roleStore");

const project = "seat-lessons";
const conversationId = "seat";
const rule = "Before reporting an agent as stalled, inspect the tail of its conversation for recent work.";
const why = "An activity signal reported a stall while the transcript showed progress.";
function service(kind = "manager", seats: { project: string | null; conversationId: string; path: null }[] = [{ project, conversationId, path: null }], via?: { deputy: string }) {
  return createMcpToolService(viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind, conversationId, ...(via ? { via } : {}) }),
    authorizedSeats: () => seats,
    listPipelineRecords: () => [],
  } as never), new MemoryMcpReceiptStore());
}

test("a designated seat leaves a role rule without a stage request", async () => {
  const result = await service().callTool("leave_lesson", { clientRequestId: "seat-first", lesson: { scope: "role", rule, why } });
  expect(result).toMatchObject({ ok: true, project, roleId: "orchestrator", left: [{ scope: `role:${project}:orchestrator`, state: "active" }] });
  expect(learnedRulesBlock(project, "orchestrator")).toContain(rule);
  const rows = roleMemoryCollection()?.snapshot() ?? [];
  expect(rows.filter(row => row.kind === "request")).toEqual([]);
  const stored = rows.find(row => row.kind === "rule");
  expect(stored).toMatchObject({ source: { origin: "seat", project, conversationId, roleId: "orchestrator", fixRound: false } });
  expect(projectView(project).scopes.find(scope => scope.roleId === "orchestrator")?.active[0]?.stageId).toBe("seat");
});

let request = 0;
const lesson = (rule: string, scope = "role", role?: string) => ({ scope, rule, why, ...(role ? { role } : {}) });
const call = (args: Record<string, unknown>, api = service()) => api.callTool("leave_lesson", { clientRequestId: `seat-check-${++request}`, ...args });

test("workers and undesignated or revoked seats cannot leave a rule", async () => {
  const before = roleMemoryCollection()?.snapshot() ?? [];
  for (const api of [service("agent"), service("manager", []), service("agent", [])]) {
    expect(await call({ lesson: lesson(rule) }, api)).toMatchObject({ ok: false });
  }
  expect(roleMemoryCollection()?.snapshot() ?? []).toEqual(before);
});

test("seat defects steer to a board task and leave neither rules nor problem signals", async () => {
  const before = roleMemoryCollection()?.snapshot() ?? [];
  for (const args of [
    { lesson: lesson("The activity signal is broken and reports stalled agents while they work.") },
    { lesson: lesson("Check src/activity.ts before reporting an agent as stalled.") },
    { problem: { statement: "The activity signal is broken.", evidence: "A working transcript was reported stalled." } },
  ]) {
    const result = await call(args);
    expect(result).toMatchObject({ ok: false, details: { code: "LESSON_IS_PROBLEM" } });
    expect(JSON.stringify(result)).toContain("create_task");
  }
  expect(roleMemoryCollection()?.snapshot() ?? []).toEqual(before);
});

test("seat guards reject declines, task narration, wrong levels and clean roles", async () => {
  for (const [args, code] of [
    [{ none: "There is no new practice." }, "LESSON_INVALID"],
    [{ lesson: lesson("Before reporting issue 42, inspect recent transcript activity.") }, "LESSON_ABOUT_ONE_TASK"],
    [{ lesson: lesson("When working in this repository, check the pinned acceptance before reporting.", "machine") }, "LESSON_WRONG_LEVEL"],
    [{ lesson: lesson(rule, "role", "reviewer") }, "LESSON_CLEAN_ROLE"],
  ] as const) expect(await call(args)).toMatchObject({ ok: false, details: { code } });
  process.env.LLV_ROLE_MEMORY = "off";
  try { expect(await call({ lesson: lesson(rule) })).toMatchObject({ ok: false, details: { code: "LESSON_SWITCHED_OFF" } }); }
  finally { delete process.env.LLV_ROLE_MEMORY; }
});

test("a seat writes maintainer and shared practice, and rewrites only readable rules with versions", async () => {
  await call({ lesson: lesson(rule) });
  expect(await call({ lesson: lesson("Verify settled evidence before marking a board task complete.", "role", "maintainer") })).toMatchObject({ ok: true, left: [{ scope: `role:${project}:maintainer` }] });
  expect(await call({ lesson: lesson("Check the pinned acceptance criteria before reporting completed work.", "project") })).toMatchObject({ ok: true, left: [{ scope: `project:${project}` }] });
  const scope = projectView(project).scopes.find(scope => scope.scope === `role:${project}:orchestrator`)!;
  const id = scope.active[0]!.id;
  await call({ lesson: lesson("Present reviewed prototype variants before starting implementation.") });
  expect(await call({ rewrite: { id, rule: "Inspect recent transcript messages before classifying an agent as stalled.", why } })).toMatchObject({ ok: true, left: [{ id, action: "rewrite" }] });
  const updated = projectView(project).scopes.find(scope => scope.scope === `role:${project}:orchestrator`)!;
  expect(updated.active.at(-1)!.id).toBe(id);
  expect(updated.active.at(-1)!.versions![0]!.rule).toBe(rule);
  const maintainer = projectView(project).scopes.find(scope => scope.scope === `role:${project}:maintainer`)!.active[0]!.id;
  expect(await call({ rewrite: { id: maintainer, rule, why } })).toMatchObject({ ok: false, details: { code: "RULE_NOT_READABLE" } });
});

test("seat attribution chooses its designation and receipt replay writes once", async () => {
  const api = service("manager", [{ project: "designation-project", conversationId, path: null }]);
  const args = { clientRequestId: "seat-replay", lesson: lesson(rule) };
  const one = await api.callTool("leave_lesson", args);
  expect(await api.callTool("leave_lesson", args)).toMatchObject({ ok: true, replayed: true });
  expect(one).toMatchObject({ ok: true, project: "designation-project" });
  expect(projectView("designation-project").scopes.find(scope => scope.roleId === "orchestrator")!.active).toHaveLength(1);
});


test("a manager without a project fails closed and a deputy writes as its seat", async () => {
  expect(await call({ lesson: lesson(rule) }, service("manager", [{ project: null, conversationId, path: null }]))).toMatchObject({ ok: false, details: { code: "LESSON_NOT_A_SEAT" } });
  expect(await call({ lesson: lesson(rule) }, service("manager", [{ project, conversationId, path: null }], { deputy: "deputy" }))).toMatchObject({ ok: true });
  expect(roleMemoryCollection()!.snapshot().find(row => row.kind === "rule")).toMatchObject({ source: { conversationId, origin: "seat" } });
});

test("seat lessons retain privacy hints and refresh publication known values", async () => {
  const { lessonKnownValuesFile } = await import("@/lib/memory/roleStore");
  const address = ["fixture", "example.test"].join("@");
  const result = await call({ lesson: lesson(`Verify the delivery recipient ${address} before reporting acknowledgement.`) });
  expect(result).toMatchObject({ ok: true, left: [{ hints: ["email_address"] }] });
  expect(fs.readFileSync(lessonKnownValuesFile(), "utf8")).toContain(address);
  const home = ["", "home", "fixture", "notes"].join("/");
  expect(await call({ lesson: lesson(`Inspect ${home} before reporting an agent as stalled.`) })).toMatchObject({ ok: false, details: { code: "LESSON_IS_PROBLEM" } });
});


test("designation is read again on the next call after revocation", async () => {
  const seats = [{ project, conversationId, path: null }];
  const api = service("manager", seats);
  expect(await call({ lesson: lesson(rule) }, api)).toMatchObject({ ok: true });
  const before = roleMemoryCollection()!.snapshot();
  seats.length = 0;
  expect(await call({ lesson: lesson("Present reviewed prototypes before starting implementation.") }, api)).toMatchObject({ ok: false, details: { code: "LESSON_NOT_A_SEAT" } });
  expect(roleMemoryCollection()!.snapshot()).toEqual(before);
});
