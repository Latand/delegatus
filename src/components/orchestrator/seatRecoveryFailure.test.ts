import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import { abandonStillbornOrchestratorSeat, beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { currentSeatFailure } from "@/lib/orchestrator/seatFailure";
import { deriveOrchestratorPanelState, parseSeatStatus, seatRequestSettled } from "./seatState";

const failure = {
  error: "database is locked", clientRequestId: "seat-host-recovery-attempt", seatEpoch: 2,
  designatedAt: "2026-10-11T17:10:00.000Z", terminalizedAt: "2026-10-11T17:11:00.000Z",
  automaticReplacement: { conversationId: "conversation_incumbent", seatEpoch: 1 },
};
const seat: OrchestratorSeat = {
  project: "atlas", seatEpoch: 1, conversationId: "conversation_incumbent", path: null,
  mandate: "Run the board.", promptVersion: null, predecessorConversationId: null, state: "active",
  intent: { mode: "spawn", clientRequestId: "first_designation", launchId: null, error: null },
  designatedAt: "2026-10-11T16:00:00.000Z", activatedAt: "2026-10-11T16:01:00.000Z",
};
const observation = { conversationId: seat.conversationId, seatEpoch: 1, hostState: "alive", observedAt: "2026-10-12T12:00:00.000Z" };
const base = { statusFailed: false, submitting: false, submitFailure: null, file: null, surface: null };
const derive = (body: unknown) => deriveOrchestratorPanelState({ ...base, status: parseSeatStatus(body) });

test("stale failed recovery with a healthy designated seat has no banner", () => {
  expect(derive({ seat, lastFailure: failure, hostObservation: observation })).toMatchObject({ kind: "live", transition: null });
});

test("a failed designation without a working seat carries the terminal failure time", () => {
  expect(derive({ seat: null, lastFailure: failure })).toMatchObject({ kind: "intent-error", error: failure.error, failedAt: failure.terminalizedAt });
});

test("a later successful designation clears a failed replacement even with equal clock times", () => {
  expect(derive({ seat: { ...seat, seatEpoch: 3, activatedAt: failure.terminalizedAt }, lastFailure: failure })).toMatchObject({ kind: "live", transition: null });
});

test("a manual failure clears only after a matching live observation newer than the failure", () => {
  const manual = { ...failure, automaticReplacement: undefined };
  for (const hostObservation of [
    null, { ...observation, observedAt: "2026-10-11T17:00:00.000Z" },
    { ...observation, conversationId: "conversation_other" }, { ...observation, seatEpoch: 3 },
    { ...observation, hostState: "unknown" }, { ...observation, observedAt: "invalid" },
  ]) expect(derive({ seat, lastFailure: manual, hostObservation })).toMatchObject({ kind: "live", transition: { kind: "error", error: manual.error } });
  expect(derive({ seat, lastFailure: manual, hostObservation: observation })).toMatchObject({ kind: "live", transition: null });
});

test("automatic recovery also requires a matching live observation strictly after the failure", () => {
  for (const hostObservation of [
    null,
    { ...observation, observedAt: "2026-10-11T17:00:00.000Z" },
    { ...observation, observedAt: failure.terminalizedAt },
    { ...observation, observedAt: "invalid" },
    { ...observation, conversationId: "conversation_other" },
    { ...observation, seatEpoch: 2 },
    { ...observation, hostState: "unknown" },
  ]) {
    expect(derive({ seat, lastFailure: failure, hostObservation })).toMatchObject({
      kind: "live", transition: { kind: "error", error: failure.error },
    });
  }
  expect(derive({ seat, lastFailure: failure, hostObservation: observation }))
    .toMatchObject({ kind: "live", transition: null });
});

test("a restored predecessor keeps the rollback failure until a later live observation", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "seat-failure-rollback-"));
  process.env.LLV_STATE_DIR = state;
  try {
    const project = "rollback-fixture";
    const predecessor = "conversation_predecessor";
    const failedId = "rollback_successor_attempt";
    const failedAt = "2026-10-11T17:11:00.000Z";
    beginOrchestratorSeatIntent({ project, mandate: "Run the board.", clientRequestId: "predecessor_attempt", mode: "existing", now: "2026-10-11T16:00:00.000Z" });
    completeOrchestratorSeatIntent({ project, clientRequestId: "predecessor_attempt", conversationId: predecessor, path: "/tmp/fixture.jsonl", now: "2026-10-11T16:01:00.000Z" });
    beginOrchestratorSeatIntent({ project, mandate: "Replace the board seat.", clientRequestId: failedId, mode: "spawn", now: "2026-10-11T17:10:00.000Z" });
    completeOrchestratorSeatIntent({ project, clientRequestId: failedId, conversationId: "conversation_successor", path: null, now: "2026-10-11T17:10:30.000Z" });
    const rollback = abandonStillbornOrchestratorSeat({ project, clientRequestId: failedId, error: "launch failed", now: failedAt });
    expect(rollback?.restored?.seatEpoch).toBeGreaterThan(rollback?.terminalized.seat.seatEpoch ?? 0);
    const restored = orchestratorSeatFor(project).active!;
    const failedSeat = rollback!.terminalized.seat;
    const restoredFailure = {
      error: failedSeat.intent.error!,
      clientRequestId: failedSeat.intent.clientRequestId,
      seatEpoch: failedSeat.seatEpoch,
      designatedAt: failedSeat.designatedAt,
      terminalizedAt: rollback!.terminalized.terminalizedAt,
      predecessorConversationId: failedSeat.predecessorConversationId,
    };
    expect(currentSeatFailure(restoredFailure, restored)).toEqual(restoredFailure);
    expect(currentSeatFailure(restoredFailure, restored, { ...observation, conversationId: predecessor, seatEpoch: restored.seatEpoch, observedAt: failedAt }))
      .toEqual(restoredFailure);
    expect(currentSeatFailure(restoredFailure, restored, { ...observation, conversationId: predecessor, seatEpoch: restored.seatEpoch }))
      .toBeNull();
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a hidden terminal failure still settles the browser's request key", () => {
  const status = parseSeatStatus({ seat, lastFailure: null, settledFailureRequestId: failure.clientRequestId });
  expect(seatRequestSettled(status, failure.clientRequestId)).toBe(true);
});
