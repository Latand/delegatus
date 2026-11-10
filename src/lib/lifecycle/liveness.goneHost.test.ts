/**
 * A host that exited in the middle of a tool call (#3740). The unanswered call
 * keeps the transcript's turn boundary unverified, and past the stall window
 * that used to turn the row into an unverified "gone" with no silence: the
 * board and the seat wake then had nothing to report while the stage attempt
 * still read as running.
 */
import { expect, test } from "bun:test";
import { evaluateActivityLiveness } from "./liveness";

const MINUTE = 60_000;
const now = Date.parse("2026-01-02T00:00:00.000Z");
const openCall = { name: "Bash", input: { command: "bun test" }, startedAt: now - 65 * MINUTE };

test("a gone host over an unanswered tool call stays a stall after the stall window", () => {
  const verdict = evaluateActivityLiveness({ host: { state: "gone" }, turnState: "busy", silentForMs: 65 * MINUTE, stallAfterMs: 10 * MINUTE, now,
    activityFacts: { lastRecordAt: now - 65 * MINUTE, turnBoundaryVerified: false, openCall } });
  expect(verdict).toMatchObject({ lifecycle: "stalled", reason: "host_gone_turn_open", verified: true });
});

test("a gone host whose unverified boundary has no open call keeps the unverified answer", () => {
  const verdict = evaluateActivityLiveness({ host: { state: "gone" }, turnState: "busy", silentForMs: 65 * MINUTE, stallAfterMs: 10 * MINUTE, now,
    activityFacts: { lastRecordAt: now - 65 * MINUTE, turnBoundaryVerified: false, openCall: null } });
  expect(verdict).toMatchObject({ lifecycle: "gone", reason: "host_gone_turn_unverified", verified: false });
});

test("a live host over the same open call is not called a stall by this rule", () => {
  const verdict = evaluateActivityLiveness({ host: { state: "alive" }, turnState: "busy", silentForMs: 65 * MINUTE, stallAfterMs: 10 * MINUTE, now,
    activityFacts: { lastRecordAt: now - 65 * MINUTE, turnBoundaryVerified: false, openCall } });
  expect(verdict.verified === false || verdict.lifecycle !== "stalled" || verdict.reason !== "host_gone_turn_open").toBe(true);
});
