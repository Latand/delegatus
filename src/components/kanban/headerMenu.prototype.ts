import type { ComponentType } from "react";
import {
  Activity, AppWindow, Bell, Bot, Brain, Cable, CircleArrowUp, Compass, GraduationCap, Languages, LayoutGrid, LifeBuoy, Link2, ListChecks, LogOut, MessagesSquare, Mic,
  QrCode, Route, Server, Settings, ShieldCheck, SlidersHorizontal, Smartphone, Users, Volume2, type LucideIcon,
} from "lucide-react";

import type { Dress, FamilySpec, Placement, Words } from "./compactMenus.family.prototype";
import { MemoryDot, MemoryPill } from "./headerMemory.prototype";

/* Design prototype (docs/design/compact-card-menu.md, "The header's menu"):
   three groupings of the app header's ⋯, drawn in the look of the chosen card
   menu: icons, rows that open in place, compact. Every variant holds the same
   entries, each pressing the product's own row; they differ in which group an
   entry sits in and what the group and the entry are called. The evidence
   fixture mounts one under `?header=1|2|3`. */

/** Sent by the memory entry before it presses the Settings row, so the dialog opens with memory first. */
export const HEADER_MEMORY_EVENT = "cmf:header-memory";

export const HEADER_VARIANTS = [1, 2, 3] as const;
export type HeaderVariant = (typeof HEADER_VARIANTS)[number];

/** Every entry of today's header menu, and the phone's rows that stand for it in the board menu. */
export const HEADER_ITEMS = {
  language: { rail: "language", phone: null, icon: Languages, today: { en: "Language", uk: "Мова" } },
  qr: { rail: "qr", phone: null, icon: QrCode, today: { en: "Open on phone (QR)", uk: "Відкрити на телефоні (QR)" } },
  push: { rail: "push", phone: null, icon: Bell, today: { en: "Notifications", uk: "Сповіщення" } },
  guide: { rail: "rail-menu-setup-guide", phone: "setup-guide", icon: Compass, today: { en: "Setup guide", uk: "Посібник із налаштування" } },
  walk: { rail: "rail-menu-interface-walk", phone: "interface-walk", icon: Route, today: { en: "Interface walk", uk: "Екскурсія інтерфейсом" } },
  mapping: { rail: "rail-menu-agent-mapping", phone: "agent-mapping", icon: SlidersHorizontal, today: { en: "Agent mapping", uk: "Призначення агентів" } },
  dictation: { rail: "rail-menu-dictation", phone: "dictation", icon: Mic, today: { en: "Dictation", uk: "Диктування" } },
  settings: { rail: "rail-menu-settings", phone: "settings", icon: ShieldCheck, today: { en: "Settings", uk: "Налаштування" } },
  /* The shared memory block of the Settings dialog (#2536): no row of its own today. */
  memory: { rail: "memory", phone: "memory", icon: Brain, today: { en: "Shared memory for this project", uk: "Спільна пам’ять для цього проєкту" } },
  linked: { rail: "rail-menu-linked-settings", phone: "linked-settings", icon: Link2, today: { en: "Linked installs", uk: "Пов’язані інсталяції" } },
  relay: { rail: "rail-menu-external-relay", phone: "external-relay", icon: MessagesSquare, today: { en: "External relay", uk: "Зовнішній ретранслятор" } },
  update: { rail: "rail-menu-update", phone: "self-update", icon: CircleArrowUp, today: { en: "Update", uk: "Оновлення" } },
  activity: { rail: "rail-menu-activity", phone: "activity", icon: Activity, today: { en: "Activity", uk: "Активність" } },
  team: { rail: "rail-menu-team", phone: "team", icon: Users, today: { en: "Team", uk: "Команда" } },
  signOut: { rail: "rail-menu-sign-out", phone: null, icon: LogOut, today: { en: "Sign out · {name}", uk: "Вийти · {name}" } },
  /* The phone's own device rows, which the desktop keeps in the board's ⋯. */
  sound: { rail: null, phone: "sound-settings-trigger", icon: Volume2, today: { en: "Sound alerts", uk: "Звукові сповіщення" } },
  awake: { rail: null, phone: "keep-awake-row", icon: Smartphone, today: { en: "Keep screen awake", uk: "Не гасити екран" } },
} as const satisfies Record<string, { rail: string | null; phone: string | null; icon: LucideIcon; today: Words }>;
export type HeaderItem = keyof typeof HEADER_ITEMS;

export interface HeaderGroup {
  id: string; title: Words; icon: LucideIcon; items: readonly HeaderItem[];
  /** The name the group takes on the phone, where its rows are the device's. */
  phoneTitle?: Words;
  /** Opens as a page: in place it would pass the menu's bound. */
  page?: boolean;
  /** A page on the phone only, where the sheet is already near today's height. */
  phonePage?: boolean;
  /** The group's row carries the state of shared memory, which it holds. */
  memoryDot?: boolean;
}
export type HeaderSlot = { items: readonly HeaderItem[]; cells?: boolean } | { group: HeaderGroup };
export interface HeaderLayout {
  name: Words;
  idea: Words;
  /** Old name → new name; an entry not listed keeps today's. */
  names: Partial<Record<HeaderItem, Words>>;
  slots: readonly HeaderSlot[];
}

const row = (...items: HeaderItem[]): HeaderSlot => ({ items });
const group = (id: string, en: string, uk: string, icon: LucideIcon, items: readonly HeaderItem[], more: Partial<HeaderGroup> = {}): HeaderSlot => ({ group: { id, title: { en, uk }, icon, items, ...more } });

export const HEADER_LAYOUTS: Record<HeaderVariant, HeaderLayout> = {
  1: {
    name: { en: "Whose it is", uk: "Чиє це" },
    idea: {
      en: "A group is named after what a change in it touches: this browser, this installation, the people who can get in. What is opened to read (the time report, an update, help) stays outside the groups.",
      uk: "Група названа тим, чого торкається зміна в ній: цей браузер, ця інсталяція, люди з доступом. Те, що відкривають почитати (звіт про час, оновлення, довідка), стоїть поза групами.",
    },
    names: {
      qr: { en: "Open on phone", uk: "Відкрити на телефоні" },
      mapping: { en: "Agents by role", uk: "Агенти для ролей" },
      dictation: { en: "Speech recognition", uk: "Розпізнавання мовлення" },
      linked: { en: "Linked machines", uk: "Пов’язані комп’ютери" },
      relay: { en: "Questions from chats", uk: "Питання з чатів" },
      settings: { en: "Privacy", uk: "Приватність" },
      memory: { en: "Project memory", uk: "Пам’ять проєкту" },
    },
    slots: [
      row("activity", "update", "memory"),
      group("device", "This browser", "Цей браузер", AppWindow, ["language", "push", "sound", "awake"], { phoneTitle: { en: "This device", uk: "Цей пристрій" }, phonePage: true }),
      group("install", "This installation", "Ця інсталяція", Server, ["mapping", "dictation", "linked", "relay", "settings"], { page: true }),
      group("people", "People and access", "Люди й доступ", Users, ["team", "qr", "signOut"]),
      group("help", "Help", "Довідка", LifeBuoy, ["guide", "walk"], { phonePage: true }),
    ],
  },
  2: {
    name: { en: "What I came to do", uk: "Що я хочу зробити" },
    idea: {
      en: "The three places opened most are icon cells at the top; the rest is grouped by the job at hand: set up the agents, connect something, tune language and alerts, learn the product. The entry called Settings is named for the one thing its two switches share: what leaves this machine.",
      uk: "Три місця, які відкривають найчастіше, стоять клітинками з іконками вгорі; решта згрупована за справою: налаштувати агентів, щось підключити, мова й сповіщення, навчитися. Пункт «Налаштування» названо тим, що об’єднує два його перемикачі: що йде з цього комп’ютера назовні.",
    },
    names: {
      qr: { en: "Open on phone", uk: "Відкрити на телефоні" },
      mapping: { en: "Who does what", uk: "Хто що робить" },
      dictation: { en: "Voice input", uk: "Голосове введення" },
      linked: { en: "Other installs", uk: "Інші інсталяції" },
      relay: { en: "Outside chats", uk: "Зовнішні чати" },
      settings: { en: "Install ping", uk: "Анонімний пінг" },
      memory: { en: "Shared memory", uk: "Спільна пам’ять" },
    },
    slots: [
      { items: ["activity", "team", "update"], cells: true },
      group("agents", "Agents and voice", "Агенти й голос", Bot, ["mapping", "dictation"]),
      group("connect", "Connections", "Підключення", Cable, ["qr", "linked", "relay"]),
      group("alerts", "Language and alerts", "Мова й сповіщення", Bell, ["language", "push", "sound", "awake"], { phoneTitle: { en: "Sound and screen", uk: "Звук і екран" }, phonePage: true }),
      group("outbound", "What leaves here", "Що йде назовні", ShieldCheck, ["memory", "settings"], { memoryDot: true }),
      group("learn", "How to use it", "Як користуватися", GraduationCap, ["guide", "walk"]),
      row("signOut"),
    ],
  },
  3: {
    name: { en: "Settings that are settings", uk: "Справжні «Налаштування»" },
    idea: {
      en: "The word Settings stays and becomes true: one page holds every switch and table of this browser and this installation, each under a name that says what it sets. The first level is only places to go: the time report, the team, the phone, the update, help.",
      uk: "Слово «Налаштування» лишається і стає правдою: одна сторінка тримає кожен перемикач і таблицю цього браузера й цієї інсталяції, кожен під назвою, що каже, що саме він налаштовує. На першому рівні лише місця, куди йдуть: звіт про час, команда, телефон, оновлення, довідка.",
    },
    names: {
      qr: { en: "Open on phone", uk: "Відкрити на телефоні" },
      activity: { en: "Time report", uk: "Звіт про час" },
      team: { en: "Team and sessions", uk: "Команда й сеанси" },
      mapping: { en: "Roles: engine and model", uk: "Ролі: рушій і модель" },
      relay: { en: "Chat relay", uk: "Ретранслятор чатів" },
      settings: { en: "Install ping", uk: "Анонімний пінг" },
      memory: { en: "Project memory", uk: "Пам’ять проєкту" },
    },
    slots: [
      row("activity", "team", "qr", "update"),
      group("settings", "Settings", "Налаштування", Settings, ["language", "push", "sound", "awake", "memory", "mapping", "dictation", "linked", "relay", "settings"], { page: true, memoryDot: true }),
      group("help", "Help and learning", "Довідка й навчання", LifeBuoy, ["guide", "walk"]),
      row("signOut"),
    ],
  },
};

/** The name an entry carries in a variant. */
export const headerName = (variant: HeaderVariant, item: HeaderItem): Words => HEADER_LAYOUTS[variant].names[item] ?? HEADER_ITEMS[item].today;

/** Where an entry is in a variant: at rest, or the group that holds it. */
export function headerHome(variant: HeaderVariant, item: HeaderItem): { group: HeaderGroup | null; cell: boolean } | null {
  for (const slot of HEADER_LAYOUTS[variant].slots) {
    if ("group" in slot) { if (slot.group.items.includes(item)) return { group: slot.group, cell: false }; }
    else if (slot.items.includes(item)) return { group: null, cell: Boolean(slot.cells) };
  }
  return null;
}

type Surface = "rail" | "phone";

function placements(variant: HeaderVariant, surface: Surface): Placement[] {
  return HEADER_LAYOUTS[variant].slots.flatMap((slot): Placement[] => {
    const keys = ("group" in slot ? slot.group.items : slot.items).flatMap((item) => HEADER_ITEMS[item][surface] ?? []);
    if (!keys.length) return [];
    if (!("group" in slot)) return [{ rows: keys, cells: slot.cells }];
    const { id, title, phoneTitle, icon, page, phonePage, memoryDot } = slot.group;
    return [{ section: { trail: memoryDot ? MemoryDot as ComponentType : undefined, id, title: surface === "phone" ? phoneTitle ?? title : title, rows: keys, icon, page: page || (surface === "phone" && phonePage), solo: true } }];
  });
}

/* The header's rows carry no icon today, so every one is drawn with its own;
   the phone's rows carry theirs, so only a renamed row and the three that
   have none are drawn over. */
function dress(variant: HeaderVariant, surface: Surface): Record<string, Dress> {
  const out: Record<string, Dress> = {};
  for (const [item, entry] of Object.entries(HEADER_ITEMS) as [HeaderItem, (typeof HEADER_ITEMS)[HeaderItem]][]) {
    const key = entry[surface];
    const name = HEADER_LAYOUTS[variant].names[item];
    if (!key) continue;
    if (item === "memory") out[key] = { icon: entry.icon, name, trail: MemoryPill };
    else if (surface === "rail") out[key] = { icon: entry.icon, name };
    else if (name || item === "settings" || item === "linked" || item === "relay") out[key] = { icon: entry.icon, name };
  }
  return out;
}

const PHONE_CREATE = ["new-task", "new-agent", "new-pipeline"];
const PHONE_POLICY = ["merge-on-review", "share-project", "bridge-reports", "asks-you", "project-archive", "project-unarchive", "project-delete"];

/** The header's menu and the phone's board menu, laid out as one header variant. The rows that belong to the board keep the chosen card menu's layout. */
export function headerFamilySpecs(variant: HeaderVariant): FamilySpec[] {
  const same = <T,>(layout: T) => ({ 1: layout, 2: layout, 3: layout });
  return [
    {
      id: "header",
      container: "[data-rail-menu-panel]",
      leading: ["language", "qr", "push"],
      sample: "button[data-rail-menu-settings]",
      dress: dress(variant, "rail"),
      virtual: { memory: { press: "[data-rail-menu-settings]", event: HEADER_MEMORY_EVENT } },
      ordered: true,
      layouts: same({ placements: placements(variant, "rail") }),
    },
    {
      id: "phone-board",
      container: "[data-mobile2-sheet='menu'] [role='menu']:has([data-mobile2-menu-row='new-task'])",
      sample: "button[data-mobile2-menu-row='tasks']",
      dress: dress(variant, "phone"),
      virtual: { memory: { press: "[data-mobile2-menu-row='settings']", event: HEADER_MEMORY_EVENT } },
      ordered: true,
      layouts: same({
        placements: [
          { rows: PHONE_CREATE, cells: true },
          { rows: ["tasks", "pipelines", "hidden"] },
          { section: { id: "view", title: { en: "View and places", uk: "Вигляд і розділи" }, rows: ["view-board", "view-catalog", "accounts", "host"], page: true, icon: LayoutGrid } },
          ...placements(variant, "phone"),
          { section: { id: "policy", title: { en: "Project rules", uk: "Правила проєкту" }, rows: PHONE_POLICY, page: true, icon: ListChecks } },
        ],
      }),
    },
  ];
}
