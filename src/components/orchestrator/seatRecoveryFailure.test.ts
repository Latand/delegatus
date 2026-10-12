import { expect, test } from "bun:test";

import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
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

test("a hidden terminal failure still settles the browser's request key", () => {
  const status = parseSeatStatus({ seat, lastFailure: null, settledFailureRequestId: failure.clientRequestId });
  expect(seatRequestSettled(status, failure.clientRequestId)).toBe(true);
});
