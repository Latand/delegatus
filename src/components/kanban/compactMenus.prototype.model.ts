import { popoverLeft, type KanbanMenuItem } from "./kanbanMenus";

/* The three numbered layouts of the board's menus (docs/design/compact-card-menu.md),
   as data: each takes the entries the board builds today, marked by `id` and
   `group`, and says where every one of them goes. The presenter draws what
   this returns; the test beside this file checks that no entry is lost. */

export type MenuVariant = 1 | 2 | 3;
export const MENU_VARIANTS: readonly MenuVariant[] = [1, 2, 3];

export type MenuAction = Extract<KanbanMenuItem, { type: "item" | "radio" | "check" }>;
export type MenuSwatches = Extract<KanbanMenuItem, { type: "swatches" }>;
/* A section inside a section is one more page: the pipelines of a card that holds several. */
export type MenuEntry = MenuAction | MenuSwatches | { type: "sep" } | { type: "section"; section: MenuSection };

export interface MenuSection {
  id: string;
  title: string;
  /** What is chosen now, shown on the closed row. */
  value: string | null;
  entries: MenuEntry[];
  /** The rows keep their second line (a lane's actions say what they stop). */
  hints: boolean;
  /** A pipeline's row carries the pipeline mark and its state. */
  lane?: boolean;
}

export type MenuNode =
  /* One row of choices side by side: the four columns, the three priorities. */
  | { node: "segments"; id: string; label: string; options: MenuAction[] }
  /* The frequent actions as one row of icon cells. */
  | { node: "quick"; actions: MenuAction[] }
  | { node: "row"; action: MenuAction; hint: boolean }
  /* A named row that opens in place (`expand`) or replaces the list (`drill`). */
  | { node: "section"; section: MenuSection; open: "expand" | "drill" }
  /* A section drawn as one row of its own controls: the colours and the icon. */
  | { node: "inline"; section: MenuSection }
  | { node: "sep" };

/** An entry a layout leaves out, with the place that already does the same. */
export interface MenuRemoval { id: string; label: string; home: MenuHome }
export type MenuHome = "fold" | "hiddenPill" | "statusChip" | "unlinkWhenLinked";

export interface CompactLayout { width: number; nodes: MenuNode[]; removed: MenuRemoval[] }

/** The words a layout adds; everything else is the board's own label. */
export interface MenuWords { appearance: string; more: string; move: string; priority: string; task: string; closing: string; none: string; pipelines: string }

const isAction = (item: KanbanMenuItem): item is MenuAction => item.type === "item" || item.type === "radio" || item.type === "check";

function lanes(items: readonly KanbanMenuItem[]): MenuSection[] {
  const sections = new Map<string, MenuSection>();
  for (const item of items) {
    if (!item.group) continue;
    const section = sections.get(item.group) ?? { id: item.group, title: "", value: null, entries: [], hints: true, lane: true };
    sections.set(item.group, section);
    if (item.type === "head") { section.title = item.label; section.value = item.note ?? null; }
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
  const segments = (id: string, label: string, options: MenuAction[]): MenuNode[] => (options.length ? [{ node: "segments", id, label, options }] : []);
  /* One row however many lanes the card holds: a single pipeline opens its
     actions, several open their list first. A page keeps each action's second
     line, so what Close and Pause stop is read before it is chosen. */
  const pipelines: MenuNode[] = laneSections.length === 0 ? []
    : laneSections.length === 1 ? section({ ...laneSections[0]!, value: null }, "drill")
    : section({ id: "pipelines", title: words.pipelines, value: String(laneSections.length), entries: laneSections.map((lane) => ({ type: "section" as const, section: lane })), hints: false }, "drill");

  if (variant === 1) {
    return {
      width: 300,
      nodes: [
        ...segments("status", words.move, statuses),
        { node: "quick", actions: [rename, describe, links, hide].filter((action): action is MenuAction => action !== undefined) },
        { node: "sep" },
        ...segments("priority", words.priority, priorities),
        ...section(appearance, "expand"),
        ...pipelines,
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
        ...pipelines,
        ...rows([collapse]),
        { node: "sep" },
        ...rows([hide]),
      ],
      removed: [],
    };
  }
  /* Pruned: the fold beside the ⋯ already collapses the card, and the status
     chip's menu already sets a waiting reason. */
  const removed: MenuRemoval[] = [];
  if (collapse) removed.push({ id: "collapse", label: collapse.label, home: "fold" });
  if (hold) removed.push({ id: "hold", label: hold.label, home: "statusChip" });
  return {
    width: 300,
    nodes: [
      ...segments("status", words.move, statuses),
      ...segments("priority", words.priority, priorities),
      { node: "sep" },
      ...(appearance.entries.length ? [{ node: "inline" as const, section: appearance }] : []),
      ...rows([rename, describe, links]),
      ...pipelines,
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
  /* Pruned in 1 and 3: the Hidden pill in the board's header opens the same
     tray, so the row stays only where it would otherwise leave the menu empty. */
  const pruned = variant !== 2 && bulk.length > 0 && hidden !== undefined;
  return {
    width: 300,
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
        { node: "quick", actions: present([full, copyLink, link]) },
        { node: "sep" },
        /* Taking a card off the board is a full row that says what it does: as
           an icon cell it sat under the pane's own close button and read as it. */
        ...rows([closeOnBoard], true),
        ...(more.length ? [{ node: "section" as const, section: { id: "more", title: words.more, value: null, entries: more, hints: true }, open: "expand" as const }] : []),
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
    width: 300,
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

const within = (section: MenuSection): MenuEntry[] => section.entries.flatMap((entry) => (entry.type === "section" ? within(entry.section) : entry.type === "sep" ? [] : [entry]));

/** Every action a layout shows, wherever it sits. */
export function layoutActions(layout: CompactLayout): MenuEntry[] {
  return layout.nodes.flatMap((node): MenuEntry[] => {
    if (node.node === "segments") return node.options;
    if (node.node === "quick") return node.actions;
    if (node.node === "row") return [node.action];
    if (node.node === "section" || node.node === "inline") return within(node.section);
    return [];
  });
}

/** Every state a layout can be in, as the path of sections opened to reach it; the resting state is the empty path. */
export function layoutStates(layout: CompactLayout): string[][] {
  const states: string[][] = [[]];
  const walk = (section: MenuSection, path: string[]) => {
    states.push(path);
    for (const entry of section.entries) if (entry.type === "section") walk(entry.section, [...path, entry.section.id]);
  };
  for (const node of layout.nodes) if (node.node === "section") walk(node.section, [node.section.id]);
  return states;
}

/** The section a path of opened sections ends at. */
export function sectionAt(layout: CompactLayout, path: readonly string[]): MenuSection | null {
  let entries: MenuSection[] = layout.nodes.flatMap((node) => (node.node === "section" ? [node.section] : []));
  let found: MenuSection | null = null;
  for (const id of path) {
    found = entries.find((section) => section.id === id) ?? null;
    if (!found) return null;
    entries = found.entries.flatMap((entry) => (entry.type === "section" ? [entry.section] : []));
  }
  return found;
}

export const MENU_GAP = 6;
/* A second press on the spot that just swapped the list is the tail of a
   double click: it is dropped for this long unless the pointer moved this far. */
export const SWAP_GUARD_MS = 1000;
export const SWAP_GUARD_PX = 4;
export type MenuSide = "below" | "above" | "beside";

/** Where a menu goes so that no state of it covers its own button: below it
    while the tallest state fits there, else above it with its bottom edge held
    (it grows upward), else beside it. */
export function menuPlacement(anchor: { left: number; right: number; top: number; bottom: number }, width: number, tallest: number, view: { width: number; height: number }): { side: MenuSide; left: number; top: number | null; bottom: number | null } {
  const left = popoverLeft(anchor, width, view.width);
  if (anchor.bottom + MENU_GAP + tallest <= view.height - 8) return { side: "below", left, top: anchor.bottom + MENU_GAP, bottom: null };
  if (anchor.top - MENU_GAP - tallest >= 8) return { side: "above", left, top: null, bottom: view.height - (anchor.top - MENU_GAP) };
  const before = anchor.left - MENU_GAP - width;
  return { side: "beside", left: before >= 8 ? before : Math.min(anchor.right + MENU_GAP, view.width - width - 8), top: Math.max(8, Math.min(anchor.top, view.height - 8 - tallest)), bottom: null };
}
