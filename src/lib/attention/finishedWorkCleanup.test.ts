import { agentRegistry, closeAgentRegistryForTests, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPipeline, pipelineStateCollectionSeeds, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { initializeStateCollections, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { loadTasksFile, mutateTasksFile, saveTasksFile } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { cleanupFinishedWorkAtStartup, FINISHED_WORK_CLEANUP } from "./finishedWorkCleanup";

const NOW = "2026-10-19T06:00:00.000Z";
const AT = "2026-10-12T06:00:00.000Z";
let directory: string, previous: string | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finished-work-"));
  previous = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = directory;
  initializeStateCollections(path.join(directory, "state.sqlite"), pipelineStateCollectionSeeds());
});
afterEach(() => {
  closeAgentRegistryForTests();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const file = () => path.join(directory, "tasks.json");
const task = (id: string): BoardTask => ({ id, project: "fixture", text: "Unfinished work", status: "assigned", placement: "unplaced", assignments: [], createdAt: AT, updatedAt: AT });
const lane = (id: string, taskId: string, state: "running" | "completed" | "closed" = "completed"): Pipeline => ({
  ...buildPipeline({ id, task: "Work", taskIds: [taskId], project: "fixture", repoDir: directory, stages: [{ id: "work", kind: "run", role: { roleId: "builder" }, effectiveRole: { roleId: "builder", engine: "claude", model: "fable", effort: null, access: "read-write", promptScaffold: "Build" }, prompt: "Work", next: null, onFail: null }], srcPath: null, srcConversationId: null, now: AT, state: "draft" }), state, cursor: state === "running" ? { stageId: "work", state: "pending", input: null, activatedBy: null } : null, closedAt: state === "running" ? null : AT,
});
function seed() {
  saveTasksFile({ tasks: [task("terminal"), task("archived"), task("active"), task("direct")], recentCreates: [{ clientRequestId: "create-once", taskId: "terminal" }], migrations: { unrelated: AT } }, file());
  savePipelines([lane("terminal-lane", "terminal"), lane("active-lane", "active", "running")]);
  const spec = pipelineStateCollectionSeeds().find(row => row.collection === "pipelines_archive")!;
  new SqliteStateCollection<Pipeline>(path.join(directory, "state.sqlite"), { ...spec, busyMessage: "busy", clone: structuredClone, decode: value => value as Pipeline })
    .boundedPatch(1, transaction => transaction.put(lane("archived-lane", "archived", "closed")));
}

test("fenced cleanup includes the archive and preserves receipts, direct work and active lanes across a real restart", async () => {
  seed(); const before = loadTasksFile(file());
  expect(await cleanupFinishedWorkAtStartup(NOW)).toBe(2);
  const after = loadTasksFile(file());
  expect(after.tasks.map(row => [row.id, row.status])).toEqual([["terminal", "inbox"], ["archived", "inbox"], ["active", "assigned"], ["direct", "assigned"]]);
  expect(after.tasks.slice(2)).toEqual(before.tasks.slice(2));
  expect(after.recentCreates).toEqual(before.recentCreates);
  expect(after.migrations).toEqual({ unrelated: AT, [FINISHED_WORK_CLEANUP]: NOW });
  mutateTasksFile(state => ({ state: { ...state, tasks: state.tasks.map(row => row.id === "terminal" ? { ...row, status: "assigned", updatedAt: NOW } : row) }, result: undefined }), file());
  const reopened = loadTasksFile(file());
  const child = Bun.spawn([process.execPath, "--eval", `import { cleanupFinishedWorkAtStartup } from './src/lib/attention/finishedWorkCleanup.ts'; console.log(await cleanupFinishedWorkAtStartup('${NOW}'));`], { env: { ...process.env, LLV_STATE_DIR: directory }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, error).toBe(0); expect(output.trim()).toBe("0"); expect(loadTasksFile(file())).toEqual(reopened);
});

test("a retired release and an edit at admission preserve the task and migration marker", async () => {
  seed(); const before = loadTasksFile(file());
  await expect(cleanupFinishedWorkAtStartup(NOW, () => { throw new Error("release retired"); })).rejects.toThrow("release retired");
  expect(loadTasksFile(file())).toEqual(before);
  await cleanupFinishedWorkAtStartup(NOW, () => {
    mutateTasksFile(state => ({ state: { ...state, tasks: state.tasks.map(row => row.id === "terminal" ? { ...row, statusBy: { actor: { kind: "operator" }, from: "inbox", at: NOW } } : row) }, result: undefined }), file());
  });
  expect(loadTasksFile(file()).tasks.find(row => row.id === "terminal")?.status).toBe("assigned");
});

test("startup cleanup preserves live stage-only membership and still cleans terminal work", async () => {
  const registry = agentRegistry();
  const cwd = directory;
  const launchProfile = emptyLaunchProfile({ cwd });
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd, transport: "structured", launchProfile });
  if (begun.kind !== "created") throw new Error("expected stage conversation reservation");
  const stagePath = path.join(directory, "stage.jsonl");
  const settlement = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "claude", sessionId: "stage-only" }, artifactPath: stagePath, cwd,
    accountId: null, launchProfile, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  expect(settlement.kind).toBe("settled");
  const snapshot = registry.readOnlySnapshot();
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversation = lookup.conversation(begun.receipt.conversationId);
  const generation = conversation?.generations.at(-1);
  const currentEntry = Object.values(snapshot.entries).find(entry => entry.key.engine === conversation?.engine && entry.artifactPath === generation?.path);
  expect({ path: generation?.path, status: currentEntry?.status }).toEqual({ path: stagePath, status: "live" });
  expect(lookup.conversationForPath(stagePath)?.id).toBe(begun.receipt.conversationId);
  seed();
  const stageLane = { ...lane("terminal-lane", "terminal"), runs: [{ stageId: "work", attempts: [{
    n: 1, state: "passed", effectiveRole: { roleId: "builder", engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: "Build" },
    launchId: null, conversationId: begun.receipt.conversationId, sessionId: null, agentPath: stagePath, paneId: null, flowId: null,
    providerRecoveries: [], startedAt: AT, completedAt: AT, activatedBy: null, input: null, output: null,
    verdict: null, error: null,
  }] }] } as unknown as Pipeline;
  savePipelines([stageLane, lane("active-lane", "active", "running")]);

  expect(await cleanupFinishedWorkAtStartup(NOW)).toBe(1);
  expect(loadTasksFile(file()).tasks.map(row => [row.id, row.status])).toEqual([
    ["terminal", "assigned"], ["archived", "inbox"], ["active", "assigned"], ["direct", "assigned"],
  ]);
  const after = loadTasksFile(file());
  const child = Bun.spawn([process.execPath, "--eval", `import { cleanupFinishedWorkAtStartup } from './src/lib/attention/finishedWorkCleanup.ts'; console.log(await cleanupFinishedWorkAtStartup('${NOW}'));`],
    { env: { ...process.env, LLV_STATE_DIR: directory }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, error).toBe(0);
  expect(output.trim()).toBe("0");
  expect(loadTasksFile(file())).toEqual(after);
});
