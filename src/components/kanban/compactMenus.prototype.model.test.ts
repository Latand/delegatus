import { describe, expect, test } from "bun:test";

import { compactLayout, layoutActions, layoutStates, MENU_VARIANTS, sectionAt, type MenuAction, type MenuWords } from "./compactMenus.prototype.model";
import type { KanbanMenuItem } from "./kanbanMenus";

const WORDS: MenuWords = { appearance: "Appearance", more: "More", move: "Move to", priority: "Priority", task: "Task link", closing: "Close or stop", none: "No colour", pipelines: "Pipelines" };
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
  for (const variant of MENU_VARIANTS) {
    test(`variant ${variant} keeps every entry of the card's menu or names where it went`, () => {
      for (const [status, lanes] of [["assigned", 0], ["blocked", 1], ["inbox", 3]] as const) {
        const items = cardItems(status, lanes);
        const layout = compactLayout("card", items, variant, WORDS)!;
        const kept = new Set(labels(layoutActions(layout) as KanbanMenuItem[]));
        const removed = new Set(layout.removed.map((entry) => entry.label));
        const lost = labels(items).filter((label) => !kept.has(label) && !removed.has(label));
        expect(lost).toEqual([]);
        /* Nothing is both shown and listed as removed, and nothing is shown twice. */
        expect([...removed].filter((label) => kept.has(label))).toEqual([]);
        expect(labels(layoutActions(layout) as KanbanMenuItem[]).length).toBe(kept.size);
      }
    });

    test(`variant ${variant} keeps a column's and a conversation's entries or names where they went`, () => {
      const column = [act("hideIdle"), act("showHidden")];
      const reader = [act("full"), act("copyLink"), act("handoff"), { type: "sep" } as KanbanMenuItem, act("link"), act("unlink", { disabled: true }), { type: "sep" } as KanbanMenuItem, act("closeOnBoard"), { type: "sep" } as KanbanMenuItem, act("stopHost")];
      for (const [kind, items] of [["column", column], ["reader", reader]] as const) {
        const layout = compactLayout(kind, items, variant, WORDS)!;
        const kept = new Set(labels(layoutActions(layout) as KanbanMenuItem[]));
        const removed = new Set(layout.removed.map((entry) => entry.label));
        expect(labels(items).filter((label) => !kept.has(label) && !removed.has(label))).toEqual([]);
      }
    });
  }

  test("variant 3 removes only what has another home", () => {
    const resting = compactLayout("card", cardItems("assigned", 1), 3, WORDS)!;
    expect(resting.removed.map((entry) => [entry.id, entry.home])).toEqual([["collapse", "fold"], ["hold", "statusChip"]]);
    /* A waiting card rests at the same height: its reason stays in the status chip's menu. */
    const waiting = compactLayout("card", cardItems("blocked", 1), 3, WORDS)!;
    expect(waiting.nodes.length).toBe(resting.nodes.length);
    /* A column whose only entry is the hidden tray keeps it. */
    expect(compactLayout("column", [act("showHidden")], 3, WORDS)!.removed).toEqual([]);
    /* An explicit link of the operator's own stays removable. */
    const linked = compactLayout("reader", [act("full"), act("unlink")], 3, WORDS)!;
    expect(linked.removed).toEqual([]);
  });

  test("a pipeline's and a stage's menu, and the short ones, stay as they are", () => {
    for (const kind of ["pipeline", "stage", "status", "colour", "create", undefined]) {
      for (const variant of MENU_VARIANTS) expect(compactLayout(kind, cardItems("assigned", 1), variant, WORDS)).toBeNull();
    }
  });

  test("variants 1 and 2 remove nothing from the card's menu", () => {
    for (const variant of [1, 2] as const) expect(compactLayout("card", cardItems("assigned", 2), variant, WORDS)!.removed).toEqual([]);
  });

  test("the recommended variant takes the column's pruning and keeps Remove from the board out of the icon cells", () => {
    expect(compactLayout("column", [act("hideIdle"), act("showHidden")], 1, WORDS)!.removed.map((entry) => entry.home)).toEqual(["hiddenPill"]);
    expect(compactLayout("column", [act("hideIdle"), act("showHidden")], 2, WORDS)!.removed).toEqual([]);
    const reader = compactLayout("reader", [act("full"), act("closeOnBoard", { why: "what it does" })], 1, WORDS)!;
    expect(reader.nodes.flatMap((node) => (node.node === "quick" ? node.actions.map((action) => action.id) : []))).toEqual(["full"]);
    expect(reader.nodes.some((node) => node.node === "row" && node.action.id === "closeOnBoard" && node.hint)).toBe(true);
  });

  for (const variant of MENU_VARIANTS) {
    test(`variant ${variant} rests at the same number of rows however many pipelines the card holds`, () => {
      const one = compactLayout("card", cardItems("assigned", 1), variant, WORDS)!;
      const five = compactLayout("card", cardItems("assigned", 5), variant, WORDS)!;
      expect(five.nodes.length).toBe(one.nodes.length);
      /* One pipeline opens its actions; several open their list, and each of them its own page. */
      expect(layoutStates(one).filter((state) => state.some((id) => id.startsWith("lane:")))).toEqual([["lane:0"]]);
      expect(layoutStates(five).filter((state) => state[0] === "pipelines").map((state) => state.join("/"))).toEqual(["pipelines", ...[0, 1, 2, 3, 4].map((lane) => `pipelines/lane:${lane}`)]);
      const page = sectionAt(five, ["pipelines", "lane:3"])!;
      expect([page.title, page.value, page.hints]).toEqual(["Lane 3", "Running", true]);
      /* A pipeline's actions are a page in every variant, where each keeps its second line. */
      expect(one.nodes.find((node) => node.node === "section" && node.section.lane)).toMatchObject({ open: "drill", section: { hints: true } });
    });
  }
});
