import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pipeline } from "./types";
import type { AutoMergePorts } from "@/lib/forge/autoMerge";
import { TASK_DETAILS_LIMIT } from "@/lib/tasks/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-budget-follow-up-"));
const previous = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;
const { budgetFollowUpInput, fileBudgetFollowUp } = await import("./budgetFollowUp");
const { sweepAutoMerge, sweepBudgetFollowUps } = await import("@/lib/forge/autoMerge");
const { loadTasks, saveTasks, mutateTasksFile, loadTasksFile } = await import("@/lib/tasks/store");
const { createTask } = await import("@/lib/tasks/commands");
afterAll(() => { process.env.LLV_STATE_DIR = previous; fs.rmSync(sandbox, { recursive: true, force: true }); });
beforeEach(() => saveTasks([]));

function fixture(): Pipeline {
  return { id: "spent-lane", task: "Ship reviewed change", project: "repo-fixture", taskIds: ["original-task"], state: "completed",
    lastPassedCommit: "a".repeat(40), reviewBudgetSpent: { stageId: "review", attempt: 2, findings: 2, head: "a".repeat(40), at: "2026-10-01T00:00:00Z" },
    runs: [{ stageId: "review", attempts: [{ n: 2, verdict: { status: "fail", findings: ["P1 first finding verbatim", "P2 second finding verbatim"] } }] }],
  } as unknown as Pipeline;
}
function portsFor(lane: Pipeline, enabled = false): AutoMergePorts {
  return { now: () => Date.parse("2026-10-02T00:00:00Z"), loadPipelines: () => [lane],
    setting: () => ({ enabled }), pullRequestOf: () => ({ repository: "acme/widgets", number: 12 }), cachedState: () => null,
    fileFollowUp: fileBudgetFollowUp,
    mutate: async (_id: string, change: (pipeline: Pipeline) => boolean) => change(lane),
  } as unknown as AutoMergePorts;
}

test("spent findings file exactly one assigned task linked through the lane", async () => {
  const lane = fixture(); const ports = portsFor(lane);
  await sweepBudgetFollowUps(ports);
  await sweepBudgetFollowUps(ports);
  const tasks = loadTasks(); expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ status: "assigned", project: lane.project, placement: "unplaced" });
  for (const phrase of [lane.id, "original-task", lane.lastPassedCommit, "P1 first finding verbatim", "P2 second finding verbatim"]) expect(tasks[0]!.details).toContain(phrase);
  expect(lane.reviewBudgetSpent!.followUp?.taskId).toBe(tasks[0]!.id);
  expect(lane.stateDetail).toContain(tasks[0]!.text);
  expect(budgetFollowUpInput(lane, lane.lastPassedCommit, "en").text).toBe("Review follow-up: Ship reviewed change");
  expect(budgetFollowUpInput(lane, lane.lastPassedCommit, "uk").text).toBe("Зауваження після рев’ю: Ship reviewed change");
});

test.each([false, true])("task-first replay survives a lost lane write and restart (%s)", async (restart) => {
  const lane = fixture(); const ports = portsFor(lane);
  ports.mutate = async () => { throw new Error("lost lane write"); };
  await expect(sweepBudgetFollowUps(ports)).rejects.toThrow("lost lane write");
  expect(loadTasks()).toHaveLength(1);
  if (restart) {
    // Fresh process reads the persisted receipt and replays the production write.
    const child = Bun.spawnSync([process.execPath, "-e", `const { fileBudgetFollowUp } = await import(${JSON.stringify(path.join(import.meta.dir, "budgetFollowUp.ts"))}); fileBudgetFollowUp(${JSON.stringify(lane)}, "${lane.lastPassedCommit}");`], { cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
  }
  ports.mutate = async (_id, change) => change(lane);
  await sweepBudgetFollowUps(ports);
  expect(loadTasks()).toHaveLength(1);
  expect(lane.reviewBudgetSpent!.followUp?.taskId).toBe(loadTasks()[0]!.id);
});

test("follow-up waits for merge and records the merged head", async () => {
  const lane = fixture(); const ports = portsFor(lane, true);
  await sweepBudgetFollowUps(ports); expect(loadTasks()).toHaveLength(0);
  lane.merge = { state: "merged", mergedHead: "b".repeat(40) } as Pipeline["merge"];
  await sweepBudgetFollowUps(ports);
  expect(loadTasks()[0]!.details).toContain("b".repeat(40));
});

test.each([false, true])("follow-up ownership survives create receipt eviction and a fresh process (legacy: %s)", async (legacy) => {
  const lane = fixture(); const ports = portsFor(lane);
  ports.mutate = async () => { throw new Error("lost lane write"); };
  await expect(sweepBudgetFollowUps(ports)).rejects.toThrow("lost lane write");
  const original = loadTasks()[0]!;
  if (legacy) { delete original.origin; saveTasks([original]); }
  for (let index = 0; index < 100; index++) {
    mutateTasksFile(state => {
      const result = createTask(state.tasks, { project: lane.project, text: `Unrelated ${index}`, placement: "unplaced", clientRequestId: `unrelated-${index}` }, state.recentCreates, { explicit: true, allowBoardOverflow: true });
      if (!result.ok) throw new Error(result.error);
      return { state: { tasks: result.tasks, recentCreates: result.recentCreates }, result };
    });
  }
  expect(loadTasksFile().recentCreates.some(receipt => receipt.taskId === original.id)).toBe(false);
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { sweepBudgetFollowUps } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../forge/autoMerge.ts"))});
    const { fileBudgetFollowUp } = await import(${JSON.stringify(path.join(import.meta.dir, "budgetFollowUp.ts"))});
    const lane = ${JSON.stringify(lane)};
    await sweepBudgetFollowUps({ now: Date.now, loadPipelines: () => [lane], setting: () => ({ enabled: false }), fileFollowUp: fileBudgetFollowUp, mutate: async (_id, change) => change(lane) });
    process.stdout.write(JSON.stringify(lane.reviewBudgetSpent.followUp));
  `], { cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).taskId).toBe(original.id);
  expect(loadTasks().filter(task => task.details?.includes(`Lane: ${lane.id}\n`))).toHaveLength(1);
});

test.each(["custody", "blocked", "cancelled", "legacy-merged"] as const)("outside merge confirms its head before filing, across retry/restart (%s)", async (state) => {
  const lane = fixture(); const ports = portsFor(lane, true);
  lane.closedAt = "2026-10-01T00:00:00Z";
  // Completed review evidence used by the merge sweep's eligibility check.
  lane.stages = [{ id: "review", kind: "run", next: null, onFail: { to: "fix", maxRounds: 1 }, access: "read-only" }] as Pipeline["stages"];
  lane.runs[0]!.attempts[0]!.state = "failed";
  ports.setting = () => ({ enabled: true, changedAt: "2026-09-01T00:00:00Z", changedBy: "operator" });
  ports.cachedState = () => "merged";
  ports.mergerBusy = () => state === "custody";
  if (state !== "custody") lane.merge = { state: state === "legacy-merged" ? "merged" : state, repository: "acme/widgets", prNumber: 12, mergedHead: null } as Pipeline["merge"];
  let available = false;
  ports.run = async () => {
    if (!available) throw new Error("forge temporarily unavailable");
    return JSON.stringify({ state: "MERGED", headRefOid: "b".repeat(40), mergeCommit: { oid: "c".repeat(40) }, mergedAt: "2026-10-01T01:00:00Z" });
  };
  await sweepAutoMerge(ports);
  await sweepBudgetFollowUps(ports);
  expect(loadTasks()).toHaveLength(0);
  available = true;
  await sweepAutoMerge(ports);
  // Lose the lane's receipt, after confirmed merge evidence was persisted.
  ports.mutate = async (_id, change) => {
    const draft = structuredClone(lane);
    const changed = change(draft);
    if (draft.reviewBudgetSpent?.followUp) throw new Error("lost follow-up receipt");
    if (changed) Object.assign(lane, draft);
    return changed;
  };
  await expect(sweepBudgetFollowUps(ports)).rejects.toThrow("lost follow-up receipt");
  expect(lane.merge).toMatchObject({ state: "merged", mergedHead: "b".repeat(40) });
  expect(loadTasks()[0]!.details).toContain(`Merged head: ${"b".repeat(40)}`);
  const originalId = loadTasks()[0]!.id;
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { sweepBudgetFollowUps } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../forge/autoMerge.ts"))});
    const { fileBudgetFollowUp } = await import(${JSON.stringify(path.join(import.meta.dir, "budgetFollowUp.ts"))});
    const lane = ${JSON.stringify(lane)};
    await sweepBudgetFollowUps({ now: Date.now, loadPipelines: () => [lane], setting: () => ({ enabled: true }), pullRequestOf: () => ({ repository: "acme/widgets", number: 12 }), cachedState: () => "merged", fileFollowUp: fileBudgetFollowUp, mutate: async (_id, change) => change(lane) });
    process.stdout.write(JSON.stringify(lane.reviewBudgetSpent.followUp));
  `], { cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).taskId).toBe(originalId);
  expect(loadTasks()).toHaveLength(1);
});

test("an outside merge read cannot populate evidence for a replacement PR", async () => {
  const lane = fixture(); const ports = portsFor(lane, true);
  lane.merge = { state: "blocked", repository: "acme/widgets", prNumber: 12, mergedHead: null } as Pipeline["merge"];
  ports.cachedState = () => "merged";
  ports.run = async () => {
    lane.merge!.prNumber = 13;
    return JSON.stringify({ state: "MERGED", headRefOid: "b".repeat(40) });
  };
  await sweepAutoMerge(ports);
  expect(lane.merge).toMatchObject({ state: "blocked", prNumber: 13, mergedHead: null });
  await sweepBudgetFollowUps(ports);
  expect(loadTasks()).toHaveLength(0);
});

test("overflow keeps whole findings then points to the durable attempt", () => {
  const lane = fixture();
  const findings = Array.from({ length: 50 }, (_, i) => `P2 finding ${i} ` + "x".repeat(1980));
  lane.runs[0]!.attempts[0]!.verdict!.findings = findings;
  const input = budgetFollowUpInput(lane, lane.lastPassedCommit, "en");
  expect(input.details!.length).toBeLessThanOrEqual(TASK_DETAILS_LIMIT);
  expect(input.details).toContain(findings[0]!);
  expect(input.details).toContain("get_pipeline spent-lane stageId review attempt 2");
  for (const line of input.details!.split("\n").filter(line => line.startsWith("P2 finding"))) expect(findings).toContain(line);
});


test("an existing follow-up lane on the original task prevents a duplicate card", async () => {
  const lane = fixture(); const ports = portsFor(lane);
  const existing = { id: "existing-follow-up", project: lane.project, taskIds: lane.taskIds, task: "Review follow-up: Ship reviewed change", spec: `Fix the findings kept by lane ${lane.id}`, state: "running" } as Pipeline;
  ports.loadPipelines = () => [lane, existing];
  await sweepBudgetFollowUps(ports);
  expect(loadTasks()).toHaveLength(0);
  expect(lane.reviewBudgetSpent!.followUp).toMatchObject({ taskId: "original-task", title: existing.task });
});
