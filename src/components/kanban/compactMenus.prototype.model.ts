import type { KanbanMenuItem } from "./kanbanMenus";

/* The three numbered layouts of the board's menus (docs/design/compact-card-menu.md),
   as data: each takes the entries the board builds today, marked by `id` and
   `group`, and says where every one of them goes. The presenter draws what
   this returns; the test beside this file checks that no entry is lost. */

export type MenuVariant = 1 | 2 | 3;
export const MENU_VARIANTS: readonly MenuVariant[] = [1, 2, 3];

export type MenuAction = Extract<KanbanMenuItem, { type: "item" | "radio" | "check" }>;
export type MenuSwatches = Extract<KanbanMenuItem, { type: "swatches" }>;
export type MenuEntry = MenuAction | MenuSwatches | { type: "sep" };

export interface MenuSection {
  id: string;
  title: string;
  /** What is chosen now, shown on the closed row. */
  value: string | null;
  entries: MenuEntry[];
  /** The rows keep their second line (a lane's actions say what they stop). */
  hints: boolean;
}

export type MenuNode =
  /* One row of choices side by side: the four columns, the three priorities. */
  | { node: "segments"; id: string; label: string; options: MenuAction[] }
  /* The frequent actions as one row of icon cells. */
  | { node: "quick"; actions: MenuAction[] }
  | { node: "row"; action: MenuAction; hint: boolean }
  /* A named row that opens in place (`expand`) or replaces the list (`drill`). */
  | { node: "section"; section: MenuSection; open: "expand" | "drill" }
  | { node: "sep" };

/** An entry a layout leaves out, with the place that already does the same. */
export interface MenuRemoval { id: string; label: string; home: MenuHome }
export type MenuHome = "fold" | "hiddenPill" | "holdWhenWaiting" | "unlinkWhenLinked";

export interface CompactLayout { width: number; nodes: MenuNode[]; removed: MenuRemoval[] }

/** The words a layout adds; everything else is the board's own label. */
export interface MenuWords { appearance: string; more: string; move: string; priority: string; task: string; closing: string; none: string }

const isAction = (item: KanbanMenuItem): item is MenuAction => item.type === "item" || item.type === "radio" || item.type === "check";

function lanes(items: readonly KanbanMenuItem[]): MenuSection[] {
  const sections = new Map<string, MenuSection>();
  for (const item of items) {
    if (!item.group) continue;
    const section = sections.get(item.group) ?? { id: item.group, title: "", value: null, entries: [], hints: true };
    sections.set(item.group, section);
    if (item.type === "head") section.title = item.label;
    else section.entries.push(item);
  }
  return [...sections.values()];
}

function cardLayout(items: readonly KanbanMenuItem[], variant: MenuVariant, words: MenuWords): CompactLayout {
  const actions = items.filter(isAction).filter((item) => !item.group);
  const find = (id: string) => actions.find((item) => item.id === id);
  const statuses = actions.filter((item) => item.id?.startsWith("status:"));
  const priorities = actions.filter((item) => item.id?.startsWith("priority:"));
  const swatches = items.find((item): item is MenuSwatches => item.type === "swatches");
  const [hold, icon, collapse, rename, describe, links, hide] = ["hold", "icon", "collapse", "rename", "describe", "links", "hide"].map(find);
  const laneSections = lanes(items);
  const rows = (list: (MenuAction | undefined)[], hint = false): MenuNode[] => list.flatMap((action) => (action ? [{ node: "row" as const, action, hint }] : []));
  const present = (list: (MenuEntry | undefined)[]) => list.filter((entry): entry is MenuEntry => entry !== undefined);
  const chosen = (list: MenuAction[]) => list.find((item) => item.checked)?.label ?? null;
  const appearance: MenuSection = { id: "appearance", title: words.appearance, value: swatches ? swatches.names(swatches.value) : null, entries: present([swatches, icon]), hints: false };
  const priority: MenuSection = { id: "priority", title: words.priority, value: chosen(priorities), entries: priorities, hints: false };
  const section = (entry: MenuSection, open: "expand" | "drill"): MenuNode[] => (entry.entries.length ? [{ node: "section", section: entry, open }] : []);

  if (variant === 1) {
    return {
      width: 300,
      nodes: [
        { node: "segments", id: "status", label: words.move, options: statuses },
        { node: "quick", actions: [rename, describe, links, hide].filter((action): action is MenuAction => action !== undefined) },
        { node: "sep" },
        ...section(priority, "expand"),
        ...section(appearance, "expand"),
        /* Opened in place, a lane's rows keep to one line; what each one stops is its tooltip. */
        ...laneSections.flatMap((lane) => section({ ...lane, hints: false }, "expand")),
        ...section({ id: "more", title: words.more, value: null, entries: present([hold, collapse]), hints: false }, "expand"),
      ],
      removed: [],
    };
  }
  if (variant === 2) {
    return {
      width: 300,
      nodes: [
        ...section({ id: "status", title: words.move, value: chosen(statuses), entries: present([...statuses, hold]), hints: false }, "drill"),
        ...section(priority, "drill"),
        ...section(appearance, "drill"),
        ...rows([rename, describe, links]),
        ...laneSections.flatMap((lane) => section(lane, "drill")),
        ...rows([collapse]),
        { node: "sep" },
        ...rows([hide]),
      ],
      removed: [],
    };
  }
  /* Pruned: the fold beside the ⋯ already collapses the card, and a waiting
     reason belongs to a card that waits. */
  const waiting = statuses.find((item) => item.checked)?.status === "blocked";
  const removed: MenuRemoval[] = [];
  if (collapse) removed.push({ id: "collapse", label: collapse.label, home: "fold" });
  if (hold && !waiting) removed.push({ id: "hold", label: hold.label, home: "holdWhenWaiting" });
  return {
    width: 288,
    nodes: [
      { node: "segments", id: "status", label: words.move, options: statuses },
      ...(priorities.length ? [{ node: "segments" as const, id: "priority", label: words.priority, options: priorities }] : []),
      { node: "sep" },
      ...section(appearance, "expand"),
      ...rows([rename, describe, links, waiting ? hold : undefined]),
      ...laneSections.flatMap((lane) => section(lane, "drill")),
      { node: "sep" },
      ...rows([hide], true),
    ],
    removed,
  };
}

function columnLayout(items: readonly KanbanMenuItem[], variant: MenuVariant): CompactLayout {
  const actions = items.filter(isAction);
  const hidden = actions.find((item) => item.id === "showHidden");
  const bulk = actions.filter((item) => item.id !== "showHidden");
  /* Pruned: the Hidden pill in the board's header opens the same tray, so the
     row stays only where it would otherwise leave the menu empty. */
  const pruned = variant === 3 && bulk.length > 0 && hidden !== undefined;
  return {
    width: variant === 3 ? 288 : 300,
    nodes: [...bulk, ...(pruned || !hidden ? [] : [hidden])].map((action) => ({ node: "row" as const, action, hint: true })),
    removed: pruned ? [{ id: "showHidden", label: hidden.label, home: "hiddenPill" }] : [],
  };
}

function readerLayout(items: readonly KanbanMenuItem[], variant: MenuVariant, words: MenuWords): CompactLayout {
  const actions = items.filter(isAction);
  const find = (id: string) => actions.find((item) => item.id === id);
  const [full, copyLink, handoff, link, unlink, closeOnBoard, stopHost] = ["full", "copyLink", "handoff", "link", "unlink", "closeOnBoard", "stopHost"].map(find);
  const rows = (list: (MenuAction | undefined)[], hint = false): MenuNode[] => list.flatMap((action) => (action ? [{ node: "row" as const, action, hint }] : []));
  const present = (list: (MenuAction | undefined)[]) => list.filter((entry): entry is MenuAction => entry !== undefined);
  if (variant === 1) {
    const more = present([handoff, unlink, stopHost]);
    return {
      width: 300,
      nodes: [
        { node: "quick", actions: present([full, copyLink, link, closeOnBoard]) },
        ...(more.length ? [{ node: "sep" as const }, { node: "section" as const, section: { id: "more", title: words.more, value: null, entries: more, hints: true }, open: "expand" as const }] : []),
      ],
      removed: [],
    };
  }
  if (variant === 2) {
    const task = present([link, unlink]);
    const closing = present([closeOnBoard, stopHost]);
    return {
      width: 300,
      nodes: [
        ...rows([full, copyLink, handoff]),
        ...(task.length ? [{ node: "section" as const, section: { id: "task", title: words.task, value: null, entries: task, hints: true }, open: "drill" as const }] : []),
        ...(closing.length ? [{ node: "sep" as const }, { node: "section" as const, section: { id: "closing", title: words.closing, value: null, entries: closing, hints: true }, open: "drill" as const }] : []),
      ],
      removed: [],
    };
  }
  /* Pruned: Unlink is offered only while there is a link of the operator's own to take off. */
  const unlinkable = unlink && !unlink.disabled;
  return {
    width: 288,
    nodes: [
      ...rows([full, copyLink, link, unlinkable ? unlink : undefined, handoff]),
      ...(closeOnBoard || stopHost ? [{ node: "sep" as const }] : []),
      ...rows([closeOnBoard, stopHost]),
    ],
    removed: unlink && !unlinkable ? [{ id: "unlink", label: unlink.label, home: "unlinkWhenLinked" }] : [],
  };
}

/** The layout of one of the board's menus, or null where the menu stays as it
    is: a pipeline's and a stage's (kept by the operator's word), and the short
    status, colour and create menus. */
export function compactLayout(kind: string | undefined, items: readonly KanbanMenuItem[], variant: MenuVariant, words: MenuWords): CompactLayout | null {
  if (kind === "card") return cardLayout(items, variant, words);
  if (kind === "column") return columnLayout(items, variant);
  if (kind === "reader") return readerLayout(items, variant, words);
  return null;
}

/** Every action a layout shows, wherever it sits. */
export function layoutActions(layout: CompactLayout): MenuEntry[] {
  return layout.nodes.flatMap((node): MenuEntry[] => {
    if (node.node === "segments") return node.options;
    if (node.node === "quick") return node.actions;
    if (node.node === "row") return [node.action];
    if (node.node === "section") return node.section.entries.filter((entry) => entry.type !== "sep");
    return [];
  });
}
