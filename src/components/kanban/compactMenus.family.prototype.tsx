"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";

import { useLocale } from "@/lib/i18n";

import { useSwapGuard } from "./compactMenus.prototype";
import type { MenuVariant } from "./compactMenus.prototype.model";

/* Design prototype (docs/design/compact-card-menu.md): the grammar of each
   numbered card menu, carried to the menus the board's `KanbanMenu` does not
   draw: the board's ⋯, the rail header's ⋯ and the phone's sheets. Every row
   stays the product's own element with its own handler; this only orders the
   rows, hides the ones behind a closed section and adds the section rows. A
   row no rule names stays with the row before it, so nothing can drop out
   unnamed. A section opens in place where the menu then stays inside its
   bound (360 px on the desktop, today's height without scrolling on the
   phone) and as a page where it would not; variant 2 opens every one as a
   page. The evidence fixture mounts it under `?menus=1|2|3`. */

type Words = { en: string; uk: string };
interface Section {
  id: string; title: Words; rows: readonly string[];
  /** Opens as a page with a back row: in place it would pass the menu's bound. */
  page?: boolean;
}
type Placement =
  | { rows: readonly string[]; cells?: boolean }
  | { section: Section };
interface Removal { row: string; home: Words }
interface FamilySpec {
  id: string;
  /** The element whose children are the rows. */
  container: string;
  /** Wrappers whose children are the rows (the board ⋯ groups). */
  flatten?: string;
  /** Names for leading rows that carry no attribute of their own. */
  leading?: readonly string[];
  /** A product row whose class a section row borrows. */
  sample: string;
  layouts: Record<MenuVariant, { placements: readonly Placement[]; removed?: readonly Removal[] }>;
}

const sec = (id: string, en: string, uk: string, rows: readonly string[], page = false): Placement => ({ section: { id, title: { en, uk }, rows, page } });
const PAGE = true;
const RARE: Words = { en: "Rarely used", uk: "Рідко потрібне" };

/* The four project switches with their explanations are taller than a menu
   may be, so they are two sections: what merges and syncs, what the
   orchestrator tells the operator. */
const BAR_MERGING = ["merge-on-review", "share-project"];
const BAR_SEAT = ["bridge-reports", "asks-you"];
const BAR_POLICY = [...BAR_MERGING, ...BAR_SEAT];
const merging = sec("merging", "Merging and syncing", "Мердж і синхронізація", BAR_MERGING, PAGE);
const seat = sec("seat", "Orchestrator", "Оркестратор", BAR_SEAT, PAGE);
const BAR_PROJECT = ["project-archive", "project-unarchive", "project-delete"];
const RAIL_DEVICE = ["language", "qr", "push"];
const RAIL_GUIDES = ["rail-menu-setup-guide", "rail-menu-interface-walk", "rail-menu-agent-mapping", "rail-menu-dictation"];
const RAIL_INSTALL = ["rail-menu-linked-settings", "rail-menu-external-relay", "rail-menu-update"];
const PHONE_CREATE = ["new-task", "new-agent", "new-pipeline"];
const PHONE_GUIDES = ["setup-guide", "interface-walk", "agent-mapping", "dictation"];
const PHONE_INSTALL = ["settings", "linked-settings", "external-relay", "self-update"];
/* Interrupt is urgent while the agent works, so it is never behind a section. */
const CHAT_TURN = ["compact", "recheck"];
const CHAT_MANAGE = ["rename", "crown", "handoff", "terminal", "host"];
const MOVES = ["move-inbox", "move-assigned", "move-blocked", "move-done"];

export const FAMILY_SPECS: readonly FamilySpec[] = [
  {
    id: "board",
    container: "[data-bar-more-menu]",
    flatten: "[data-bar-menu-group]",
    sample: "button[data-testid='dash-search'], button",
    layouts: {
      1: { placements: [{ rows: ["dash-search", "sound-toggle", "sound-settings-trigger"] }, sec("accounts", "Accounts", "Акаунти", ["accounts"]), merging, seat, sec("project", "Archive or delete", "Архів і видалення", BAR_PROJECT)] },
      2: { placements: [{ rows: ["dash-search"] }, sec("sound", "Sound", "Звук", ["sound-toggle", "sound-settings-trigger"]), sec("accounts", "Accounts", "Акаунти", ["accounts"]), merging, seat, sec("project", "Archive or delete", "Архів і видалення", BAR_PROJECT)] },
      3: { placements: [{ rows: ["dash-search", "sound-toggle", "accounts", ...BAR_POLICY] }, { section: { id: "rare", title: RARE, rows: ["sound-settings-trigger", ...BAR_PROJECT] } }] },
    },
  },
  {
    id: "header",
    container: "[data-rail-menu-panel]",
    leading: RAIL_DEVICE,
    sample: "button[data-rail-menu-settings]",
    layouts: {
      1: { placements: [{ rows: ["rail-menu-settings", "rail-menu-activity", "rail-menu-team"] }, sec("device", "This device", "Цей пристрій", RAIL_DEVICE), sec("guides", "Guides", "Посібники", RAIL_GUIDES), sec("install", "Installation", "Інсталяція", RAIL_INSTALL)] },
      2: { placements: [{ rows: ["rail-menu-settings", "rail-menu-activity", "rail-menu-team"] }, sec("device", "This device", "Цей пристрій", RAIL_DEVICE), sec("guides", "Guides", "Посібники", RAIL_GUIDES), sec("install", "Installation", "Інсталяція", RAIL_INSTALL)] },
      3: { placements: [{ rows: [...RAIL_DEVICE, "rail-menu-settings", "rail-menu-activity", "rail-menu-team", "rail-menu-update"] }, { section: { id: "rare", title: RARE, rows: [...RAIL_GUIDES, "rail-menu-linked-settings", "rail-menu-external-relay"], page: true } }] },
    },
  },
  {
    id: "phone-board",
    container: "[data-mobile2-sheet='menu'] [role='menu']:has([data-mobile2-menu-row='new-task'])",
    sample: "button[data-mobile2-menu-row='tasks']",
    layouts: {
      1: { placements: [{ rows: PHONE_CREATE, cells: true }, { rows: ["tasks", "pipelines", "hidden"] }, sec("view", "View and places", "Вигляд і розділи", ["view-board", "view-catalog", "accounts", "host", "activity", "team"], PAGE), sec("device", "This device", "Цей пристрій", ["sound-settings-trigger", "sound-toggle", "keep-awake-row"]), sec("policy", "Project rules", "Правила проєкту", [...BAR_POLICY, ...BAR_PROJECT], PAGE), sec("guides", "Guides", "Посібники", PHONE_GUIDES), sec("install", "Installation", "Інсталяція", PHONE_INSTALL)] },
      2: { placements: [sec("create", "New…", "Створити…", PHONE_CREATE), { rows: ["tasks", "pipelines", "hidden"] }, sec("view", "View and places", "Вигляд і розділи", ["view-board", "view-catalog", "accounts", "host", "activity", "team"]), sec("device", "This device", "Цей пристрій", ["sound-settings-trigger", "sound-toggle", "keep-awake-row"]), sec("policy", "Project rules", "Правила проєкту", [...BAR_POLICY, ...BAR_PROJECT]), sec("guides", "Guides", "Посібники", PHONE_GUIDES), sec("install", "Installation", "Інсталяція", PHONE_INSTALL)] },
      3: { placements: [{ rows: PHONE_CREATE, cells: true }, { rows: ["tasks", "pipelines", "hidden", "view-board", "view-catalog", "accounts", "sound-settings-trigger", "sound-toggle"] }, sec("policy", "Project rules", "Правила проєкту", [...BAR_POLICY, ...BAR_PROJECT], PAGE), { section: { id: "rare", title: RARE, rows: ["host", "activity", "team", "keep-awake-row", ...PHONE_GUIDES, ...PHONE_INSTALL], page: true } }] },
    },
  },
  {
    id: "phone-conversation",
    container: "[data-mobile2-sheet='menu']:has([data-mobile2-chat-identity]) [role='menu']",
    sample: "button[data-mobile2-menu-row]",
    layouts: {
      1: { placements: [{ rows: ["attention", "reports", "pipeline", "seat", "pinned", "background", "stop"] }, sec("subagents", "Subagents", "Субагенти", ["subagent"]), sec("turn", "This turn", "Цей хід", CHAT_TURN), sec("manage", "Conversation", "Розмова", [...CHAT_MANAGE, "predecessor", "search", "project"]), sec("end", "Close or stop", "Закрити або зупинити", ["close", "kill"])] },
      2: { placements: [{ rows: ["attention", "reports", "pipeline", "seat", "pinned", "background", "stop"] }, sec("subagents", "Subagents", "Субагенти", ["subagent"]), sec("turn", "This turn", "Цей хід", CHAT_TURN), sec("manage", "Conversation", "Розмова", [...CHAT_MANAGE, "predecessor", "search", "project"]), sec("end", "Close or stop", "Закрити або зупинити", ["close", "kill"])] },
      3: {
        placements: [{ rows: ["attention", "pipeline", "seat", "pinned", "background", "stop", "compact", "rename", "search", "project", "close"] }, sec("subagents", "Subagents", "Субагенти", ["subagent"]), { section: { id: "rare", title: RARE, rows: ["recheck", "crown", "handoff", "terminal", "host", "predecessor", "kill"], page: true } }],
        removed: [{ row: "reports", home: { en: "the Reports control in the conversation's header", uk: "кнопка «Звіти» в шапці розмови" } }],
      },
    },
  },
  {
    id: "phone-card",
    container: "[data-phone-card-sheet]",
    sample: "button[data-phone-card-action]",
    layouts: {
      1: { placements: [{ rows: MOVES, cells: true }, { rows: ["dismiss", "open-agent", "hide"] }] },
      2: { placements: [sec("move", "Move to", "Перенести до", MOVES), { rows: ["dismiss", "open-agent", "hide"] }] },
      3: { placements: [{ rows: MOVES, cells: true }, { rows: ["dismiss", "open-agent", "hide"] }] },
    },
  },
  {
    id: "phone-task",
    container: "[data-phone-task-menu-sheet]",
    sample: "button[data-phone-task-menu]",
    layouts: {
      1: {
        placements: [{ rows: ["rename", "details", "links", "hide", "show"], cells: true }, { rows: ["priority", "colour"] }],
        removed: [{ row: "board", home: { en: "the ⋯ on the board itself, one Back away", uk: "⋯ на самій дошці, один крок «Назад»" } }],
      },
      2: { placements: [{ rows: ["rename", "priority", "colour", "details", "links", "hide", "show", "board"] }] },
      3: {
        placements: [{ rows: ["rename", "priority", "colour", "details", "links", "hide", "show"] }],
        removed: [{ row: "board", home: { en: "the ⋯ on the board itself, one Back away", uk: "⋯ на самій дошці, один крок «Назад»" } }],
      },
    },
  },
];

const KEY_ATTRS = ["data-mobile2-menu-row", "data-phone-card-action", "data-phone-task-menu", "data-testid"] as const;
const NAME_KEYS = /^data-(rail-menu-[a-z-]+|merge-on-review|share-project|bridge-reports|asks-you|project-[a-z-]+|keep-awake|sound-toggle|sound)$/;

/** What a row is, read from the marks the product already puts on it. */
function rowKey(row: Element): string | null {
  for (const attribute of KEY_ATTRS) {
    const value = row.getAttribute(attribute);
    if (value) return value.startsWith("subagent") ? "subagent" : value.replace(/^(mobile-)?menu-/, "");
  }
  for (const attribute of row.attributes) {
    const match = NAME_KEYS.exec(attribute.name);
    if (match) return match[1]!;
  }
  const inner = row.querySelector("[data-merge-on-review], [data-share-project], [data-bridge-reports], [data-asks-you], [data-testid], [data-keep-awake]");
  return inner && inner !== row ? rowKey(inner) : null;
}

const isRule = (row: HTMLElement) => !row.textContent?.trim() && !row.querySelector("button, a, input, svg");

/* The section rows take the product's own row class; these add what a section
   row needs on top, and the phone's cells. */
export const FAMILY_CSS = `
[data-cmf] { display: flex; flex-direction: column; }
[data-cmf][data-cmf-cells] { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); }
[data-cmf][data-cmf-cells] > *, [data-cmf][data-cmf-cells] > [data-cmf-chrome] > * { grid-column: 1 / -1; }
[data-cmf] > [data-cmf-chrome], [data-cmf] [data-cmf-flat] { display: contents; }
[data-cmf] [data-cmf-hidden] { display: none !important; }
[data-cmf] [data-cmf-head] { display: flex; width: 100%; align-items: center; text-align: left; }
[data-cmf] [data-cmf-head] > .cmf-title { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-cmf] [data-cmf-head] > svg { width: 16px; height: 16px; flex-shrink: 0; opacity: 0.55; }
[data-cmf] [data-cmf-head] > .cmf-count { flex-shrink: 0; margin-right: 6px; font-size: 12px; font-weight: 500; opacity: 0.6; font-variant-numeric: tabular-nums; }
[data-cmf] [data-cmf-head="back"] { font-weight: 700; border-bottom: 1px solid var(--border-default); border-radius: 0; margin-bottom: 4px; }
[data-cmf] [data-cmf-in] { box-shadow: inset 2px 0 0 var(--border-default); }
[data-cmf][data-cmf-cells] [data-cmf-cell] { flex-direction: column; justify-content: center; gap: 4px; min-height: 60px; padding: 8px 2px; text-align: center; font-size: 11.5px; line-height: 1.2; }
[data-cmf][data-cmf-cells] [data-cmf-cell] > span { flex: none; max-width: 100%; white-space: normal; }
[data-cmf][data-cmf-cells] [data-cmf-cell] > span > span { font-size: 11.5px; line-height: 1.2; }
/* A cell carries its name; the second line a full row has is the row's title here. */
[data-cmf][data-cmf-cells] [data-cmf-cell] > span + span + span, [data-cmf][data-cmf-cells] [data-cmf-cell] > span > span + span { display: none; }
[data-cmf][data-cmf-variant="3"] [data-merge-on-review] [role="status"]:not(.text-danger),
[data-cmf][data-cmf-variant="3"] [data-share-project] [role="status"]:not(.text-danger),
[data-cmf][data-cmf-variant="3"] [data-bridge-reports] [role="status"]:not(.text-danger),
[data-cmf][data-cmf-variant="3"] [data-asks-you] [role="status"]:not(.text-danger) { display: none; }
`;

interface Laid { row: HTMLElement; key: string }

/* Variant 2 opens every section as a page; the others only the ones marked. */
const paged = (variant: MenuVariant, section: Section) => variant === 2 || Boolean(section.page);

function rowsOf(container: HTMLElement, spec: FamilySpec): Laid[] {
  const direct = [...container.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute("data-cmf-chrome"));
  const rows = direct.flatMap((child) => {
    if (!spec.flatten || !child.matches(spec.flatten)) return [child];
    child.setAttribute("data-cmf-flat", "");
    /* A group's rows are known by the group when they carry no mark of their own. */
    const group = child.getAttribute("data-bar-menu-group");
    return [...child.children].filter((row): row is HTMLElement => row instanceof HTMLElement).map((row, index) => {
      if (!rowKey(row) && group && (group === "accounts" || index === 0)) row.setAttribute("data-cmf-key", group === "sound" ? "sound-toggle" : group);
      return row;
    });
  });
  const laid: Laid[] = [];
  let leading = 0;
  for (const row of rows) {
    if (isRule(row)) { row.setAttribute("data-cmf-hidden", "rule"); continue; }
    const known = row.getAttribute("data-cmf-key") ?? rowKey(row);
    const named = known ?? (laid.length === leading && spec.leading?.[leading] ? spec.leading[leading]! : null);
    if (!known && named) leading += 1;
    /* A row no rule names stays with the row before it. */
    laid.push({ row, key: named ?? laid[laid.length - 1]?.key ?? "unnamed" });
  }
  return laid;
}

function FamilyMenu({ container, spec, variant }: { container: HTMLElement; spec: FamilySpec; variant: MenuVariant }) {
  const { locale } = useLocale();
  const lang = locale === "uk" ? "uk" : "en";
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const layout = spec.layouts[variant];
  const chrome = useMemo(() => {
    const host = document.createElement("div");
    host.setAttribute("data-cmf-chrome", "");
    return host;
  }, []);
  /* The product re-renders its rows (a switch flips, a count moves); lay them out again. */
  useEffect(() => {
    const observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof HTMLElement && !node.hasAttribute("data-cmf-chrome") && !node.closest("[data-cmf-chrome]")))) setTick((value) => value + 1);
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [container]);
  const sample = useMemo(() => container.querySelector<HTMLElement>(spec.sample)?.className ?? "", [container, spec.sample]);
  /* Where the product's rows lead with an icon, a section's title starts where their labels do. */
  const lead = useMemo(() => {
    const first = container.querySelector<HTMLElement>(spec.sample)?.firstElementChild;
    return first && (first.tagName.toLowerCase() === "svg" || first.querySelector("svg")) ? first.getBoundingClientRect().width : 0;
  }, [container, spec.sample]);
  const [heads, setHeads] = useState<{ id: string; title: string; order: number; count: number; page: boolean }[]>([]);
  const swapped = useSwapGuard();
  const swap = (next: string | null, event: React.MouseEvent) => {
    swapped(event);
    setOpen(next);
  };
  useLayoutEffect(() => {
    if (!chrome.isConnected) container.appendChild(chrome);
    container.setAttribute("data-cmf", spec.id);
    container.setAttribute("data-cmf-variant", String(variant));
    container.setAttribute("data-cmf-view", open ?? "rest");
    const laid = rowsOf(container, spec);
    const taken = new Set<Laid>();
    const removed = new Set((layout.removed ?? []).map((entry) => entry.row));
    let order = 0;
    let cells = false;
    const next: typeof heads = [];
    const sections = layout.placements.flatMap((placement) => ("section" in placement ? [placement.section] : []));
    const inside = open ? sections.find((section) => section.id === open && paged(variant, section)) ?? null : null;
    const put = (entry: Laid, shown: boolean, cell: number | null, within: boolean) => {
      taken.add(entry);
      entry.row.style.order = String(order++);
      entry.row.setAttribute("data-cmf-row", entry.key);
      entry.row.toggleAttribute("data-cmf-hidden", !shown);
      entry.row.toggleAttribute("data-cmf-in", within && shown && !inside);
      if (cell) { entry.row.setAttribute("data-cmf-cell", ""); entry.row.style.gridColumn = `span ${cell}`; }
      else { entry.row.removeAttribute("data-cmf-cell"); entry.row.style.gridColumn = ""; }
    };
    const place = (placement: Placement, last: boolean) => {
      const keys = "section" in placement ? placement.section.rows : placement.rows;
      const members = laid.filter((entry) => !taken.has(entry) && (keys.includes(entry.key) || (last && !removed.has(entry.key))));
      if ("section" in placement) {
        if (!members.length) return;
        const section = placement.section;
        next.push({ id: section.id, title: section.title[lang], order: order++, count: members.length, page: paged(variant, section) });
        for (const entry of members) put(entry, open === section.id, null, true);
        return;
      }
      const span = placement.cells && members.length ? Math.floor(12 / Math.min(members.length, 4)) : null;
      if (span) cells = true;
      for (const entry of members) put(entry, !inside, span, false);
    };
    layout.placements.forEach((placement, index) => place(placement, index === layout.placements.length - 1));
    /* Named for removal: the row has another home, which the note lists. */
    for (const entry of laid) if (!taken.has(entry)) entry.row.setAttribute("data-cmf-hidden", "removed");
    container.toggleAttribute("data-cmf-cells", cells);
    /* The section rows are counted from the rows the product drew, which only the laid-out DOM knows. */
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setHeads((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [chrome, container, spec, variant, layout, open, lang, tick]);
  useEffect(() => () => { chrome.remove(); }, [chrome]);
  const inside = open ? heads.find((head) => head.id === open && head.page) ?? null : null;
  return createPortal(
    <>
      <style>{FAMILY_CSS}</style>
      {inside ? (
        <button type="button" className={sample} data-cmf-head="back" data-cmf-section={inside.id} style={{ order: -1 }} onClick={(event) => swap(null, event)}>
          <ChevronLeft aria-hidden />
          <span className="cmf-title">{inside.title}</span>
        </button>
      ) : heads.map((head) => (
        <button
          key={head.id}
          type="button"
          className={sample}
          data-cmf-head="section"
          data-cmf-section={head.id}
          data-cmf-opens={head.page ? "page" : "place"}
          aria-haspopup={head.page ? "menu" : undefined}
          aria-expanded={head.page ? undefined : open === head.id}
          style={{ order: head.order }}
          onClick={(event) => (head.page ? swap(head.id, event) : setOpen(open === head.id ? null : head.id))}
        >
          {lead ? <span aria-hidden style={{ width: lead, flexShrink: 0 }} /> : null}
          <span className="cmf-title">{head.title}</span>
          <span className="cmf-count">{head.count}</span>
          {/* A page is the arrow to the right; a section that opens in place points down, and up once it is open. */}
          {head.page ? <ChevronRight aria-hidden /> : open === head.id ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </button>
      ))}
    </>,
    chrome,
  );
}

/* A menu opened again is a new element: its sections start closed. */
const mounts = new WeakMap<HTMLElement, number>();
let mounted = 0;
const mountOf = (container: HTMLElement) => mounts.get(container) ?? (mounts.set(container, ++mounted), mounted);

/** Finds each family menu as the product opens it and lays it out. */
export function MenuFamily({ variant }: { variant: MenuVariant }) {
  const [found, setFound] = useState<{ container: HTMLElement; spec: FamilySpec }[]>([]);
  useEffect(() => {
    const scan = () => {
      const next = FAMILY_SPECS.flatMap((spec) => [...document.querySelectorAll<HTMLElement>(spec.container)].map((container) => ({ container, spec })));
      setFound((current) => (current.length === next.length && current.every((entry, index) => entry.container === next[index]!.container) ? current : next));
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <>{found.map(({ container, spec }) => <FamilyMenu key={`${spec.id}:${mountOf(container)}`} container={container} spec={spec} variant={variant} />)}</>;
}
