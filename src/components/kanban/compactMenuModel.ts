import { popoverLeft, type KanbanMenuItem } from "./kanbanMenus";

/* The layout of the board's compact menus (docs/design/compact-card-menu.md),
   as data: each takes the entries the board builds, marked by `id` and
   `group`, and says where every one of them goes. `compactMenu.tsx` draws
   what this returns; the test beside this file checks that no entry is lost. */

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
  | { node: "sep" };

/** An entry a layout leaves out, with the place that already does the same. */
export interface MenuRemoval { id: string; label: string; home: "hiddenPill" }

export interface CompactLayout { width: number; nodes: MenuNode[]; removed: MenuRemoval[] }

/** The words a layout adds; everything else is the board's own label. */
export interface MenuWords { appearance: string; more: string; move: string; priority: string; pipelines: string }

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

const present = <T,>(list: (T | undefined)[]) => list.filter((entry): entry is T => entry !== undefined);

function cardLayout(items: readonly KanbanMenuItem[], words: MenuWords): CompactLayout {
  const actions = items.filter(isAction).filter((item) => !item.group);
  const find = (id: string) => actions.find((item) => item.id === id);
  const statuses = actions.filter((item) => item.id?.startsWith("status:"));
  const priorities = actions.filter((item) => item.id?.startsWith("priority:"));
  const swatches = items.find((item): item is MenuSwatches => item.type === "swatches");
  const [hold, icon, collapse, rename, describe, links, hide] = ["hold", "icon", "collapse", "rename", "describe", "links", "hide"].map(find);
  const laneSections = lanes(items);
  const section = (entry: MenuSection, open: "expand" | "drill"): MenuNode[] => (entry.entries.length ? [{ node: "section", section: entry, open }] : []);
  const segments = (id: string, label: string, options: MenuAction[]): MenuNode[] => (options.length ? [{ node: "segments", id, label, options }] : []);
  /* One row however many lanes the card holds: a single pipeline opens its
     actions, several open their list first. A page keeps each action's second
     line, so what Close and Pause stop is read before it is chosen. */
  const pipelines: MenuNode[] = laneSections.length === 0 ? []
    : laneSections.length === 1 ? section({ ...laneSections[0]!, value: null }, "drill")
    : section({ id: "pipelines", title: words.pipelines, value: String(laneSections.length), entries: laneSections.map((lane) => ({ type: "section" as const, section: lane })), hints: false }, "drill");
  return {
    width: 300,
    nodes: [
      ...segments("status", words.move, statuses),
      { node: "quick", actions: present([rename, describe, links, hide]) },
      ...segments("priority", words.priority, priorities),
      ...section({ id: "appearance", title: words.appearance, value: swatches ? swatches.names(swatches.value) : null, entries: present<MenuEntry>([swatches, icon]), hints: false }, "expand"),
      ...pipelines,
      ...section({ id: "more", title: words.more, value: null, entries: present([hold, collapse]), hints: false }, "expand"),
    ],
    removed: [],
  };
}

function columnLayout(items: readonly KanbanMenuItem[]): CompactLayout {
  const actions = items.filter(isAction);
  const hidden = actions.find((item) => item.id === "showHidden");
  const bulk = actions.filter((item) => item.id !== "showHidden");
  /* The Hidden pill in the board's header opens the same tray, so the row
     stays only where it would otherwise leave the menu empty. */
  const pruned = bulk.length > 0 && hidden !== undefined;
  return {
    width: 300,
    nodes: [...bulk, ...(pruned || !hidden ? [] : [hidden])].map((action) => ({ node: "row" as const, action, hint: true })),
    removed: pruned ? [{ id: "showHidden", label: hidden.label, home: "hiddenPill" }] : [],
  };
}

function readerLayout(items: readonly KanbanMenuItem[], words: MenuWords): CompactLayout {
  const actions = items.filter(isAction);
  const find = (id: string) => actions.find((item) => item.id === id);
  const [full, copyLink, handoff, link, unlink, closeOnBoard, stopHost] = ["full", "copyLink", "handoff", "link", "unlink", "closeOnBoard", "stopHost"].map(find);
  const more = present([handoff, unlink, stopHost]);
  return {
    width: 300,
    nodes: [
      { node: "quick", actions: present([full, copyLink, link]) },
      { node: "sep" },
      /* Taking a card off the board is a full row that says what it does: as
         an icon cell it sat under the pane's own close button and read as it. */
      ...(closeOnBoard ? [{ node: "row" as const, action: closeOnBoard, hint: true }] : []),
      ...(more.length ? [{ node: "section" as const, section: { id: "more", title: words.more, value: null, entries: more, hints: true }, open: "expand" as const }] : []),
    ],
    removed: [],
  };
}

/** The layout of one of the board's menus, or null where the menu stays the
    plain list: a pipeline's and a stage's (kept by the operator's word), and
    the short status, colour and create menus. */
export function compactLayout(kind: string | undefined, items: readonly KanbanMenuItem[], words: MenuWords): CompactLayout | null {
  if (kind === "card") return cardLayout(items, words);
  if (kind === "column") return columnLayout(items);
  if (kind === "reader") return readerLayout(items, words);
  return null;
}

const within = (section: MenuSection): MenuEntry[] => section.entries.flatMap((entry) => (entry.type === "section" ? within(entry.section) : entry.type === "sep" ? [] : [entry]));

/** Every action a layout shows, wherever it sits. */
export function layoutActions(layout: CompactLayout): MenuEntry[] {
  return layout.nodes.flatMap((node): MenuEntry[] => {
    if (node.node === "segments") return node.options;
    if (node.node === "quick") return node.actions;
    if (node.node === "row") return [node.action];
    if (node.node === "section") return within(node.section);
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

/** The row at the foot of a page of pipelines that opens the page of those that did not fit. */
export const MORE_LANES = "pipelines-more";

/** How many rows of a list go on each of its pages so that no page is taller
    than `room`. Every page but the last ends in the row that opens the next,
    `more` tall; a list that fits is one page. */
export function pageSizes(heights: readonly number[], room: number, more: number): number[] {
  const sizes: number[] = [];
  for (let at = 0; at < heights.length;) {
    const rest = heights.slice(at);
    if (rest.reduce((sum, height) => sum + height, 0) <= room) { sizes.push(rest.length); break; }
    let used = more;
    let count = 0;
    while (count < rest.length && used + rest[count]! <= room) used += rest[count++]!;
    sizes.push(Math.max(1, count));
    at += Math.max(1, count);
  }
  return sizes;
}

/** The same layout with the list of a card's pipelines cut into pages of these
    sizes: each page keeps its rows and hands the rest to one more page behind
    its last row. One size, or none, leaves the list whole. */
export function pagedLanes(layout: CompactLayout, sizes: readonly number[], title: string): CompactLayout {
  if (sizes.length < 2) return layout;
  const pages = (entries: MenuEntry[], [size, ...rest]: readonly number[]): MenuEntry[] => (size === undefined || rest.length === 0 || entries.length <= size ? entries : [
    ...entries.slice(0, size),
    { type: "section", section: { id: MORE_LANES, title, value: String(entries.length - size), entries: pages(entries.slice(size), rest), hints: false } },
  ]);
  return { ...layout, nodes: layout.nodes.map((node) => (node.node === "section" && node.section.id === "pipelines" ? { ...node, section: { ...node.section, entries: pages(node.section.entries, sizes) } } : node)) };
}

export const MENU_GAP = 6;
export type MenuSide = "below" | "beside";

/** Where a menu goes so that no state of it covers its own button and every
    state hangs from the same top edge: below the button while the tallest
    state fits there, else beside it. The top never moves, so a section always
    opens under its own row, wherever on the screen the button is. Below a
    button that sits in a narrower surface (a column folded open to a shelf),
    `withinLeft` keeps the menu from starting left of that surface. */
export function menuPlacement(anchor: { left: number; right: number; top: number; bottom: number }, width: number, tallest: number, view: { width: number; height: number }, withinLeft: number | null = null): { side: MenuSide; left: number; top: number } {
  if (anchor.bottom + MENU_GAP + tallest <= view.height - 8) {
    const left = popoverLeft(anchor, width, view.width);
    return { side: "below", left: withinLeft !== null && left < withinLeft ? Math.max(8, Math.min(withinLeft, view.width - width - 8)) : left, top: anchor.bottom + MENU_GAP };
  }
  const before = anchor.left - MENU_GAP - width;
  return { side: "beside", left: before >= 8 ? before : Math.min(anchor.right + MENU_GAP, view.width - width - 8), top: Math.max(8, Math.min(anchor.top, view.height - 8 - tallest)) };
}
