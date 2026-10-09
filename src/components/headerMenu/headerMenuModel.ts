/* The app header's ⋯ (docs/design/header-menu.md): the mix the operator
   chose on 2026-10-06, variant 2's row of icon cells on top and variant 3's
   rows below it. This file says where every entry of the menu stands; the
   components draw it and call each entry's own handler. */

import type { MemorySettingView } from "@/lib/memory/viewTypes";

/** Every entry of today's header menu (the design note's inventory), with the
    memory and key rows that were blocks of the old Settings dialog and the
    phone's two device rows. */
export const HEADER_ITEMS = [
  "activity", "team", "update", "qr", "language", "push", "memory", "key",
  "mapping", "dictation", "voice", "linked", "relay", "ping", "guide", "walk", "signOut", "sound", "awake",
] as const;
export type HeaderItem = (typeof HEADER_ITEMS)[number];
export type HeaderSurface = "desktop" | "phone";

export type HeaderRow =
  | { kind: "item"; item: HeaderItem }
  /** Opens as a page of the menu with a back row: in place it would pass the menu's 360 px. */
  | { kind: "page"; id: "settings" | "help"; items: readonly HeaderItem[] }
  /** Opens in place under its own row. */
  | { kind: "fold"; id: "help"; items: readonly HeaderItem[] };

export interface HeaderLayout {
  cells: readonly HeaderItem[];
  rows: readonly HeaderRow[];
}

const CELLS = ["activity", "team", "update"] as const;
const HELP_ITEMS = ["guide", "walk"] as const;

/* The desktop has no board-menu home for the language, the QR and the bell, so
   they stand here; the phone keeps them as the three buttons in its drawer
   header, keeps sound and keep-awake in this menu, and signs out on the Team
   page. The voice companion (#2519) is a desktop surface, so its settings are
   a desktop row only. */
export const HEADER_LAYOUTS: Record<HeaderSurface, HeaderLayout> = {
  desktop: {
    cells: CELLS,
    rows: [
      { kind: "item", item: "qr" },
      { kind: "page", id: "settings", items: ["language", "push", "memory", "key", "mapping", "dictation", "voice", "linked", "relay", "ping"] },
      { kind: "fold", id: "help", items: HELP_ITEMS },
      { kind: "item", item: "signOut" },
    ],
  },
  phone: {
    cells: CELLS,
    rows: [
      { kind: "page", id: "settings", items: ["sound", "awake", "memory", "key", "mapping", "dictation", "linked", "relay", "ping"] },
      /* A page on the phone: the sheet at rest already stands near today's 743 px, and in place it would scroll. */
      { kind: "page", id: "help", items: HELP_ITEMS },
    ],
  },
};

/** Where an entry stands on a surface, and how many presses from the closed menu reach it. */
export function headerHome(surface: HeaderSurface, item: HeaderItem): { where: "cell" | "rest" | "settings" | "help"; presses: number } | null {
  const layout = HEADER_LAYOUTS[surface];
  if (layout.cells.includes(item)) return { where: "cell", presses: 2 };
  for (const row of layout.rows) {
    if (row.kind === "item" && row.item === item) return { where: "rest", presses: 2 };
    if (row.kind !== "item" && row.items.includes(item)) return { where: row.id, presses: 3 };
  }
  return null;
}

/* ---- Shared memory's state, in words ---------------------------------- */

export type MemoryView = Partial<MemorySettingView> & { enabled: boolean; status?: "unavailable" };
export type MemoryTone = "working" | "off" | "noKey" | "capped" | "notOwner" | "unknown";

/** The one state a person needs at a glance, from the reasons the product
    reports: what blocks it first, the one a person can lift first among
    them, then the switch. */
export function memoryTone(view: MemoryView | null): MemoryTone {
  if (!view || view.status === "unavailable" || !view.reasons) return "unknown";
  for (const reason of ["noKey", "capped", "notOwner"] as const) if (view.reasons.includes(reason)) return reason;
  return view.reasons.includes("projectOff") || !view.enabled ? "off" : "working";
}

export const memoryBlocked = (tone: MemoryTone) => tone === "noKey" || tone === "capped" || tone === "notOwner";

type Lang = "en" | "uk";
const monthParts = (value: string | undefined) => {
  const [year, index] = (value ?? "").split("-").map(Number);
  return year && index ? { year, index } : null;
};

/** "жовтень" / "October" for a `2026-10` month. */
export function monthName(value: string | undefined, lang: Lang): string {
  const parts = monthParts(value);
  return parts ? new Date(Date.UTC(parts.year, parts.index - 1, 1)).toLocaleDateString(lang, { month: "long", timeZone: "UTC" }) : "";
}

/** The first day of the month after `value`: "1 листопада" / "November 1". */
export function monthResets(value: string | undefined, lang: Lang): string {
  const parts = monthParts(value);
  return parts ? new Date(Date.UTC(parts.year, parts.index, 1)).toLocaleDateString(lang, { day: "numeric", month: "long", timeZone: "UTC" }) : "";
}

/** Dollars with two decimals, and none on a whole amount. */
export const money = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
