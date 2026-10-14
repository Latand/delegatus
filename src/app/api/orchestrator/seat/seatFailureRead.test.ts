import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, failOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { productionIncumbentDependencies } from "./status/incumbent";
import { GET } from "./route";
import * as taskStore from "@/lib/tasks/store";
import { persistProjectAliases } from "@/lib/projects/aliases";

let sandbox = "";
let previousState: string | undefined;
let liveness: ReturnType<typeof spyOn>;
beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "seat-failure-read-"));
  process.env.LLV_STATE_DIR = sandbox;
  liveness = spyOn(productionIncumbentDependencies, "liveness").mockResolvedValue({ lifecycle: "idle", hostState: "alive", silentForMs: 0 });
});
afterEach(() => {
  liveness.mockRestore();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
const AT = "2026-10-11T17:00:00.000Z";
function healthySeat() {
  beginOrchestratorSeatIntent({ project: "atlas", mandate: "Run the board.", clientRequestId: "seed_designation", mode: "existing", now: AT });
  const result = completeOrchestratorSeatIntent({ project: "atlas", clientRequestId: "seed_designation", conversationId: `conversation_${randomUUID()}`, path: null, now: AT });
  if (result.kind !== "activated") throw new Error("fixture seat did not activate");
  return result.seat;
}
function failedRecovery(active: ReturnType<typeof healthySeat>) {
  beginOrchestratorSeatIntent({ project: "atlas", mandate: "Run the board.", clientRequestId: "seat-host-recovery-failure", mode: "spawn",
    automaticReplacement: { conversationId: active.conversationId!, seatEpoch: active.seatEpoch }, now: AT });
  failOrchestratorSeatIntent("atlas", "seat-host-recovery-failure", "database is locked", "2026-10-11T17:11:00.000Z");
}
const read = async () => (await GET(new NextRequest("http://127.0.0.1/api/orchestrator/seat?project=atlas"))).json();

test("the seat read hides a failed automatic replacement when its incumbent is alive and keeps history", async () => {
  const active = healthySeat();
  failedRecovery(active);
  const answer = await read();
  expect(answer.lastFailure).toBeNull();
  expect(answer.hostObservation).toMatchObject({ conversationId: active.conversationId, seatEpoch: active.seatEpoch, hostState: "alive" });
  expect(answer.settledFailureRequestId).toBe("seat-host-recovery-failure");
  expect(liveness).toHaveBeenCalledWith(active.conversationId);
  expect(orchestratorSeatFor("atlas").history).toHaveLength(1);
});

test("no working seat keeps the failed designation and its terminal time", async () => {
  beginOrchestratorSeatIntent({ project: "atlas", mandate: "Run the board.", clientRequestId: "failed_designation", mode: "spawn", now: AT });
  failOrchestratorSeatIntent("atlas", "failed_designation", "database is locked", "2026-10-11T17:11:00.000Z");
  expect(await read()).toMatchObject({ seat: null, lastFailure: { error: "database is locked", terminalizedAt: "2026-10-11T17:11:00.000Z" } });
  expect(liveness).not.toHaveBeenCalled();
});

test("an unknown host observation keeps the failure visible", async () => {
  failedRecovery(healthySeat());
  liveness.mockRejectedValue(new Error("liveness unavailable"));
  expect(await read()).toMatchObject({ lastFailure: { error: "database is locked" } });
});

test("a later successful designation clears history without asking liveness", async () => {
  failedRecovery(healthySeat());
  beginOrchestratorSeatIntent({ project: "atlas", mandate: "Run the board.", clientRequestId: "later_designation", mode: "existing", now: "2026-10-11T17:12:00.000Z" });
  completeOrchestratorSeatIntent({ project: "atlas", clientRequestId: "later_designation", conversationId: `conversation_${randomUUID()}`, path: null, now: "2026-10-11T17:12:00.000Z" });
  expect(await read()).toMatchObject({ lastFailure: null });
  expect(liveness).not.toHaveBeenCalled();
});

test("a seat status poll resolves task projects once for the whole seat history", async () => {
  const seats = Array.from({ length: 12 }, (_, index) => {
    const request = `history_${index}`;
    beginOrchestratorSeatIntent({ project: "atlas", mandate: "Run the board.", clientRequestId: request, mode: "existing", now: AT });
    const result = completeOrchestratorSeatIntent({ project: "atlas", clientRequestId: request,
      conversationId: `conversation_history_${index}`, path: null, now: AT });
    if (result.kind !== "activated") throw new Error("fixture seat did not activate");
    return result.seat;
  });
  expect(persistProjectAliases([{ source: "old-atlas", target: "atlas", displayName: "Atlas" }])).toBe(true);
  const tasks = Array.from({ length: 240 }, (_, index) => ({
    id: `task_${index}`, project: index < seats.length ? "old-atlas" : `foreign_${index % 8}`,
    text: `Notes ${index}`, details: "Kept notes", updatedAt: AT,
    assignments: [{ conversationId: `conversation_history_${index}`, path: null }],
  })) as ReturnType<typeof taskStore.loadTasks>;
  const load = spyOn(taskStore, "loadTasks").mockReturnValue(tasks);
  const stat = spyOn(fs, "statSync");
  try {
    const answer = await read();
    expect(answer.currentTask?.taskId).toBe("task_11");
    expect(answer.previous).toHaveLength(11);
    expect(answer.previous.every((row: { taskId: string | null }) => row.taskId !== null)).toBe(true);
    const aliasReads = stat.mock.calls.filter(([filename]) => String(filename).endsWith("project-aliases.json")).length;
    console.info("seat history alias reads", aliasReads);
    expect(aliasReads).toBeLessThan(80);
  } finally { stat.mockRestore(); load.mockRestore(); }
});
