import { describe, expect, test } from "bun:test";

import { compactLayout, layoutActions, layoutStates, MENU_GAP, menuPlacement, MORE_LANES, pagedLanes, pageSizes, sectionAt, type MenuAction, type MenuWords } from "./compactMenuModel";
import type { KanbanMenuItem } from "./kanbanMenus";

const WORDS: MenuWords = { appearance: "Appearance", more: "More", move: "Move to", priority: "Priority", pipelines: "Pipelines" };
const act = (id: string, extra: Partial<MenuAction> = {}): KanbanMenuItem => ({ type: "item", id, label: id, onSelect: () => {}, ...extra });
const radio = (id: string, checked = false): KanbanMenuItem => ({ type: "radio", id, label: id, checked, status: id.startsWith("status:") ? (id.slice(7) as "inbox") : undefined, onSelect: () => {} });

/** The card's ⋯ as the board builds it, for a card in `status` holding `lanes` pipelines. */
function cardItems(status: string, lanes: number): KanbanMenuItem[] {
  return [
    { type: "head", label: "Move to" },
    ...["inbox", "assigned", "blocked", "done"].map((name) => radio(`status:${name}`, name === status)),
    act("hold"),
    { type: "sep" }, { type: "head", label: "Priority" },
    ...["high", "normal", "low"].map((name) => radio(`priority:${name}`, name === "normal")),
    { type: "sep" }, { type: "head", label: "Colour" },
    { type: "swatches", id: "colour", label: "Colour", value: null, names: (color) => color ?? "none", hex: {} as never, onPick: () => {} },
    { type: "sep" },
    act("icon"), act("collapse"), act("rename"), act("describe"), act("links"),
    ...Array.from({ length: lanes }, (_, lane): KanbanMenuItem[] => [
      { type: "sep" }, { type: "head", label: `Lane ${lane}`, group: `lane:${lane}`, note: "Running" },
      ...["expand", "attach", "pause", "retry", "skip"].map((name): KanbanMenuItem => ({ type: "item", label: `${name} ${lane}`, group: `lane:${lane}`, onSelect: () => {} })),
      { type: "sep", group: `lane:${lane}` },
      { type: "item", label: `close ${lane}`, group: `lane:${lane}`, onSelect: () => {} },
    ]).flat(),
    { type: "sep" },
    act("hide"),
  ];
}

const labels = (items: readonly KanbanMenuItem[]) => items.flatMap((item) => (item.type === "sep" || item.type === "head" ? [] : [item.label]));

describe("compact menu layouts", () => {
  test("the card's menu keeps every entry the board builds", () => {
    for (const [status, lanes] of [["assigned", 0], ["blocked", 1], ["inbox", 3]] as const) {
      const items = cardItems(status, lanes);
      const layout = compactLayout("card", items, WORDS)!;
      const kept = labels(layoutActions(layout) as KanbanMenuItem[]);
      expect(labels(items).filter((label) => !kept.includes(label))).toEqual([]);
      expect(layout.removed).toEqual([]);
      /* Nothing is shown twice. */
      expect(kept.length).toBe(new Set(kept).size);
    }
  });

  test("the card's menu is the columns, the icon cells, the priorities, then the rows that open", () => {
    const layout = compactLayout("card", cardItems("assigned", 1), WORDS)!;
    expect(layout.width).toBe(300);
    expect(layout.nodes.map((node) => (node.node === "section" ? `${node.section.id}:${node.open}` : node.node === "segments" ? `segments:${node.id}` : node.node))).toEqual([
      "segments:status", "quick", "segments:priority", "appearance:expand", "lane:0:drill", "more:expand",
    ]);
    const quick = layout.nodes.find((node) => node.node === "quick");
    expect(quick?.node === "quick" ? quick.actions.map((action) => action.id) : []).toEqual(["rename", "describe", "links", "hide"]);
    expect(sectionAt(layout, ["appearance"])!.entries.map((entry) => (entry.type === "swatches" ? "colour" : "id" in entry ? entry.id : entry.type))).toEqual(["colour", "icon"]);
    expect(sectionAt(layout, ["more"])!.entries.map((entry) => ("id" in entry ? entry.id : entry.type))).toEqual(["hold", "collapse"]);
  });

  test("a column's and a conversation's menus keep their entries or name where one went", () => {
    const column = [act("hideIdle"), act("showHidden")];
    const reader = [act("full"), act("copyLink"), act("handoff"), { type: "sep" } as KanbanMenuItem, act("link"), act("unlink", { disabled: true }), { type: "sep" } as KanbanMenuItem, act("closeOnBoard"), { type: "sep" } as KanbanMenuItem, act("stopHost")];
    for (const [kind, items] of [["column", column], ["reader", reader]] as const) {
      const layout = compactLayout(kind, items, WORDS)!;
      const kept = new Set(labels(layoutActions(layout) as KanbanMenuItem[]));
      const removed = new Set(layout.removed.map((entry) => entry.label));
      expect(labels(items).filter((label) => !kept.has(label) && !removed.has(label))).toEqual([]);
    }
    /* The Hidden pill in the board's header opens the same tray; a column whose only entry is the tray keeps it. */
    expect(compactLayout("column", column, WORDS)!.removed.map((entry) => [entry.id, entry.home])).toEqual([["showHidden", "hiddenPill"]]);
    expect(compactLayout("column", [act("showHidden")], WORDS)!.removed).toEqual([]);
    expect(compactLayout("reader", reader, WORDS)!.removed).toEqual([]);
  });

  test("a pipeline's and a stage's menu, and the short ones, stay the plain list", () => {
    for (const kind of ["pipeline", "stage", "status", "colour", "create", undefined]) expect(compactLayout(kind, cardItems("assigned", 1), WORDS)).toBeNull();
  });

  test("Remove from the board stays out of a conversation's icon cells", () => {
    const reader = compactLayout("reader", [act("full"), act("closeOnBoard", { why: "what it does" })], WORDS)!;
    expect(reader.nodes.flatMap((node) => (node.node === "quick" ? node.actions.map((action) => action.id) : []))).toEqual(["full"]);
    expect(reader.nodes.some((node) => node.node === "row" && node.action.id === "closeOnBoard" && node.hint)).toBe(true);
  });

  test("the card's menu rests at the same number of rows however many pipelines the card holds", () => {
    const one = compactLayout("card", cardItems("assigned", 1), WORDS)!;
    const five = compactLayout("card", cardItems("assigned", 5), WORDS)!;
    expect(five.nodes.length).toBe(one.nodes.length);
    /* One pipeline opens its actions; several open their list, and each of them its own page. */
    expect(layoutStates(one).filter((state) => state.some((id) => id.startsWith("lane:")))).toEqual([["lane:0"]]);
    expect(layoutStates(five).filter((state) => state[0] === "pipelines").map((state) => state.join("/"))).toEqual(["pipelines", ...[0, 1, 2, 3, 4].map((lane) => `pipelines/lane:${lane}`)]);
    const page = sectionAt(five, ["pipelines", "lane:3"])!;
    expect([page.title, page.value, page.hints]).toEqual(["Lane 3", "Running", true]);
    /* A pipeline's actions are a page, where each keeps its second line. */
    expect(one.nodes.find((node) => node.node === "section" && node.section.lane)).toMatchObject({ open: "drill", section: { hints: true } });
  });

  test("a list of pipelines too tall for one page keeps what fits and hands the rest to the next page", () => {
    /* Seven rows of 39 px in the 313 px a page leaves under its back row: one page. */
    expect(pageSizes(Array(7).fill(39), 313, 28)).toEqual([7]);
    /* Twelve do not fit: each page but the last gives 28 px to the row that opens the next. */
    expect(pageSizes(Array(12).fill(39), 313, 28)).toEqual([7, 5]);
    expect(pageSizes(Array(20).fill(39), 313, 28)).toEqual([7, 7, 6]);
    /* Rows of their own heights fill a page in order, and a row taller than the page still gets one. */
    expect(pageSizes([55, 39, 39, 55, 55, 39, 55, 39, 39], 313, 28)).toEqual([6, 3]);
    expect(pageSizes([400, 39], 313, 28)).toEqual([1, 1]);
    expect(pageSizes([], 313, 28)).toEqual([]);
  });

  test("the pages of a long list lose no pipeline and no action, and a list that fits is left as it was", () => {
    const twelve = compactLayout("card", cardItems("assigned", 12), WORDS)!;
    expect(pagedLanes(twelve, [12], "More pipelines")).toBe(twelve);
    expect(pagedLanes(twelve, [], "More pipelines")).toBe(twelve);
    const paged = pagedLanes(twelve, [5, 5, 2], "More pipelines");
    expect(paged.nodes.length).toBe(twelve.nodes.length);
    expect(layoutActions(paged)).toEqual(layoutActions(twelve));
    const ids = (path: string[]) => sectionAt(paged, path)!.entries.map((entry) => (entry.type === "section" ? entry.section.id : entry.type));
    expect(ids(["pipelines"])).toEqual([...[0, 1, 2, 3, 4].map((lane) => `lane:${lane}`), MORE_LANES]);
    expect(ids(["pipelines", MORE_LANES])).toEqual([...[5, 6, 7, 8, 9].map((lane) => `lane:${lane}`), MORE_LANES]);
    expect(ids(["pipelines", MORE_LANES, MORE_LANES])).toEqual(["lane:10", "lane:11"]);
    /* The row to the next page says how many are behind it. */
    expect(sectionAt(paged, ["pipelines", MORE_LANES])).toMatchObject({ title: "More pipelines", value: "7", hints: false });
    expect(sectionAt(paged, ["pipelines", MORE_LANES, MORE_LANES])).toMatchObject({ value: "2" });
    expect(sectionAt(paged, ["pipelines", MORE_LANES, "lane:7"])).toMatchObject({ title: "Lane 7", hints: true });
    /* A card with one pipeline has no list to cut. */
    const one = compactLayout("card", cardItems("assigned", 1), WORDS)!;
    expect(layoutStates(pagedLanes(one, [1, 1], "More pipelines"))).toEqual(layoutStates(one));
  });
});

describe("where a compact menu stands", () => {
  const WIDTH = 300;

  test("below its button while the tallest state fits there, beside it otherwise, hung from its top edge", () => {
    const view = { width: 1440, height: 900 };
    const high = { left: 700, right: 724, top: 200, bottom: 224 };
    expect(menuPlacement(high, WIDTH, 342, view)).toEqual({ side: "below", left: 724 - WIDTH, top: 224 + MENU_GAP });
    /* A button low in the window: the menu stands before it and reaches up as far as its tallest state needs. */
    const low = { left: 700, right: 724, top: 800, bottom: 824 };
    expect(menuPlacement(low, WIDTH, 342, view)).toEqual({ side: "beside", left: 700 - MENU_GAP - WIDTH, top: 900 - 8 - 342 });
    /* At the left edge there is no room before the button, so the menu goes after it. */
    expect(menuPlacement({ left: 20, right: 44, top: 640, bottom: 664 }, WIDTH, 342, { width: 1000, height: 700 })).toMatchObject({ side: "beside", left: 44 + MENU_GAP });
  });

  test("no state covers the button or leaves the window, wherever the button is", () => {
    for (const view of [{ width: 1440, height: 900 }, { width: 1000, height: 700 }]) {
      for (let top = 0; top <= view.height - 24; top += 7) for (const left of [8, 300, view.width - 40]) for (const tallest of [69, 257, 276, 328, 342, 360]) {
        const anchor = { left, right: left + 24, top, bottom: top + 24 };
        const spot = menuPlacement(anchor, WIDTH, tallest, view);
        /* Every state hangs from `top`, so the tallest one is the box that could reach the button. */
        const box = { left: spot.left, right: spot.left + WIDTH, top: spot.top, bottom: spot.top + tallest };
        const covers = box.left < anchor.right && box.right > anchor.left && box.top < anchor.bottom && box.bottom > anchor.top;
        expect([view.height, top, left, tallest, covers]).toEqual([view.height, top, left, tallest, false]);
        expect(box.top).toBeGreaterThanOrEqual(8);
        expect(box.bottom).toBeLessThanOrEqual(view.height - 8);
        expect(box.left).toBeGreaterThanOrEqual(8);
        expect(box.right).toBeLessThanOrEqual(view.width - 8);
      }
    }
  });
});
