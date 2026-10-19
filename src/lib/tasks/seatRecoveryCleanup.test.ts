import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { seatHostRecoveryCard } from "@/lib/monitor/seatHostRecovery";
import { buildPipeline, pipelineStateCollectionSeeds, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { initializeStateCollections, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { SEAT_RECOVERY_CLEANUP, isEmptySeatRecoveryTask, retireSeatRecoveryPlaceholdersAtStartup } from "./seatRecoveryCleanup";
import { loadTasksFile, mutateTasksFile, saveTasksFile } from "./store";
import type { BoardTask } from "./types";

const NOW = "2026-10-19T06:00:00.000Z";
const CREATED = "2026-10-18T08:55:00.000Z";
let directory: string, previous: string | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "seat-recovery-cleanup-"));
  previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  initializeStateCollections(path.join(directory, "state.sqlite"), pipelineStateCollectionSeeds());
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const file = () => path.join(directory, "tasks.json");
function task(id: string, locale: "uk" | "en" = "uk"): BoardTask {
  const card = seatHostRecoveryCard({ id, conversationId: "seat", seatEpoch: 7, at: CREATED, state: "revived", detail: "shared composer recovery started a fresh host", told: true }, locale);
  return { id, project: "project-a", status: "inbox", text: card.detail, details: `${card.record}\n\nmonitor-ref: seat-host-recovery-${"a".repeat(32)}`,
    placement: "unplaced", assignments: [], createdAt: CREATED, updatedAt: CREATED };
}
function pipeline(id: string, taskId: string) {
  return buildPipeline({ id, task: "linked work", project: "project-a", repoDir: directory, taskIds: [taskId], stages: [], srcPath: null, srcConversationId: null, now: NOW, state: "draft" });
}
function seed(tasks: BoardTask[]) {
  saveTasksFile({ tasks, recentCreates: [{ clientRequestId: "retained-create", taskId: tasks[0]!.id }], migrations: { unrelated: CREATED } }, file());
}

test("only untouched generated successes qualify, including edits that do not advance updatedAt", () => {
  const original = task("eligible");
  expect(isEmptySeatRecoveryTask(original, new Set())).toBe(true);
  expect(isEmptySeatRecoveryTask({ ...original, hold: undefined }, new Set())).toBe(true);
  const excluded: Partial<BoardTask>[] = [
    { text: "Відновлення оркестратора" }, { details: original.details + "\noperator context" },
    { updatedAt: NOW }, { status: "assigned" }, { status: "done" }, { placement: "pinned", pos: { x: 0, y: 0 } },
    { chosen: true }, { color: "slate" }, { icon: "wrench" }, { priority: "high" }, { boardChoice: true },
    { note: { text: "keep", author: { kind: "operator" }, updatedAt: CREATED } },
    { steps: [] }, { attachments: [] }, { machine: "peer" }, { origin: { kind: "conversation", key: "seat", refinement: "titled" } },
    { assignments: [{ launchId: "launch", path: null, panePid: null, state: "linked", error: null, at: CREATED, conversationId: "seat" }] },
  ];
  for (const patch of excluded) expect(isEmptySeatRecoveryTask({ ...original, ...patch }, new Set()), JSON.stringify(patch)).toBe(false);
  expect(isEmptySeatRecoveryTask(original, new Set([original.id]))).toBe(false);
  expect(isEmptySeatRecoveryTask({ ...original, text: original.text.replace("Сесію відновлено.", "Ротацію розпочато.") }, new Set())).toBe(false);
});

test("startup closes both locales, preserves active and archived memberships, receipts and edits, then survives process restart", async () => {
  const kept = { ...task("edited"), color: "slate" as const };
  seed([task("uk"), task("en", "en"), task("linked"), task("archived"), kept]);
  const linked = pipeline("linked-pipeline", "linked");
  savePipelines([linked]);
  const archive = pipelineStateCollectionSeeds().find(spec => spec.collection === "pipelines_archive")!;
  new SqliteStateCollection<Pipeline>(path.join(directory, "state.sqlite"), { ...archive, busyMessage: "fixture busy", clone: structuredClone, decode: value => value as Pipeline }).boundedPatch(1, tx => tx.put(pipeline("archived-pipeline", "archived")));
  const before = loadTasksFile(file());
  expect(await retireSeatRecoveryPlaceholdersAtStartup(NOW)).toBe(2);
  const after = loadTasksFile(file());
  expect(after.tasks.filter(row => row.status === "done").map(row => row.id)).toEqual(["uk", "en"]);
  for (const id of ["linked", "archived", "edited"]) expect(after.tasks.find(row => row.id === id)).toEqual(before.tasks.find(row => row.id === id));
  expect(after.recentCreates).toEqual(before.recentCreates);
  expect(after.migrations).toEqual({ unrelated: CREATED, [SEAT_RECOVERY_CLEANUP]: NOW });
  mutateTasksFile(state => ({ state: { ...state, tasks: state.tasks.map(row => row.id === "uk" ? { ...row, status: "inbox", updatedAt: NOW } : row) }, result: undefined }), file());
  const reopened = loadTasksFile(file());
  const child = Bun.spawn([process.execPath, "--eval", `import { retireSeatRecoveryPlaceholdersAtStartup } from './src/lib/tasks/seatRecoveryCleanup.ts'; console.log(await retireSeatRecoveryPlaceholdersAtStartup('${NOW}'));`], { env: { ...process.env, LLV_STATE_DIR: directory }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, error).toBe(0);
  expect(output.trim()).toBe("0");
  expect(loadTasksFile(file())).toEqual(reopened);
});

test("lost startup authority leaves tasks and the migration marker untouched", async () => {
  seed([task("held")]);
  const before = loadTasksFile(file());
  await expect(retireSeatRecoveryPlaceholdersAtStartup(NOW, () => { throw new Error("release retired"); })).rejects.toThrow("release retired");
  expect(loadTasksFile(file())).toEqual(before);
});

test("unverifiable pipeline history refuses cleanup without recording completion", async () => {
  seed([task("held")]);
  savePipelines([pipeline("malformed", "held")]);
  const db = new Database(path.join(directory, "state.sqlite"));
  try { db.query("UPDATE state_rows SET value_json = ? WHERE collection = 'pipelines' AND row_key = ?").run('{"id":"malformed"}', "malformed"); }
  finally { db.close(); }
  const before = loadTasksFile(file());
  await expect(retireSeatRecoveryPlaceholdersAtStartup(NOW)).rejects.toThrow("cannot verify pipeline membership");
  expect(loadTasksFile(file())).toEqual(before);
});

test("task edits and pipeline links arriving after the scan are protected", async () => {
  seed([task("edited-during-admission")]);
  const before = loadTasksFile(file());
  await expect(retireSeatRecoveryPlaceholdersAtStartup(NOW, () => {
    savePipelines([pipeline("new-link", before.tasks[0]!.id)]);
  })).rejects.toThrow("pipeline membership changed");
  expect(loadTasksFile(file())).toEqual(before);
  savePipelines([]);
  expect(await retireSeatRecoveryPlaceholdersAtStartup(NOW, () => {
    mutateTasksFile(state => ({ state: { ...state, tasks: state.tasks.map(row => ({ ...row, color: "slate" })) }, result: undefined }), file());
  })).toBe(0);
  expect(loadTasksFile(file()).tasks[0]!.status).toBe("inbox");
});
