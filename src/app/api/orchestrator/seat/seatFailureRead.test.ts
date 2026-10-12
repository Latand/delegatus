import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, failOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { productionIncumbentDependencies } from "./status/incumbent";
import { GET } from "./route";

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
