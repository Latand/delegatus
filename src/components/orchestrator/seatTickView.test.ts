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
      nextEligibleAt: null, nextRunAt: null, waitingOn: "off", pauseReason: null, runsError: null,
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
  /* The status block's wake line: the state once, then the last and the next
     wake — no title, sentence, last-check row or "Blocker: none". */
  expect(reading.status).toEqual({
    headline: "Wakes every 60 min · last check 3m ago",
    detail: "Last wake never · next at the next check",
  });
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
  expect(reading.status.headline).toBe("Wakes every 60 min · stale: no check recorded");
  /* Stale is explained once, in the detail line, with the cadence it missed. */
  expect(reading.status.detail).toBe("Checks run every 5 min, so the tick itself may be down.");
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
  /* The blocker is named once: the headline keeps the plain last check and the
     detail line carries the blocker. */
  expect(outstanding.status.headline).toBe("Wakes every 60 min · last check 3m ago");
  expect(outstanding.status.detail).toBe("Next wake held: unresolved wake since 2h ago (dispatch refused)");

  const guard = read(answer({ state: state({ retryGuard: [{ kind: "stalled", wakes: 2 }] }) }));
  expect(guard.blocker).toBe("retry guard: stalled lane (2 wakes changed nothing)");

  const gap = read(answer({ state: state({ sourceGap: { source: "pull-requests", gap: "api-unreachable", since: "2026-09-15T12:00:00.000Z" } }) }));
  expect(gap.blocker).toBe("source gap: pull requests since 3d ago (api-unreachable)");

  const migration = read(answer({ state: state({ accountingGap: "torn" }) }));
  expect(migration.blocker).toContain("accounting import is blocked");
});

test("paused: the face says off, the dot is muted, and the status says so without a second sentence", () => {
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
  expect(reading.status).toEqual({ headline: "Wakes off since 2h ago · last check 3m ago", detail: null });
  /* The last delivery is a Details fact now. */
  expect(reading.lastDelivery).toBe("landed · 3h ago");
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
  expect(stopped.status.detail).toBe("Checks run every 5 min, so the tick itself may be down.");

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
  expect(reading.status).toEqual({
    headline: "Wakes every 60 min · state unknown",
    detail: "Actual state unknown: the tick has not recorded this project.",
  });
  expect(reading.lastDelivery).toBe("unknown");
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
  expect(failed.status).toEqual({ headline: "Wakes could not be read", detail: null });
  expect(read(null).line).toBe("Tick: reading…");
});

/* #1771: a tick whose every wake is refused reads as enabled, checking and
   recently delivering. The last DELIVERED wake beside when the next one is due
   is what makes that visible on the board instead of by asking the seat. */
test("the next wake is read beside the last delivered one, and never invented (#1771)", () => {
  const detail = (value: SeatTickSettingsAnswer) => read(value).status.detail;
  const due = answer({ state: state({ lastWakeAt: "2026-09-18T11:30:00.000Z", lastWakeReasons: ["interval"] }) });
  /* An hour after the last landing, on the hour's cadence. */
  expect(detail(due)).toBe("Last wake 30m ago · interval · next in 30 min");

  /* The interval already spent: the next check is the answer, never an instant
     in the past dressed up as a schedule. */
  expect(detail(answer({ state: state({ lastWakeAt: "2026-09-18T09:00:00.000Z" }) }))).toBe("Last wake 3h ago · next at the next check");
  /* A row that has never landed a wake is due at the next check too. */
  expect(detail(answer({ state: state() }))).toBe("Last wake never · next at the next check");

  /* A fence is not a schedule: while something holds the next wake back, the
     line says so and names what, once. */
  const fenced = answer({
    state: state({ lastWakeAt: "2026-09-18T11:30:00.000Z", outstandingWake: { preparedAt: "2026-09-18T10:00:00.000Z", dispatch: "refused" } }),
  });
  expect(detail(fenced)).toBe("Next wake held: unresolved wake since 2h ago (dispatch refused)");

  /* Off means nothing is due, and a project with no row says the word. */
  const off = answer({
    effective: { ...answer().effective, enabled: false },
    state: state({ lastWakeAt: "2026-09-18T11:30:00.000Z" }),
  });
  expect(detail(off)).toBeNull();
  expect(detail(answer())).toBe("Actual state unknown: the tick has not recorded this project.");

  /* A long cadence collapses into hours rather than counting minutes. */
  const daily = answer({
    effective: { ...answer().effective, wakeIntervalMinutes: 1440 },
    state: state({ lastWakeAt: "2026-09-18T09:00:00.000Z" }),
  });
  expect(detail(daily)).toBe("Last wake 3h ago · next in 21 h");
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

test("maintenance: off says so on its status line, with no card and no clause about a next run", () => {
  const r = reading(maintenance());
  expect(r.state).toBe("off");
  expect(r.tone).toBe("muted");
  expect(r.status).toEqual({ headline: "Maintenance off", segments: [] });
  expect(r.last).toEqual({ text: "never", links: [] });
  expect(r.next).toBe("none while maintenance is off");
  expect(r.cardTaskId).toBeNull();
  expect(r.warning).toBeNull();
});

test("maintenance: on and never run names the first run at the next check", () => {
  const r = reading(maintenance({ enabled: true, intervalHours: 6, waitingOn: null, nextRunAt: "2026-09-18T12:05:00.000Z" }));
  expect(r.state).toBe("on");
  expect(r.tone).toBe("ok");
  expect(r.status.headline).toBe("Maintenance every 6 h · never run");
  expect(r.status.segments).toEqual([{ kind: "text", text: expect.stringMatching(/^first run ≈ \d{2}:\d{2}$/) }]);
  expect(r.next).toMatch(/^first run at the next check, about \d{2}:\d{2}$/);
});

test("maintenance: a live run reads as running, links its card and defers the next run", () => {
  const r = reading(maintenance({ enabled: true, waitingOn: "live-run", live: run({ state: "running", endedAt: null, taskId: "live-card" }), lastRun: run() }));
  expect(r.state).toBe("running");
  expect(r.status.headline).toMatch(/^Maintenance running since \d{2}:\d{2}$/);
  expect(r.status.segments).toEqual([]);
  expect(r.cardTaskId).toBe("live-card");
  expect(r.next).toBe("after the current run ends");
});

test("maintenance: a succeeded run shows time, count, the need-you link to its card and the next run", () => {
  const r = reading(maintenance({ enabled: true, waitingOn: "interval", lastRun: run(), nextRunAt: "2026-09-18T12:10:00.000Z" }));
  expect(r.tone).toBe("ok");
  expect(r.status.headline).toMatch(/^Maintenance every 3 h · done \d{2}:\d{2}$/);
  expect(r.status.segments).toEqual([
    { kind: "text", text: "9 changed" },
    { kind: "card", text: "3 need you", taskId: "task-1" },
    { kind: "text", text: expect.stringMatching(/^next ≈ \d{2}:\d{2}$/) },
  ]);
  expect(r.last.text).toMatch(/^Done \d{2}:\d{2} · 9 changed$/);
  expect(r.last.links).toEqual([{ kind: "card", text: "3 need you", taskId: "task-1" }]);
  expect(r.next).toMatch(/^about \d{2}:\d{2}$/);
  expect(r.cardTaskId).toBe("task-1");
  /* One needs you, none needs you: the count is a plural and the link goes. */
  expect(reading(maintenance({ enabled: true, lastRun: run({ attentionCount: 1 }) })).status.segments[1]).toMatchObject({ kind: "card", text: "1 needs you" });
  const quiet = reading(maintenance({ enabled: true, lastRun: run({ attentionCount: 0 }) }));
  expect(quiet.last.links).toEqual([]);
  expect(quiet.status.segments).toContainEqual({ kind: "text", text: "nothing needs you" });
});

test("maintenance: a failed run is a warning with its reason by kind, never the engine's detail", () => {
  const r = reading(maintenance({
    enabled: true,
    lastRun: run({ state: "failed", failure: { kind: "no-account", detail: "/srv/engine/state.json refused" } }),
    nextRunAt: "2026-09-18T12:10:00.000Z",
  }));
  expect(r.tone).toBe("warn");
  expect(r.status.headline).toMatch(/^Maintenance every 3 h · failed \d{2}:\d{2}$/);
  expect(r.status.segments).toEqual([
    { kind: "text", text: "no Codex account is available for this project" },
    { kind: "accounts", text: "Accounts" },
    { kind: "text", text: expect.stringMatching(/^retry ≈ \d{2}:\d{2}$/) },
  ]);
  expect(r.last.text).toMatch(/^Failed \d{2}:\d{2} · no Codex account is available for this project$/);
  expect(r.last.links).toEqual([{ kind: "accounts", text: "Accounts" }]);
  expect(JSON.stringify(r)).not.toContain("/srv/engine");
  /* Only a missing account has the Accounts remedy. */
  const other = reading(maintenance({ enabled: true, lastRun: run({ state: "failed", failure: { kind: "host-died", detail: "" } }) }));
  expect(other.last.links).toEqual([]);
  /* A kind this build does not know still reads as a failure, not as blank. */
  const odd = reading(maintenance({ enabled: true, lastRun: run({ state: "failed", failure: { kind: "from-the-future" as never, detail: "" } }) }));
  expect(odd.last.text).toContain("the run failed for a reason this panel does not know");
});

test("maintenance: a hold says why the next run waits", () => {
  expect(reading(maintenance({ enabled: true, waitingOn: "deployment", nextRunAt: "2026-09-18T12:05:00.000Z" })).next).toBe("held while a deployment runs");
  expect(reading(maintenance({ enabled: true, waitingOn: "no-seat" })).next).toBe("held: the project has no seat");
  /* No instant and nothing holding it: the checks themselves are off. */
  expect(reading(maintenance({ enabled: true, waitingOn: null, nextRunAt: null })).next).toBe("unknown: tick checks are off");
});

test("maintenance: wakes off pauses it, says so on both lines, and keeps the last result", () => {
  const r = reading(maintenance({ enabled: true, waitingOn: "wakes-off", pauseReason: "paused while wakes are off", lastRun: run(), nextRunAt: null }));
  expect(r.tone).toBe("muted");
  expect(r.next).toBe("paused while wakes are off");
  expect(r.status.segments).toContainEqual({ kind: "text", text: "paused while wakes are off" });
  expect(r.last.text).toMatch(/^Done \d{2}:\d{2} · 9 changed$/);
  /* A run that was already live carries the pause beside it. */
  const live = reading(maintenance({ enabled: true, waitingOn: "live-run", pauseReason: "paused while wakes are off", live: run({ state: "running", endedAt: null }) }));
  expect(live.status.segments).toEqual([{ kind: "text", text: "paused while wakes are off" }]);
});

test("maintenance: an unreadable run store warns and the setting still reads", () => {
  const r = reading(maintenance({ enabled: true, runsError: "store unreadable" }));
  expect(r.tone).toBe("warn");
  expect(r.warning).toContain("The setting still works");
  expect(r.status.headline).toBe("Maintenance every 3 h · never run");
});

test("maintenance: both locales carry every failure kind and the status words", () => {
  for (const key of Object.values(MAINTENANCE_FAILURES)) {
    expect(translate("en", key), `en ${key}`).not.toBe(key);
    expect(translate("uk", key), `uk ${key}`).not.toBe(key);
  }
  const uk = reading(maintenance({ enabled: true, lastRun: run() }), "uk");
  expect(uk.status.headline).toMatch(/^Обслуговування кожні 3 год · готово \d{2}:\d{2}$/);
  expect(uk.status.segments[0]).toEqual({ kind: "text", text: "змінено 9" });
  expect(uk.status.segments[1]).toEqual({ kind: "card", text: "3 чекають на вас", taskId: "task-1" });
  expect(reading(maintenance({ enabled: true, lastRun: run({ attentionCount: 1 }) }), "uk").status.segments[1]).toMatchObject({ text: "1 чекає на вас" });
  expect(uk.last.text).toMatch(/^Готово \d{2}:\d{2} · змінено 9$/);
  const failed = reading(maintenance({ enabled: true, lastRun: run({ state: "failed", failure: { kind: "no-account", detail: "" } }) }), "uk");
  expect(failed.status.segments).toContainEqual({ kind: "accounts", text: "Акаунти" });
  expect(failed.last.text).toMatch(/^Не вдалося \d{2}:\d{2} · /);
});
