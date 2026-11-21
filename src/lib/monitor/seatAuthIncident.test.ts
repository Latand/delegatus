import { expect, test } from "bun:test";
import { openSeatAuthIncident, normalizeSeatAuthIncident, normalizeSeatAuthTelegramNotice, seatAuthIncidentRecovered, seatAuthNotice, type SeatTurnOutcome } from "./seatAuthIncident";
import { seatTickStateForEpoch } from "./seatTickState";
import { emptySeatTickState, type SeatTickSeatInput } from "./types";

const failedAt = Date.parse("2026-10-08T00:05:00Z");
const seat: SeatTickSeatInput = { conversationId: "conversation_fixture", seatEpoch: 7, path: null,
  designatedAt: "2026-10-08T00:00:00Z", turn: "idle", activity: null, mandateCarriesTickContract: true };
const outcome: SeatTurnOutcome = { engine: "claude", accountId: null, path: "fixture.jsonl",
  auth: { ts: failedAt, text: "OAuth session expired and could not be refreshed" }, normalTurnTs: null };

test("only operator notice debt survives normalization; legacy report destinations are discarded", () => {
  const notice = { id: "seat-auth:fixture:7:1", audience: "operator" as const, text: "Fixture diagnostic" };
  expect(normalizeSeatAuthTelegramNotice(notice)).toEqual(notice);
  expect(normalizeSeatAuthTelegramNotice({ id: notice.id, chat: "fixture-report", html: "Fixture diagnostic" })).toBeNull();
  for (const invalid of [{ ...notice, chat: "fixture-report" }, { ...notice, topicId: 1 }, { ...notice, html: "old" },
    { ...notice, audience: "project" }, { ...notice, text: "" }, { ...notice, id: "other" }, null]) {
    expect(normalizeSeatAuthTelegramNotice(invalid)).toBeNull();
  }
});

test("first auth turn opens a durable identity and designation/re-login watermarks exclude stale turns", () => {
  const incident = openSeatAuthIncident("fixture", seat, outcome)!;
  expect(incident.id).toBe(`seat-auth:fixture:7:${failedAt}`);
  expect(openSeatAuthIncident("fixture", { ...seat, designatedAt: "2026-10-08T00:06:00Z" }, outcome)).toBeNull();
  expect(openSeatAuthIncident("fixture", seat, outcome, failedAt)).toBeNull();
  expect(openSeatAuthIncident("fixture", seat, { ...outcome, auth: null })).toBeNull();
  expect(normalizeSeatAuthIncident(incident)).toEqual(incident);
  expect(normalizeSeatAuthIncident({ ...incident, lastFailedTs: "invalid" })).toBeUndefined();
  expect(seatTickStateForEpoch({ ...emptySeatTickState(), authIncident: incident }, 8).authIncident).toEqual(incident);
});

test("later auth stays one incident; epoch, newer normal turn and changed credentials recover it", () => {
  const incident = openSeatAuthIncident("fixture", seat, outcome)!;
  expect(seatAuthIncidentRecovered(incident, 7, { ...outcome, auth: { ...outcome.auth!, ts: failedAt + 1 } }, null)).toBe(false);
  expect(seatAuthIncidentRecovered(incident, 8, outcome, null)).toBe(true);
  expect(seatAuthIncidentRecovered(incident, 7, { ...outcome, normalTurnTs: failedAt + 1 }, null)).toBe(true);
  expect(seatAuthIncidentRecovered(incident, 7, outcome, "new-login")).toBe(true);
  expect(seatAuthIncidentRecovered({ ...incident, credentialStamp: "old-login" }, 7, outcome, null)).toBe(false);
});

test("uk/en notices name failure, account, action, allowed rotation or outside-pool choice", () => {
  const incident = { ...openSeatAuthIncident("fixture", seat, outcome)!, accountId: "a" };
  const labels = new Map([["a", "A"], ["b", "B"]]);
  incident.rotation = { state: "none-allowed" };
  expect(seatAuthNotice(incident, labels, ["b"], "uk").body).toContain("увійдіть в акаунт ще раз");
  expect(seatAuthNotice(incident, labels, ["b"], "en").body).toContain("Accounts outside the project binding: «B»");
  incident.rotation = { state: "rotated", toAccountId: "b" };
  expect(seatAuthNotice(incident, labels, [], "en").body).toContain("automatically moved with handoff to account «B»");
  incident.rotation = { state: "refused", error: "launch refused" };
  expect(seatAuthNotice(incident, labels, [], "uk").body).toContain("launch refused");
});
