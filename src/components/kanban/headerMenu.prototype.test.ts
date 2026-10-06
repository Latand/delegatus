import { describe, expect, test } from "bun:test";

import type { MemorySettingView } from "@/lib/memory/viewTypes";

import { HEADER_ITEMS, HEADER_LAYOUTS, HEADER_MEMORY_EVENT, HEADER_VARIANTS, headerFamilySpecs, headerHome, headerName, type HeaderItem } from "./headerMenu.prototype";
import { MEMORY_STATES, memoryFixtureView, memoryTone } from "./headerMemory.prototype";

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

describe("shared memory's home in the header's menu", () => {
  test("every variant names memory apart from the ping and shows its state at the first level", () => {
    for (const variant of HEADER_VARIANTS) {
      expect(headerName(variant, "memory")).not.toEqual(headerName(variant, "settings"));
      const home = headerHome(variant, "memory")!;
      const [rail, phone] = headerFamilySpecs(variant);
      for (const spec of [rail!, phone!]) {
        expect(spec.dress?.memory?.trail).toBeDefined();
        expect(spec.virtual?.memory?.event).toBe(HEADER_MEMORY_EVENT);
        /* At rest the entry carries its state itself; inside a group the group's row carries it. */
        const section = spec.layouts[1].placements.flatMap((placement) => ("section" in placement && placement.section.rows.includes("memory") ? [placement.section] : []))[0];
        if (home.group) expect(section?.trail).toBeDefined(); else expect(section).toBeUndefined();
      }
    }
  });

  test("one state is read from the reasons the product reports, the blocking one first", () => {
    const view = (reasons: MemorySettingView["reasons"], enabled = true) => ({ ...memoryFixtureView("working"), enabled, reasons });
    expect(memoryTone(null)).toBe("unknown");
    expect(memoryTone({ enabled: true, status: "unavailable" })).toBe("unknown");
    expect(memoryTone(view([]))).toBe("working");
    expect(memoryTone(view(["projectOff"], false))).toBe("off");
    expect(memoryTone(view(["projectOff", "noKey"], false))).toBe("noKey");
    expect(memoryTone(view(["capped"]))).toBe("capped");
    expect(memoryTone(view(["noKey", "notOwner"]))).toBe("notOwner");
    for (const state of MEMORY_STATES) expect(memoryTone(memoryFixtureView(state))).toBe(state);
  });
});
