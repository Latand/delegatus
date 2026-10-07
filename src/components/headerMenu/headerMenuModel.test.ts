import { expect, test } from "bun:test";

import { HEADER_ITEMS, HEADER_LAYOUTS, headerHome, memoryTone, money, monthName, monthResets, type HeaderItem, type HeaderSurface } from "./headerMenuModel";

/* The mix the operator chose (docs/design/header-menu.md): variant 2's
   three icon cells, variant 3's rows below, every entry once. */

const placements = (surface: HeaderSurface): HeaderItem[] => {
  const layout = HEADER_LAYOUTS[surface];
  return [...layout.cells, ...layout.rows.flatMap((row) => (row.kind === "item" ? [row.item] : row.items))];
};
/* Variant 3's presses from the closed menu: its first level is two, Settings and Help are three. */
const VARIANT_3_PRESSES: Record<HeaderItem, number> = {
  activity: 2, team: 2, qr: 2, update: 2, signOut: 2,
  language: 3, push: 3, sound: 3, awake: 3, memory: 3, key: 3, mapping: 3, dictation: 3, linked: 3, relay: 3, ping: 3, guide: 3, walk: 3,
};
/* Where the phone keeps what its menu does not hold: the drawer header and the Team page. */
const PHONE_ELSEWHERE: HeaderItem[] = ["language", "qr", "push", "signOut"];
/* The desktop keeps the device rows in the board's ⋯. */
const DESKTOP_ELSEWHERE: HeaderItem[] = ["sound", "awake"];

for (const surface of ["desktop", "phone"] as const) {
  test(`${surface}: every entry appears once, and nothing reachable today is dropped`, () => {
    const placed = placements(surface);
    expect(new Set(placed).size).toBe(placed.length);
    const elsewhere = surface === "phone" ? PHONE_ELSEWHERE : DESKTOP_ELSEWHERE;
    expect([...placed, ...elsewhere].sort()).toEqual([...HEADER_ITEMS].sort());
  });

  test(`${surface}: no entry takes more presses than variant 3 gives it`, () => {
    for (const item of placements(surface)) expect(headerHome(surface, item)!.presses).toBeLessThanOrEqual(VARIANT_3_PRESSES[item]);
  });

  test(`${surface}: the three icon cells are variant 2's, and variant 3's rows for the same places are gone`, () => {
    expect(HEADER_LAYOUTS[surface].cells).toEqual(["activity", "team", "update"]);
    expect(HEADER_LAYOUTS[surface].rows.filter((row) => row.kind === "item").map((row) => row.kind === "item" && row.item)).not.toContain("activity");
    expect(headerHome(surface, "memory")!.where).toBe("settings");
    expect(headerHome(surface, "key")!.where).toBe("settings");
    expect(headerHome(surface, "ping")!.where).toBe("settings");
    expect(headerHome(surface, "guide")).toEqual({ where: "help", presses: 3 });
  });
}

test("memory's state comes from the reasons the product reports: what a person can lift first, then the switch", () => {
  expect(memoryTone(null)).toBe("unknown");
  expect(memoryTone({ enabled: true, status: "unavailable" })).toBe("unknown");
  expect(memoryTone({ enabled: true })).toBe("unknown");
  expect(memoryTone({ enabled: true, reasons: [] })).toBe("working");
  expect(memoryTone({ enabled: false, reasons: ["projectOff"] })).toBe("off");
  expect(memoryTone({ enabled: false, reasons: ["projectOff", "noKey"] })).toBe("noKey");
  expect(memoryTone({ enabled: true, reasons: ["noKey", "notOwner"] })).toBe("noKey");
  expect(memoryTone({ enabled: true, reasons: ["capped", "notOwner"] })).toBe("capped");
  expect(memoryTone({ enabled: true, reasons: ["notOwner"] })).toBe("notOwner");
});

test("the month is its name, the reset its first day, money two decimals or none", () => {
  expect(monthName("2026-10", "uk")).toBe("жовтень");
  expect(monthName("2026-10", "en")).toBe("October");
  expect(monthResets("2026-10", "uk")).toBe("1 листопада");
  expect(monthResets("2026-12", "en")).toBe("January 1");
  expect(monthName(undefined, "en")).toBe("");
  expect([money(5), money(1.214), money(0.5)]).toEqual(["$5", "$1.21", "$0.50"]);
});
