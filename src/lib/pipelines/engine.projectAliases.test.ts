import { afterAll, beforeEach } from "bun:test";
import { canonicalProject, persistProjectAliases } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";
import { loadTasks } from "@/lib/tasks/store";
import { pipelineTaskLinkError } from "./store";
import {
  expect, spyOn, test, crypto, fs, path, harness, boardTask, RUN_STAGES,
  createPipelineFromRequest, loadPipelines, savePipelines, saveTasks, tickPipelines,
} from "./engine.fixture";

const REPOSITORY = `repo-${"1".repeat(32)}`;
const PREDECESSOR = `repo-${"2".repeat(32)}`;
const TASK_PROJECT = `repo-${"3".repeat(32)}`;
let sequence = 0;
const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
  `${(++sequence).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
afterAll(() => ids.mockRestore());
beforeEach(() => {
  savePipelines([]);
  saveTasks([]);
  projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), () => ({
    next: { aliases: {}, displayNames: {} }, result: undefined,
  }));
});

function recordAliases() {
  expect(persistProjectAliases([
    { source: PREDECESSOR, target: REPOSITORY, displayName: "Fixture project" },
    { source: TASK_PROJECT, target: PREDECESSOR, displayName: "Fixture project" },
  ])).toBe(true);
}

test("creation admits recorded project aliases with autoStart and binds the task before the agent starts", async () => {
  const h = harness();
  recordAliases();
  const task = boardTask("aliased-task", TASK_PROJECT);
  saveTasks([task]);
  h.ports.projectForCwd = () => PREDECESSOR;
  const request = { task: "Build aliased task", repoDir: "/repo", taskIds: [task.id], autoStart: true, stages: RUN_STAGES as never };
  const options = { creationRequest: { key: "alias-create", digest: "alias-create-digest" } };
  const created = await createPipelineFromRequest(request, h.ports, options);
  expect(created.error).toBeUndefined();
  expect(created.pipeline?.taskIds).toEqual([task.id]);
  expect(loadPipelines()).toHaveLength(1);
  expect(h.spawnInputs).toEqual([]);

  const replay = await createPipelineFromRequest(request, h.ports, options);
  expect(replay.pipeline?.id).toBe(created.pipeline!.id);
  expect(loadPipelines()).toHaveLength(1);
  const spawn = h.ports.spawnAgent;
  let reservations = 0;
  h.ports.spawnAgent = async (input, onReserved) => spawn(input, async reservation => {
    await onReserved(reservation);
    reservations += 1;
    expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);
    expect(loadTasks().find(row => row.id === task.id)?.assignments).toContainEqual(
      expect.objectContaining({ conversationId: reservation.conversationId }));
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(reservations).toBe(1);
  expect(h.spawnInputs).toHaveLength(1);
});

test.each([REPOSITORY, PREDECESSOR, TASK_PROJECT])("the shared ownership guard resolves both sides through recorded aliases: %s", project => {
  recordAliases();
  const task = boardTask("raw-alias-task", TASK_PROJECT);
  expect(pipelineTaskLinkError({ project }, [task.id], [task])).toBeNull();
});

test.each(["different-project", `repo-${"4".repeat(32)}`])("an unproven project identity refuses creation before launch: %s", async foreignProject => {
  const h = harness();
  recordAliases();
  const task = boardTask("foreign-task", foreignProject);
  saveTasks([task]);
  h.ports.projectForCwd = () => PREDECESSOR;
  const result = await createPipelineFromRequest({ task: "Refused task", repoDir: "/repo", taskIds: [task.id], autoStart: true, stages: RUN_STAGES as never }, h.ports);
  expect(result).toEqual({ error: `task project does not match pipeline project: ${task.id}`, status: 400 });
  expect(loadPipelines()).toEqual([]);
  expect(h.spawnInputs).toEqual([]);
  expect(canonicalProject(foreignProject)).toBe(foreignProject);
});

test("the refusal names the foreign task when an aliased task precedes it", async () => {
  const h = harness();
  recordAliases();
  const aliased = boardTask("aliased-task", TASK_PROJECT);
  const foreign = boardTask("foreign-task", `repo-${"4".repeat(32)}`);
  saveTasks([aliased, foreign]);
  h.ports.projectForCwd = () => PREDECESSOR;
  const result = await createPipelineFromRequest({ task: "Mixed tasks", repoDir: "/repo", taskIds: [aliased.id, foreign.id], autoStart: true, stages: RUN_STAGES as never }, h.ports);
  expect(result).toEqual({ error: `task project does not match pipeline project: ${foreign.id}`, status: 400 });
  expect(loadPipelines()).toEqual([]);
  expect(h.spawnInputs).toEqual([]);
});

test("a missing task still refuses creation before launch", async () => {
  const h = harness();
  recordAliases();
  h.ports.projectForCwd = () => PREDECESSOR;
  const result = await createPipelineFromRequest({ task: "Missing task", repoDir: "/repo", taskIds: ["missing-task"], autoStart: true, stages: RUN_STAGES as never }, h.ports);
  expect(result).toEqual({ error: "task not found: missing-task", status: 400 });
  expect(loadPipelines()).toEqual([]);
  expect(h.spawnInputs).toEqual([]);
});

test("a changed origin with no proven rename remains a different project", async () => {
  const { projectForCwd } = await import("@/lib/scanner/describe");
  const { projectIdentityFromRepositoryRoot } = await import("@/lib/projects/identity");
  const h = harness();
  const cwd = path.join(process.env.LLV_STATE_DIR!, "changed-origin");
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  const config = path.join(cwd, ".git", "config");
  fs.writeFileSync(config, '[remote "origin"]\nurl = https://example.invalid/team/original.git\n');
  const original = projectIdentityFromRepositoryRoot(cwd)!.project;
  const task = boardTask("original-remote-task", original);
  saveTasks([task]);
  fs.writeFileSync(config, '[remote "origin"]\nurl = https://example.invalid/team/replacement.git\n');
  const replacement = projectForCwd(cwd)!;
  expect(replacement).not.toBe(original);
  expect(canonicalProject(original)).toBe(original);
  h.ports.projectForCwd = projectForCwd;
  const result = await createPipelineFromRequest({ task: "Changed repository", repoDir: cwd, taskIds: [task.id], autoStart: true, stages: RUN_STAGES as never }, h.ports);
  expect(result).toEqual({ error: `task project does not match pipeline project: ${task.id}`, status: 400 });
  expect(loadPipelines()).toEqual([]);
  expect(h.spawnInputs).toEqual([]);
});
