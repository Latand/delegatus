import { expect, test } from "bun:test";
import { maintenanceWindowOpen, nextMaintenanceWindowTime, normalizeMaintenanceWindow, type MaintenanceWindow } from "./window";
const window: MaintenanceWindow = { timeZone: "Europe/Paris", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };
const at = Date.parse;
test("named zone, weekday and inclusive start/exclusive end are independent of process zone", () => {
  expect(maintenanceWindowOpen(window, at("2026-10-23T07:00:00Z"))).toBe(true);
  expect(maintenanceWindowOpen(window, at("2026-10-23T15:00:00Z"))).toBe(false);
  expect(maintenanceWindowOpen(window, at("2026-10-24T10:00:00Z"))).toBe(false);
  expect(nextMaintenanceWindowTime(window, at("2026-10-23T15:00:00Z"))).toBe(at("2026-10-26T08:00:00Z"));
  expect(maintenanceWindowOpen(null, at("2026-10-24T10:00:00Z"))).toBe(true);
});
test("DST missing hours skip and repeated hours remain eligible", () => {
  const sunday = { ...window, weekdays: [7], startHour: 2, endHour: 3 };
  expect(nextMaintenanceWindowTime(sunday, at("2026-03-29T00:00:00Z"))).toBe(at("2026-04-05T00:00:00Z"));
  expect(maintenanceWindowOpen(sunday, at("2026-10-25T00:30:00Z"))).toBe(true);
  expect(maintenanceWindowOpen(sunday, at("2026-10-25T01:30:00Z"))).toBe(true);
  expect(nextMaintenanceWindowTime(sunday, at("2026-03-22T02:00:00Z"))).toBe(at("2026-04-05T00:00:00Z"));
  expect(nextMaintenanceWindowTime(sunday, at("2026-10-25T00:59:59.999Z"))).toBe(at("2026-10-25T00:59:59.999Z"));
  expect(nextMaintenanceWindowTime(sunday, at("2026-10-25T02:00:00Z"))).toBe(at("2026-11-01T01:00:00Z"));
});
test("fractional offsets and a half-hour DST jump use local hour boundaries", () => {
  const nepal = { ...window, timeZone: "Asia/Kathmandu", weekdays: [1], startHour: 9, endHour: 10 };
  expect(nextMaintenanceWindowTime(nepal, at("2026-10-26T03:14:59Z"))).toBe(at("2026-10-26T03:15:00Z"));
  const island = { ...window, timeZone: "Australia/Lord_Howe", weekdays: [7], startHour: 2, endHour: 3 };
  expect(nextMaintenanceWindowTime(island, at("2026-10-03T15:00:00Z"))).toBe(at("2026-10-03T15:30:00Z"));
  expect(maintenanceWindowOpen(island, at("2026-10-03T16:00:00Z"))).toBe(false);
});
for (const timeZone of ["Africa/Casablanca", "Africa/El_Aaiun"]) {
  test(`${timeZone} follows the IANA 2026c return to permanent UTC`, () => {
    const sunday = { ...window, timeZone, weekdays: [7], startHour: 2, endHour: 3 };
    expect(maintenanceWindowOpen(sunday, at("2026-10-25T01:30:00Z"))).toBe(false);
    expect(maintenanceWindowOpen(sunday, at("2026-10-25T02:30:00Z"))).toBe(true);
    expect(maintenanceWindowOpen(sunday, at("2026-10-25T03:00:00Z"))).toBe(false);
    expect(nextMaintenanceWindowTime(sunday, at("2026-10-25T00:00:00Z"))).toBe(at("2026-10-25T02:00:00Z"));
    // Before the September rule change, the same hour still used UTC+01.
    expect(maintenanceWindowOpen(sunday, at("2026-09-13T01:30:00Z"))).toBe(true);
    expect(maintenanceWindowOpen(sunday, at("2026-09-13T02:30:00Z"))).toBe(false);
    expect(nextMaintenanceWindowTime(sunday, at("2026-09-13T00:00:00Z"))).toBe(at("2026-09-13T01:00:00Z"));
  });
}
for (const [timeZone, opening] of [
  ["America/Vancouver", "2026-11-01T09:00:00Z"],
  ["America/Edmonton", "2026-11-01T08:00:00Z"],
  ["America/Inuvik", "2026-11-01T08:00:00Z"],
  ["America/Winnipeg", "2026-11-01T07:00:00Z"],
] as const) {
  test(`${timeZone} follows the 2026 permanent-offset rules`, () => {
    const sunday = { ...window, timeZone, weekdays: [7], startHour: 2, endHour: 3 };
    expect(nextMaintenanceWindowTime(sunday, at("2026-11-01T00:00:00Z"))).toBe(at(opening));
    expect(maintenanceWindowOpen(sunday, at(opening) - 1)).toBe(false);
    expect(maintenanceWindowOpen(sunday, at(opening))).toBe(true);
    expect(maintenanceWindowOpen(sunday, at(opening) + 30 * 60_000)).toBe(true);
    expect(maintenanceWindowOpen(sunday, at(opening) + 60 * 60_000)).toBe(false);
  });
}
test("invalid zones, empty days, fractional and overnight hours are refused", () => {
  for (const patch of [{ timeZone: "Invalid/Zone" }, { timeZone: "+02:00" }, { timeZone: "toString" }, { timeZone: "constructor" }, { timeZone: "__proto__" }, { timeZone: "Africa_Casablanca" }, { weekdays: [] }, { weekdays: [0] }, { weekdays: [1.5] }, { startHour: 9.5 }, { endHour: 9 }, { endHour: 25 }]) {
    expect(normalizeMaintenanceWindow({ ...window, ...patch })).toBeNull();
  }
  expect(normalizeMaintenanceWindow({ ...window, weekdays: [5, 1, 1] })?.weekdays).toEqual([1, 5]);
});

test("published zone aliases and case-insensitive names retain their rules", () => {
  const now = at("2026-10-25T02:30:00Z");
  for (const timeZone of ["Africa/Casablanca", "africa/casablanca", "UTC", "Etc/UTC"]) {
    const normalized = normalizeMaintenanceWindow({ ...window, timeZone, weekdays: [7], startHour: 2, endHour: 3 });
    expect(normalized).not.toBeNull();
    expect(maintenanceWindowOpen(normalized!, now)).toBe(true);
  }
  const alias = { ...window, timeZone: "US/Eastern", weekdays: [6], startHour: 22, endHour: 23 };
  expect(normalizeMaintenanceWindow(alias)).not.toBeNull();
  expect(maintenanceWindowOpen(alias, now)).toBe(true);
});

test("direct evaluation refuses an unknown zone without falling back to the process zone", () => {
  for (const timeZone of ["Invalid/Zone", "+02:00", "", "toString", "constructor", "__proto__"]) {
    const invalid = { ...window, timeZone };
    expect(() => maintenanceWindowOpen(invalid, at("2026-10-25T02:30:00Z"))).toThrow(RangeError);
    expect(() => nextMaintenanceWindowTime(invalid, at("2026-10-25T00:00:00Z"))).toThrow(RangeError);
  }
});

test("midnight uses hour zero and the zone's weekday across UTC dates", () => {
  const monday = { ...window, timeZone: "Asia/Tokyo", weekdays: [1], startHour: 0, endHour: 1 };
  expect(maintenanceWindowOpen(monday, at("2026-10-25T14:59:59.999Z"))).toBe(false);
  expect(maintenanceWindowOpen(monday, at("2026-10-25T15:00:00Z"))).toBe(true);
  expect(maintenanceWindowOpen(monday, at("2026-10-25T16:00:00Z"))).toBe(false);
  const sunday = { ...window, timeZone: "America/New_York", weekdays: [7], startHour: 23, endHour: 24 };
  expect(maintenanceWindowOpen(sunday, at("2026-10-26T03:59:59.999Z"))).toBe(true);
  expect(maintenanceWindowOpen(sunday, at("2026-10-26T04:00:00Z"))).toBe(false);
});

test("Morocco's permanent UTC transition preserves the repeated hour and earlier history", () => {
  for (const timeZone of ["Africa/Casablanca", "africa/casablanca", "Africa/El_Aaiun"]) {
    const sunday = { ...window, timeZone, weekdays: [7], startHour: 1, endHour: 2 };
    expect(maintenanceWindowOpen(sunday, at("2026-09-20T00:00:00Z"))).toBe(true);
    expect(maintenanceWindowOpen(sunday, at("2026-09-20T00:59:59.999Z"))).toBe(true);
    expect(maintenanceWindowOpen(sunday, at("2026-09-20T01:00:00Z"))).toBe(true);
    expect(maintenanceWindowOpen(sunday, at("2026-09-20T02:00:00Z"))).toBe(false);
  }
});

test("Canadian aliases keep permanent offsets through the following winter", () => {
  for (const [timeZone, hour] of [["Canada/Pacific", 19], ["canada/mountain", 20], ["America/Yellowknife", 20], ["Canada/Central", 21], ["America/Rainy_River", 21]] as const) {
    const saturday = { ...window, timeZone, weekdays: [6], startHour: hour, endHour: hour + 1 };
    expect(normalizeMaintenanceWindow(saturday)).not.toBeNull();
    expect(maintenanceWindowOpen(saturday, at("2027-01-03T02:00:00Z"))).toBe(true);
    expect(maintenanceWindowOpen(saturday, at("2027-01-03T03:00:00Z"))).toBe(false);
  }
});
