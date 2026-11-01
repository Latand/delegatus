import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { filesReadSummary } from "@/lib/filesReadSummary";
import { pipelineRoleLookup, resolvePipelineRole } from "@/lib/pipelines/roles";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { saveTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { projectTaskTimelines } from "./taskTimeline";
import { resolvedTimelineMembers } from "./taskTimelineMembers";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import type { FileEntry } from "@/lib/types";
import { staleWorkingFixture } from "@/lib/agent/spawnProjection.fixture";

const NOW = Date.parse("2026-10-26T13:20:00Z");
const stamp = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const ms = (minutes: number) => NOW + minutes * 60_000;

function task(id = "task-main", project = "repo-alpha"): BoardTask {
  return { id, project, text: "Timeline work", status: "assigned", placement: "unplaced", assignments: [],
    createdAt: stamp(-300), updatedAt: stamp(-10) };
}

function lane(id = "lane-main", owner = task()): Pipeline {
  const role = { roleId: "builder" as const };
  const resolved = resolvePipelineRole({ role, engine: "codex", model: null, effort: "high", access: "read-write" }, "run", pipelineRoleLookup);
  if (!resolved.role) throw new Error(resolved.error);
  const pipeline = buildPipeline({ id, task: owner.text, project: owner.project, taskIds: [owner.id], repoDir: "/repo",
    srcPath: null, srcConversationId: null, now: stamp(-120), stages: [{ id: "build", kind: "run", next: null,
      "prompt": "Build the change", role, effectiveRole: resolved.role }] });
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

test("resolved working members without a pipeline supply real turn spans and default expansion", () => {
  const directory = path.join(sandbox, "standalone"); fs.mkdirSync(directory, { recursive: true });
  const file = { ...staleWorkingFixture(directory, NOW).live, project: "repo-alpha", lastTurn: { startedAt: ms(-2), endedAt: null } };
  const members = [{ taskId: "task-main", file }];
  const readMembers = (tasks = [task()], pipelines: Pipeline[] = []) => projectTaskTimelines({ project: "repo-alpha", tasks, pipelines, members, nowMs: NOW });
  const projected = readMembers().tasks[0]!;
  expect(projected).toMatchObject({ live: true, startedAtMs: ms(-2), endAtMs: NOW, pipelines: [] });
  expect(projected.agents).toHaveLength(1);
  expect(projected.agents[0]).toMatchObject({ engine: "codex", model: "gpt-6.1-sol", startedAtMs: ms(-2), endAtMs: NOW, live: true, pipelineId: null });
  expect(projectTaskTimelines({ project: "repo-alpha", tasks: [task()], pipelines: [], members: [...members, ...members], nowMs: NOW }).tasks[0]!.agents).toHaveLength(1);
  expect(readMembers([]).tasks).toEqual([]);
  expect(readMembers([{ ...task(), status: "done" }]).tasks).toEqual([]);
  expect(readMembers([{ ...task(), project: "repo-other" }]).tasks).toEqual([]);
  const pipeline = lane();
  attempt(pipeline, 1, -2, null, "running").conversationId = file.conversationId!;
  expect(readMembers([task()], [pipeline]).tasks[0]!.agents).toEqual([]);
  for (const patch of [{ proc: "killed" }, { lastTurn: { startedAt: ms(-2), endedAt: ms(-1) } }, { project: "repo-other" }, { root: "claude-projects", kind: "subagent" }]) {
    const rejected = projectTaskTimelines({ project: "repo-alpha", tasks: [task()], pipelines: [], members: [{ taskId: "task-main", file: { ...file, ...patch } as FileEntry }], nowMs: NOW });
    expect(rejected.tasks).toEqual([]);
  }
});

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
  const ordered = read(source);
  current.runs[0]!.attempts.reverse();
  expect(read([previous, current])).toEqual(ordered);
});

test.each(["completed", "needs_decision"] as const)("%s history retains a later working turn of its stage conversation", state => {
  const directory = path.join(sandbox, `resumed-${state}`); fs.mkdirSync(directory, { recursive: true });
  const file = { ...staleWorkingFixture(directory, NOW).live, project: "repo-alpha", lastTurn: { startedAt: ms(-2), endedAt: null } };
  const pipeline = lane(); pipeline.state = state;
  const prior = attempt(pipeline, 1, -30, -10);
  prior.conversationId = file.conversationId!; prior.agentPath = file.path;
  if (state === "completed") { pipeline.cursor = null; pipeline.closedAt = stamp(-10); }
  const projection = projectTaskWorkflows([task()], [pipeline], [], [file], "repo-alpha");
  const members = resolvedTimelineMembers(projection, [task()]);
  expect(members.some(member => member.file === file)).toBe(true);
  expect(resolvedTimelineMembers(projection, [])).toEqual([]);
  const input = { project: "repo-alpha", tasks: [task()], pipelines: filesReadSummary([], [pipeline]).pipelines, members };
  const first = projectTaskTimelines({ ...input, nowMs: NOW }).tasks[0]!;
  expect(first).toMatchObject({ live: true, startedAtMs: ms(-30), endAtMs: NOW });
  expect(first.agents).toHaveLength(1);
  expect(first.agents[0]).toMatchObject({ startedAtMs: ms(-2), endAtMs: NOW, live: true });
  expect(first.pipelines[0]!.attempts[0]).toMatchObject({ endAtMs: ms(-10), live: false });
  file.agentActivity!.lastRecordAt = ms(10) - 1000;
  const later = projectTaskTimelines({ ...input, nowMs: ms(10) }).tasks[0]!;
  expect(later.agents[0]!.endAtMs).toBe(ms(10));
  expect(later.pipelines[0]!.attempts).toEqual(first.pipelines[0]!.attempts);
});

test.each(["pause", "account"] as const)("a confirmed %s suspension freezes agent work while the open task keeps elapsed time", reason => {
  const pipeline = lane(); pipeline.state = "paused";
  const current = attempt(pipeline, 1, -30, null, "running");
  current.suspension = { reason, detail: "Host stopped", requestedAt: stamp(-10), stoppedAt: stamp(-9) };
  const summary = filesReadSummary([], [pipeline]).pipelines;
  const first = read(summary).tasks[0]!;
  const later = read(summary, [task()], ms(10)).tasks[0]!;
  expect(first).toMatchObject({ live: false, startedAtMs: ms(-30), endAtMs: NOW });
  expect(first.pipelines[0]!.attempts[0]).toMatchObject({ live: false, stopped: true, completedAtMs: null, endAtMs: ms(-9) });
  expect(later.endAtMs).toBe(ms(10));
  expect(later.pipelines[0]!.attempts).toEqual(first.pipelines[0]!.attempts);
  current.completedAt = stamp(-1);
  expect(read([pipeline]).tasks[0]!.pipelines[0]!.attempts[0]!.endAtMs).toBe(ms(-9));
  current.completedAt = null;
  // A requested stop has no confirmed boundary yet.
  delete current.suspension.stoppedAt;
  expect(read([pipeline]).tasks[0]!.pipelines[0]!.attempts[0]).toMatchObject({ live: true, stopped: false, endAtMs: NOW });
  // A new attempt leaves the earlier stopped attempt frozen.
  current.suspension.stoppedAt = stamp(-9);
  pipeline.state = "running";
  attempt(pipeline, 2, -2, null, "running");
  expect(read([pipeline], [task()], ms(10)).tasks[0]!.pipelines[0]!.attempts.map(row => [row.live, row.stopped, row.endAtMs]))
    .toEqual([[false, true, ms(-9)], [true, false, ms(10)]]);
});

test("resolved membership keeps shown assignments and explicit lanes without promoting other stages of a related lane", () => {
  const directory = path.join(sandbox, "resolved-members"); fs.mkdirSync(directory, { recursive: true });
  const first = { ...staleWorkingFixture(directory, NOW).live, project: "repo-alpha" };
  const second = { ...first, conversationId: "conversation_second", path: "/repo/second.jsonl" };
  const pipeline = lane();
  const one = attempt(pipeline, 1, -30, -20); one.conversationId = first.conversationId!; one.agentPath = first.path;
  const two = attempt(pipeline, 2, -10, null, "running"); two.conversationId = second.conversationId; two.agentPath = second.path;
  const related = task("related");
  related.assignments = [{ path: first.path, conversationId: first.conversationId, panePid: null, state: "delivered", error: null, at: stamp(-2) }];
  const projection = projectTaskWorkflows([task(), related], [pipeline], [], [first, second], "repo-alpha");
  expect(resolvedTimelineMembers(projection, [task()]).map(member => member.file.path)).toEqual([first.path, second.path]);
  expect(resolvedTimelineMembers(projection, [related]).map(member => member.file.path)).toEqual([first.path]);
  expect(resolvedTimelineMembers(projection, [])).toEqual([]);
  pipeline.hiddenAt = stamp(-1);
  expect(resolvedTimelineMembers(projection, [task()])).toEqual([]);
  pipeline.hiddenAt = null;
  pipeline.state = "draft";
  expect(resolvedTimelineMembers(projection, [task()])).toEqual([]);
  pipeline.state = "running"; pipeline.project = "repo-other";
  expect(resolvedTimelineMembers(projection, [task()])).toEqual([]);
});

test("confirmed stops override a stale working member but allow its later resumed turn", () => {
  const directory = path.join(sandbox, "stopped-member"); fs.mkdirSync(directory, { recursive: true });
  const file = { ...staleWorkingFixture(directory, NOW).live, project: "repo-alpha", lastTurn: { startedAt: ms(-30), endedAt: null } };
  const pipeline = lane(); pipeline.state = "paused";
  const current = attempt(pipeline, 1, -30, null, "running");
  current.conversationId = file.conversationId!; current.agentPath = file.path;
  current.suspension = { reason: "pause", detail: "Host stopped", requestedAt: stamp(-10), stoppedAt: stamp(-9) };
  const input = { project: "repo-alpha", tasks: [task()], pipelines: [pipeline], members: [{ taskId: "task-main", file }] };
  for (const nowMs of [NOW, ms(10)]) {
    const projected = projectTaskTimelines({ ...input, nowMs }).tasks[0]!;
    expect(projected.live).toBe(false);
    expect(projected.agents).toEqual([]);
    expect(projected.pipelines[0]!.attempts[0]!.endAtMs).toBe(ms(-9));
  }
  file.lastTurn.startedAt = ms(-2);
  const resumed = projectTaskTimelines({ ...input, nowMs: NOW }).tasks[0]!;
  expect(resumed.live).toBe(true);
  expect(resumed.agents[0]).toMatchObject({ startedAtMs: ms(-2), endAtMs: NOW });
  expect(resumed.pipelines[0]!.attempts[0]!.endAtMs).toBe(ms(-9));
});

test("resuming the same suspended attempt restores its live interval without duplicating its member", () => {
  const directory = path.join(sandbox, "resumed-attempt"); fs.mkdirSync(directory, { recursive: true });
  const file = { ...staleWorkingFixture(directory, NOW).live, project: "repo-alpha", lastTurn: { startedAt: ms(-30), endedAt: null } };
  const pipeline = lane(); pipeline.state = "paused";
  const current = attempt(pipeline, 1, -30, null, "running");
  current.conversationId = file.conversationId!; current.agentPath = file.path;
  current.suspension = { reason: "pause", detail: "Host stopped", requestedAt: stamp(-10), stoppedAt: stamp(-9) };
  const readCurrent = (nowMs: number) => projectTaskTimelines({ project: "repo-alpha", tasks: [task()],
    pipelines: filesReadSummary([], [pipeline]).pipelines, members: [{ taskId: "task-main", file }], nowMs }).tasks[0]!;
  expect(readCurrent(NOW).pipelines[0]!.attempts[0]).toMatchObject({ live: false, endAtMs: ms(-9) });
  // The engine's resume writer reuses the attempt and clears the confirmed stop.
  pipeline.state = "running"; pipeline.resumedAt = stamp(-2);
  current.suspension.requestedAt = pipeline.resumedAt;
  delete current.suspension.stoppedAt;
  file.lastTurn.startedAt = ms(-2);
  for (const nowMs of [NOW, ms(10)]) {
    file.agentActivity!.lastRecordAt = nowMs - 1000;
    const resumed = readCurrent(nowMs);
    expect(resumed.live).toBe(true);
    expect(resumed.agents).toEqual([]);
    expect(resumed.pipelines[0]!.attempts).toHaveLength(1);
    expect(resumed.pipelines[0]!.attempts[0]).toMatchObject({ live: true, startedAtMs: ms(-30), endAtMs: nowMs });
  }
});

test.each(["spawning", "running", "reviewing", "committing"] as const)("%s uses the supplied clock only for the cursor stage", state => {
  const pipeline = lane();
  const build = attempt(pipeline, 1, -90, -60);
  const reviewStage = structuredClone(pipeline.stages[0]!);
  reviewStage.id = "review";
  reviewStage.effectiveRole.engine = "claude";
  reviewStage.effectiveRole.roleId = "reviewer";
  reviewStage.effectiveRole.model = "claude-opus-4-6";
  pipeline.stages[0]!.next = reviewStage.id;
  pipeline.stages.push(reviewStage);
  const review = { ...structuredClone(build), state, startedAt: stamp(-30), completedAt: null,
    effectiveRole: structuredClone(reviewStage.effectiveRole) };
  pipeline.runs.push({ stageId: reviewStage.id, attempts: [review] });
  pipeline.cursor = { ...pipeline.cursor!, stageId: reviewStage.id, state };
  // Later edits cannot alter the runtime captured by either stage's attempt.
  reviewStage.effectiveRole.engine = "codex";
  reviewStage.effectiveRole.roleId = "architect";
  const rows = read(filesReadSummary([], [pipeline]).pipelines).tasks[0]!.pipelines[0]!.attempts;
  expect(rows.map(row => [row.stageId, row.engine, row.roleId, row.startedAtMs, row.endAtMs, row.live])).toEqual([
    ["build", "codex", "builder", ms(-90), ms(-60), false],
    ["review", "claude", "reviewer", ms(-30), NOW, true],
  ]);
  expect(read([pipeline], [task()], ms(10)).tasks[0]!.pipelines[0]!.attempts[1]!.endAtMs).toBe(ms(10));
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
  pipelines[0]!.taskIds.push(tasks[0]!.id, tasks[5]!.id, "missing-task");
  pipelines[3]!.taskIds.push(tasks[0]!.id);
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

test.each(["passed", "failed", "needs_decision", "skipped"] as const)("%s with an unrecorded completion never grows as live work", state => {
  const pipeline = lane();
  const current = attempt(pipeline, 1, -90, null, "running");
  expect(read([pipeline]).tasks[0]!.live).toBe(true);
  current.state = state;
  expect(read([pipeline]).tasks[0]!.pipelines[0]!.attempts[0]).toMatchObject({ live: false, endAtMs: null });
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
  pipeline.cursor.stageId = "build";
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
