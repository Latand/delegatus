import { describe, expect, test } from "bun:test";

import {
  B_CONVERSATION_TITLE_REFS, INVENTORY, LEFT_OUT, MENUS_A, MENUS_B, SETTINGS, SIDEBAR_HOMES, SUBAGENTS,
  combinedHomes, firstViewControls, menuHomes, pressesTo, refsOf, type Menu,
} from "./interfaceRedesign.prototype.model";

const ids = Object.keys(INVENTORY);
const family = (letter: string) => ids.filter((id) => id.startsWith(letter));
const carried = (menus: Record<string, Menu>, surfaces: string[]) => new Set(surfaces.flatMap((surface) => refsOf([...menus[surface]!.promoted, ...menus[surface]!.rows])));

describe("interface redesign: no variant loses a function without saying so", () => {
  test("the inventory is the audit's 81 functions", () => {
    expect(family("S").length).toBe(10);
    expect(family("G").length).toBe(14);
    expect(family("B").length).toBe(16);
    expect(family("W").length).toBe(13);
    expect(family("M").length).toBe(20);
    expect(family("O").length).toBe(8);
  });

  test("every rail and rail-menu function has a desktop and a phone home in each sidebar variant", () => {
    for (const id of [...family("S"), ...family("G")]) for (const variant of [1, 2, 3] as const) {
      const home = SIDEBAR_HOMES[id]?.[variant];
      expect(home?.desktop, `${id} in variant ${variant}`).toBeTruthy();
      expect(home?.phone, `${id} in variant ${variant}`).toBeTruthy();
    }
  });

  test("every row names inventory ids that exist", () => {
    const refs = [
      ...Object.values(MENUS_A).flatMap((menu) => refsOf([...menu.promoted, ...menu.rows])),
      ...Object.values(MENUS_B).flatMap((menu) => refsOf([...menu.promoted, ...menu.rows])),
      ...SETTINGS.flatMap((section) => refsOf(section.rows)),
    ];
    for (const ref of refs) expect(INVENTORY[ref], ref).toBeDefined();
  });

  test("direction A carries every menu function, or names why it is left out", () => {
    const have = carried(MENUS_A, ["board", "rail", "card", "phoneBoard", "phoneConversation"]);
    for (const id of [...family("G"), ...family("B"), ...family("M"), "W3", "W4"]) {
      if (LEFT_OUT.A[id]) continue;
      expect(have.has(id), id).toBe(true);
    }
  });

  test("direction B carries every menu function in a menu, the title row or Settings, or names why it is left out", () => {
    const have = new Set([...carried(MENUS_B, ["board", "card", "phoneBoard", "phoneConversation"]), ...SETTINGS.flatMap((section) => refsOf(section.rows)), ...B_CONVERSATION_TITLE_REFS]);
    for (const id of [...family("G"), ...family("B"), ...family("M"), "W3", "W4"]) {
      if (LEFT_OUT.B[id]) continue;
      expect(have.has(id), id).toBe(true);
    }
  });

  test("the home tables are complete and never empty", () => {
    for (const table of [menuHomes("A"), menuHomes("B"), combinedHomes()]) for (const id of ids) {
      expect(table[id]?.desktop, id).toBeTruthy();
      expect(table[id]?.phone, id).toBeTruthy();
      expect(table[id]!.desktop.endsWith(", ") || table[id]!.phone.endsWith(", "), id).toBe(false);
    }
  });

  test("a regrouped menu's first view does not grow with the number of agents or lanes", () => {
    expect(firstViewControls(MENUS_A.phoneConversation!)).toBe(9);
    expect(firstViewControls(MENUS_B.phoneConversation!)).toBe(12);
    expect(firstViewControls(MENUS_A.phoneBoard!)).toBe(13);
    expect(firstViewControls(MENUS_B.phoneBoard!)).toBe(10);
    expect(firstViewControls(MENUS_A.board!)).toBe(5);
    expect(firstViewControls(MENUS_B.board!)).toBe(3);
    expect(firstViewControls(MENUS_A.rail!)).toBe(7);
    expect(SUBAGENTS).toBe(38);
  });

  test("presses to a function are counted from the closed menu", () => {
    expect(pressesTo(MENUS_A.board!, "B1")).toBe(2);
    expect(pressesTo(MENUS_A.board!, "B4")).toBe(3);
    expect(pressesTo(MENUS_A.phoneConversation!, "M12")).toBe(2);
    expect(pressesTo(MENUS_A.phoneConversation!, "M8")).toBe(3);
    expect(pressesTo(MENUS_B.phoneConversation!, "M10")).toBe(2);
    expect(pressesTo(MENUS_B.phoneConversation!, "M5")).toBe(2);
    expect(pressesTo(MENUS_B.phoneConversation!, "M20")).toBe(3);
  });
});
