import { describe, expect, test } from "bun:test";

import type { MemorySettingView } from "@/lib/memory/viewTypes";

import { HEADER_ITEMS, HEADER_LAYOUTS, HEADER_VARIANTS, headerFamilySpecs, headerHome, headerName, type HeaderItem } from "./headerMenu.prototype";
import { MEMORY_STATES, memoryFixtureServer, memoryFixtureView, memoryTone, memoryWord, money } from "./headerMemory.prototype";

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

describe("shared memory and the key in the header's menu", () => {
  test("every variant gives memory and the key their own rows, each with its state and its page", () => {
    for (const variant of HEADER_VARIANTS) {
      expect(headerName(variant, "memory").en).toBe("Shared memory");
      expect(headerName(variant, "settings")).not.toEqual(HEADER_ITEMS.settings.today);
      /* The key stands at the level memory does, since two features use it. */
      expect(headerHome(variant, "key")?.group?.id).toBe(headerHome(variant, "memory")?.group?.id);
      const home = headerHome(variant, "memory")!;
      for (const spec of headerFamilySpecs(variant)) {
        for (const row of ["memory", "key"] as const) {
          expect(spec.dress?.[row]?.trail).toBeDefined();
          expect(spec.dress?.[row]?.panel).toBeDefined();
          expect(spec.virtual?.[row]).toBeDefined();
        }
        /* At rest the entry carries its state itself; inside a group the group's row names it too. */
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

  test("the state is a word in both languages, with the month's count and the day the cap resets", () => {
    expect(memoryWord(memoryFixtureView("working"), "en")).toBe("Working · 61 this month");
    expect(memoryWord(memoryFixtureView("working"), "uk")).toBe("Працює · 61 цього місяця");
    expect(memoryWord(memoryFixtureView("off"), "uk")).toBe("Вимкнено");
    expect(memoryWord(memoryFixtureView("noKey"), "en")).toBe("Key needed");
    expect(memoryWord(memoryFixtureView("capped"), "en")).toBe("Cap until November 1");
    expect(memoryWord(memoryFixtureView("capped"), "uk")).toBe("Ліміт до 1 листопада");
    for (const state of MEMORY_STATES) for (const lang of ["en", "uk"] as const) for (const short of [false, true]) expect(memoryWord(memoryFixtureView(state), lang, short)).not.toMatch(/Jev|decision|рішен/i);
  });

  test("money has two decimals, and none on a whole amount", () => {
    expect(money(1.214)).toBe("$1.21");
    expect(money(4.996)).toBe("$5.00");
    expect(money(5)).toBe("$5");
  });

  test("the fixture's endpoints answer a flipped switch and a saved key as the product's would", () => {
    const server = memoryFixtureServer("noKey");
    expect(memoryTone(server("GET", "/api/memory/settings", null) as MemorySettingView)).toBe("noKey");
    expect(server("PUT", "/api/asks-you/key", { key: "k" })).toEqual({ present: true, source: "file" });
    expect(memoryTone(server("GET", "/api/memory/settings", null) as MemorySettingView)).toBe("working");
    expect(memoryTone(server("PUT", "/api/memory/settings", { enabled: false }) as MemorySettingView)).toBe("off");
  });
});
