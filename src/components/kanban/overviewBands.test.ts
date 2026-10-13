import { expect, test } from "bun:test";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import { buildBranchGroups } from "@/components/projectModel";
import { buildSchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import { buildKanbanModel } from "./kanbanModel";
import { createOverviewBands } from "./overviewBands";

const NOW = 1_800_000_000;
const file = (id: string, project: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  path: `fixtures/${id}.jsonl`, conversationId: id, project, title: id, root: "claude-projects", name: id,
  kind: "session", engine: "claude", fmt: "claude", mtime: NOW - 10, size: 10, activity: "live", proc: "running",
  parent: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null }, ...extra,
} as FileEntry);
const task = (id: string, project: string, worker?: FileEntry): BoardTask => ({
  id, project, text: id, status: "assigned", placement: "unplaced", createdAt: "2026-01-01", updatedAt: "2026-01-01",
  assignments: worker ? [{ path: worker.path, conversationId: worker.conversationId, state: "delivered", at: "2026-01-01", error: null, panePid: null }] : [],
});
const role = { roleId: "builder", engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null };
const pipeline = (id: string, project: string, taskId: string, worker?: FileEntry): Pipeline => ({
  id, project, task: id, taskIds: [taskId], state: "running", stages: [{ id: "build", kind: "run", effectiveRole: role, next: null }],
  runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", effectiveRole: role, conversationId: worker?.conversationId ?? null,
    agentPath: worker?.path ?? null, launchId: "launch-" + id, flowId: null, startedAt: "2026-01-01" }] }],
  createdAt: "2026-01-01", cursor: { stageId: "build", state: "running" },
} as Pipeline);

function input(files: FileEntry[], tasks: BoardTask[], pipelines: Pipeline[] = [], flows: Flow[] = []) {
  return { files, tasks, pipelines, flows, layoutFlows: flows, surface: pipelines, placed: [], now: NOW, untitled: "Untitled", reviewFlow: "Review",
    groups: [...new Set(files.map(file => file.project))].flatMap(project => buildBranchGroups(files, project, { now: NOW })) };
}

function full(view: ReturnType<typeof input>) {
  const projection = projectTaskWorkflows(view.tasks, view.pipelines, view.flows, view.files);
  const layout = buildSchemeLayout(view.groups, [], view.files, view.layoutFlows, [], view.pipelines, view.surface, undefined, undefined, view.placed, undefined, { now: view.now });
  return { projection, bands: buildTaskBands(layout, { tasks: view.tasks, projection, untitled: view.untitled, reviewFlow: view.reviewFlow, deferDoneVisibility: true }) };
}

function verify(view: ReturnType<typeof input>, derive = createOverviewBands()) {
  const result = derive(view);
  expect(buildKanbanModel({ ...view, ...result })).toEqual(buildKanbanModel({ ...view, ...full(view) }));
  return result;
}

test("only a changed independent project's bands are derived again", () => {
  const a = file("a", "a"), b = file("b", "b");
  const tasks = [task("a", "a", a), task("b", "b", b)];
  const derive = createOverviewBands();
  const beforeInput = input([a, b], tasks);
  const before = verify(beforeInput, derive);
  const afterInput = input([{ ...a, size: 20 }, b], tasks);
  // The Overview grouper retains the untouched project's group identity.
  afterInput.groups[1] = beforeInput.groups[1];
  const after = verify(afterInput, derive);
  expect(after.bands.find(band => band.id === "task:b")).toBe(before.bands.find(band => band.id === "task:b"));
  expect(after.bands.find(band => band.id === "task:a")).not.toBe(before.bands.find(band => band.id === "task:a"));
  verify(input([b], [tasks[1]]), derive);
  verify(beforeInput, derive);
});

test("shared workers, foreign lineage, lanes and review history preserve the complete board", () => {
  const a = file("a", "a"), b = file("b", "b", { parent: a.path, kind: "subagent" });
  const reviewer = file("reviewer", "c");
  const tasks = [task("a", "a", a), task("b", "b", a), task("c", "c", b)];
  const p = pipeline("p", "b", "a", b);
  p.runs[0].attempts[0].flowId = "review";
  const flow = { id: "review", project: "c", implementerPath: b.path, implementerConversationId: b.conversationId,
    state: "reviewing", rounds: [{ n: 1, reviewerPath: reviewer.path, reviewerConversationId: reviewer.conversationId, verdict: null }],
    createdAt: "2026-01-01", roles: { implementer: role, reviewer: role }, mode: "auto", preset: "default", roundLimit: 3,
  } as unknown as Flow;
  const derive = createOverviewBands();
  verify(input([a, b, reviewer], tasks, [p], [flow]), derive);
  verify(input([a, b, { ...reviewer, lastAgentWorkAt: NOW * 1000 }], tasks, [p], [flow]), derive);
  verify(input([a, { ...b, parent: null }], tasks, [], []), derive);
});

test("unresolved assignments join foreign lanes before a transcript exists", () => {
  for (const binding of ["launch", "conversation", "path"] as const) {
    const t = task("a", "a"), p = pipeline("p", "b", "unrelated");
    const attempt = p.runs[0].attempts[0];
    const assignment = { path: null, state: "spawning", at: "2026-01-01", error: null, panePid: null } as BoardTask["assignments"][number];
    if (binding === "launch") assignment.launchId = attempt.launchId!;
    if (binding === "conversation") assignment.conversationId = attempt.conversationId = "not-yet-scanned";
    if (binding === "path") assignment.path = attempt.agentPath = "fixtures/not-yet-scanned.jsonl";
    t.assignments = [assignment];
    verify(input([], [t], [p]));
  }
});

test("project movement and duplicate conversation generations cannot split one worker", () => {
  const old = file("a", "a", { migratedTo: "fixtures/new.jsonl" });
  const current = file("a", "b", { path: "fixtures/new.jsonl" });
  const tasks = [task("a", "a", old), task("b", "b", current)];
  const derive = createOverviewBands();
  verify(input([old, current], tasks), derive);
  verify(input([{ ...current, project: "c" }], tasks), derive);
});

test("independent projects retain the full board's order and unlinked work across catalog permutations", () => {
  const files = [file("a", "a"), file("b", "b"), file("c", "c")];
  const tasks = [task("z", "c", files[2]), task("a", "a", files[0]), task("empty", "b")];
  const pipelines = [pipeline("unlinked", "b", "missing", files[1]), pipeline("linked", "a", "a", files[0])];
  const derive = createOverviewBands();
  verify(input(files, tasks, pipelines), derive);
  verify(input([...files].reverse(), [...tasks].reverse(), [...pipelines].reverse()), derive);
  verify(input(files, [{ ...tasks[0], status: "done" }, ...tasks.slice(1)], pipelines), derive);
  verify(input(files, tasks, [{ ...pipelines[0], state: "paused" }, pipelines[1]]), derive);
  verify(input(files, tasks, []), derive);
  verify(input([], [], []), derive);
  verify(input(files, tasks, pipelines), derive);
});

test("clock and label changes invalidate cached project bands without a new payload", () => {
  const worker = file("quiet", "a", { activity: "idle", proc: null, authoritativeTurn: undefined });
  const unnamed = { ...task("unnamed", "a"), text: "" };
  const view = input([worker], [unnamed]);
  const derive = createOverviewBands();
  const before = verify(view, derive);
  const translated = verify({ ...view, untitled: "Untitled task", reviewFlow: "Review flow" }, derive);
  expect(translated.bands.find(band => band.id === "task:unnamed")?.title).toBe("Untitled task");
  expect(translated.bands).not.toBe(before.bands);
  verify({ ...view, now: NOW + 49 * 3600 }, derive);
});
