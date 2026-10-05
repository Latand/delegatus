/*
 * The data behind the interface-redesign prototype
 * (docs/design/interface-redesign.md): the audit's inventory of today's
 * functions, the home each numbered variant gives every one of them, and the
 * rows of the regrouped menus. The prototype draws from this file and
 * `interfaceRedesign.prototype.model.test.ts` holds it complete, so a variant
 * cannot lose a function without saying so.
 *
 * Inventory ids are the ones in docs/design/interface-redesign-usage-audit.md.
 */

export type Lang = "en" | "uk";
export type Text = Record<Lang, string>;
const T = (en: string, uk: string): Text => ({ en, uk });

/* ── Inventory ─────────────────────────────────────────────────────────── */

export const INVENTORY: Record<string, string> = {
  S1: "Hide and restore the rail (B)",
  S2: "Filter projects by text",
  S3: "Create a project",
  S4: "Open Overview, select a project, read its counts",
  S5: "Pin a project with the crown",
  S6: "Archived projects",
  S7: "Fold the system footer",
  S8: "Resource pressure, sessions, stop idle sessions",
  S9: "Engine limits, accounts, usage history",
  S10: "Messaging integration status and setup",
  G1: "Language",
  G2: "Open on phone (QR, link, guide)",
  G3: "Browser push notifications",
  G4: "Setup guide",
  G5: "Interface walkthrough",
  G6: "Agent mapping",
  G7: "Dictation setup",
  G8: "Telemetry settings",
  G9: "Linked installations",
  G10: "External relay",
  G11: "Updates",
  G12: "Activity page",
  G13: "Team page",
  G14: "Sign out",
  B1: "Search my messages",
  B2: "Project account choices",
  B3: "Sound on or off, sound levels",
  B4: "Merge when review passes",
  B5: "Share with linked machines",
  B6: "Orchestrator reports delivery",
  B7: "Asks you (installation-wide)",
  B8: "Archive or unarchive the project",
  B9: "Delete the project (desktop)",
  B10: "Create agent, task or pipeline (phone menu)",
  B11: "Task list, pipelines list (phone menu)",
  B12: "Hidden work",
  B13: "Board or all conversations (phone menu)",
  B14: "Host details (phone menu)",
  B15: "Keep the screen awake (phone)",
  B16: "Phone copies of G4 to G13",
  W1: "Column menu",
  W2: "Card status menu",
  W3: "Full card menu",
  W4: "Pipeline group in the card menu",
  W5: "Stage menu",
  W6: "Reader menu",
  W7: "Standalone pipeline strip menu",
  W8: "Phone task overflow",
  W9: "Phone task lane sheet",
  W10: "Phone pipeline overflow",
  W11: "Agent strip overflow",
  W12: "Work links +N",
  W13: "Phone card action sheet",
  M1: "Pinned tasks and relations",
  M2: "Background tasks",
  M3: "Orchestrator seat sheet",
  M4: "Open the pipeline",
  M5: "Open a subagent (N rows)",
  M6: "Attention and pending decisions",
  M7: "Reports",
  M8: "Rename the conversation",
  M9: "Crown the conversation",
  M10: "Hand off",
  M11: "Predecessor conversation",
  M12: "Interrupt the running turn",
  M13: "Compact context",
  M14: "Host details",
  M15: "Terminal attach command",
  M16: "Recheck runtime state",
  M17: "Search (menu copy)",
  M18: "Project board menu",
  M19: "Close the conversation card",
  M20: "Stop the host",
  O1: "Background process menu",
  O2: "Member menu",
  O3: "Send chevron menu",
  O4: "Runtime selector",
  O5: "Microphone context menu",
  O6: "Speech context menu",
  O7: "Phone row swipe and long-press sheet",
  O8: "Conversation account badge menu",
};

/* ── Regrouped menus ───────────────────────────────────────────────────── */

export interface Row {
  key: string;
  label: Text;
  /** Inventory ids this row carries. */
  refs: string[];
  kind?: "row" | "danger" | "toggle" | "segment" | "chips";
  /** The choices of a segment or a chip row; each is one control. */
  choices?: Text[];
  /** A count or a state printed at the row's end. */
  trail?: Text;
  /** Rows a drill-in shows in place of the first view. */
  into?: Row[];
}
export interface Menu {
  title: Text;
  /** Two or three frequent actions drawn first, as wide buttons. */
  promoted: Row[];
  rows: Row[];
}

const row = (key: string, refs: string[], en: string, uk: string, extra: Partial<Row> = {}): Row => ({ key, refs, label: T(en, uk), ...extra });

const STATUS = [T("Inbox", "Вхідні"), T("Assigned", "У роботі"), T("Blocked", "Очікують"), T("Done", "Готові")];
const PRIORITY = [T("High", "Високий"), T("Normal", "Звичайний"), T("Low", "Низький")];
const LANGS = [T("English", "English"), T("Українська", "Українська")];
const VIEWS = [T("Board", "Дошка"), T("All conversations", "Усі розмови")];
const CREATE = [T("Agent", "Агент"), T("Task", "Задача"), T("Pipeline", "Пайплайн")];
/* The audit's sampled conversation carried 38 descendants. */
export const SUBAGENTS = 38;

const lane = (name: string): Row => row(`lane-${name}`, ["W4"], `Pipeline: ${name}`, `Пайплайн: ${name}`, {
  into: [
    row("lane-open", ["W4"], "Open the stages", "Відкрити етапи"),
    row("lane-links", ["W4"], "Attach work links", "Додати посилання"),
    row("lane-pause", ["W4"], "Pause", "Призупинити"),
    row("lane-retry", ["W4"], "Retry the stage", "Повторити етап"),
    row("lane-skip", ["W4"], "Skip the stage", "Пропустити етап"),
    row("lane-finish", ["W4"], "This lane finishes the task", "Ця лінія завершує задачу", { kind: "toggle" }),
    row("lane-close", ["W4"], "Close the lane", "Закрити лінію", { kind: "danger" }),
  ],
});

const SETUP = [
  row("setup-guide", ["G4", "B16"], "Setup guide", "Посібник із налаштування"),
  row("walk", ["G5", "B16"], "Interface walkthrough", "Огляд інтерфейсу"),
  row("mapping", ["G6", "B16"], "Agent mapping", "Відповідність агентів"),
  row("dictation", ["G7", "B16"], "Dictation", "Диктування"),
];
const CONNECTIONS = [
  row("linked", ["G9", "B16"], "Linked installations", "Пов’язані машини"),
  row("relay", ["G10", "B16"], "External relay", "Зовнішній релей"),
  row("update", ["G11", "B16"], "Updates", "Оновлення"),
  row("telemetry", ["G8", "B16"], "Telemetry", "Телеметрія"),
];
const PEOPLE = [
  row("activity", ["G12", "B16"], "Activity", "Активність"),
  row("team", ["G13", "B16"], "Team", "Команда"),
  row("signout", ["G14"], "Sign out", "Вийти", { kind: "danger" }),
];

/** Direction A: frequent actions promoted, the rest in named groups. */
export const MENUS_A: Record<string, Menu> = {
  board: {
    title: T("Project", "Проєкт"),
    promoted: [
      row("search", ["B1"], "Search my messages", "Пошук моїх повідомлень"),
      row("accounts", ["B2"], "Accounts", "Акаунти"),
    ],
    rows: [
      row("notify", ["B3", "B7"], "Notifications", "Сповіщення", { into: [
        row("sound", ["B3"], "Sound", "Звук", { kind: "toggle" }),
        row("levels", ["B3"], "Sound levels", "Рівні звуку"),
        row("asks", ["B7"], "Asks you", "Питає вас", { kind: "toggle" }),
      ] }),
      row("policies", ["B4", "B5", "B6"], "Project policies", "Правила проєкту", { into: [
        row("merge", ["B4"], "Merge when review passes", "Мерджити, коли рев’ю пройдено", { kind: "toggle" }),
        row("share", ["B5"], "Share with linked machines", "Поділитися з пов’язаними машинами", { kind: "toggle" }),
        row("reports", ["B6"], "Orchestrator reports", "Звіти оркестратора", { kind: "toggle" }),
      ] }),
      row("project", ["B8", "B9"], "Archive or delete", "Архів або видалення", { into: [
        row("archive", ["B8"], "Archive the project", "Архівувати проєкт"),
        row("delete", ["B9"], "Delete the project", "Видалити проєкт", { kind: "danger" }),
      ] }),
    ],
  },
  rail: {
    title: T("Delegatus", "Delegatus"),
    promoted: [
      row("language", ["G1"], "Language", "Мова", { kind: "segment", choices: LANGS }),
      row("phone", ["G2"], "Open on phone", "Відкрити на телефоні"),
      row("push", ["G3"], "Notifications", "Сповіщення", { kind: "toggle" }),
    ],
    rows: [
      row("setup", ["G4", "G5", "G6", "G7"], "Setup and guides", "Налаштування й посібники", { into: SETUP }),
      row("connections", ["G8", "G9", "G10", "G11"], "Connections and updates", "З’єднання й оновлення", { into: CONNECTIONS }),
      row("people", ["G12", "G13", "G14"], "Activity and team", "Активність і команда", { into: PEOPLE }),
    ],
  },
  card: {
    title: T("Task", "Задача"),
    promoted: [
      row("status", ["W3", "W2"], "Status", "Статус", { kind: "segment", choices: STATUS }),
      row("rename", ["W3"], "Rename", "Перейменувати"),
      row("hide", ["W3"], "Hide from the board", "Сховати з дошки"),
    ],
    rows: [
      row("priority", ["W3"], "Priority", "Пріоритет", { into: [row("priority-pick", ["W3"], "Priority", "Пріоритет", { kind: "segment", choices: PRIORITY })] }),
      row("appearance", ["W3"], "Colour and icon", "Колір і значок", { into: [
        row("colour", ["W3"], "Colour", "Колір", { kind: "chips", choices: Array.from({ length: 9 }, (_, index) => T(String(index), String(index))) }),
        row("icon", ["W3"], "Icon", "Значок"),
      ] }),
      row("details", ["W3"], "Details and links", "Деталі й посилання", { into: [
        row("description", ["W3"], "Edit the description", "Редагувати опис"),
        row("hold", ["W3"], "Hold reason", "Причина очікування"),
        row("links", ["W3"], "Attach work links", "Додати посилання"),
        row("collapse", ["W3"], "Collapse the card", "Згорнути картку"),
      ] }),
      lane("Search fix"),
      lane("Release notes"),
    ],
  },
  phoneBoard: {
    title: T("atlas", "atlas"),
    promoted: [
      row("tasks", ["B11"], "Tasks", "Задачі"),
      row("pipelines", ["B11"], "Pipelines", "Пайплайни"),
      row("hidden", ["B12"], "Hidden", "Сховані", { trail: T("2", "2") }),
    ],
    rows: [
      row("create", ["B10"], "Create", "Створити", { kind: "chips", choices: CREATE }),
      row("view", ["B13"], "View", "Вигляд", { kind: "segment", choices: VIEWS }),
      row("accounts", ["B2"], "Accounts and limits", "Акаунти й ліміти"),
      row("host", ["B14"], "Host details", "Стан хоста"),
      row("notify", ["B3", "B7", "B15", "G3"], "Notifications", "Сповіщення", { into: [
        row("sound", ["B3"], "Sound", "Звук", { kind: "toggle" }),
        row("levels", ["B3"], "Sound levels", "Рівні звуку"),
        row("asks", ["B7"], "Asks you", "Питає вас", { kind: "toggle" }),
        row("awake", ["B15"], "Keep the screen awake", "Не вимикати екран", { kind: "toggle" }),
        row("push", ["G3"], "Push notifications", "Push-сповіщення", { kind: "toggle" }),
      ] }),
      row("policies", ["B4", "B5", "B6", "B8"], "Project settings", "Налаштування проєкту", { into: [
        row("merge", ["B4"], "Merge when review passes", "Мерджити, коли рев’ю пройдено", { kind: "toggle" }),
        row("share", ["B5"], "Share with linked machines", "Поділитися з пов’язаними машинами", { kind: "toggle" }),
        row("reports", ["B6"], "Orchestrator reports", "Звіти оркестратора", { kind: "toggle" }),
        row("archive", ["B8"], "Archive the project", "Архівувати проєкт"),
      ] }),
      row("delegatus", ["G1", "G2", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G14", "B16"], "Delegatus", "Delegatus", { into: [
        row("language", ["G1"], "Language", "Мова", { kind: "segment", choices: LANGS }),
        row("phone", ["G2"], "Phone access link", "Посилання для телефона"),
        ...SETUP, ...CONNECTIONS, ...PEOPLE,
      ] }),
    ],
  },
  phoneConversation: {
    title: T("Orchestrator", "Оркестратор"),
    promoted: [
      row("interrupt", ["M12"], "Interrupt", "Перервати"),
      row("compact", ["M13"], "Compact", "Стиснути"),
      row("pipeline", ["M4"], "Pipelines", "Пайплайни"),
    ],
    rows: [
      row("attention", ["M6"], "Needs you", "Потрібні ви", { trail: T("3", "3") }),
      row("agents", ["M5"], "Agents", "Агенти", { trail: T(String(SUBAGENTS), String(SUBAGENTS)), into: [] }),
      row("context", ["M1", "M2", "M3", "M7", "M11"], "Context", "Контекст", { into: [
        row("pinned", ["M1"], "Pinned tasks", "Закріплені задачі"),
        row("background", ["M2"], "Background tasks", "Фонові задачі"),
        row("seat", ["M3"], "Orchestrator seat", "Місце оркестратора"),
        row("reports", ["M7"], "Reports", "Звіти"),
        row("predecessor", ["M11"], "Earlier conversation", "Попередня розмова"),
      ] }),
      row("conversation", ["M8", "M9", "M10", "M19"], "Conversation", "Розмова", { into: [
        row("rename", ["M8"], "Rename", "Перейменувати"),
        row("crown", ["M9"], "Crown", "Коронувати", { kind: "toggle" }),
        row("handoff", ["M10"], "Hand off", "Передати"),
        row("close", ["M19"], "Close the card", "Закрити картку"),
      ] }),
      row("host", ["M14", "M15", "M16", "M20"], "Host", "Хост", { into: [
        row("host-details", ["M14"], "Host details", "Стан хоста"),
        row("recheck", ["M16"], "Recheck the runtime", "Перевірити стан"),
        row("terminal", ["M15"], "Terminal command", "Команда для термінала"),
        row("stop", ["M20"], "Stop the host", "Зупинити хост", { kind: "danger" }),
      ] }),
      row("project", ["M18"], "Project menu", "Меню проєкту"),
    ],
  },
};

/** Direction B's one Settings place: two scopes, each a short list of sections. */
export interface SettingsSection { key: string; title: Text; scope: "project" | "delegatus"; rows: Row[] }
export const SETTINGS: SettingsSection[] = [
  { key: "accounts", scope: "project", title: T("Accounts", "Акаунти"), rows: [
    row("claude", ["B2"], "Claude account", "Акаунт Claude", { trail: T("Main", "Main") }),
    row("codex", ["B2"], "Codex account", "Акаунт Codex", { trail: T("Main", "Main") }),
  ] },
  { key: "policies", scope: "project", title: T("Policies", "Правила"), rows: [
    row("merge", ["B4"], "Merge when review passes", "Мерджити, коли рев’ю пройдено", { kind: "toggle" }),
    row("share", ["B5"], "Share with linked machines", "Поділитися з пов’язаними машинами", { kind: "toggle" }),
    row("reports", ["B6"], "Orchestrator reports", "Звіти оркестратора", { kind: "toggle" }),
  ] },
  { key: "lifecycle", scope: "project", title: T("Archive", "Архів"), rows: [
    row("archive", ["B8"], "Archive the project", "Архівувати проєкт"),
    row("delete", ["B9"], "Delete the project", "Видалити проєкт", { kind: "danger" }),
  ] },
  { key: "general", scope: "delegatus", title: T("General", "Загальні"), rows: [
    row("language", ["G1"], "Language", "Мова", { kind: "segment", choices: LANGS }),
    row("phone", ["G2"], "Open on phone", "Відкрити на телефоні"),
    row("awake", ["B15"], "Keep the screen awake", "Не вимикати екран", { kind: "toggle" }),
  ] },
  { key: "notifications", scope: "delegatus", title: T("Notifications", "Сповіщення"), rows: [
    row("push", ["G3"], "Push notifications", "Push-сповіщення", { kind: "toggle" }),
    row("sound", ["B3"], "Sound", "Звук", { kind: "toggle" }),
    row("levels", ["B3"], "Sound levels", "Рівні звуку"),
    row("asks", ["B7"], "Asks you", "Питає вас", { kind: "toggle" }),
  ] },
  { key: "setup", scope: "delegatus", title: T("Setup and guides", "Налаштування й посібники"), rows: SETUP },
  { key: "connections", scope: "delegatus", title: T("Connections and updates", "З’єднання й оновлення"), rows: [
    ...CONNECTIONS,
    row("telegram", ["S10"], "Telegram", "Telegram", { trail: T("Not connected", "Не підключено") }),
  ] },
  { key: "people", scope: "delegatus", title: T("Activity and team", "Активність і команда"), rows: PEOPLE },
];

/** Direction B: only what acts on the object itself; every setting is in Settings. */
export const MENUS_B: Record<string, Menu> = {
  board: {
    title: T("Project", "Проєкт"),
    promoted: [],
    rows: [
      row("search", ["B1"], "Search my messages", "Пошук моїх повідомлень"),
      row("settings-project", ["B2", "B4", "B5", "B6", "B8", "B9"], "Project settings", "Налаштування проєкту"),
      row("settings", ["B3", "B7"], "Delegatus settings", "Налаштування Delegatus"),
    ],
  },
  card: {
    title: T("Task", "Задача"),
    promoted: [row("status", ["W3", "W2"], "Status", "Статус", { kind: "segment", choices: STATUS })],
    rows: [
      row("priority", ["W3"], "Priority", "Пріоритет", { kind: "segment", choices: PRIORITY }),
      row("rename", ["W3"], "Rename", "Перейменувати"),
      row("details", ["W3"], "Details, colour and icon", "Деталі, колір і значок"),
      row("links", ["W3"], "Attach work links", "Додати посилання"),
      row("collapse", ["W3"], "Collapse the card", "Згорнути картку"),
      row("hide", ["W3"], "Hide from the board", "Сховати з дошки"),
      lane("Search fix"),
      lane("Release notes"),
    ],
  },
  phoneBoard: {
    title: T("atlas", "atlas"),
    promoted: [],
    rows: [
      row("tasks", ["B11"], "Tasks", "Задачі", { trail: T("13", "13") }),
      row("pipelines", ["B11"], "Pipelines", "Пайплайни", { trail: T("6", "6") }),
      row("hidden", ["B12"], "Hidden work", "Сховане", { trail: T("2", "2") }),
      row("view", ["B13"], "View", "Вигляд", { kind: "segment", choices: VIEWS }),
      row("create", ["B10"], "Create", "Створити", { kind: "chips", choices: CREATE }),
      row("host", ["B14"], "Host details", "Стан хоста"),
      row("settings", ["B2", "B3", "B4", "B5", "B6", "B7", "B8", "B15", "B16"], "Settings", "Налаштування"),
    ],
  },
  phoneConversation: {
    title: T("Orchestrator", "Оркестратор"),
    promoted: [],
    rows: [
      row("interrupt", ["M12"], "Interrupt", "Перервати"),
      row("compact", ["M13"], "Compact context", "Стиснути контекст"),
      row("pipeline", ["M4"], "Pipelines", "Пайплайни"),
      row("attention", ["M6"], "Needs you", "Потрібні ви", { trail: T("3", "3") }),
      row("agents", ["M5"], "Agents", "Агенти", { trail: T(String(SUBAGENTS), String(SUBAGENTS)), into: [] }),
      row("work", ["M1", "M2"], "Tasks and background work", "Задачі й фонова робота"),
      row("seat", ["M3"], "Orchestrator seat", "Місце оркестратора"),
      row("predecessor", ["M11"], "Earlier conversation", "Попередня розмова"),
      row("handoff", ["M10"], "Hand off", "Передати"),
      row("close", ["M19"], "Close the card", "Закрити картку"),
      row("host", ["M14", "M15", "M16", "M20"], "Host", "Хост", { into: [
        row("host-details", ["M14"], "Host details", "Стан хоста"),
        row("recheck", ["M16"], "Recheck the runtime", "Перевірити стан"),
        row("terminal", ["M15"], "Terminal command", "Команда для термінала"),
        row("stop", ["M20"], "Stop the host", "Зупинити хост", { kind: "danger" }),
      ] }),
      row("settings", ["M18"], "Settings", "Налаштування"),
    ],
  },
};

/** Rows direction B draws in the sheet's title row instead of the list. */
export const B_CONVERSATION_TITLE_REFS = ["M8", "M9"];

/**
 * What a direction takes out of a menu, and why. Each entry is said in the
 * design note; nothing else may be missing from a direction's rows.
 */
export const LEFT_OUT: Record<"A" | "B", Record<string, string>> = {
  A: {
    M17: "the phone header already carries Search; the menu's copy is the duplicate",
  },
  B: {
    M17: "the phone header already carries Search; the menu's copy is the duplicate",
    M7: "the orchestrator header already carries Reports; a conversation without that header keeps its row",
  },
};

export function refsOf(rows: Row[]): string[] {
  return rows.flatMap((entry) => [...entry.refs, ...(entry.into ? refsOf(entry.into) : [])]);
}

/** Controls a menu shows before any drill-in: each choice of a segment or chip row is one. */
export function firstViewControls(menu: Menu): number {
  const count = (entry: Row) => entry.choices && (entry.kind === "segment" || entry.kind === "chips") ? entry.choices.length : 1;
  return [...menu.promoted, ...menu.rows].reduce((sum, entry) => sum + count(entry), 0);
}

/** Presses from the closed menu to a row carrying `ref`: 1 opens the menu. */
export function pressesTo(menu: Menu, ref: string): number | null {
  const walk = (rows: Row[], depth: number): number | null => {
    for (const entry of rows) {
      if (entry.into) {
        const inside = walk(entry.into, depth + 1);
        if (inside !== null) return inside;
        if (entry.into.length === 0 && entry.refs.includes(ref)) return depth + 1;
      } else if (entry.refs.includes(ref)) return depth + 1;
    }
    return null;
  };
  return walk([...menu.promoted, ...menu.rows], 1);
}

/* ── Where every function lives, per variant ───────────────────────────── */

export interface Home { desktop: string; phone: string }
const H = (desktop: string, phone: string = desktop): Home => ({ desktop, phone });
const SAME = H("unchanged");

const SYSTEM_1 = "System chip in the board header, opens the System panel";
const SYSTEM_2 = "the rail's one System row, opens the System panel";
const SYSTEM_3 = "status ring at the rail's foot, opens the System panel";
const SHEET = "project sheet from the title";
const SETTINGS_1 = "Settings group of the Go-to palette";
const SETTINGS_2 = "Settings row at the rail's foot";
const SETTINGS_3 = "gear at the rail's foot";
const SHEET_SETTINGS = "Settings row of the project sheet";

/** Variants 1 to 3 move the rail (S) and its header menu (G); everything else stays where it is. */
export const SIDEBAR_HOMES: Record<string, { 1: Home; 2: Home; 3: Home }> = {
  S1: { 1: H("removed: there is no rail to hide; B opens the Go-to palette", "n/a (no rail on the phone)"), 2: H("hide control in the rail header; B", "n/a"), 3: H("collapse control at the rail's foot; B", "n/a") },
  S2: { 1: H("the palette's field, focused when it opens (title, B or Ctrl+K)", "field at the top of the project sheet (new on the phone)"), 2: H("field at the top of the rail", "field at the top of the project sheet (new on the phone)"), 3: H("field at the top of the open rail; / opens the rail on it", "field at the top of the project sheet (new on the phone)") },
  S3: { 1: H("New project row at the palette's foot", `${SHEET}, New project row`), 2: H("+ beside the rail's field", `${SHEET}, New project row`), 3: H("+ tile under the project tiles; + beside the field when open", `${SHEET}, New project row`) },
  S4: { 1: H("the board header's project title opens the palette: Overview, then projects with their counts", `${SHEET} (as today)`), 2: H("the rail's list", `${SHEET} (as today)`), 3: H("project tiles with an attention dot; names and counts when open", `${SHEET} (as today)`) },
  S5: { 1: H("crown at the end of a palette row", "crown at the end of a sheet row (new on the phone)"), 2: H("crown at the end of a rail row", "crown at the end of a sheet row (new on the phone)"), 3: H("crown at the end of a row when open; pinned tiles come first when closed", "crown at the end of a sheet row (new on the phone)") },
  S6: { 1: H("Archived fold at the end of the palette's projects", `${SHEET}, Archived fold (as today)`), 2: H("Archived fold at the end of the rail's list", `${SHEET}, Archived fold (as today)`), 3: H("Archived fold when open; the fold's tile opens the rail", `${SHEET}, Archived fold (as today)`) },
  S7: { 1: H("removed: the footer it folded is now one chip", "n/a"), 2: H("removed: the footer it folded is now one row", "n/a"), 3: H("removed: the footer it folded is now one ring", "n/a") },
  S8: { 1: H(SYSTEM_1, `${SHEET}, System row (as today's resource row)`), 2: H(SYSTEM_2, `${SHEET}, System row`), 3: H(SYSTEM_3, `${SHEET}, System row`) },
  S9: { 1: H(`${SYSTEM_1}; the chip prints the tightest limit`, "board menu, Accounts and limits (as today)"), 2: H(`${SYSTEM_2}; the row prints each engine's tightest limit`, "board menu, Accounts and limits (as today)"), 3: H(`${SYSTEM_3}; the ring is the tightest limit`, "board menu, Accounts and limits (as today)") },
  S10: { 1: H("Telegram row of the System panel", "board menu (as today)"), 2: H("Telegram row of the System panel", "board menu (as today)"), 3: H("Telegram row of the System panel", "board menu (as today)") },
  ...Object.fromEntries(["G1", "G2", "G3", "G14"].map((id) => [id, {
    1: H(SETTINGS_1, `${SHEET_SETTINGS} (new on the phone)`), 2: H(SETTINGS_2, `${SHEET_SETTINGS} (new on the phone)`), 3: H(SETTINGS_3, `${SHEET_SETTINGS} (new on the phone)`),
  }])),
  ...Object.fromEntries(["G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13"].map((id) => [id, {
    1: H(SETTINGS_1, "board menu (as today)"), 2: H(SETTINGS_2, "board menu (as today)"), 3: H(SETTINGS_3, "board menu (as today)"),
  }])),
};

const settingsHome = (ref: string): string => {
  const section = SETTINGS.find((entry) => refsOf(entry.rows).includes(ref));
  return section ? `Settings, ${section.scope === "project" ? "This project" : "Delegatus"}, ${section.title.en}` : "";
};
const menuHome = (menus: Record<string, Menu>, surface: string, ref: string): string => {
  const menu = menus[surface];
  if (!menu) return "";
  const top = [...menu.promoted, ...menu.rows].find((entry) => refsOf([entry]).includes(ref));
  if (!top) return "";
  const promoted = menu.promoted.includes(top);
  return `${promoted ? "promoted" : "row"} "${top.label.en}"${top.into && top.into.length ? ", one level in" : ""}`;
};

/** Variants 4 and 5 regroup the menus (G, B, the card and the phone conversation); the rail stays. */
export function menuHomes(direction: "A" | "B"): Record<string, Home> {
  const menus = direction === "A" ? MENUS_A : MENUS_B;
  const out: Record<string, Home> = {};
  for (const id of Object.keys(INVENTORY)) {
    const left = LEFT_OUT[direction][id];
    if (left) { out[id] = H(`left out: ${left}`); continue; }
    const family = id[0];
    if (family === "S") { out[id] = id === "S10" && direction === "B" ? H("rail footer (as today) and Settings, Delegatus, Connections", "Settings, Delegatus, Connections") : SAME; continue; }
    if (family === "O" || (family === "W" && !["W2", "W3", "W4", "W8"].includes(id))) { out[id] = SAME; continue; }
    if (id === "W8") { out[id] = H("n/a (phone)", "phone task overflow, in the card menu's grouping (drawn once, on the desktop card)"); continue; }
    if (family === "W") { out[id] = H(`card menu, ${menuHome(menus, "card", id)}`, "phone task overflow, same grouping"); continue; }
    if (family === "M") {
      const inTitle = direction === "B" && B_CONVERSATION_TITLE_REFS.includes(id);
      out[id] = H("n/a (phone menu)", inTitle ? "the conversation sheet's title row" : `conversation menu, ${menuHome(menus, "phoneConversation", id)}`);
      continue;
    }
    /* G and B: the rail's menu and the board's menu. */
    const phoneMenuOnly = ["B10", "B11", "B12", "B13", "B14", "B15", "B16"].includes(id);
    const phoneRow = menuHome(menus, "phoneBoard", id);
    const place = direction === "B" ? settingsHome(id) : "";
    const viaSettings = (where: string) => `${where} "Settings", then ${place}`;
    let desktop: string;
    if (phoneMenuOnly) desktop = "n/a (phone menu only, as today)";
    else if (direction === "B") desktop = place ? (family === "G" ? `gear in the rail header, then ${place}` : viaSettings("board menu,")) : `board menu, ${menuHome(menus, "board", id)}`;
    else desktop = family === "G" ? `rail menu, ${menuHome(menus, "rail", id)}` : `board menu, ${menuHome(menus, "board", id)}`;
    let phone: string;
    if (id === "B9") phone = "n/a (desktop only, as today)";
    else if (id === "B1") phone = "Search in the top bar (as today)";
    else if (id === "B16") phone = direction === "B" ? "board menu, Settings: the same sections as G4 to G13" : `board menu, ${phoneRow}`;
    else if (direction === "B" && place) phone = viaSettings("board menu,");
    else phone = `board menu, ${phoneRow}`;
    out[id] = H(desktop, phone);
  }
  return out;
}

/** Variant 7 is 1's shell with 5's menus: the rail's homes from 1, the rest from 5. */
export function combinedHomes(): Record<string, Home> {
  const menus = menuHomes("B");
  const out: Record<string, Home> = {};
  for (const id of Object.keys(INVENTORY)) {
    const sidebar = SIDEBAR_HOMES[id];
    if (id[0] === "S" && sidebar) out[id] = id === "S10" ? H("Telegram row of the System panel; Settings, Delegatus, Connections", "Settings, Delegatus, Connections") : sidebar[1];
    else if (id[0] === "G") out[id] = H(menus[id]!.desktop, menus[id]!.phone);
    else out[id] = menus[id]!;
  }
  return out;
}

/* ── Invented content the prototype's own chrome draws ─────────────────── */

export interface ProtoProject { name: string; live: number; needs: number; total: number; crowned: boolean; age: Text }
export const PROJECTS: ProtoProject[] = [
  { name: "atlas", live: 6, needs: 3, total: 26, crowned: true, age: T("31 s ago", "31 с тому") },
  { name: "harbor-ledger", live: 2, needs: 1, total: 418, crowned: true, age: T("4 min ago", "4 хв тому") },
  { name: "river-mesh", live: 0, needs: 0, total: 62, crowned: false, age: T("2 h ago", "2 год тому") },
  { name: "lantern-docs", live: 1, needs: 0, total: 24, crowned: false, age: T("43 min ago", "43 хв тому") },
  { name: "quarry", live: 0, needs: 0, total: 3, crowned: false, age: T("2 d ago", "2 д тому") },
];
export const ARCHIVED = ["old-kiln", "tidewater"];
export const LIMITS = [
  { engine: "Claude", plan: "max", windows: [{ label: T("5 h", "5 год"), left: 65 }, { label: T("Week", "Тиждень"), left: 56 }] },
  { engine: "Codex", plan: "pro", windows: [{ label: T("5 h", "5 год"), left: 60 }, { label: T("Week", "Тиждень"), left: 90 }] },
];
export const tightestLimit = (): number => Math.min(...LIMITS.flatMap((entry) => entry.windows.map((window) => window.left)));
