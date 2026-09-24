import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyGhostSettlement, planGhostSettlement, type GhostSettlementInput } from "./ghostSettlement";
import { loadTasks, saveTasks } from "./store";
import type { BoardTask, TaskAssignment } from "./types";

/*
 * Settling the «Untitled task» backlog. The planner is pure; the script runs
 * against a throw-away state directory made here, never the operator's.
 */

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function assignment(extra: Partial<TaskAssignment> = {}): TaskAssignment {
  return { path: "/transcripts/old.jsonl", conversationId: "conversation_old", panePid: null, state: "linked", error: null, at: ago(48 * HOUR), ...extra };
}

function task(id: string, extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "repo-fixture",
    status: "assigned",
    text: `Placeholder ${id}`,
    placement: "unplaced",
    origin: { kind: "conversation", key: `conversation_${id}`, refinement: "pending" },
    assignments: [assignment({ conversationId: `conversation_${id}`, path: `/transcripts/${id}.jsonl` })],
    createdAt: ago(48 * HOUR),
    updatedAt: ago(48 * HOUR),
    ...extra,
  } as BoardTask;
}

const backlog: BoardTask[] = [
  task("old-backfill"),
  task("fixture", { project: "dir-fixture", text: "Exercise legacy spawn fixture", origin: { kind: "launch", key: "launch-fixture", refinement: "pending" }, assignments: [assignment({ launchId: "launch-fixture", conversationId: "conversation_fixture", path: null, engine: "codex", at: ago(20 * HOUR) })] }),
  task("digest", { project: "dir-digest", text: "You are compacting the rotation history of a project manager agent's mandate. W…" }),
  task("probe", { project: "dir-probe", text: "Reply with exactly: ok" }),
  task("never-started", { text: "Build the export", origin: { kind: "launch", key: "launch-x", refinement: "pending" }, assignments: [assignment({ launchId: "launch-x", conversationId: "conversation_x", path: null })] }),
  task("running", { assignments: [assignment({ conversationId: "conversation_running", path: "/transcripts/running.jsonl" })] }),
  task("named", { origin: { kind: "conversation", key: "k-named", refinement: "titled" } }),
  task("noted", { details: "The operator's notes" }),
  task("laned"),
  task("container", { origin: { kind: "pipeline", key: "pipeline-1", refinement: "pending" } }),
  task("seat", { text: "orchestrator · Run the conveyor", origin: { kind: "launch", key: "seat-launch", refinement: "pending" }, assignments: [assignment({ launchId: "seat-launch", conversationId: "conversation_seat", path: "/transcripts/seat.jsonl" })] }),
  task("retired-seat", { text: "orchestrator · Run the conveyor", origin: { kind: "launch", key: "old-seat-launch", refinement: "pending" }, assignments: [assignment({ launchId: "old-seat-launch", conversationId: "conversation_old_seat", path: "/transcripts/old-seat.jsonl" })] }),
  task("closed", { status: "done" }),
];

function input(extra: Partial<GhostSettlementInput> = {}): GhostSettlementInput {
  return {
    tasks: backlog,
    pipelineTaskIds: new Set(["laned"]),
    seatIdentities: new Set(["conversation_seat"]),
    transcriptOf: (file) => ({ mtimeMs: file.endsWith("running.jsonl") ? NOW - 60_000 : NOW - 30 * HOUR }),
    nowMs: NOW,
    idleMs: 6 * HOUR,
    ...extra,
  };
}

test("the backlog settles what nothing will name — ended conversations, helpers, probes, unstarted launches and the fixture — and keeps the rest", () => {
  const plan = planGhostSettlement(input());
  const settled = plan.decisions.filter((decision) => decision.settle).map((decision) => [decision.taskId, decision.kind]);
  expect(settled).toEqual([
    ["old-backfill", "conversation"],
    ["fixture", "fixture"],
    ["digest", "handoff-digest"],
    ["probe", "probe"],
    ["never-started", "launch-not-started"],
    ["retired-seat", "orchestrator"],
  ]);
  expect(plan.kept).toEqual({ "still-running": 1, "operator-edit": 1, pipeline: 1, container: 1, "active-seat": 1 });
  expect(plan.settle).toEqual({
    "repo-fixture": { conversation: 1, "launch-not-started": 1, orchestrator: 1 },
    "dir-fixture": { fixture: 1 },
    "dir-digest": { "handoff-digest": 1 },
    "dir-probe": { probe: 1 },
  });
  /* Named tasks and closed ones are not even examined. */
  expect(plan.totals).toEqual({ examined: 11, settle: 6, kept: 5 });
});

test("applying marks tasks done and deletes none, and a task named since the plan is left alone", () => {
  const plan = planGhostSettlement(input());
  const renamed = backlog.map((entry) => (entry.id === "probe" ? { ...entry, text: "Check the account", origin: { ...entry.origin!, refinement: "titled" as const } } : entry));
  const { pipelineTaskIds, seatIdentities, transcriptOf, nowMs, idleMs } = input();
  const outcome = applyGhostSettlement(renamed, plan, { pipelineTaskIds, seatIdentities, transcriptOf, nowMs, idleMs }, "2026-09-24T12:00:00.000Z");
  expect(outcome.tasks).toHaveLength(backlog.length);
  expect(outcome.settled).toEqual(["old-backfill", "fixture", "digest", "never-started", "retired-seat"]);
  expect(outcome.tasks.find((entry) => entry.id === "probe")!.status).toBe("assigned");
  expect(outcome.tasks.filter((entry) => entry.status === "done").map((entry) => entry.id).sort()).toEqual(["closed", "digest", "fixture", "never-started", "old-backfill", "retired-seat"]);
});

test("the script dry-runs first, then settles a throw-away state directory, and prints counts only", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-settle-ghosts-"));
  roots.push(stateDir);
  const transcripts = path.join(stateDir, "transcripts");
  fs.mkdirSync(transcripts);
  const oldFile = path.join(transcripts, "old.jsonl");
  fs.writeFileSync(oldFile, "{}\n");
  fs.utimesSync(oldFile, new Date(Date.now() - 30 * HOUR), new Date(Date.now() - 30 * HOUR));
  const liveFile = path.join(transcripts, "live.jsonl");
  fs.writeFileSync(liveFile, "{}\n");
  const tasksFile = path.join(stateDir, "tasks.json");
  const old = (ms: number) => new Date(Date.now() - ms).toISOString();
  saveTasks([
    task("old-backfill", { createdAt: old(48 * HOUR), assignments: [assignment({ conversationId: "conversation_a", path: oldFile, at: old(48 * HOUR) })] }),
    task("fixture", { project: "dir-fixture", text: "Exercise legacy spawn fixture", origin: { kind: "launch", key: "launch-fixture", refinement: "pending" }, assignments: [assignment({ launchId: "launch-fixture", conversationId: "conversation_fixture", path: null, at: old(20 * HOUR) })] }),
    task("live", { assignments: [assignment({ conversationId: "conversation_live", path: liveFile, at: old(48 * HOUR) })] }),
  ], tasksFile);
  const run = (...extra: string[]) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, path.join("scripts", "settle-ghost-tasks.ts"), "--state-dir", stateDir, ...extra], cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: stateDir }, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).not.toContain("Error");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  };

  const dry = run();
  expect(dry).toEqual({ mode: "dry-run", idleHours: 6, examined: 3, settle: 2, kept: { "still-running": 1 }, byProject: { "repo-fixture": { conversation: 1 }, "dir-fixture": { fixture: 1 } } });
  expect(loadTasks(tasksFile).filter((entry) => entry.status === "done")).toEqual([]);

  const applied = run("--apply");
  expect(applied.settled).toBe(2);
  const after = loadTasks(tasksFile);
  expect(after).toHaveLength(3);
  expect(after.filter((entry) => entry.status === "done").map((entry) => entry.id).sort()).toEqual(["fixture", "old-backfill"]);
  /* A second pass finds nothing left to settle. */
  expect(run().settle).toBe(0);
});
