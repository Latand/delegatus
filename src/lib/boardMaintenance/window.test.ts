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
test("invalid zones, empty days, fractional and overnight hours are refused", () => {
  for (const patch of [{ timeZone: "Invalid/Zone" }, { timeZone: "+02:00" }, { weekdays: [] }, { weekdays: [0] }, { weekdays: [1.5] }, { startHour: 9.5 }, { endHour: 9 }, { endHour: 25 }]) {
    expect(normalizeMaintenanceWindow({ ...window, ...patch })).toBeNull();
  }
  expect(normalizeMaintenanceWindow({ ...window, weekdays: [5, 1, 1] })?.weekdays).toEqual([1, 5]);
});
