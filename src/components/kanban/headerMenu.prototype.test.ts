import { describe, expect, test } from "bun:test";

import { HEADER_ITEMS, HEADER_LAYOUTS, HEADER_VARIANTS, headerFamilySpecs, headerHome, headerName, type HeaderItem } from "./headerMenu.prototype";

const ITEMS = Object.keys(HEADER_ITEMS) as HeaderItem[];

describe("the header's menu, three groupings (docs/design/compact-card-menu.md)", () => {
  test("every entry of today's menu has exactly one home in every variant", () => {
    for (const variant of HEADER_VARIANTS) {
      const placed = HEADER_LAYOUTS[variant].slots.flatMap((slot) => ("group" in slot ? slot.group.items : slot.items));
      expect([...placed].sort()).toEqual([...ITEMS].sort());
      for (const item of ITEMS) expect(headerHome(variant, item)).not.toBeNull();
    }
  });

  test("the desktop menu and the phone's board menu list every row the product draws for an entry", () => {
    for (const variant of HEADER_VARIANTS) {
      const [rail, phone] = headerFamilySpecs(variant);
      const keys = (spec: typeof rail) => spec!.layouts[1].placements.flatMap((placement) => ("section" in placement ? placement.section.rows : placement.rows));
      for (const item of ITEMS) {
        const entry = HEADER_ITEMS[item];
        if (entry.rail) expect(keys(rail)).toContain(entry.rail);
        if (entry.phone) expect(keys(phone)).toContain(entry.phone);
      }
    }
  });

  test("the entry called Settings is renamed in every variant, and every new name exists in both languages", () => {
    for (const variant of HEADER_VARIANTS) {
      expect(headerName(variant, "settings")).not.toEqual(HEADER_ITEMS.settings.today);
      for (const name of Object.values(HEADER_LAYOUTS[variant].names)) {
        expect(name.en.trim()).not.toBe("");
        expect(name.uk.trim()).not.toBe("");
      }
    }
  });

  test("no group is called Settings unless it holds the switches of the browser and of the installation", () => {
    for (const variant of HEADER_VARIANTS) for (const slot of HEADER_LAYOUTS[variant].slots) {
      if (!("group" in slot) || slot.group.title.en !== "Settings") continue;
      for (const item of ["language", "push", "mapping", "dictation", "linked", "relay", "settings"] as const) expect(slot.group.items).toContain(item);
      for (const item of ["activity", "team", "guide", "walk", "update", "signOut"] as const) expect(slot.group.items).not.toContain(item);
    }
  });

  test("the three variants differ in grouping and in naming", () => {
    const shape = (variant: (typeof HEADER_VARIANTS)[number]) => JSON.stringify(HEADER_LAYOUTS[variant].slots.map((slot) => ("group" in slot ? [slot.group.title.en, slot.group.items] : slot.items)));
    const names = (variant: (typeof HEADER_VARIANTS)[number]) => JSON.stringify(HEADER_LAYOUTS[variant].names);
    expect(new Set(HEADER_VARIANTS.map(shape)).size).toBe(3);
    expect(new Set(HEADER_VARIANTS.map(names)).size).toBe(3);
  });
});
