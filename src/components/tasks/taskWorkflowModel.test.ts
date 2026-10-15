import { expect, test } from "bun:test";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import { createTaskWorkflowProjector, projectTaskWorkflows, taskWorkflowMembershipKey } from "./taskWorkflowModel";

const task = (id = "task-a", overrides: Partial<BoardTask> = {}): BoardTask => ({ id, project: "project", text: "Restore delivery",
  status: "assigned", placement: "unplaced", assignments: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides });
const file = (id: string, path = `fixtures/${id}.jsonl`, overrides: Partial<FileEntry> = {}): FileEntry => ({ path, conversationId: id,
  title: `Worker ${id}`, root: "codex-sessions", name: id, project: "project", engine: "codex", kind: "session", fmt: "codex",
  parent: null, mtime: 1, size: 1, activity: "recent", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, ...overrides });
const role = { roleId: "builder" as const, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null };
const attempt = (n: number, overrides: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt => ({ n, state: "failed", effectiveRole: role,
  launchId: `launch-${n}`, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
  startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: "launch failed", ...overrides });
const pipeline = (id: string, attempts: PipelineStageAttempt[] = [], overrides: Partial<Pipeline> = {}): Pipeline => ({
  id, task: "Restore delivery", taskIds: ["task-a"], project: "project", repoDir: "fixture-repo", worktreeDir: "fixture-worktree",
  branch: "fixture-branch", baseBranch: "main", baseRef: "a".repeat(40), lastPassedCommit: "b".repeat(40),
  stages: [{ id: "build", kind: "run", effectiveRole: role, prompt: "Build", next: null }], runs: [{ stageId: "build", attempts }],
  cursor: null, state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "2026-01-01", closedAt: null, ...overrides });

test("a done task retains two executions, pathless failure, review findings and a planned stage", () => {
  const a = pipeline("initial", [attempt(1), attempt(2, { conversationId: "worker", agentPath: "fixtures/worker.jsonl", state: "passed", verdict: { status: "pass" }, error: null })]);
  const b = pipeline("successor", [attempt(1, { effectiveRole: { ...role, roleId: "reviewer" }, verdict: { status: "fail", findings: ["Late response clears a newer draft"] }, reviewHeadSha: "c".repeat(40) })]);
  b.stages.push({ id: "verify", kind: "run", effectiveRole: role, prompt: "Verify", next: null });
  const result = projectTaskWorkflows([task("task-a", { status: "done" })], [a, b], [], [file("worker")]).tasks[0];
  expect(result.executions).toHaveLength(2);
  expect(result.references.map(r => r.kind)).toEqual(["attempt", "attempt", "attempt", "planned"]);
  expect(result.workers).toHaveLength(1);
  expect(result.unresolved).toBe(2);
  expect(result.reviews).toBe(1);
  expect(result.references[2].findings).toEqual(["Late response clears a newer draft"]);
  expect(result.references[2].reviewedSha).toBe("c".repeat(40));
  expect(result.executions[0].pipeline.publishedCommit).toBeUndefined();
});

test("manager source overlap and matching titles never manufacture membership", () => {
  const t = task("task-a", { source: { path: "fixtures/manager.jsonl", ts: null, text: "Restore delivery", fingerprint: "fixture", engine: "codex" },
    assignments: [{ path: "fixtures/manager.jsonl", conversationId: "manager", panePid: null, state: "handoff", error: null, at: "2026-01-01" }] });
  const p = pipeline("other", [], { taskIds: [], srcPath: "fixtures/manager.jsonl", srcConversationId: "manager" });
  const result = projectTaskWorkflows([t], [p], [], [file("manager")]);
  expect(result.tasks[0].executions).toHaveLength(0);
  expect(result.unlinkedPipelines).toEqual([p]);
});

test("direct launch assignment links an unresolved attempt without a transcript", () => {
  const t = task("task-a", { assignments: [{ path: null, launchId: "launch-1", panePid: null, state: "spawning", error: null, at: "2026-01-01" }] });
  const result = projectTaskWorkflows([t], [pipeline("p", [attempt(1)], { taskIds: [] })], [], []);
  expect(result.tasks[0].executions[0].basis).toBe("assignment");
  expect(result.tasks[0].references.every(r => r.file === null)).toBe(true);
});

test("current generation wins over placeholders and archived paths; contradictory identity stays unresolved", () => {
  const old = file("worker", "fixtures/old.jsonl", { migratedTo: "fixtures/new.jsonl" });
  const current = file("worker", "fixtures/new.jsonl");
  const p = pipeline("p", [attempt(1, { conversationId: "worker", agentPath: old.path }), attempt(2, { conversationId: "missing", agentPath: current.path })]);
  const result = projectTaskWorkflows([task()], [p], [], [file("worker", "spawn:launch-1"), old, current]).tasks[0];
  expect(result.references[0].file).toBe(current);
  expect(result.references[1].file).toBeNull();
  expect(result.workers).toEqual([current]);
});

test("shared worker has one canonical target in each task and remains reachable at scale", () => {
  for (const count of [24, 100, 1000]) {
    const files = Array.from({ length: count }, (_, i) => file(`worker-${i}`));
    const tasks = Array.from({ length: Math.ceil(count / 4) }, (_, i) => task(`task-${i}`));
    const pipelines = tasks.map((t, i) => pipeline(`p-${i}`, files.slice(i * 4, i * 4 + 4).map((f, n) => attempt(n + 1, { conversationId: f.conversationId!, agentPath: f.path })), { taskIds: [t.id] }));
    pipelines[0].taskIds.push(tasks.at(-1)!.id);
    const result = projectTaskWorkflows(tasks, pipelines, [], files);
    expect(new Set(result.tasks.flatMap(t => t.workers.map(f => f.path))).size).toBe(count);
    expect(result.unlinkedWorkers).toHaveLength(0);
    expect(result.tasks.at(-1)!.workers).toContain(files.at(-1)!);
  }
});

test("embedded review rounds preserve their own SHA, verdict and binding", () => {
  const p = pipeline("p", [attempt(1, { flowId: "flow-a" })]);
  const flow = { id: "flow-a", implementerPath: "fixtures/builder.jsonl", rounds: [
    { n: 1, reviewerBindingId: "binding-a", reviewerPath: "fixtures/reviewer.jsonl", reviewerConversationId: "reviewer", verdict: "REQUEST_CHANGES", findingsCount: 2, reviewHeadSha: "d".repeat(40) },
    { n: 2, reviewerBindingId: "binding-b", reviewerPath: null, reviewerConversationId: null, verdict: null, findingsCount: null, terminalAt: "2026-01-02" },
  ] } as Flow;
  const result = projectTaskWorkflows([task()], [p], [flow], [file("reviewer")]);
  expect(result.tasks[0].reviews).toBe(2);
  expect(result.tasks[0].references.at(-2)?.reviewedSha).toBe("d".repeat(40));
  expect(result.tasks[0].references.at(-1)?.state).toBe("unresolved");
  expect(result.unlinkedFlows).toHaveLength(0);
});

test("unlinked history is project-scoped while explicit cross-project workers remain reachable", () => {
  const local = file("local"), other = file("other", "fixtures/other.jsonl", { project: "other-project" });
  const foreignPipeline = pipeline("foreign", [attempt(1, { conversationId: "other", agentPath: other.path })], { project: "other-project", taskIds: [] });
  const result = projectTaskWorkflows([task()], [foreignPipeline], [], [local, other], "project");
  expect(result.unlinkedWorkers).toEqual([local]);
  expect(result.unlinkedPipelines).toHaveLength(0);
  expect(result.unlinkedReferences.map(r => r.file)).toEqual([local]);
  foreignPipeline.taskIds = ["task-a"];
  const linked = projectTaskWorkflows([task()], [foreignPipeline], [], [local, other], "project");
  expect(linked.tasks[0].workers).toEqual([other]);
  expect(linked.unlinkedWorkers).toEqual([local]);
});

test("a changed conversation rebuilds only its task, retaining unrelated task history", () => {
  const project = createTaskWorkflowProjector();
  const files = [file("a"), file("b")];
  const tasks = [task("a"), task("b")];
  const pipelines = files.map(f => pipeline(f.conversationId!, [attempt(1, { conversationId: f.conversationId })], { taskIds: [f.conversationId!] }));
  const first = project(tasks, pipelines, [], files);
  const updated = { ...files[0], size: 2 };
  const next = project(tasks, pipelines, [], [updated, files[1]]);
  expect(next).toEqual(projectTaskWorkflows(tasks, pipelines, [], [updated, files[1]]));
  expect(next.tasks[0]).not.toBe(first.tasks[0]);
  expect(next.tasks[0].workers).toEqual([updated]);
  expect(next.tasks[1]).toBe(first.tasks[1]);
  expect(next.tasks[1].executions).toBe(first.tasks[1].executions);
});

test("membership changes, removed work and arriving generations invalidate the affected task", () => {
  const project = createTaskWorkflowProjector();
  const assigned = task("a", { assignments: [{ path: "fixtures/a.jsonl", panePid: null, state: "delivered", error: null, at: "2026-01-01" }] });
  const foreign = pipeline("foreign", [attempt(1, { conversationId: "a", agentPath: "fixtures/older.jsonl" })], { taskIds: [], project: "elsewhere" });
  const first = project([assigned], [foreign], [], []);
  expect(first.tasks[0].executions).toHaveLength(0);
  const arrived = project([assigned], [foreign], [], [file("a")]);
  expect(arrived.tasks[0].executions.map(e => e.basis)).toEqual(["assignment"]);
  expect(arrived.tasks[0].workers).toHaveLength(1);
  const explicit = { ...foreign, taskIds: ["a"] };
  const linked = project([assigned], [explicit], [], [file("a")]);
  expect(linked.tasks[0].executions[0].basis).toBe("explicit");
  const removed = project([assigned], [], [], []);
  expect(removed.tasks[0].executions).toHaveLength(0);
  expect(removed.tasks[0].workers).toHaveLength(0);
  expect(removed.tasks[0].unresolved).toBe(1);
  expect(project([], [explicit], [], []).unlinkedPipelines).toEqual([explicit]);
});

test("pipeline and review edits retain unrelated tasks and refresh findings without a file change", () => {
  const project = createTaskWorkflowProjector();
  const tasks = [task("a"), task("b")];
  const p = pipeline("p", [attempt(1, { flowId: "f" })], { taskIds: ["a"] });
  const f = { id: "f", implementerPath: null, rounds: [] } as unknown as Flow;
  const first = project(tasks, [p], [f], []);
  const changed = { ...f, rounds: [{ n: 1, reviewerPath: null, verdict: "APPROVE", findingsCount: 0 }] } as Flow;
  const reviewed = project(tasks, [p], [changed], []);
  expect(reviewed.tasks[0].reviews).toBe(1);
  expect(reviewed.tasks[0]).not.toBe(first.tasks[0]);
  expect(reviewed.tasks[1]).toBe(first.tasks[1]);
  const finished = { ...p, state: "completed" as const };
  const next = project(tasks, [finished], [changed], []);
  expect(next.tasks[0].executions[0].pipeline.state).toBe("completed");
  expect(next.tasks[1]).toBe(reviewed.tasks[1]);
});


test("size and freshness updates refresh all shared references and match full projection through generation changes", () => {
  const project = createTaskWorkflowProjector();
  const a = file("a"), b = file("b"), outside = file("outside");
  const tasks = [task("task-a"), task("task-b")];
  const pipelines = [pipeline("shared", [attempt(1, { conversationId: "a", agentPath: a.path, flowId: "review" })], { taskIds: tasks.map(t => t.id) })];
  const flows = [{ id: "review", project: "project", implementerPath: a.path, implementerConversationId: "a", state: "closed", rounds: [
    { n: 1, reviewerPath: b.path, reviewerConversationId: "b", verdict: "APPROVE", findingsCount: 0 },
  ] } as Flow];
  for (const files of [
    [a, b, outside], [a, { ...b, size: 100 }, outside], [a, { ...b, mtime: 20 }, outside],
    [{ ...a, size: 10, mtime: 30 }, b, { ...outside, size: 50 }],
    [a, { ...b, title: "Renamed", activity: "idle" as const }, outside],
    [a, file("b", "fixtures/rebound.jsonl"), outside], [a, outside], [outside, a, b],
  ]) {
    const result = project(tasks, pipelines, flows, files, "project");
    expect(result).toEqual(projectTaskWorkflows(tasks, pipelines, flows, files, "project"));
    expect(result.tasks.every(t => t.references.every(Boolean))).toBe(true);
  }
  const oldA = file("a", "fixtures/a-old.jsonl", { migratedTo: "fixtures/a-next.jsonl", mtime: 10 });
  const olderA = file("a", "fixtures/a-older.jsonl", { migratedTo: "fixtures/a-next.jsonl", mtime: 5 });
  for (const files of [[oldA, olderA, b], [oldA, { ...olderA, mtime: 15 }, b]]) {
    expect(project(tasks, pipelines, flows, files)).toEqual(projectTaskWorkflows(tasks, pipelines, flows, files));
  }
  for (const files of [[a, a, b], [{ ...a, size: 500 }, a, b], [a, { ...a, size: 700 }, b]]) {
    expect(project(tasks, pipelines, flows, files)).toEqual(projectTaskWorkflows(tasks, pipelines, flows, files));
  }
});

test("membership keys survive payload freshness but change when generation or relationship facts change", () => {
  const project = createTaskWorkflowProjector();
  const tasks = [task()], pipelines = [pipeline("p", [attempt(1, { conversationId: "a" })])], flows: Flow[] = [];
  const a = file("a"), b = file("b");
  const first = project(tasks, pipelines, flows, [a, b]);
  const fresh = project(tasks, pipelines, flows, [{ ...a, size: 200, mtime: 50 }, b]);
  expect(taskWorkflowMembershipKey(fresh)).toBe(taskWorkflowMembershipKey(first));
  expect(fresh.tasks[0].references[0].file?.size).toBe(200);
  for (const files of [[{ ...a, activity: "idle" as const }, b], [file("a", "fixtures/new.jsonl"), b], [b], [b, a]]) {
    const next = project(tasks, pipelines, flows, files);
    expect(taskWorkflowMembershipKey(next)).not.toBe(taskWorkflowMembershipKey(fresh));
    expect(next).toEqual(projectTaskWorkflows(tasks, pipelines, flows, files));
  }
});
