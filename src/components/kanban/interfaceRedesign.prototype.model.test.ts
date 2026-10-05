import { describe, expect, test } from "bun:test";

import {
  ACTIONS, HOME_KEYS, INVENTORY, MENUS_A, MENUS_B, PROJECT_ONLY_ROWS, REGROUPED, SETTINGS, SIDEBAR_HOMES, SUBAGENTS,
  allRowKeys, combinedHomes, firstViewControls, menuHomes, missingActions, pressesTo, refsOf, type Menu, type Row,
} from "./interfaceRedesign.prototype.model";

const ids = Object.keys(INVENTORY);
const family = (letter: string) => ids.filter((id) => id.startsWith(letter));

/** A copy of a direction's menus with every row carrying `ref` taken out, however deep. */
const without = (menus: Record<string, Menu>, ref: string): Record<string, Menu> => {
  const strip = (rows: Row[]): Row[] => rows.filter((entry) => !entry.refs.includes(ref)).map((entry) => (entry.into ? { ...entry, into: strip(entry.into) } : entry));
  return Object.fromEntries(Object.entries(menus).map(([name, menu]) => [name, { ...menu, promoted: strip(menu.promoted), rows: strip(menu.rows) }]));
};

describe("interface redesign: no variant loses a function without saying so", () => {
  test("the inventory is the audit's 88 functions, and its composite entries are spelled out as actions", () => {
    expect(family("S").length).toBe(10);
    expect(family("G").length).toBe(14);
    expect(family("B").length).toBe(16);
    expect(family("W").length).toBe(13);
    expect(family("M").length).toBe(20);
    expect(family("O").length).toBe(8);
    expect(family("V").length).toBe(7);
    expect(ids.length).toBe(88);
    expect(Object.keys(ACTIONS.V2!)).toEqual(["sound", "levels"]);
    expect(Object.keys(ACTIONS.V6!)).toEqual(["guide", "walk", "mapping", "dictation"]);
    expect(Object.keys(ACTIONS.W3!)).toEqual(["status", "hold", "priority", "colour", "icon", "collapse", "rename", "description", "links", "hide", "lanes"]);
    expect(Object.keys(ACTIONS.W4!).length).toBe(7);
    expect(Object.keys(ACTIONS.W8!).length).toBe(7);
  });

  test("every rail and rail-menu function has a desktop and a phone home in each sidebar variant", () => {
    for (const id of [...family("S"), ...family("G")]) for (const variant of [1, 2, 3] as const) {
      const home = SIDEBAR_HOMES[id]?.[variant];
      expect(home?.desktop, `${id} in variant ${variant}`).toBeTruthy();
      expect(home?.phone, `${id} in variant ${variant}`).toBeTruthy();
    }
  });

  test("every row names an action that exists, and never a composite entry as a whole", () => {
    const refs = [
      ...Object.values(MENUS_A).flatMap((menu) => refsOf([...menu.promoted, ...menu.rows])),
      ...Object.values(MENUS_B).flatMap((menu) => refsOf([...menu.promoted, ...menu.rows])),
      ...SETTINGS.flatMap((section) => refsOf(section.rows)),
    ];
    for (const ref of refs) expect(HOME_KEYS.includes(ref), ref).toBe(true);
  });

  test("each direction carries every action of the menus it regroups, or names why it is left out", () => {
    expect(missingActions("A")).toEqual([]);
    expect(missingActions("B")).toEqual([]);
  });

  test("taking out any one named action turns the check red", () => {
    for (const direction of ["A", "B"] as const) {
      const menus = direction === "A" ? MENUS_A : MENUS_B;
      const carried = new Set(REGROUPED[direction].flatMap((surface) => refsOf([...menus[surface]!.promoted, ...menus[surface]!.rows])));
      for (const ref of carried) {
        const settings = SETTINGS.map((section) => ({ ...section, rows: section.rows.filter((entry) => !entry.refs.includes(ref)) }));
        expect(missingActions(direction, without(menus, ref), settings), `${direction} without ${ref}`).toContain(ref);
      }
    }
    /* The one the first draft lost: direction B's card had no place for the hold reason. */
    expect(missingActions("B", without(MENUS_B, "W3.hold"))).toEqual(["W3.hold"]);
  });

  test("the phone Overview has its own menu: every entry it has today, and nothing that acts on one project", () => {
    const today = HOME_KEYS.filter((key) => key.startsWith("V"));
    expect(today.length).toBe(11);
    for (const [direction, menus] of [["A", MENUS_A], ["B", MENUS_B]] as const) {
      const menu = menus.phoneOverview!;
      const rows = [...menu.promoted, ...menu.rows];
      for (const key of allRowKeys(rows)) expect(PROJECT_ONLY_ROWS.includes(key), `${direction}: ${key}`).toBe(false);
      /* Direction A draws every entry in the menu; B keeps the hidden work there and sends the rest to the Delegatus scope of Settings. */
      const inSettings = SETTINGS.filter((section) => section.scope === "delegatus").flatMap((section) => refsOf(section.rows));
      const reached = direction === "A" ? refsOf(rows) : [...refsOf(rows), ...inSettings];
      for (const key of today) expect(reached.includes(key), `${direction}: ${key}`).toBe(true);
      expect(rows.some((entry) => entry.face), `${direction}: a row that leads to a project's menu`).toBe(false);
    }
    /* A project's own menu carries none of the Overview's ids, so the check above cannot pass through it. */
    for (const surface of ["phoneBoard", "rail", "board"]) for (const ref of refsOf([...(MENUS_A[surface]?.promoted ?? []), ...(MENUS_A[surface]?.rows ?? [])])) expect(ref.startsWith("V"), `${surface}: ${ref}`).toBe(false);
    expect(SETTINGS.filter((section) => section.scope === "project").flatMap((section) => refsOf(section.rows)).some((ref) => ref.startsWith("V"))).toBe(false);
    expect(menuHomes("A")["V6.walk"]!.phone).toBe('Overview menu, row "Delegatus", one level in, "Interface walkthrough"');
    expect(menuHomes("B")["V2.sound"]!.phone).toBe('Overview menu, "Settings", then Settings, Delegatus, Notifications');
    expect(menuHomes("B").V1!.phone).toBe('Overview menu, row "Hidden work"');
    expect(combinedHomes().V7!.phone).toBe('Overview menu, "Settings", then Settings, Delegatus, Connections and updates');
  });

  test("the home tables are complete, never empty, and read from the rows the menus draw", () => {
    for (const table of [menuHomes("A"), menuHomes("B"), combinedHomes()]) for (const key of HOME_KEYS) {
      expect(table[key]?.desktop, key).toBeTruthy();
      expect(table[key]?.phone, key).toBeTruthy();
      expect(table[key]!.desktop.endsWith(", ") || table[key]!.phone.endsWith(", ") || /, ""|, then $/.test(`${table[key]!.desktop}|${table[key]!.phone}`), key).toBe(false);
    }
    expect(menuHomes("B")["W3.hold"]!.desktop).toBe('card menu, row "Hold reason"');
    expect(menuHomes("A")["W3.hold"]!.desktop).toBe('card menu, row "Details and links", one level in, "Hold reason"');
    expect(menuHomes("B")["W8.priority"]!.phone).toBe('task menu, row "Priority"');
    expect(menuHomes("A")["W8.rename"]!.phone).toBe('task menu, promoted "Rename"');
    /* Variant 7 has no rail, so nothing in it may be reached through the rail. */
    for (const home of Object.values(combinedHomes())) expect(`${home.desktop} ${home.phone}`).not.toMatch(/rail's "⋯"|rail menu|gear in the rail/);
  });

  test("a regrouped menu's first view does not grow with the number of agents or lanes", () => {
    expect(firstViewControls(MENUS_A.phoneConversation!)).toBe(9);
    expect(firstViewControls(MENUS_B.phoneConversation!)).toBe(12);
    expect(firstViewControls(MENUS_A.phoneBoard!)).toBe(13);
    expect(firstViewControls(MENUS_B.phoneBoard!)).toBe(10);
    expect(firstViewControls(MENUS_A.phoneOverview!)).toBe(5);
    expect(firstViewControls(MENUS_B.phoneOverview!)).toBe(2);
    expect(firstViewControls(MENUS_A.phoneTask!)).toBe(9);
    expect(firstViewControls(MENUS_B.phoneTask!)).toBe(9);
    expect(firstViewControls(MENUS_A.board!)).toBe(5);
    expect(firstViewControls(MENUS_B.board!)).toBe(3);
    expect(firstViewControls(MENUS_A.card!)).toBe(11);
    expect(firstViewControls(MENUS_B.card!)).toBe(15);
    expect(firstViewControls(MENUS_A.rail!)).toBe(7);
    expect(SUBAGENTS).toBe(38);
  });

  test("presses to a function are counted from the closed menu", () => {
    expect(pressesTo(MENUS_A.board!, "B1")).toBe(2);
    expect(pressesTo(MENUS_A.board!, "B4")).toBe(3);
    expect(pressesTo(MENUS_A.card!, "W3.hold")).toBe(3);
    expect(pressesTo(MENUS_B.card!, "W3.hold")).toBe(2);
    expect(pressesTo(MENUS_B.card!, "W3.colour")).toBe(3);
    expect(pressesTo(MENUS_A.phoneTask!, "W8.colour")).toBe(3);
    expect(pressesTo(MENUS_B.phoneTask!, "W8.priority")).toBe(2);
    expect(pressesTo(MENUS_A.phoneConversation!, "M12")).toBe(2);
    expect(pressesTo(MENUS_A.phoneConversation!, "M8")).toBe(3);
    expect(pressesTo(MENUS_B.phoneConversation!, "M10")).toBe(2);
    expect(pressesTo(MENUS_B.phoneConversation!, "M5")).toBe(2);
    expect(pressesTo(MENUS_B.phoneConversation!, "M20")).toBe(3);
  });
});
