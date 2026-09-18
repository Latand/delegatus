import { expect, test } from "bun:test";

import { translate, type MessageKey } from "@/lib/i18n";
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

import { SEAT_TICK_REASON_KEYS, seatTickIntervalWord, seatTickReading } from "./seatTickView";

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
  expect(reading.rows.find((row) => row.label === "Last wake")?.value).toBe("never");
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
  expect(reading.sentence).toBe("Off since 2h ago. No wake is sent; checks still run.");
  expect(reading.rows.find((row) => row.label === "Last wake")?.value).toBe("3h ago · interval");
  expect(reading.rows.find((row) => row.label === "Last delivery")?.value).toBe("landed · 3h ago");
  expect(reading.rows.find((row) => row.label === "Blocker")?.value).toBe("none");
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

test("both locales carry every wake reason", () => {
  for (const key of SEAT_TICK_REASON_KEYS) {
    expect(translate("en", key), `en ${key}`).not.toBe(key);
    expect(translate("uk", key), `uk ${key}`).not.toBe(key);
  }
});
