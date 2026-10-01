import { expect, test } from "bun:test";

import { translate, type MessageKey } from "@/lib/i18n";
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

import type { BoardMaintenanceAnswer, BoardMaintenanceRunSummary } from "@/lib/boardMaintenance/answer";

import { MAINTENANCE_FAILURES, SEAT_TICK_REASON_KEYS, maintenanceReading, seatTickIntervalWord, seatTickReading } from "./seatTickView";

/*
 * What the control says, as a pure function of the settings answer (#1681).
 *
 * The claims under test are the issue's two hard ones: the chip face is the
 * SCHEDULE and the dot is the STATE, never each other's; and a fact the Viewer
 * does not have reads as «unknown» rather than as an age computed from a
 * missing instant.
 */

const t = ((key: MessageKey, params?: Record<string, string | number>) => translate("en", key, params)) as never;
const NOW = Date.parse("2026-09-18T12:00:00.000Z");

function answer(overrides: Partial<SeatTickSettingsAnswer> = {}): SeatTickSettingsAnswer {
  return {
    maintenance: {
      enabled: false, intervalHours: 3, defaultIntervalHours: 3, minIntervalHours: 1, maxIntervalHours: 168,
      updatedAt: null, setBy: null, live: null, lastRun: null,
      nextEligibleAt: null, nextRunAt: null, waitingOn: "off", runsError: null,
    },
    project: "viewer",
    changed: false,
    at: "2026-09-18T12:00:00.000Z",
    actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
    settings: {
      project: "viewer",
      enabled: true,
      wakeIntervalMinutes: null,
      reason: null,
      monitorPrompt: null,
      until: null,
      updatedAt: null,
      setBy: null,
    },
    effective: {
      enabled: true,
      wakeIntervalMinutes: 60,
      reason: null,
      monitorPrompt: null,
      until: null,
      isDefault: true,
      configured: false,
      lapsed: false,
      updatedAt: null,
    },
    defaults: { project: "viewer", enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null },
    defaultWakeIntervalMinutes: 60,
    monitorPromptLength: 0,
    cardText: null,
    policy: { checkIntervalMinutes: 5, staleAfterMinutes: 15, retryGuardWakes: 2 },
    state: null,
    stateError: null,
    lastRun: null,
    lastDelivery: null,
    journalError: null,
    ...overrides,
  };
}

function state(overrides: Partial<NonNullable<SeatTickSettingsAnswer["state"]>> = {}): NonNullable<SeatTickSettingsAnswer["state"]> {
  return {
    lastCheckAt: "2026-09-18T11:57:00.000Z",
    lastWakeAt: null,
    lastWakeReasons: [],
    outstandingWake: null,
    retryGuard: [],
    sourceGap: null,
    accountingGap: null,
    ...overrides,
  };
}

const read = (value: SeatTickSettingsAnswer | null, failed = false) => seatTickReading({ answer: value, failed }, NOW, t);

test("an interval collapses only where it collapses exactly", () => {
  expect(seatTickIntervalWord(5, t)).toBe("every 5 min");
  /* Not «1 h»: one unit is no clearer than the number the operator typed. */
  expect(seatTickIntervalWord(60, t)).toBe("every 60 min");
  expect(seatTickIntervalWord(90, t)).toBe("every 90 min");
  expect(seatTickIntervalWord(120, t)).toBe("every 2 h");
  expect(seatTickIntervalWord(1440, t)).toBe("every 24 h");
  expect(seatTickIntervalWord(2880, t)).toBe("every 2 d");
});

test("healthy: the face is the schedule, the dot is the state, and the line carries both", () => {
  const reading = read(answer({ state: state() }));
  expect(reading.state).toBe("healthy");
  expect(reading.tone).toBe("ok");
  expect(reading.chip).toBe("hourly");
  expect(reading.line).toBe("Tick: every 60 min · last check 3m ago");
  expect(reading.sentence).toBe("Enabled and checking; last check 3m ago.");
  expect(reading.blocker).toBeNull();
  expect(reading.offDefault).toBe(false);
});

test("a non-default interval changes the face and nothing about the dot", () => {
  const healthy = read(answer({
    settings: { ...answer().settings, wakeIntervalMinutes: 5, reason: "a release afternoon", updatedAt: "2026-09-18T10:00:00.000Z" },
    effective: { ...answer().effective, wakeIntervalMinutes: 5, reason: "a release afternoon", isDefault: false, configured: true, updatedAt: "2026-09-18T10:00:00.000Z" },
    state: state(),
  }));
  expect(healthy.chip).toBe("every 5 min");
  expect(healthy.tone).toBe("ok");
  expect(healthy.offDefault).toBe(true);
  expect(healthy.line).toBe("Tick: every 5 min · last check 3m ago");
});

test("stale: an enabled tick with no recent check reads as enabled AND stale, never as healthy", () => {
  const reading = read(answer({ state: state({ lastCheckAt: "2026-09-18T11:37:00.000Z" }) }));
  expect(reading.state).toBe("stale");
  expect(reading.tone).toBe("warn");
  /* The face still says the schedule: the tick IS configured hourly. */
  expect(reading.chip).toBe("hourly");
  expect(reading.line).toBe("Tick: every 60 min · stale: last check 23m ago");
  expect(reading.sentence).toContain("Enabled, and stale");
  expect(reading.sentence).toContain("Checks run every 5 min");
  expect(reading.sentence).not.toContain("checking;");
});

test("stale: a row with no check at all is stale rather than unknown, and no age is invented", () => {
  const reading = read(answer({ state: state({ lastCheckAt: null }) }));
  expect(reading.state).toBe("stale");
  expect(reading.line).toBe("Tick: every 60 min · stale: no check recorded");
  expect(reading.rows.find((row) => row.label === "Last check")?.value).toBe("unknown");
  expect(reading.rows.find((row) => row.label === "Last wake delivered")?.value).toBe("never");
});

test("blocked: the first thing holding the wake back is named, in the operator's order", () => {
  const outstanding = read(answer({
    state: state({
      outstandingWake: { preparedAt: "2026-09-18T10:00:00.000Z", dispatch: "refused" },
      retryGuard: [{ kind: "interval", wakes: 4 }],
    }),
  }));
  expect(outstanding.state).toBe("blocked");
  expect(outstanding.tone).toBe("warn");
  expect(outstanding.line).toBe("Tick: every 60 min · blocked: unresolved wake since 2h ago (dispatch refused)");

  const guard = read(answer({ state: state({ retryGuard: [{ kind: "stalled", wakes: 2 }] }) }));
  expect(guard.blocker).toBe("retry guard: stalled lane (2 wakes changed nothing)");

  const gap = read(answer({ state: state({ sourceGap: { source: "pull-requests", gap: "api-unreachable", since: "2026-09-15T12:00:00.000Z" } }) }));
  expect(gap.blocker).toBe("source gap: pull requests since 3d ago (api-unreachable)");

  const migration = read(answer({ state: state({ accountingGap: "torn" }) }));
  expect(migration.blocker).toContain("accounting import is blocked");
});

test("paused: the face says off, the dot is muted, and the actual rows still report what the row holds", () => {
  const reading = read(answer({
    settings: { ...answer().settings, enabled: false, reason: "nothing to do until Monday", updatedAt: "2026-09-18T10:00:00.000Z" },
    effective: { ...answer().effective, enabled: false, reason: "nothing to do until Monday", isDefault: false, configured: true, updatedAt: "2026-09-18T10:00:00.000Z" },
    state: state({ lastWakeAt: "2026-09-18T09:00:00.000Z", lastWakeReasons: ["interval"] }),
    lastDelivery: { at: "2026-09-18T09:00:00.000Z", outcome: "landed" },
  }));
  expect(reading.state).toBe("paused");
  expect(reading.tone).toBe("muted");
  expect(reading.chip).toBe("off");
  expect(reading.line).toBe("Tick: off since 2h ago · last check 3m ago");
  expect(reading.sentence).toBe("Off since 2h ago. No wake is sent. Checks still run.");
  expect(reading.rows.find((row) => row.label === "Last wake delivered")?.value).toBe("3h ago · interval");
  expect(reading.rows.find((row) => row.label === "Last delivery")?.value).toBe("landed · 3h ago");
  expect(reading.rows.find((row) => row.label === "Blocker")?.value).toBe("none");
});

test("paused and not checked: the pause is stated without claiming checks still run", () => {
  const off = {
    settings: { ...answer().settings, enabled: false, reason: "nothing to do until Monday", updatedAt: "2026-09-18T10:00:00.000Z" },
    effective: { ...answer().effective, enabled: false, reason: "nothing to do until Monday", isDefault: false, configured: true, updatedAt: "2026-09-18T10:00:00.000Z" },
  };
  /* The tick was paused deliberately AND its own checks have stopped. Both are
     facts about this project and the section may not assert only the first. */
  const stopped = read(answer({ ...off, state: state({ lastCheckAt: "2026-09-18T11:30:00.000Z" }) }));
  expect(stopped.state).toBe("paused");
  expect(stopped.chip).toBe("off");
  /* The dot reports the ACTUAL state, so it cannot stay the muted grey of a
     tick that is quiet on purpose and still being checked. */
  expect(stopped.tone).toBe("warn");
  expect(stopped.sentence).toBe("Off since 2h ago. No wake is sent. The tick is not checking either: the last check was 30m ago, so nothing is refreshing this reading.");
  expect(stopped.sentence).not.toContain("Checks still run");
  expect(stopped.line).toBe("Tick: off since 2h ago · stale: last check 30m ago");

  /* Paused with the checks still running keeps the original reading. */
  const checked = read(answer({ ...off, state: state() }));
  expect(checked.state).toBe("paused");
  expect(checked.tone).toBe("muted");
  expect(checked.sentence).toBe("Off since 2h ago. No wake is sent. Checks still run.");

  /* A row with no check at all, while off: the same qualifier, no age. */
  const never = read(answer({ ...off, state: state({ lastCheckAt: null }) }));
  expect(never.tone).toBe("warn");
  expect(never.sentence).toContain("No check is recorded either");
  expect(never.sentence).not.toContain("Checks still run");

  /* Off with NO row: nothing has been measured, so the pause is stated and
     the checks are reported as the unknown they are — never as «still run». */
  const noRow = read(answer({ ...off, state: null }));
  expect(noRow.state).toBe("paused");
  expect(noRow.tone).toBe("muted");
  expect(noRow.sentence).toBe("Off since 2h ago. No wake is sent. Actual state unknown: the tick has not recorded this project.");
  expect(noRow.sentence).not.toContain("Checks still run");
});

test("unknown: no row is a hollow dot and the word, with no age anywhere", () => {
  const reading = read(answer());
  expect(reading.state).toBe("unknown");
  expect(reading.tone).toBe("unknown");
  expect(reading.chip).toBe("hourly");
  expect(reading.line).toBe("Tick: every 60 min · state unknown");
  expect(reading.sentence).toBe("Actual state unknown: the tick has not recorded this project.");
  for (const row of reading.rows) expect(row.value).toBe("unknown");
});

test("unknown: an unreadable row says which store failed, and the settings still read", () => {
  const reading = read(answer({ state: null, stateError: "the accounting is busy" }));
  expect(reading.state).toBe("unknown");
  expect(reading.sentence).toBe("Actual state unknown: the tick's record could not be read.");
  expect(reading.chip).toBe("hourly");
});

test("a settings read that never answered says so, and claims nothing about the tick", () => {
  const failed = read(null, true);
  expect(failed.line).toBe("Tick: could not be read");
  expect(failed.tone).toBe("unknown");
  expect(failed.rows).toEqual([]);
  expect(read(null).line).toBe("Tick: reading…");
});

/* #1771: a tick whose every wake is refused reads as enabled, checking and
   recently delivering. The last DELIVERED wake beside when the next one is due
   is what makes that visible on the board instead of by asking the seat. */
test("the next wake is read beside the last delivered one, and never invented (#1771)", () => {
  const due = read(answer({ state: state({ lastWakeAt: "2026-09-18T11:30:00.000Z", lastWakeReasons: ["interval"] }) }));
  expect(due.rows.find((row) => row.label === "Last wake delivered")?.value).toBe("30m ago · interval");
  /* An hour after the last landing, on the hour's cadence. */
  expect(due.rows.find((row) => row.label === "Next wake")?.value).toBe("in 30 min");

  /* The interval already spent: the next check is the answer, never an instant
     in the past dressed up as a schedule. */
  const overdue = read(answer({ state: state({ lastWakeAt: "2026-09-18T09:00:00.000Z" }) }));
  expect(overdue.rows.find((row) => row.label === "Next wake")?.value).toBe("at the next check");
  /* A row that has never landed a wake is due at the next check too. */
  expect(read(answer({ state: state() })).rows.find((row) => row.label === "Next wake")?.value).toBe("at the next check");

  /* A fence is not a schedule: while something holds the next wake back, the
     row says so and the Blocker row beside it says what. */
  const fenced = read(answer({
    state: state({ lastWakeAt: "2026-09-18T11:30:00.000Z", outstandingWake: { preparedAt: "2026-09-18T10:00:00.000Z", dispatch: "refused" } }),
  }));
  expect(fenced.rows.find((row) => row.label === "Next wake")?.value).toBe("held back while the blocker stands");

  /* Off means nothing is due, and a project with no row says the word. */
  const off = read(answer({
    effective: { ...answer().effective, enabled: false },
    state: state({ lastWakeAt: "2026-09-18T11:30:00.000Z" }),
  }));
  expect(off.rows.find((row) => row.label === "Next wake")?.value).toBe("none while the tick is off");
  expect(read(answer()).rows.find((row) => row.label === "Next wake")?.value).toBe("unknown");

  /* A long cadence collapses into hours rather than counting minutes. */
  const daily = read(answer({
    effective: { ...answer().effective, wakeIntervalMinutes: 1440 },
    state: state({ lastWakeAt: "2026-09-18T09:00:00.000Z" }),
  }));
  expect(daily.rows.find((row) => row.label === "Next wake")?.value).toBe("in 21 h");
});

test("both locales carry every wake reason", () => {
  for (const key of SEAT_TICK_REASON_KEYS) {
    expect(translate("en", key), `en ${key}`).not.toBe(key);
    expect(translate("uk", key), `uk ${key}`).not.toBe(key);
  }
});

/*
 * The board maintenance timer's reading (#2162): the states the UI brief names,
 * each as the words, the tone and the card it would show.
 */

const TIME = /\d{2}:\d{2}/;

function maintenance(overrides: Partial<BoardMaintenanceAnswer> = {}): BoardMaintenanceAnswer {
  return { ...answer().maintenance, ...overrides };
}

function run(overrides: Partial<BoardMaintenanceRunSummary> = {}): BoardMaintenanceRunSummary {
  return {
    runId: "run-1", taskId: "task-1", conversationId: "conv-1", state: "succeeded",
    claimedAt: "2026-09-18T09:00:00.000Z", launchedAt: "2026-09-18T09:00:05.000Z", endedAt: "2026-09-18T09:14:00.000Z",
    failure: null, counts: { writes: 14, tasks: 9, status: 4, closed: 2, created: 1, text: 5, details: 0, looks: 2 }, attentionCount: 3,
    ...overrides,
  };
}

const reading = (value: BoardMaintenanceAnswer | null | undefined, locale = "en") =>
  maintenanceReading(value, NOW, locale, ((key: MessageKey, params?: Record<string, string | number>) => translate(locale as "en" | "uk", key, params)) as never)!;

test("maintenance: an answer with no timer block shows no group", () => {
  expect(maintenanceReading(undefined, NOW, "en", t)).toBeNull();
  expect(maintenanceReading(null, NOW, "en", t)).toBeNull();
});

test("maintenance: off and never run says so, with no result row and no card", () => {
  const r = reading(maintenance());
  expect(r.state).toBe("off");
  expect(r.tone).toBe("muted");
  expect(r.summary).toBe("Off");
  expect(r.rows.map((row) => [row.key, row.value])).toEqual([["last", "never"], ["next", "none while maintenance is off"]]);
  expect(r.cardTaskId).toBeNull();
  expect(r.warning).toBeNull();
});

test("maintenance: on and never run names the first run at the next check", () => {
  const r = reading(maintenance({ enabled: true, intervalHours: 6, waitingOn: null, nextRunAt: "2026-09-18T12:05:00.000Z" }));
  expect(r.state).toBe("on");
  expect(r.tone).toBe("ok");
  expect(r.summary).toBe("On · every 6 h");
  expect(r.rows.find((row) => row.key === "next")?.value).toMatch(/^first run at the next check, about \d{2}:\d{2}$/);
});

test("maintenance: a live run reads as running, links its card and defers the next run", () => {
  const r = reading(maintenance({ enabled: true, waitingOn: "live-run", live: run({ state: "running", endedAt: null, taskId: "live-card" }), lastRun: run() }));
  expect(r.state).toBe("running");
  expect(r.summary).toMatch(/^Running since \d{2}:\d{2}$/);
  expect(r.cardTaskId).toBe("live-card");
  expect(r.rows.find((row) => row.key === "next")?.value).toBe("after the current run ends");
});

test("maintenance: a succeeded run shows time, counts, the attention count and its card", () => {
  const r = reading(maintenance({ enabled: true, waitingOn: "interval", lastRun: run(), nextRunAt: "2026-09-18T12:10:00.000Z" }));
  expect(r.tone).toBe("ok");
  expect(r.rows.find((row) => row.key === "last")?.value).toMatch(/^Done · \d{2}:\d{2}$/);
  expect(r.rows.find((row) => row.key === "result")?.value).toBe("Tasks changed: 9 · for you: 3");
  expect(r.rows.find((row) => row.key === "next")?.value).toMatch(/^about \d{2}:\d{2}$/);
  expect(r.cardTaskId).toBe("task-1");
});

test("maintenance: a failed run is a warning with its reason by kind, never the engine's detail", () => {
  const r = reading(maintenance({
    enabled: true,
    lastRun: run({ state: "failed", failure: { kind: "no-account", detail: "/srv/engine/state.json refused" } }),
    nextRunAt: "2026-09-18T12:10:00.000Z",
  }));
  expect(r.tone).toBe("warn");
  expect(r.rows.find((row) => row.key === "last")?.value).toMatch(/^Failed · \d{2}:\d{2}$/);
  expect(r.rows.find((row) => row.key === "result")?.value).toBe("no Codex account is available for this project");
  expect(JSON.stringify(r)).not.toContain("/srv/engine");
  /* A kind this build does not know still reads as a failure, not as blank. */
  const odd = reading(maintenance({ enabled: true, lastRun: run({ state: "failed", failure: { kind: "from-the-future" as never, detail: "" } }) }));
  expect(odd.rows.find((row) => row.key === "result")?.value).toBe("the run failed for a reason this panel does not know");
});

test("maintenance: a hold says why the next run waits", () => {
  expect(reading(maintenance({ enabled: true, waitingOn: "deployment", nextRunAt: "2026-09-18T12:05:00.000Z" })).rows.find((row) => row.key === "next")?.value).toBe("held while a deployment runs");
  expect(reading(maintenance({ enabled: true, waitingOn: "no-seat" })).rows.find((row) => row.key === "next")?.value).toBe("held: the project has no seat");
  /* No instant and nothing holding it: the checks themselves are off. */
  expect(reading(maintenance({ enabled: true, waitingOn: null, nextRunAt: null })).rows.find((row) => row.key === "next")?.value).toBe("unknown: tick checks are off");
});

test("maintenance: an unreadable run store warns and the setting still reads", () => {
  const r = reading(maintenance({ enabled: true, runsError: "store unreadable" }));
  expect(r.tone).toBe("warn");
  expect(r.warning).toContain("The setting still works");
  expect(r.summary).toBe("On · every 3 h");
});

test("maintenance: both locales carry every failure kind and the group's words", () => {
  for (const key of Object.values(MAINTENANCE_FAILURES)) {
    expect(translate("en", key), `en ${key}`).not.toBe(key);
    expect(translate("uk", key), `uk ${key}`).not.toBe(key);
  }
  const uk = reading(maintenance({ enabled: true, lastRun: run() }), "uk");
  expect(uk.summary).toBe("Увімкнено · кожні 3 год");
  expect(uk.rows.find((row) => row.key === "result")?.value).toBe("Змінено задач: 9 · для вас: 3");
  expect(uk.rows.find((row) => row.key === "last")?.value).toMatch(TIME);
});
