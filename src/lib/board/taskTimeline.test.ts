import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { filesReadSummary } from "@/lib/filesReadSummary";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { saveTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { projectTaskTimelines } from "./taskTimeline";

const NOW = Date.parse("2026-10-26T13:20:00Z");
const stamp = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const ms = (minutes: number) => NOW + minutes * 60_000;

function task(id = "task-main", project = "repo-alpha"): BoardTask {
  return { id, project, text: "Timeline work", status: "assigned", placement: "unplaced", assignments: [],
    createdAt: stamp(-300), updatedAt: stamp(-10) };
}

function lane(id = "lane-main", owner = task()): Pipeline {
  const pipeline = buildPipeline({ id, task: owner.text, project: owner.project, taskIds: [owner.id], repoDir: "/repo",
    srcPath: null, srcConversationId: null, now: stamp(-120), stages: [{ id: "build", kind: "run", next: null,
      "prompt": "Build the change", effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high",
        access: "read-write", promptScaffold: null } }] });
  pipeline.state = "running";
  pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
  return pipeline;
}

function attempt(pipeline: Pipeline, n: number, from: number | null, to: number | null, state: PipelineStageAttempt["state"] = "passed"): PipelineStageAttempt {
  const row: PipelineStageAttempt = { n, state, effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: from === null ? null : stamp(from), completedAt: to === null ? null : stamp(to),
    input: null, output: null, activatedBy: null, verdict: null, error: null };
  pipeline.runs[0]!.attempts.push(row);
  return row;
}

function read(pipelines: Pipeline[], tasks = [task()], nowMs = NOW) {
  return projectTaskTimelines({ project: "repo-alpha", tasks, pipelines, nowMs });
}

test("real board summary records retain retries, settled lanes and frozen attempt runtimes", () => {
  const previous = lane("earlier");
  previous.state = "completed";
  previous.createdAt = stamp(-240);
  previous.cursor = null;
  attempt(previous, 1, -230, -180);
  const current = lane();
  const failed = attempt(current, 1, -120, -100, "failed");
  failed.effectiveRole.engine = "claude";
  failed.effectiveRole.model = "claude-opus-4-6";
  failed.effectiveRole.roleId = "reviewer";
  const running = attempt(current, 2, -90, null, "running");
  current.stages[0]!.effectiveRole.model = "changed-stage-model";
  current.stages[0]!.effectiveRole.roleId = "architect";
  const historical = attempt(current, 3, -200, -190);
  historical.historical = true;
  // Content bodies and identifiers never become timeline fields.
  running.input = running.output = "Execution body";
  running.accountId = "account-fixture";
  const source = [current, previous];
  const before = JSON.stringify(source);
  const projected = read(filesReadSummary([], source).pipelines);
  expect(projected).toEqual(read(source));
  const row = projected.tasks[0]!;
  expect(row).toMatchObject({ taskId: "task-main", createdAtMs: ms(-300), startedAtMs: ms(-230), endAtMs: NOW, live: true });
  expect(row.pipelines.map(pipeline => pipeline.id)).toEqual(["earlier", "lane-main"]);
  expect(row.pipelines[1]!.attempts.map(row => [row.attempt, row.historical, row.startedAtMs, row.endAtMs, row.engine, row.roleId, row.model, row.live]))
    .toEqual([[3, true, ms(-200), ms(-190), "codex", "architect", "changed-stage-model", false],
      [1, false, ms(-120), ms(-100), "claude", "reviewer", "claude-opus-4-6", false],
      [2, false, ms(-90), NOW, "codex", "builder", null, true]]);
  expect(JSON.stringify(projected)).not.toContain("Execution body");
  expect(JSON.stringify(projected)).not.toContain("account-fixture");
  row.pipelines[1]!.attempts[0]!.model = "local edit";
  expect(JSON.stringify(source)).toBe(before);
  // Pipeline and attempt collection order cannot alter the geometry or keys.
  current.runs[0]!.attempts.reverse();
  expect(read([previous, current])).toEqual(read(filesReadSummary([], source).pipelines));
});

test("only tasks with an open lane appear, with project and task membership checked together", () => {
  const tasks = [task(), task("done"), task("settled"), task("draft"), task("hidden"), task("foreign", "repo-beta"), task("empty")];
  tasks[1]!.status = "done";
  const pipelines = tasks.slice(0, -1).map(row => lane(`lane-${row.id}`, row));
  pipelines[2]!.state = "completed";
  pipelines[3]!.state = "draft";
  pipelines[4]!.hiddenAt = stamp(-20);
  // A foreign lane claiming an own task id must never contribute history.
  pipelines[5]!.taskIds.push(tasks[0]!.id);
  pipelines[0]!.taskIds.push(tasks[0]!.id, "missing-task");
  const result = read(pipelines, tasks);
  expect(result.tasks.map(row => row.taskId)).toEqual(["task-main"]);
  expect(result.tasks[0]!.pipelines.map(row => row.id)).toEqual(["lane-task-main"]);
  expect(read([], tasks).tasks).toEqual([]);
  expect(read(pipelines, []).tasks).toEqual([]);
});

test.each(["provisioning", "running", "needs_decision", "needs_review", "paused"] as const)("%s keeps the task span through now while only live attempts advance", state => {
  const pipeline = lane();
  pipeline.state = state;
  attempt(pipeline, 1, -100, -90, "needs_decision");
  const first = read([pipeline]).tasks[0]!;
  const later = read([pipeline], [task()], ms(10)).tasks[0]!;
  expect([first.endAtMs, later.endAtMs, first.live]).toEqual([NOW, ms(10), false]);
  expect(later.pipelines[0]!.attempts[0]!.endAtMs).toBe(ms(-90));
});

test("unknown, reversed and future times never invent elapsed agent work", () => {
  const pipeline = lane();
  const invalid = attempt(pipeline, 1, -120, null, "failed");
  invalid.startedAt = "unrecorded";
  attempt(pipeline, 2, -100, -110, "failed");
  attempt(pipeline, 3, -90, null, "failed");
  attempt(pipeline, 4, null, null, "pending");
  attempt(pipeline, 5, 10, null, "running");
  const rows = read([pipeline]).tasks[0]!.pipelines[0]!.attempts;
  expect(rows.every(row => row.endAtMs === null && !row.live)).toBe(true);
  expect(rows.find(row => row.attempt === 2)?.completedAtMs).toBe(ms(-110));
  expect(read([pipeline]).tasks[0]!.startedAtMs).toBe(ms(-100));
  pipeline.runs[0]!.attempts = [];
  expect(read([pipeline]).tasks[0]!.startedAtMs).toBe(ms(-120));
  pipeline.createdAt = "unrecorded";
  expect(read([pipeline]).tasks[0]!.startedAtMs).toBeNull();
  const malformedEnd = attempt(pipeline, 6, -30, null, "running");
  malformedEnd.completedAt = "unrecorded";
  expect(read([pipeline]).tasks[0]!.pipelines[0]!.attempts[0]).toMatchObject({ completedAtMs: null, endAtMs: null, live: false });
  attempt(pipeline, 7, null, -20);
  expect(read([pipeline]).tasks[0]!.pipelines[0]!.attempts.at(-1)).toMatchObject({ startedAtMs: null, completedAtMs: ms(-20), endAtMs: null });
  expect(() => read([pipeline], [task()], NaN)).toThrow("timeline clock must be finite");
});

test("closed, superseded, historical and non-cursor attempts never grow through now", () => {
  const pipeline = lane();
  attempt(pipeline, 1, -90, null, "running");
  attempt(pipeline, 2, -80, -70, "passed");
  const old = attempt(pipeline, 3, -60, null, "running");
  old.historical = true;
  expect(read([pipeline]).tasks[0]!.live).toBe(false);
  const latest = attempt(pipeline, 4, -50, null, "committing");
  expect(read([pipeline], [task()], ms(10)).tasks[0]!.pipelines[0]!.attempts.at(-1)!.endAtMs).toBe(ms(10));
  pipeline.cursor = { ...pipeline.cursor!, stageId: "review" };
  expect(read([pipeline]).tasks[0]!.live).toBe(false);
  pipeline.cursor = null;
  pipeline.state = "closed";
  pipeline.closedAt = stamp(-10);
  const next = lane("refresh");
  expect(read([pipeline, next]).tasks[0]!.pipelines.find(row => row.id === pipeline.id)!.attempts.find(row => row.attempt === latest.n)!.endAtMs).toBeNull();
});

test("removed stages retain attempt identity and explicit null runtime fields stay frozen", () => {
  const pipeline = lane();
  const first = attempt(pipeline, 1, -90, -80);
  first.effectiveRole.roleId = null;
  first.legacyReview = true;
  pipeline.stages[0]!.effectiveRole.model = "later-model";
  pipeline.stages[0]!.effectiveRole.roleId = "reviewer";
  expect(read([pipeline]).tasks[0]!.pipelines[0]!.attempts[0]).toMatchObject({ roleId: null, model: null });
  pipeline.stages = [];
  expect(read([pipeline]).tasks[0]!.pipelines[0]!.attempts[0]).toMatchObject({
    stageId: "build", kind: "review-loop", roleId: null, model: null, engine: "codex", startedAtMs: ms(-90), endAtMs: ms(-80),
  });
});

test("shared lanes produce independent task rows with deterministic time ties", () => {
  const pipeline = lane();
  pipeline.taskIds.push("task-second");
  attempt(pipeline, 1, -90, null, "running");
  const tasks = [task("task-second"), task()];
  const projected = read([pipeline], tasks);
  expect(projected.tasks.map(row => row.taskId)).toEqual(["task-main", "task-second"]);
  expect(read([pipeline], tasks.toReversed())).toEqual(projected);
  projected.tasks[0]!.pipelines[0]!.attempts[0]!.model = "local-model";
  expect(projected.tasks[1]!.pipelines[0]!.attempts[0]!.model).toBeNull();
});

const previousState = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "board-timeline-access-"));
afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("existing board HTTP reads enforce workspace membership before timeline shaping", async () => {
  process.env.LLV_STATE_DIR = sandbox;
  const { resetTeamStoreForTests, teamStore } = await import("@/lib/team/store");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { MEMBER_COOKIE, mintSession } = await import("@/lib/team/sessions");
  const { workspaceScope } = await import("@/lib/team/workspaceAccess");
  const { workspaceFiles } = await import("@/lib/team/workspaceProjection");
  const taskRoute = await import("@/app/api/tasks/route");
  const pipelineRoute = await import("@/app/api/pipelines/route");
  resetTeamStoreForTests();
  try {
    const store = teamStore();
    const owner = { id: "m_owner", name: "Owner", role: "owner" as const, status: "active" as const, color: "teal" as const, telegram: null,
      createdAt: stamp(-300), createdBy: "claim", revokedAt: null };
    const member = { ...owner, id: "m_member", name: "Member", role: "member" as const };
    store.insertMember(owner);
    store.insertMember(member);
    const workspace = `w_${"a".repeat(32)}`;
    createWorkspace(store, owner, { id: workspace, name: "Alpha", projects: ["repo-alpha"] });
    store.putWorkspaceMember(workspace, member.id, "member", owner.id, stamp(-100));
    const session = mintSession(store, member.id, "claim", { surface: "desktop", browser: "chrome" });
    const tasks = [task(), task("foreign", "repo-beta")];
    const pipelines = tasks.map(row => {
      const pipeline = lane(`lane-${row.id}`, row);
      attempt(pipeline, 1, -90, null, "running");
      return pipeline;
    });
    saveTasks(tasks);
    savePipelines(pipelines);
    const request = (route: string) => new NextRequest(`http://localhost/api/${route}`, { headers: { cookie: `${MEMBER_COOKIE}=${session.value}` } });
    const load = async () => {
      const taskResponse = await taskRoute.GET(request("tasks"));
      const pipelineResponse = await pipelineRoute.GET(request("pipelines"));
      expect([taskResponse.status, pipelineResponse.status]).toEqual([200, 200]);
      return { tasks: (await taskResponse.json()).tasks as BoardTask[], pipelines: (await pipelineResponse.json()).pipelines as Pipeline[] };
    };
    const allowed = await load();
    expect(allowed.tasks.map(row => row.id)).toEqual(["task-main"]);
    expect(allowed.pipelines.map(row => row.id)).toEqual(["lane-task-main"]);
    expect(read(allowed.pipelines, allowed.tasks).tasks[0]!.live).toBe(true);
    const board = workspaceFiles(workspaceScope(store, member.id), { files: [], tasks, flows: [], pipelines: filesReadSummary([], pipelines).pipelines,
      workflows: [], systemHealth: { tmux: { status: "healthy" } }, readProjection: "board-summary" });
    expect(read(board.pipelines, board.tasks)).toEqual(read(allowed.pipelines, allowed.tasks));
    for (const route of ["tasks", "pipelines"]) {
      const denied = await (route === "tasks" ? taskRoute : pipelineRoute).GET(request(`${route}?project=repo-beta`));
      expect(denied.status).toBe(403);
      const unsigned = await (route === "tasks" ? taskRoute : pipelineRoute).GET(new NextRequest(`http://localhost/api/${route}`));
      expect(unsigned.status).toBe(401);
    }
    // Persisted revocation is observed on the next read, without a new session.
    store.removeWorkspaceMember(workspace, member.id);
    const revoked = await load();
    expect(revoked.tasks).toEqual([]);
    expect(revoked.pipelines).toEqual([]);
  } finally { resetTeamStoreForTests(); }
});
