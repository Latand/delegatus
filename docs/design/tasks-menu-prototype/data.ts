/*
 * Fixture for the tasks-menu prototype. The tasks are modelled on the live
 * Delegatus board of 2026-10-12 (titles of this public repository's own work,
 * statuses, stages, PR numbers and the gaps between `updatedAt` and the last
 * real work measured in the audit), plus two invented side projects for the
 * «all projects» scope. Every time is minutes before the page loaded, so the
 * ages the frames print are the ones the operator would read.
 *
 * `updatedMin` is what the stored row says; `workMin` is the newest real work
 * (stage attempt, assignment, agent activity or PR event). The original panel
 * sorts by the first, every variant by the second.
 */
import type { StageChipState } from "@/lib/pipelines/stageChip";
import { taskMotion, type TaskMotion } from "@/lib/tasks/motion";
import type { BoardTask, TaskColor, TaskHold, TaskStatus } from "@/lib/tasks/types";
import type { PullRequestState, ResolvedWorkLinks } from "@/lib/forge/workLinks";

export type AgentState = "working" | "check" | "idle" | "needs-you" | "finished" | "failed";
export type Role = "architect" | "builder" | "reviewer" | "verifier" | "merger" | "orchestrator";
export type Bilingual = { en: string; uk: string };

export interface ProtoStage {
  id: string;
  role: Role;
  engine: "claude" | "codex";
  model: string;
  state: StageChipState;
}

export interface ProtoPr {
  number: number;
  state: PullRequestState;
}

export interface ProtoEvent {
  min: number;
  kind: "stage_started" | "stage_passed" | "stage_failed" | "pr_opened" | "pr_merged" | "checks" | "pushed" | "asked" | "assigned" | "created";
  stage?: string;
  pr?: number;
}

export interface ProtoTask {
  id: string;
  project: string;
  title: Bilingual;
  body?: Bilingual;
  status: TaskStatus;
  color?: TaskColor;
  icon?: string;
  updatedMin: number;
  createdMin: number;
  /** Newest real work, minutes ago; null when nothing ever ran. */
  workMin: number | null;
  stages: ProtoStage[];
  agent?: { state: AgentState; sinceMin: number };
  pr?: ProtoPr;
  hold?: { kind: TaskHold["kind"]; note: Bilingual; ref?: string; sinceMin: number };
  events: ProtoEvent[];
  assignments: number;
}

export interface ProtoAgent {
  id: string;
  project: string;
  kind: "stage" | "spawned";
  role: Role;
  stage?: string;
  engine: "claude" | "codex";
  model: string;
  state: AgentState;
  launchedMin: number;
  stateMin: number;
  taskId: string | null;
  title?: Bilingual;
}

export const PROJECT = "repo-delegatus";
export const PROJECT_NAMES: Record<string, string> = { "repo-delegatus": "delegatus", "repo-landing": "landing-site", "repo-notes": "notes-app" };

const S = (id: string, role: Role, engine: "claude" | "codex", model: string, state: StageChipState): ProtoStage => ({ id, role, engine, model, state });
const OPUS = "claude-opus-5-5";
const SOL = "gpt-6-sol";
const ASTRA = "gpt-6-astra";

export const TASKS: ProtoTask[] = [
  {
    id: "t-menu", project: PROJECT, status: "assigned", color: "violet", icon: "list-todo", updatedMin: 2, createdMin: 70, workMin: 3,
    title: { uk: "Меню «Задачі»: свіжі задачі зверху, з деталями", en: "Tasks menu: recent tasks first, with real detail" },
    body: { uk: "Аудит поточного меню і 2–3 варіанти: свіжа робота зверху, деталі в рядку, список запущених агентів.", en: "Audit the current menu and draw 2–3 variants: recent work first, detail in the row, a list of launched agents." },
    stages: [S("prototype", "architect", "claude", OPUS, "needs_decision")], agent: { state: "needs-you", sinceMin: 3 },
    hold: { kind: "operator", note: { uk: "обрати варіант меню", en: "pick a menu variant" }, sinceMin: 3 },
    events: [{ min: 3, kind: "asked" }, { min: 68, kind: "stage_started", stage: "prototype" }, { min: 70, kind: "created" }], assignments: 1,
  },
  {
    id: "t-header", project: PROJECT, status: "assigned", color: "sky", icon: "panel-top", updatedMin: 3, createdMin: 90, workMin: 1,
    title: { uk: "Хедер дошки не перевантажений і нічого не накладається", en: "The board header is uncluttered and nothing overlaps" },
    stages: [S("prototype", "architect", "claude", OPUS, "running")], agent: { state: "working", sinceMin: 18 },
    events: [{ min: 18, kind: "stage_started", stage: "prototype" }, { min: 88, kind: "stage_failed", stage: "prototype" }], assignments: 2,
  },
  {
    id: "t-login", project: PROJECT, status: "assigned", color: "teal", icon: "user-check", updatedMin: 11, createdMin: 260, workMin: 4,
    title: { uk: "Після входу в акаунт його статус оновлюється сам", en: "After a login the account status refreshes by itself" },
    body: { uk: "Картка акаунта сама перечитує стан і ліміти після входу, без ручного «Оновити».", en: "The account card re-reads its status and limits after a login, with no manual Refresh." },
    stages: [S("build", "builder", "claude", OPUS, "passed"), S("review", "reviewer", "codex", ASTRA, "passed"), S("ui-fix", "builder", "codex", SOL, "running"), S("ui-check", "verifier", "claude", OPUS, "pending")],
    agent: { state: "working", sinceMin: 22 }, pr: { number: 2776, state: "open" },
    events: [{ min: 4, kind: "pushed" }, { min: 22, kind: "stage_started", stage: "ui-fix" }, { min: 41, kind: "stage_passed", stage: "review" }, { min: 63, kind: "pr_opened", pr: 2776 }, { min: 64, kind: "stage_passed", stage: "build" }], assignments: 3,
  },
  {
    id: "t-activity", project: PROJECT, status: "assigned", color: "amber", icon: "activity", updatedMin: 190, createdMin: 300, workMin: 2,
    title: { uk: "Стан агента правдивий: працює, чекає на перевірку чи простоює", en: "Agent activity tells the truth: working, waiting on a check, or idle" },
    stages: [S("build", "builder", "claude", OPUS, "running"), S("review", "reviewer", "codex", ASTRA, "pending")], agent: { state: "working", sinceMin: 40 },
    events: [{ min: 40, kind: "stage_started", stage: "build" }, { min: 120, kind: "stage_failed", stage: "review" }], assignments: 2,
  },
  {
    id: "t-cpu", project: PROJECT, status: "assigned", color: "slate", icon: "cpu", updatedMin: 35, createdMin: 900, workMin: 6,
    title: { uk: "CPU-черга не голодує: 10 хвилин очікування, далі по черзі", en: "CPU admission never starves: a 10-minute wait, then queue order" },
    stages: [S("build", "builder", "codex", SOL, "passed"), S("review", "reviewer", "claude", OPUS, "failed"), S("fix", "builder", "codex", ASTRA, "running")],
    agent: { state: "working", sinceMin: 48 }, pr: { number: 2773, state: "open" },
    events: [{ min: 6, kind: "pushed" }, { min: 48, kind: "stage_started", stage: "fix" }, { min: 50, kind: "stage_failed", stage: "review" }, { min: 180, kind: "pr_opened", pr: 2773 }], assignments: 3,
  },
  {
    id: "t-memory", project: PROJECT, status: "assigned", color: "violet", icon: "brain", updatedMin: 115, createdMin: 400, workMin: 9,
    title: { uk: "Повторювані зауваження рев’ю потрапляють у пам’ять ролей", en: "Recurring review findings reach the role memory" },
    stages: [S("build", "builder", "claude", OPUS, "running")], agent: { state: "working", sinceMin: 55 },
    events: [{ min: 55, kind: "stage_started", stage: "build" }], assignments: 1,
  },
  {
    id: "t-phone-menu", project: PROJECT, status: "assigned", color: "coral", icon: "smartphone", updatedMin: 50, createdMin: 240, workMin: 11,
    title: { uk: "Меню «…» на телефоні не дає горизонтального скролу", en: "Phone «…» menus never add sideways scroll" },
    stages: [S("build", "builder", "codex", SOL, "committing")], agent: { state: "check", sinceMin: 11 },
    events: [{ min: 11, kind: "checks" }, { min: 65, kind: "stage_started", stage: "build" }], assignments: 1,
  },
  {
    id: "t-needs", project: PROJECT, status: "assigned", color: "pink", icon: "inbox", updatedMin: 60, createdMin: 1300, workMin: 15,
    title: { uk: "«Чекають на вас» лишає тільки справжні рішення", en: "«Waiting on you» keeps only real decisions" },
    stages: [S("build", "builder", "claude", OPUS, "passed"), S("refresh", "merger", "codex", SOL, "running")],
    agent: { state: "check", sinceMin: 15 }, pr: { number: 2769, state: "open" },
    events: [{ min: 15, kind: "checks", pr: 2769 }, { min: 75, kind: "stage_started", stage: "refresh" }, { min: 900, kind: "pr_opened", pr: 2769 }], assignments: 2,
  },
  {
    id: "t-limit", project: PROJECT, status: "blocked", color: "amber", icon: "gauge", updatedMin: 100, createdMin: 400, workMin: 100,
    title: { uk: "Ліміт паралельних воркерів — одне налаштування на всю машину", en: "One machine-wide parallel-worker limit" },
    stages: [S("brief", "architect", "claude", OPUS, "needs_decision")], agent: { state: "needs-you", sinceMin: 100 },
    hold: { kind: "operator", note: { uk: "ліміт на машину чи на проєкт?", en: "per machine or per project?" }, sinceMin: 100 },
    events: [{ min: 100, kind: "asked" }, { min: 130, kind: "stage_started", stage: "brief" }], assignments: 1,
  },
  {
    id: "t-profiles", project: PROJECT, status: "blocked", color: "violet", icon: "book-open", updatedMin: 25, createdMin: 2000, workMin: 25,
    title: { uk: "Профілі пам’яті проєкту з потоковими підсумками", en: "Project memory profiles with streamed summaries" },
    stages: [S("build", "builder", "claude", OPUS, "passed"), S("refresh", "merger", "codex", SOL, "passed")],
    agent: { state: "idle", sinceMin: 25 }, pr: { number: 2766, state: "draft" },
    hold: { kind: "pr", ref: "https://forge.example/delegatus/pull/2762", note: { uk: "там міграція, без якої ця не працює", en: "it carries the migration this one needs" }, sinceMin: 25 },
    events: [{ min: 25, kind: "stage_passed", stage: "refresh" }, { min: 1500, kind: "pr_opened", pr: 2766 }], assignments: 2,
  },
  {
    id: "t-voice", project: PROJECT, status: "assigned", color: "teal", icon: "mic", updatedMin: 52, createdMin: 2600, workMin: 52,
    title: { uk: "Голос на підписці Codex, частина 3", en: "Voice on the Codex subscription, slice 3" },
    stages: [S("refresh", "merger", "claude", OPUS, "failed")], agent: { state: "failed", sinceMin: 52 }, pr: { number: 2767, state: "open" },
    hold: { kind: "external", note: { uk: "чекає, поки main знову стане зеленим", en: "waits for main to turn green again" }, sinceMin: 52 },
    events: [{ min: 52, kind: "stage_failed", stage: "refresh" }, { min: 2400, kind: "pr_opened", pr: 2767 }], assignments: 2,
  },
  {
    id: "t-avatars", project: PROJECT, status: "assigned", color: "coral", icon: "drama", updatedMin: 70, createdMin: 3000, workMin: 70,
    title: { uk: "Ролі-аватари: Delegatus у костюмі кожної ролі", en: "Role avatars: Delegatus in each role's costume" },
    stages: [S("refresh", "merger", "codex", SOL, "pending")], pr: { number: 2754, state: "open" },
    hold: { kind: "worker", note: { uk: "черга воркерів", en: "worker queue" }, sinceMin: 70 },
    events: [{ min: 70, kind: "assigned" }, { min: 2900, kind: "pr_opened", pr: 2754 }], assignments: 2,
  },
  {
    id: "t-landing", project: PROJECT, status: "done", color: "sky", icon: "smartphone", updatedMin: 12, createdMin: 420, workMin: 14,
    title: { uk: "Лендінг на телефоні: демо-екрани не перехоплюють свайп", en: "Landing on the phone: demo frames let the page scroll" },
    stages: [S("build", "builder", "codex", SOL, "passed"), S("review", "reviewer", "claude", OPUS, "passed")], agent: { state: "finished", sinceMin: 14 }, pr: { number: 2775, state: "merged" },
    events: [{ min: 14, kind: "pr_merged", pr: 2775 }, { min: 30, kind: "stage_passed", stage: "review" }], assignments: 2,
  },
  {
    id: "t-privacy", project: PROJECT, status: "done", color: "slate", icon: "shield-check", updatedMin: 58, createdMin: 600, workMin: 60,
    title: { uk: "Перевірка приватності перед пушем вкладається в бюджет", en: "The privacy check before a push stays within its budget" },
    stages: [S("build", "builder", "claude", OPUS, "passed")], agent: { state: "finished", sinceMin: 60 }, pr: { number: 2774, state: "merged" },
    events: [{ min: 60, kind: "pr_merged", pr: 2774 }], assignments: 1,
  },
  {
    id: "t-transcript", project: PROJECT, status: "done", color: "teal", icon: "message-square", updatedMin: 115, createdMin: 1400, workMin: 118,
    title: { uk: "Розмова тримає 60% колонки: «Стоп» поруч із «Надіслати»", en: "The transcript keeps 60% of the column: Stop beside Send" },
    stages: [S("build", "builder", "claude", OPUS, "passed"), S("ui-check", "verifier", "claude", OPUS, "passed")], pr: { number: 2756, state: "merged" },
    events: [{ min: 118, kind: "pr_merged", pr: 2756 }], assignments: 2,
  },
  {
    id: "t-telegram", project: PROJECT, status: "done", color: "sky", icon: "send", updatedMin: 140, createdMin: 2000, workMin: 140,
    title: { uk: "Питання й прототипи прямо в Telegram", en: "Questions and prototypes right in Telegram" },
    stages: [S("build", "builder", "codex", SOL, "passed")], pr: { number: 2751, state: "merged" },
    events: [{ min: 140, kind: "pr_merged", pr: 2751 }], assignments: 1,
  },
  {
    id: "t-voice-read", project: PROJECT, status: "inbox", color: "teal", icon: "mic", updatedMin: 80, createdMin: 80, workMin: null,
    title: { uk: "Голос може дочитати повідомлення оркестратора до кінця", en: "Voice can read an orchestrator message to the end" },
    stages: [], events: [{ min: 80, kind: "created" }], assignments: 0,
  },
  {
    id: "t-ticker", project: PROJECT, status: "inbox", icon: "timer", updatedMin: 150, createdMin: 150, workMin: null,
    title: { uk: "Тікер місця: кожні 10 хвилин", en: "Seat ticker: every 10 minutes" },
    stages: [], events: [{ min: 150, kind: "created" }], assignments: 0,
  },
  {
    id: "t-tags", project: PROJECT, status: "inbox", color: "lime", icon: "tags", updatedMin: 1200, createdMin: 12000, workMin: 7200,
    title: { uk: "Пошук по задачах розуміє теги", en: "Task search understands tags" },
    stages: [], events: [{ min: 7200, kind: "assigned" }], assignments: 1,
  },
  {
    id: "t-export", project: PROJECT, status: "assigned", color: "lime", icon: "file-down", updatedMin: 1440, createdMin: 14000, workMin: 8600,
    title: { uk: "Експорт розмови в Markdown", en: "Export a conversation as Markdown" },
    stages: [], agent: { state: "idle", sinceMin: 8600 }, events: [{ min: 8600, kind: "assigned" }], assignments: 1,
  },
  {
    id: "t-spend", project: PROJECT, status: "blocked", color: "amber", icon: "receipt", updatedMin: 1460, createdMin: 15000, workMin: 13000,
    title: { uk: "Звіт про витрати по акаунтах", en: "Spend report per account" },
    stages: [], hold: { kind: "external", note: { uk: "чекає на доступ до білінгу", en: "waits for billing access" }, sinceMin: 13000 },
    events: [{ min: 13000, kind: "assigned" }], assignments: 1,
  },
  {
    id: "t-engine", project: PROJECT, status: "inbox", icon: "cpu", updatedMin: 1445, createdMin: 17000, workMin: null,
    title: { uk: "Третій рушій у меню нового агента", en: "A third engine in the new-agent menu" },
    stages: [], events: [{ min: 17000, kind: "created" }], assignments: 0,
  },
  {
    id: "t-pricing", project: "repo-landing", status: "assigned", color: "pink", icon: "badge-dollar-sign", updatedMin: 30, createdMin: 200, workMin: 7,
    title: { uk: "Нова сторінка цін", en: "New pricing page" },
    stages: [S("build", "builder", "codex", SOL, "running")], agent: { state: "working", sinceMin: 30 }, pr: { number: 88, state: "draft" },
    events: [{ min: 30, kind: "stage_started", stage: "build" }], assignments: 1,
  },
  {
    id: "t-sync", project: "repo-notes", status: "assigned", color: "sky", icon: "refresh-cw", updatedMin: 31, createdMin: 2000, workMin: 30,
    title: { uk: "Синхронізація нотаток без мережі", en: "Offline note sync" },
    stages: [S("build", "builder", "claude", OPUS, "passed"), S("review", "reviewer", "codex", ASTRA, "reviewing")], agent: { state: "check", sinceMin: 30 }, pr: { number: 41, state: "open" },
    events: [{ min: 30, kind: "checks", pr: 41 }], assignments: 2,
  },
  {
    id: "t-dark", project: "repo-notes", status: "done", color: "slate", icon: "moon", updatedMin: 185, createdMin: 3000, workMin: 190,
    title: { uk: "Темна тема для редактора", en: "Dark theme for the editor" },
    stages: [S("build", "builder", "codex", SOL, "passed")], pr: { number: 39, state: "merged" },
    events: [{ min: 190, kind: "pr_merged", pr: 39 }], assignments: 1,
  },
];

/* Earlier done work: the fold at the bottom counts every one of them and
   lists them when opened; the fixture keeps a short real-looking tail. */
const DONE_EARLIER: [string, string, number][] = [
  ["Сповіщення в Telegram про злиття PR", "Telegram notice when a PR merges", 1500],
  ["Кнопка «Запустити знову» на картці", "A Run again button on the card", 2300],
  ["Пам’ять ролей: уроки зі стадій", "Role memory: lessons from stages", 3100],
  ["Історія рішень у «Рішеннях» оркестратора", "Decision history in the seat's Decisions", 4000],
  ["Компактне меню картки", "Compact card menu", 5200],
  ["Пінг Codex-акаунтів раз на годину", "Hourly Codex account ping", 6100],
  ["Прев’ю файлів відкриває якорі", "File preview lands on anchors", 7000],
  ["Пояснення ліміту використання в акаунтах", "Usage-limit explanation on accounts", 8800],
];
DONE_EARLIER.forEach(([uk, en, min], index) => TASKS.push({
  id: `t-done-${index}`, project: PROJECT, status: "done", color: index % 2 ? "slate" : "teal", updatedMin: index < 4 ? 40 : min - 10, createdMin: min + 900, workMin: min,
  title: { uk, en }, stages: [S("build", "builder", index % 2 ? "codex" : "claude", index % 2 ? SOL : OPUS, "passed")], pr: { number: 2700 - index * 7, state: "merged" },
  events: [{ min, kind: "pr_merged", pr: 2700 - index * 7 }], assignments: 1,
}));

export const AGENTS: ProtoAgent[] = [
  { id: "a-menu", project: PROJECT, kind: "stage", role: "architect", stage: "prototype", engine: "claude", model: OPUS, state: "needs-you", launchedMin: 68, stateMin: 3, taskId: "t-menu" },
  { id: "a-header", project: PROJECT, kind: "stage", role: "architect", stage: "prototype", engine: "claude", model: OPUS, state: "working", launchedMin: 18, stateMin: 18, taskId: "t-header" },
  { id: "a-login", project: PROJECT, kind: "stage", role: "builder", stage: "ui-fix", engine: "codex", model: SOL, state: "working", launchedMin: 22, stateMin: 22, taskId: "t-login" },
  { id: "a-pricing", project: "repo-landing", kind: "spawned", role: "builder", engine: "codex", model: SOL, state: "working", launchedMin: 30, stateMin: 30, taskId: "t-pricing" },
  { id: "a-sync", project: "repo-notes", kind: "stage", role: "reviewer", stage: "review", engine: "codex", model: ASTRA, state: "check", launchedMin: 33, stateMin: 30, taskId: "t-sync" },
  { id: "a-activity", project: PROJECT, kind: "stage", role: "builder", stage: "build", engine: "claude", model: OPUS, state: "working", launchedMin: 40, stateMin: 40, taskId: "t-activity" },
  { id: "a-cpu", project: PROJECT, kind: "stage", role: "builder", stage: "fix", engine: "codex", model: ASTRA, state: "working", launchedMin: 48, stateMin: 48, taskId: "t-cpu" },
  { id: "a-memory", project: PROJECT, kind: "stage", role: "builder", stage: "build", engine: "claude", model: OPUS, state: "working", launchedMin: 55, stateMin: 55, taskId: "t-memory" },
  { id: "a-phone", project: PROJECT, kind: "stage", role: "builder", stage: "build", engine: "codex", model: SOL, state: "check", launchedMin: 65, stateMin: 11, taskId: "t-phone-menu" },
  { id: "a-needs", project: PROJECT, kind: "stage", role: "merger", stage: "refresh", engine: "codex", model: SOL, state: "check", launchedMin: 75, stateMin: 15, taskId: "t-needs" },
  { id: "a-relay", project: PROJECT, kind: "spawned", role: "builder", engine: "claude", model: OPUS, state: "idle", launchedMin: 95, stateMin: 20, taskId: null,
    title: { uk: "Перевірити шаблони API ретранслятора", en: "Check the relay API templates" } },
  { id: "a-limit", project: PROJECT, kind: "stage", role: "architect", stage: "brief", engine: "claude", model: OPUS, state: "needs-you", launchedMin: 130, stateMin: 100, taskId: "t-limit" },
  { id: "a-landing", project: PROJECT, kind: "stage", role: "reviewer", stage: "review", engine: "claude", model: OPUS, state: "finished", launchedMin: 70, stateMin: 30, taskId: "t-landing" },
  { id: "a-profiles", project: PROJECT, kind: "stage", role: "merger", stage: "refresh", engine: "codex", model: SOL, state: "idle", launchedMin: 140, stateMin: 25, taskId: "t-profiles" },
  { id: "a-voice", project: PROJECT, kind: "stage", role: "merger", stage: "refresh", engine: "claude", model: OPUS, state: "failed", launchedMin: 170, stateMin: 52, taskId: "t-voice" },
  { id: "a-seat", project: PROJECT, kind: "spawned", role: "orchestrator", engine: "claude", model: OPUS, state: "idle", launchedMin: 610, stateMin: 6, taskId: null,
    title: { uk: "Оркестратор Delegatus", en: "Delegatus orchestrator" } },
];

/* ── Derived views the build reads from the board's own model ─────────── */

export function minutesAgo(now: number, min: number): string {
  return new Date(now - min * 60_000).toISOString();
}

/** The task as the store holds it, for the real TaskPanel and TaskSheet. */
export function boardTask(task: ProtoTask, now: number, locale: "en" | "uk"): BoardTask {
  return {
    id: task.id,
    project: task.project,
    status: task.status,
    text: `${task.title[locale]}${task.body ? `\n${task.body[locale]}` : ""}`,
    placement: "unplaced",
    assignments: Array.from({ length: task.assignments }, (_, index) => ({
      path: `/tmp/fixture/${task.id}-${index}.jsonl`, panePid: null, state: "delivered" as const, error: null, at: minutesAgo(now, task.workMin ?? task.createdMin),
    })),
    ...(task.color ? { color: task.color } : {}),
    ...(task.icon ? { icon: task.icon } : {}),
    ...(task.hold ? { hold: protoHold(task.hold, now, locale) } : {}),
    ...(task.status !== "done" && task.updatedMin > 1000 ? { board: "hidden" as const } : {}),
    createdAt: minutesAgo(now, task.createdMin),
    updatedAt: minutesAgo(now, task.updatedMin),
  };
}

function protoHold(hold: NonNullable<ProtoTask["hold"]>, now: number, locale: "en" | "uk"): TaskHold {
  return { kind: hold.kind, note: hold.note[locale], since: minutesAgo(now, hold.sinceMin), by: "agent", ...(hold.ref ? { ref: hold.ref } : {}) };
}

/** The board's own motion projection (`taskMotion`), fed the facts the
    kanban model hands it. */
export function motionOf(task: ProtoTask, now: number, locale: "en" | "uk"): TaskMotion {
  const working = task.agent && (task.agent.state === "working" || task.agent.state === "check") ? 1 : 0;
  return taskMotion({
    status: task.status,
    hold: task.hold ? protoHold(task.hold, now, locale) : undefined,
    needsYou: task.agent?.state === "needs-you",
    working,
    inFlight: task.stages.some((stage) => stage.state === "running" || stage.state === "reviewing" || stage.state === "committing"),
    pipelines: task.stages.length ? [{ state: task.agent?.state === "needs-you" ? "needs_decision" : "running" }] : [],
  }, now);
}

/** The stage that runs now, else the last one that ran. */
export function currentStage(task: ProtoTask): ProtoStage | null {
  const live = task.stages.find((stage) => ["running", "reviewing", "committing", "needs_decision"].includes(stage.state));
  if (live) return live;
  const failed = [...task.stages].reverse().find((stage) => stage.state === "failed");
  if (failed) return failed;
  const pending = task.stages.find((stage) => stage.state === "pending");
  return pending ?? task.stages.at(-1) ?? null;
}

export function workLinks(task: ProtoTask, now: number): ResolvedWorkLinks | null {
  if (!task.pr) return task.stages.length ? { links: [], noPr: false } : null;
  return {
    noPr: false,
    links: [{
      key: `example/delegatus#${task.pr.number}`, kind: "pr", repository: "example/delegatus", number: task.pr.number,
      url: `https://forge.example/delegatus/pull/${task.pr.number}`, source: "auto", via: ["delivery-pr"], state: task.pr.state, checkedAt: minutesAgo(now, 2),
    }],
  };
}

export const IDLE_AFTER_MIN = 3 * 24 * 60;
export const FINISHED_WINDOW_MIN = 24 * 60;

/** Recency the variants sort by: the newest real work, else the creation of
    a task nothing ever ran on. Never `updatedAt`. */
export function recencyMin(task: ProtoTask): number {
  return task.workMin ?? task.createdMin;
}

export function byRecency(a: ProtoTask, b: ProtoTask): number {
  return recencyMin(a) - recencyMin(b) || a.id.localeCompare(b.id);
}

export type Fold = "active" | "idle" | "done";
/** Where a task sits in the flat list: recent work, the idle fold, the done fold. */
export function foldOf(task: ProtoTask): Fold {
  if (task.status === "done") return recencyMin(task) <= FINISHED_WINDOW_MIN ? "active" : "done";
  return recencyMin(task) > IDLE_AFTER_MIN ? "idle" : "active";
}

export type Group = "needs-you" | "working" | "waiting" | "not-started" | "finished" | "idle" | "done";
export const GROUP_ORDER: Group[] = ["needs-you", "working", "waiting", "not-started", "finished", "idle", "done"];

export function groupOf(task: ProtoTask, motion: TaskMotion): Group {
  const fold = foldOf(task);
  if (task.status === "done") return fold === "done" ? "done" : "finished";
  if (fold === "idle") return "idle";
  if (motion.key === "needs-you") return "needs-you";
  if (motion.key === "working") return task.agent?.state === "check" ? "waiting" : "working";
  if (motion.key === "not-started") return "not-started";
  return "waiting";
}

export type Bucket = "today" | "yesterday" | "week" | "older";
export function bucketOf(task: ProtoTask): Bucket {
  const min = recencyMin(task);
  if (min < 24 * 60) return "today";
  if (min < 48 * 60) return "yesterday";
  if (min < 7 * 24 * 60) return "week";
  return "older";
}

/** Crowned conversations: the old panel's top section, kept in the Agents tab. */
export const FAVORITES: { id: string; project: string; title: Bilingual }[] = [
  { id: "f-seat", project: PROJECT, title: { uk: "Оркестратор Delegatus", en: "Delegatus orchestrator" } },
  { id: "f-voice", project: PROJECT, title: { uk: "Голосовий компаньйон: сценарії", en: "Voice companion: scenarios" } },
];
