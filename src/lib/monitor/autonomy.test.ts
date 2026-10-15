import { afterEach, expect, test, setSystemTime } from "bun:test";
import { autonomyActive, autonomyMandate, autonomyReportKey, pendingAutonomyReports } from "./autonomy";
import { applySeatTickSettingsChange, defaultSeatTickSettings, effectiveSeatTickSettings, readSeatTickSettings, writeSeatTickSettings, markAutonomyReported, changeSeatTickSettings, expireSeatSchedule, seatTickSettingsAfterLapse, type SeatTickSettings, type SeatTickSettingsActor, type SeatTickSettingsChange } from "./seatTickSettings";
import { seatTickWakeMessage } from "./report";
import { DEFAULT_SEAT_TICK_POLICY, seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan } from "./seatTick";
import { emptySeatTickState, type SeatTickCheckInput } from "./types";
import { releaseStages } from "@/lib/release/stages";

const project = "autonomy-fixture";
const at = "2026-10-15T00:00:00.000Z";
const now = Date.parse(at);
const hour = 3_600_000;
const operator: SeatTickSettingsActor = { kind: "gateway", project: null, conversationId: null, seatEpoch: null };
const seat: SeatTickSettingsActor = { kind: "manager", project, conversationId: "conversation_seat", seatEpoch: 1 };
afterEach(() => setSystemTime());
function change(row: SeatTickSettings, fields: SeatTickSettingsChange, actor = operator, time = now) {
  const result = applySeatTickSettingsChange(row, fields, { actor, at: new Date(time).toISOString() });
  if (!result.ok) throw new Error(result.error);
  return result.settings;
}
function enabled() { return change(defaultSeatTickSettings(project), { autonomy: { enabled: true } }); }
function check(row: SeatTickSettings, time = now): SeatTickCheckInput {
  return { project, now: time, seat: { conversationId: seat.conversationId!, seatEpoch: 1, path: null, designatedAt: null, turn: "idle", activity: null },
    pipelines: [], tasks: [], events: [], pullRequests: [], pullRequestsUnavailable: null, ownLanes: [], signals: [], children: [], childrenUnavailable: null,
    changeFingerprint: "unchanged", state: emptySeatTickState(), policy: DEFAULT_SEAT_TICK_POLICY, settings: effectiveSeatTickSettings(row, time, hour) };
}

test("autonomy is off by default; eight hours, extension, unlimited and exact expiry", () => {
  expect(autonomyActive(defaultSeatTickSettings(project).autonomy, now)).toBe(false);
  let row = enabled();
  expect(row.autonomy?.until).toBe(new Date(now + 8 * hour).toISOString());
  expect(autonomyActive(row.autonomy, now + 8 * hour - 1)).toBe(true);
  expect(autonomyActive(row.autonomy, now + 8 * hour)).toBe(false);
  expect(effectiveSeatTickSettings(row, now + 8 * hour, hour).autonomy).toMatchObject({ enabled: false, endedAt: row.autonomy?.until, endReason: "expired" });
  row = change(row, { autonomy: { hours: 12 } }, operator, now + hour);
  expect(row.autonomy?.until).toBe(new Date(now + 13 * hour).toISOString());
  expect(row.autonomy?.startedAt).toBe(at);
  row = change(row, { autonomy: { hours: null } });
  expect(autonomyActive(row.autonomy, now + 9000 * hour)).toBe(true);
  row = change(row, { autonomy: { enabled: false } }, operator, now + 2 * hour);
  expect(row.autonomy).toMatchObject({ enabled: false, endReason: "turned-off" });
});

test("only the operator enables or extends, even when a seat quotes a request", () => {
  const row = enabled();
  for (const fields of [{ enabled: true }, { enabled: true, hours: null }]) expect(() => change(defaultSeatTickSettings(project), { autonomy: { ...fields, why: "operator asked" } }, seat)).toThrow("only shorten");
  for (const hours of [12, null]) expect(() => change(row, { autonomy: { hours, why: "operator asked" } }, seat)).toThrow("only shorten");
  expect(() => change(row, { autonomy: { hours: 1 } }, seat)).toThrow("why");
  expect(change(row, { autonomy: { hours: 1, why: "finish sooner" } }, seat).autonomy?.until).toBe(new Date(now + hour).toISOString());
  expect(change(row, { autonomy: { enabled: false, why: "stop" } }, seat).autonomy?.enabled).toBe(false);
  expect(() => change(row, { enabled: false, reason: "Stop wakes" }, { ...seat, kind: "agent" })).toThrow("only the operator");
  expect(() => change(row, { autonomy: { enabled: true, why: "retry" } }, seat, now + 8 * hour)).toThrow("only shorten");
  for (const actor of [{ ...seat, kind: "agent" as const }, { ...seat, project: "other-project" }, { ...seat, kind: "unidentified" as const }]) expect(() => change(row, { autonomy: { enabled: false, why: "stop" } }, actor)).toThrow("only the operator");
});

test("wakes coupling, schedule reset and independent expiries preserve the episode", () => {
  const off = change(defaultSeatTickSettings(project), { enabled: false, reason: "Quiet" });
  expect(() => change(off, { autonomy: { enabled: true } })).toThrow("enable orchestrator wakes");
  const expiredQuiet = change(off, { until: new Date(now + hour).toISOString() });
  expect(change(expiredQuiet, { autonomy: { enabled: true } }, operator, now + hour).enabled).toBe(true);
  const on = change(off, { enabled: true, autonomy: { enabled: true } });
  expect(change(on, { enabled: false }).autonomy?.endReason).toBe("turned-off");
  const timed = change(on, { wakeIntervalMinutes: 10, until: new Date(now + hour).toISOString() });
  const lapsed = effectiveSeatTickSettings(timed, now + hour, hour);
  expect(lapsed.lapsed).toBe(true);
  expect(autonomyActive(seatTickSettingsAfterLapse(project, lapsed).autonomy, now + hour)).toBe(true);
  expect(change(timed, { wakeIntervalMinutes: null }).autonomy?.startedAt).toBe(at);
  expect(change(on, { autonomy: { hours: -1 } }).autonomy?.until).toBe(new Date(now + hour).toISOString());
  expect(change(on, { autonomy: { hours: 8761 } }).autonomy?.until).toBe(new Date(now + 8760 * hour).toISOString());
  for (const hours of [Infinity, NaN]) expect(() => change(on, { autonomy: { hours } })).toThrow("hours");
});

test("decisions are episode-bound, idempotent, attributed and retain undo through another episode", () => {
  const decision = { startedAt: at, id: "layout", decision: "Choose compact", why: "Fits the phone", undo: "Reopen the form and choose spacious" };
  const row = change(enabled(), { autonomyDecision: decision }, seat);
  expect(change(row, { autonomyDecision: decision }, seat).autonomy?.decisions).toHaveLength(1);
  expect(row.autonomy?.decisions[0]?.undo).toBe(decision.undo);
  expect(row.autonomy?.decisions[0]?.by).toEqual(seat);
  expect(() => change(row, { autonomyDecision: { ...decision, undo: "" } }, seat)).toThrow("undo");
  expect(() => change(row, { autonomyDecision: { ...decision, decision: "Other" } }, seat)).toThrow("different content");
  expect(() => change(row, { autonomyDecision: decision }, seat, now + 8 * hour)).toThrow("no longer active");
  const restarted = change(row, { autonomy: { enabled: true } }, operator, now + 9 * hour);
  expect(restarted.autonomyHistory?.[0]?.decisions[0]?.undo).toBe(decision.undo);
  writeSeatTickSettings(project, restarted);
  markAutonomyReported(project, at, new Date(now + 9 * hour).toISOString());
  const saved = readSeatTickSettings(project);
  expect(saved.autonomy?.enabled).toBe(true);
  expect(pendingAutonomyReports(saved, now + 9 * hour)).toHaveLength(0);
});

test("every active wake carries the overlay; off and expiry carry none", () => {
  const row = enabled();
  const base = { project, reasons: [{ kind: "interval" as const, detail: "work" }], items: [], signals: [], deferred: 0, mandateCarriesContract: true };
  for (const time of [now, now + hour, now + 7 * hour]) {
    const text = seatTickWakeMessage({ ...base, autonomy: row.autonomy, now: time });
    expect(text).toContain("Full autonomy until");
    expect(text).toContain("askBeforePublish only while autonomy is on");
    expect(text).toContain("decision, why, undo");
    expect(text.length).toBeLessThanOrEqual(4000);
  }
  expect(autonomyMandate(row.autonomy, now).join("\n").length).toBeLessThanOrEqual(1200);
  expect(autonomyMandate(row.autonomy, now + 8 * hour)).toEqual([]);
  expect(seatTickWakeMessage({ ...base, autonomy: row.autonomy, now: now + 8 * hour })).toBe(seatTickWakeMessage(base));
  const busy = seatTickWakeMessage({ ...base, autonomy: row.autonomy, now, monitorPrompt: "note ".repeat(3200), operatorInstructions: "x".repeat(500), items: [{ kind: "task", id: "long", label: "work ".repeat(1000) }] });
  expect(busy.length).toBeLessThanOrEqual(4000);
  expect(busy).toContain("Operator instructions");
  expect(busy).toContain("Full autonomy until");
});

test("idle autonomy finds work and admits Inbox", () => {
  const input = check(enabled());
  const first = seatTickDecision(input);
  expect(first.verdict.kind).toBe("wake");
  if (first.verdict.kind !== "wake") throw new Error("wake expected");
  expect(first.verdict.reasons.map(reason => reason.kind)).toContain("autonomy-idle");
  const inbox = seatTickDecision({ ...input, tasks: [{ id: "inbox", title: "Improve exports", status: "inbox", owned: false, updatedAt: at }] }).verdict;
  expect(inbox.kind).toBe("wake");
  if (inbox.kind === "wake") expect(inbox.items.map(item => item.id)).toContain("inbox");
  const after = seatTickWakeCommit(first.state, seatTickWakeCommitPlan(first.verdict, { fingerprint: input.changeFingerprint, eventsThrough: 0 })!, now);
  expect(after).toBeDefined();
  const quiet = seatTickDecision(check(defaultSeatTickSettings(project))).verdict;
  expect(quiet.kind).not.toBe("wake");
});

test("ended episode asks once it is due even with wakes off; report acknowledgement clears it", () => {
  const row = change(enabled(), { enabled: false, reason: "Operator returned" }, operator, now + hour);
  let input = check(row, now + hour);
  const verdict = seatTickDecision(input).verdict;
  expect(verdict.kind).toBe("wake");
  if (verdict.kind === "wake") expect(verdict.reportLines?.join("\n")).toContain(autonomyReportKey(row.autonomy!));
  input = check({ ...row, autonomy: { ...row.autonomy!, reportAt: new Date(now + hour).toISOString() } }, now + hour);
  expect(seatTickDecision(input).verdict.kind).toBe("quiet");
});

test("release publish always rechecks current autonomy and retains every release gate", () => {
  const publish = releaseStages({ cut: "a".repeat(40), lastTag: "v1.0.0", changes: [], askBeforePublish: true }).find(stage => stage.id === "publish")!;
  expect(publish.prompt).toContain("expiry or off restores askBeforePublish");
  expect(publish.prompt).toContain("gap, change-count and hold gates");
  expect(publish.prompt).toContain("When effectiveAskBeforePublish is true");
});


test("schedule lapse and report acknowledgement preserve the latest episode and decisions", () => {
  const initial = change(enabled(), { wakeIntervalMinutes: 10, reason: "Frequent", until: new Date(now + hour).toISOString() });
  writeSeatTickSettings(project, initial);
  changeSeatTickSettings(project, { autonomy: { hours: 24 } }, { at, actor: operator });
  expireSeatSchedule(project, now + hour, hour);
  expect(readSeatTickSettings(project).autonomy?.until).toBe(new Date(now + 24 * hour).toISOString());
  expect(readSeatTickSettings(project).wakeIntervalMinutes).toBeNull();
  const stopped = change(readSeatTickSettings(project), { autonomy: { enabled: false } });
  const restarted = change(stopped, { autonomy: { enabled: true } });
  expect(restarted.autonomy!.startedAt).not.toBe(stopped.autonomy!.startedAt);
});
