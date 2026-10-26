"use client";

/*
 * Prototype v2: start a pipeline from the current conversation
 * (docs/design/pipeline-from-conversation.md; README.md beside this file).
 *
 * Every frame is the product's own surface over invented data: the desktop
 * board with the conversation open in its agent window (`KanbanBoard`, the
 * reader, the reader's and the card's ⋯ `BoardMenu`), the phone shell with
 * the conversation (`MobileShell`, `BranchPane`, `MobileConversationMenu`),
 * the phone task screen and the phone pipeline screen. What does not exist
 * yet is one row in an existing menu, one dialog in the template picker's
 * shell, one strip over the composer, one draft lane on the card.
 *
 * Three variants, each two frames (a: where the action lives, b: how the
 * stages are chosen):
 *   1  the conversation's ⋯ → the «New pipeline» template picker
 *   2  the composer's Send menu → a stage chain over the composer
 *   3  the task card's ⋯ → a draft lane on the card, Build's first message
 *
 * The query string picks what is drawn:
 *   ?variant=1|2|3&frame=a|b&lang=uk|en&theme=light|dark
 * The device follows the viewport (`useIsMobile`). The caption with the
 * variant's number is printed at the top of every frame.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Check, GitBranch, Pencil, Play, Workflow, X } from "lucide-react";

import { setLocale, translate, type Locale, type MessageKey } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { LogTailState } from "@/hooks/useLogTail";
import { setLogFeedDependenciesForTests } from "@/components/logFeedDependencies";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { BranchPane } from "@/components/BranchPane";
import { MobileBarTitle, MobileShell } from "@/components/mobile/MobileShell";
import { CHAT_TONE_DOT, CHAT_TONE_TEXT, chatStateBits } from "@/components/mobile/mobileChatState";
import { MobileConversationMenu } from "@/components/mobile/MobileConversationMenu";
import { MobileSheetRow } from "@/components/mobile/MobileSheet";
import { mobileRowState, rowStateWord } from "@/components/mobile/mobileBoardModel";
import { MobileTaskScreen } from "@/components/mobile/MobileTaskScreen";
import { MobilePipelineScreen } from "@/components/mobile/MobilePipelineScreen";
import { ComposerMenu } from "@/components/ComposerBar";
import { appendComposerDraft } from "@/components/TmuxComposer";
import { KanbanPopover } from "@/components/kanban/kanbanMenus";
import { PIPELINE_TEMPLATES, stageDisplayName } from "@/components/pipelines/pipelineModel";
import { roleNameById } from "@/components/builderCopy";
import { Z } from "@/components/layers";
import { useIsMobile } from "@/hooks/useIsMobile";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = ([1, 2, 3] as const).find((n) => String(n) === params.get("variant")) ?? 1;
const FRAME = params.get("frame") === "b" ? "b" : "a";
type Variant = typeof VARIANT;
type Frame = typeof FRAME;

document.documentElement.dataset.theme = THEME;
document.documentElement.lang = LANG;
try { localStorage.setItem("llv_lang", LANG); } catch { /* opaque origin */ }
setLocale(LANG);
const L = (en: string, uk: string) => (LANG === "uk" ? uk : en);
const t = (key: string, vars?: Record<string, string | number>) => translate(LANG, key as MessageKey, vars as never);

/* A frozen clock: every age reads the same in each render. */
const NOW_MS = Date.parse("2026-10-26T09:46:00.000Z");
const NOW = NOW_MS / 1000;
Date.now = () => NOW_MS;
const iso = (minutesAgo: number) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();

/* No server stands behind the prototype: every read answers empty, and every
   conversation has a host to send to, so the composer is the one a live agent has. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin === location.origin && url.pathname === "/api/tmux/targets") {
    const { reqs = [] } = JSON.parse(String(init?.body ?? "{}")) as { reqs?: { id: string }[] };
    return Response.json({ targets: Object.fromEntries(reqs.map((req) => [req.id, `orbit:${req.id}.0`])) });
  }
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return Response.json({}, { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;
class SilentEventSource { onerror: ((event: Event) => void) | null = null; onmessage = null; onopen = null; readyState = 2; close() {} addEventListener() {} removeEventListener() {} }
(globalThis as unknown as { EventSource: unknown }).EventSource = SilentEventSource;

/* ---------- invented project, conversation, cards ---------- */

const PROJECT = "orbit-store";
const BRANCH = "fix/csv-export-retry";
const WORKTREE_LABEL = "worktrees/csv-export-retry";
const DIRTY = ["src/export/csvWriter.ts", "src/export/upload.ts", "src/export/retry.ts"];

const SOURCE_TITLE = L("CSV export retry and streaming writes", "Повтор експорту CSV і потоковий запис");
const TASK_TITLE = L(
  "CSV export fails on large projects: the worker runs out of memory past 50k rows",
  "Експорт CSV падає на великих проєктах: воркер вилітає по пам’яті понад 50 тис. рядків",
);

/* The retry's pauses are one figure: its gaps are no-break spaces, so no line
   ends on «4» with a lone «s.» under it. */
const PAUSES = L("1 → 2 → 4 s.", "1 → 2 → 4 с.");

const USAGE = { input_tokens: 120, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0, output_tokens: 90 };
let seq = 0;
const user = (minutesAgo: number, text: string) => JSON.stringify({ type: "user", uuid: `u-${++seq}`, timestamp: iso(minutesAgo), message: { role: "user", content: text } });
const said = (minutesAgo: number, text: string, tool?: { id: string; name: string; input: Record<string, unknown> }) => JSON.stringify({
  type: "assistant", uuid: `a-${++seq}`, timestamp: iso(minutesAgo), requestId: `req-${seq}`,
  message: { id: `msg-${seq}`, role: "assistant", stop_reason: tool ? "tool_use" : "end_turn", usage: USAGE,
    content: [...(text ? [{ type: "text", text }] : []), ...(tool ? [{ type: "tool_use", ...tool }] : [])] },
});
const result = (minutesAgo: number, id: string, text: string) => JSON.stringify({ type: "user", uuid: `r-${++seq}`, timestamp: iso(minutesAgo), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });

const SOURCE_LINES = [
  user(48, L(
    "CSV export fails on large projects (over 50k rows): the worker runs out of memory. Find out why and fix it.",
    "Експорт CSV падає на великих проєктах (понад 50 тис. рядків): воркер вилітає по пам’яті. Розберись і полагодь.",
  )),
  said(47, "", { id: "t-read", name: "Read", input: { file_path: "src/export/csvWriter.ts" } }),
  result(46.9, "t-read", "export async function writeCsv(rows) { const all = rows.map(toLine).join(\"\\n\"); … }"),
  said(45, L(
    "The cause: `csvWriter` builds the whole file in memory before it uploads. I am rewriting it to stream the rows in chunks of 5,000.",
    "Причина: `csvWriter` збирає весь файл у пам’яті, перш ніж вивантажити. Переписую на потоковий запис частинами по 5 000 рядків.",
  )),
  user(40, L(
    "Do not change the file format: customers parse it. And retry when storage answers 503.",
    "Формат файлу не міняй: клієнти його парсять. І додай повтор, якщо сховище відповіло 503.",
  )),
  said(32, L(
    `Understood: the format stays byte for byte. Done: streaming writes, and a retry on 503 with pauses of ${PAUSES} Three files changed: \`src/export/csvWriter.ts\`, \`src/export/upload.ts\` and a new \`src/export/retry.ts\`.`,
    `Зрозумів: формат лишаю байт у байт. Зробив потоковий запис і повтор на 503 з паузами ${PAUSES} Змінено три файли: \`src/export/csvWriter.ts\`, \`src/export/upload.ts\` і новий \`src/export/retry.ts\`.`,
  )),
  user(16, L("Run the tests and check a file of 80k rows.", "Запусти тести і перевір на файлі з 80 тис. рядків.")),
  said(15, L("Running the export tests first.", "Спершу запускаю тести експорту."), { id: "t-test", name: "Bash", input: { command: "bun test src/export", description: L("Run the export tests", "Тести експорту") } }),
  result(13, "t-test", "42 pass\n0 fail\nRan 42 tests across 6 files. [4.81s]"),
  said(11, L(
    "Tests are green (42 pass). An 80k-row file writes in 6 s and stays under 120 MB. Left: a test for the retry after 503, then a review.",
    "Тести зелені (42 pass). Файл на 80 тис. рядків пишеться за 6 с і тримається до 120 МБ. Лишилось: тест на повтор після 503, потім рев’ю.",
  )),
];

const SOURCE_PATH = "/sessions/orbit-store/csv-export-retry.jsonl";
const SOURCE_ID = "conv_csv_export_retry";

const conversation = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
  root: "claude-projects", name: over.path.split("/").pop(), project: PROJECT, engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: NOW - 660, size: 4_096, activity: "idle", proc: null, pid: null, model: "claude-opus-5-5", effort: "high",
  pendingQuestion: null, waitingInput: null, generation: 1,
  ...over,
} as unknown as FileEntry);

/* The source: its turn ended eleven minutes ago, its host is alive, so the
   composer and the menus are the ones an idle live agent has. */
const SOURCE = conversation({
  path: SOURCE_PATH, conversationId: SOURCE_ID, title: SOURCE_TITLE,
  cwd: `/work/${PROJECT}/${WORKTREE_LABEL}`, gitBranch: BRANCH, worktree: BRANCH,
  activity: "recent", proc: "running", pid: 48_213, mtime: NOW - 660,
  lastTurn: { startedAt: NOW_MS - 16 * 60_000, endedAt: NOW_MS - 11 * 60_000 },
} as Partial<FileEntry> & { path: string });
const CHECKOUT = conversation({ path: "/sessions/orbit-store/checkout.jsonl", conversationId: "conv_checkout", title: L("Card payments: 3-D Secure second step", "Оплата карткою: другий крок 3-D Secure"), mtime: NOW - 3_000 });
const SEARCH = conversation({ path: "/sessions/orbit-store/search.jsonl", conversationId: "conv_search", title: L("Search filters lose their state on back", "Фільтри пошуку губляться після «Назад»"), mtime: NOW - 7_200 });

const assignment = (file: FileEntry) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "delivered", error: null, at: iso(50) });
const task = (id: string, status: BoardTask["status"], text: string, files: FileEntry[], minutesAgo: number, hold?: BoardTask["hold"]): BoardTask => ({
  id, project: PROJECT, text, status, placement: "unplaced", assignments: files.map(assignment),
  createdAt: iso(minutesAgo + 30), updatedAt: iso(minutesAgo), ...(hold ? { hold } : {}),
} as unknown as BoardTask);

const TASKS: BoardTask[] = [
  task("t-csv", "assigned", `${TASK_TITLE}\n${L("Customers parse the file, so the format stays byte for byte.", "Клієнти парсять файл, тож формат лишається байт у байт.")}`, [SOURCE], 11),
  task("t-pay", "assigned", `${L("Card payments: 3-D Secure second step", "Оплата карткою: другий крок 3-D Secure")}\n${L("The bank's second step opens in a new tab and loses the order.", "Другий крок банку відкривається в новій вкладці і губить замовлення.")}`, [CHECKOUT], 50,
    { kind: "external", note: L("The bank sends the sandbox key", "Банк надішле тестовий ключ"), since: iso(50), by: "agent" }),
  task("t-search", "inbox", `${L("Search filters lose their state on back", "Фільтри пошуку губляться після «Назад»")}\n${L("Going back from a product resets every filter.", "Після повернення з товару скидаються усі фільтри.")}`, [SEARCH], 120),
  task("t-orders", "inbox", `${L("Orders page is slow on phones", "Сторінка замовлень повільна на телефоні")}\n${L("Over 3 s on a mid-range phone.", "Понад 3 с на середньому телефоні.")}`, [], 300),
];

/* The brief the pipeline takes from the conversation: the operator's ask,
   the decisions made in it, what is done and what is left. */
const BRIEF = L(
  [
    "CSV export fails on large projects (over 50k rows): the worker runs out of memory.",
    "Decided in the conversation: the file format stays byte for byte, customers parse it.",
    `Done: streaming writes in chunks of 5,000 rows; retry on 503 with pauses of ${PAUSES} Tests green (42 pass).`,
    "Left: a test for the retry after 503, then a review of the three changed files.",
  ].join("\n"),
  [
    "Експорт CSV падає на великих проєктах (понад 50 тис. рядків): воркер вилітає по пам’яті.",
    "Вирішено в розмові: формат файлу лишається байт у байт, клієнти його парсять.",
    `Зроблено: потоковий запис частинами по 5 000 рядків; повтор на 503 з паузами ${PAUSES} Тести зелені (42 pass).`,
    "Лишилось: тест на повтор після 503, потім рев’ю трьох змінених файлів.",
  ].join("\n"),
);
/* Variant 2: what the operator types in the composer and hands to the pipeline. */
const TYPED = L(
  "Finish the retry test after 503 and keep the file format byte for byte. Then a review of the three changed files; fix whatever the review finds.",
  "Доведи тест на повтор після 503 і не міняй формат файлу. Потім рев’ю трьох змінених файлів; що знайде рев’ю — виправ.",
);

const role = (roleId: string, access: "read-only" | "read-write") => ({ roleId, engine: "claude", model: "claude-opus-5-5", effort: "high", access, promptScaffold: null });
/* The «Build → Review» template as the product creates it: each stage id is
   its role id (`deriveStageId`), so `stageDisplayName` names the stage by the
   role in the operator's language («Білдер → Рев'юер»). The review's fail edge
   returns to the builder stage, so no third stage carries an id the product
   could only humanize in English («Reviewer fix»). */
const STAGES = [
  { id: "builder", kind: "run", role: { roleId: "builder" }, prompt: `{{task}}\n\n${BRIEF}`, next: "reviewer", effectiveRole: role("builder", "read-write") },
  { id: "reviewer", kind: "run", role: { roleId: "reviewer" }, prompt: "{{task}}", next: null, onFail: { to: "builder", maxRounds: 2, onExhausted: "advance" }, effectiveRole: role("reviewer", "read-only") },
] as unknown as Pipeline["stages"];
const [BUILD_NAME, REVIEW_NAME] = STAGES.map((stage) => stageDisplayName(t as never, stage)) as [string, string];

/* Variant 3, frame b: the draft lane the card holds before the start. */
const DRAFT_LANE: Pipeline = {
  id: "pl_csv", task: TASK_TITLE, taskIds: ["t-csv"], project: PROJECT, repoDir: `/work/${PROJECT}`,
  worktreeDir: `/work/${PROJECT}/${WORKTREE_LABEL}`, branch: BRANCH, baseBranch: "main", baseRef: "main", lastPassedCommit: "",
  stages: STAGES, runs: [],
  cursor: { stageId: "builder", state: "pending", input: null, activatedBy: null },
  state: "draft", pausedState: null, stateDetail: null,
  srcPath: SOURCE_PATH, srcConversationId: SOURCE_ID,
  createdAt: iso(0.5), closedAt: null, updatedAt: iso(0.5),
} as unknown as Pipeline;

const LANE_DRAWN = VARIANT === 3 && FRAME === "b";
const PIPELINES: Pipeline[] = LANE_DRAWN ? [DRAFT_LANE] : [];
const FILES: FileEntry[] = [SOURCE, CHECKOUT, SEARCH];

/* The feed reads the transcript through the feed's own dependency seam. */
const tails = new Map<string, LogTailState>();
const tailOf = (file: FileEntry): LogTailState => {
  let state = tails.get(file.path);
  if (!state) {
    const lines = file.path === SOURCE_PATH ? SOURCE_LINES : [said(60, L("Looking at it.", "Дивлюся."))];
    state = { lines, linesStart: 0, size: lines.length, loading: false, error: null, tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0 } as LogTailState;
    tails.set(file.path, state);
  }
  return state;
};
setRuntimeUiEnabledForTests(false);
setLogFeedDependenciesForTests({ useLogTail: (file) => { const state = tailOf(file as FileEntry); return useSyncExternalStore(() => () => {}, () => state, () => state); } });
/* Variant 2: the composer holds what the operator typed. */
if (VARIANT === 2) { try { sessionStorage.clear(); } catch { /* opaque origin */ } appendComposerDraft(SOURCE_ID, TYPED); }

/* ---------- the words this prototype adds ---------- */

const WORDS = {
  start: L("Start pipeline", "Запустити пайплайн"),
  startWhy: L("The brief and the branch come from this conversation", "Опис задачі й гілка — з цієї розмови"),
  conversation: L("Conversation", "Розмова"),
  briefTaken: L(`Brief taken from 7 messages · ${DIRTY.length} uncommitted files stay in the checkout`, `Опис узято з 7 повідомлень · ${DIRTY.length} незакомічені файли лишаються в робочій копії`),
  runAsPipeline: L("Run as a pipeline", "Запустити як пайплайн"),
  runAsPipelineHint: L("This message becomes the pinned task; the stages are chosen next", "Це повідомлення стане закріпленою задачею; етапи — наступним кроком"),
  pinned: L("This message becomes the pinned task.", "Це повідомлення стане закріпленою задачею."),
  addStage: L("Stage", "Етап"),
  enterStarts: L("Enter starts the pipeline; Esc returns to a plain message.", "Enter запускає пайплайн; Esc повертає до звичайного повідомлення."),
  stageOf: (k: number, n: number) => L(`stage ${k} of ${n}`, `етап ${k} з ${n}`),
  removeStage: L("Remove this stage", "Прибрати цей етап"),
  removeStageWhy: L(`${BUILD_NAME} stays the only stage`, `Лишиться один етап: ${BUILD_NAME}`),
  fromConversationRow: L("Pipeline from conversation…", "Пайплайн з розмови…"),
  startDraft: L("Start", "Запустити"),
  startDraftLong: L("Start pipeline", "Запустити пайплайн"),
  firstMessage: L(`${BUILD_NAME}'s first message`, `Перше повідомлення: ${BUILD_NAME}`),
  firstMessageWhy: L("The brief from the conversation · not sent yet", "Опис із розмови · ще не надіслано"),
  edit: L("Edit", "Змінити"),
};

const ROLE_WHY: Record<string, string> = {
  builder: L("writes code in the checkout and commits", "пише код у робочій копії й комітить"),
  reviewer: L("reads the diff, never writes", "читає дифф, нічого не пише"),
  verifier: L("runs the checks and reports", "запускає перевірки і звітує"),
  architect: L("designs and writes the plan", "проєктує і пише план"),
};

/* ---------- captions ---------- */

const VARIANT_NAMES: Record<Variant, string> = {
  1: L("From the conversation menu, by template", "З меню розмови, за шаблоном"),
  2: L("From the composer, as a stage chain", "З композера, ланцюжком етапів"),
  3: L("From the task card, stages on the card", "З картки задачі, етапи на картці"),
};
const CAPTIONS: Record<Variant, Record<Frame, string>> = {
  1: {
    a: L("The conversation's ⋯ menu gains “Start pipeline”: the brief and the branch come from this conversation.", "У меню розмови ⋯ з’являється пункт «Запустити пайплайн»: опис задачі й гілка беруться з цієї розмови."),
    b: L("The usual “New pipeline” window opens: the conversation and its branch stand where the directory was; the stages are picked by template.", "Відкривається звичайне вікно «Новий пайплайн»: замість каталогу — розмова і її гілка; етапи обираються шаблоном."),
  },
  2: {
    a: L("The brief is typed in the composer; the Send button's menu offers “Run as a pipeline”.", "Доручення набрано в композері; меню кнопки «Надіслати» пропонує «Запустити як пайплайн»."),
    b: L("A stage chain appears above the composer: a pill opens its role, “+” adds a stage; the Send button becomes “Start pipeline”.", "Над композером стає ланцюжок етапів: плашка відкриває свою роль, «+» додає етап; кнопка «Надіслати» стає «Запустити пайплайн»."),
  },
  3: {
    a: L("The task card's ⋯ menu gets “Pipeline from conversation…”, naming the conversation and its branch.", "У меню картки задачі ⋯ — пункт «Пайплайн з розмови…» з назвою розмови і гілкою."),
    b: L(`A draft lane lands on the card: ${BUILD_NAME}'s first message is the brief from the conversation, editable in place; “Start” launches it.`, `На картці з’являється чернетка пайплайна: перше повідомлення етапу «${BUILD_NAME}» — опис із розмови, його можна правити; «Запустити» стартує.`),
  },
};
/* The phone's pipeline screen shows the brief under the stages, so its caption says so. */
const PHONE_CAPTIONS: Partial<Record<`${Variant}${Frame}`, string>> = {
  "3b": L(`The pipeline screen holds the draft lane: the stages with their roles, ${BUILD_NAME}'s first message (the brief from the conversation) with Edit under them, “Start pipeline” at the foot.`, `Екран пайплайна тримає чернетку: етапи з ролями, під ними перше повідомлення етапу «${BUILD_NAME}» (опис із розмови) з кнопкою «Змінити», внизу — «Запустити пайплайн».`),
};
const FRAME_LABEL: Record<Frame, string> = { a: L("a", "а"), b: L("b", "б") };

function Caption() {
  const phone = useIsMobile();
  const caption = (phone && PHONE_CAPTIONS[`${VARIANT}${FRAME}`]) || CAPTIONS[VARIANT][FRAME];
  return (
    <div data-proto-caption="" className={`relative ${Z.tooltip} flex shrink-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border bg-sunken px-3 py-1.5 text-label leading-snug text-secondary`}>
      <span className="font-semibold text-primary">{L(`Variant ${VARIANT} of 3`, `Варіант ${VARIANT} з 3`)} · {VARIANT}{FRAME_LABEL[FRAME]}</span>
      <span className="font-semibold text-secondary">{VARIANT_NAMES[VARIANT]}</span>
      <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">{caption}</span>
    </div>
  );
}

/* ---------- helpers: insert into the product's own DOM, press its own controls ---------- */

/** Waits for an element the product renders, then hands back a node inserted where the new row goes, and inserts it again if the product redraws that place. */
function useInsertedHost(find: () => { parent: Element; before: Element | null } | null, tag: "div" | "span" = "div"): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let made: HTMLElement | null = null;
    const attempt = () => {
      if (made?.isConnected) return true;
      const spot = find();
      if (!spot) return false;
      made = document.createElement(tag);
      made.setAttribute("role", "none");
      made.dataset.protoInserted = "";
      spot.parent.insertBefore(made, spot.before);
      setHost(made);
      return true;
    };
    attempt();
    const observer = new MutationObserver(() => { attempt(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [find, tag]);
  return host;
}

/** The product's own controls a frame presses, in order: the reader's ⋯, the
    card's ⋯, the card's fold, a stage pill. The driver presses them with a real
    pointer (`body[data-proto-press]` lists the selectors), the way an operator
    does: a scripted `click()` moves focus with no pointer behind it, so
    Chromium draws a focus ring on the menu's first item, and it fires before
    the card's layout has settled, so the menu measures a stale anchor. Opened
    by hand (`&press=self`), the fixture presses them itself. */
const PRESS_SELF = params.get("press") === "self";
function usePress(selector: string | null) {
  useEffect(() => {
    if (!selector) return;
    if (!PRESS_SELF) {
      const listed = JSON.parse(document.body.dataset.protoPress ?? "[]") as string[];
      document.body.dataset.protoPress = JSON.stringify([...listed, selector]);
      return;
    }
    let done = false;
    const press = () => {
      const target = document.querySelector<HTMLElement>(selector);
      if (!target || done) return Boolean(done);
      done = true;
      target.click();
      return true;
    };
    if (press()) return;
    const observer = new MutationObserver(() => { if (press()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selector]);
}

/** Every drawn box of a feed: each text run's line rectangles and each leaf
    element's box (an avatar, an icon, a rule, a dot), because an author row's
    avatar stands lower than its words and was the one thing left under the
    header once the words were above it. */
function feedBoxes(scroller: HTMLElement): DOMRect[] {
  const boxes: DOMRect[] = [];
  const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) if (rect.height > 0 && rect.width > 0) boxes.push(rect);
  }
  for (const leaf of scroller.querySelectorAll<Element>("*")) {
    const picture = leaf.tagName === "svg" || leaf.tagName === "IMG";
    if (!picture && (leaf.childElementCount || leaf.textContent?.trim() || leaf.closest("svg") || leaf.hasAttribute("data-proto-spacer"))) continue;
    const rect = leaf.getBoundingClientRect();
    if (rect.height > 0 && rect.width > 0) boxes.push(rect);
  }
  return boxes;
}

/** A frame whose transcript is scrolled to its tail: the row at the top edge
    is shown whole when the feed's bottom padding has the room, so no line is
    cut under the window header. Runs once the frame is ready and the fonts
    are in; the frame stays at its tail (the feed's tail magnet keeps a small
    distance, and pins the view back to the tail whenever the content
    changes, so the view is moved by trimming or extending the tail, never by
    scrolling against the magnet). When the room is short (variant 2b's
    strip takes it), the transcript is pushed the other way instead, into a
    spacer at its end, until the top edge lands between two drawn boxes: the
    cut row goes out of view whole, and nothing is left under the header. */
function useWholeTopRow() {
  useEffect(() => {
    let cancelled = false;
    const align = () => {
      const record: Record<string, number>[] = [];
      for (const scroller of document.querySelectorAll<HTMLElement>("[data-log-feed-scroller]")) {
        /* The pass measures the feed as it is now, an earlier pass's spacer
           included, and adds to that spacer: taking it out first would
           measure the same state and repeat the same move every pass. */
        let spacer = scroller.querySelector<HTMLElement>("[data-proto-spacer]");
        let adjust = spacer ? Number(spacer.dataset.adjust) : 0;
        const box = scroller.getBoundingClientRect();
        const boxes = feedBoxes(scroller);
        const crossing = (edge: number) => boxes.filter((rect) => rect.top < edge && rect.bottom > edge);
        let cut = 0;
        let lastBottom = box.top;
        for (const rect of boxes) {
          if (rect.top < box.top && rect.bottom > box.top) cut = Math.max(cut, box.top - rect.top);
          if (rect.bottom <= box.bottom) lastBottom = Math.max(lastBottom, rect.bottom);
        }
        const slack = box.bottom - lastBottom;
        /* The feed pins itself to its tail, so the view is moved by changing
           the tail, never by scrolling against it: a spacer at the content's
           end with a negative top margin trims the bottom padding by the cut
           (the top row comes whole), or with a height pushes the cut row out. */
        let delta = 0;
        if (cut > 0 && cut <= slack) {
          delta = -Math.ceil(cut);
        } else if (cut > 0) {
          /* The smallest shift down that puts the top edge in a gap. */
          let shift = 0;
          for (let guard = 0; guard < 12; guard += 1) {
            const under = crossing(box.top + shift);
            if (!under.length) break;
            shift = Math.max(...under.map((rect) => rect.bottom)) - box.top;
          }
          delta = Math.ceil(shift) + 1;
        }
        if (delta) {
          adjust += delta;
          if (!spacer) {
            spacer = document.createElement("div");
            spacer.dataset.protoSpacer = "";
            spacer.setAttribute("aria-hidden", "true");
            (scroller.firstElementChild ?? scroller).append(spacer);
          }
          spacer.dataset.adjust = String(adjust);
          spacer.style.height = adjust > 0 ? `${adjust}px` : "0px";
          spacer.style.marginTop = adjust < 0 ? `${adjust}px` : "0px";
          scroller.scrollTop = scroller.scrollHeight;
        }
        const images = [...scroller.querySelectorAll("img")];
        record.push({ cut: Math.round(cut), slack: Math.round(slack), delta, adjust, images: images.length, loaded: images.filter((img) => img.complete && img.naturalWidth > 0).length, scrollTop: Math.round(scroller.scrollTop), scrollMax: Math.round(scroller.scrollHeight - scroller.clientHeight) });
      }
      return record;
    };
    /* The fonts and the feed's pictures (an avatar is an image with no size
       until it is loaded) are in before anything is measured. */
    const pictures = () => Promise.all([...document.querySelectorAll<HTMLImageElement>("[data-log-feed-scroller] img")].map((img) => (
      img.complete ? null : new Promise<void>((resolve) => { img.addEventListener("load", () => resolve(), { once: true }); img.addEventListener("error", () => resolve(), { once: true }); })
    )));
    /* The feed keeps changing after the frame is ready (an avatar mounts once
       its picture is fetched), so every change to it aligns again, and the
       frame counts as aligned once the feed has been quiet for a while. The
       observer is off while a pass runs: the pass's own spacer is no change. */
    const observer = new MutationObserver(() => { schedule(); });
    /* A change of the feed's own size (the strip or the composer settling
       under it) moves the pinned tail without any mutation in the feed. */
    let sized = false;
    const resizer = new ResizeObserver(() => { if (sized) schedule(); sized = true; });
    let timer = 0;
    let passes = 0;
    const watch = () => {
      for (const scroller of document.querySelectorAll<HTMLElement>("[data-log-feed-scroller]")) {
        observer.observe(scroller, { childList: true, subtree: true, attributes: true });
        /* Observed once: a second observe() of the same element fires its first report again. */
        if (passes === 1) resizer.observe(scroller);
      }
    };
    const pass = () => {
      if (cancelled) return;
      observer.disconnect();
      const record = align();
      passes += 1;
      watch();
      clearTimeout(timer);
      const mark = () => {
        if (cancelled) return;
        const settled = [...document.querySelectorAll<HTMLElement>("[data-log-feed-scroller]")].map((scroller) => {
          const edge = scroller.getBoundingClientRect().top;
          return {
            scrollTop: Math.round(scroller.scrollTop), scrollMax: Math.round(scroller.scrollHeight - scroller.clientHeight), edge: Math.round(edge),
            crossing: feedBoxes(scroller).filter((rect) => rect.top < edge && rect.bottom > edge).map((rect) => `${Math.round(rect.top)}-${Math.round(rect.bottom)}`),
          };
        });
        /* The feed's rows settle after the pass (a row that left the viewport
           is drawn at its placeholder height): while a box still crosses the
           edge, the pass runs again on the geometry as it is now, a few times. */
        if (settled.some((feed) => feed.crossing.length) && passes < 6) { schedule(); return; }
        document.body.dataset.protoAligned = JSON.stringify({ passes, record, settled });
      };
      timer = window.setTimeout(mark, 400);
    };
    const schedule = () => {
      clearTimeout(timer);
      /* A feed that never settles still marks the frame, with what the last pass recorded. */
      if (passes >= 10) { document.body.dataset.protoAligned = JSON.stringify({ passes, unsettled: true }); return; }
      timer = window.setTimeout(() => { void document.fonts.ready.then(pictures).then(() => requestAnimationFrame(() => requestAnimationFrame(pass))); }, 150);
    };
    const whenReady = () => {
      if (cancelled) return;
      if (!document.body.dataset.protoReady) { requestAnimationFrame(whenReady); return; }
      schedule();
    };
    whenReady();
    return () => { cancelled = true; clearTimeout(timer); observer.disconnect(); resizer.disconnect(); };
  }, []);
}

/** The driver waits for this: the frame's defining element is on screen. */
function useReady(selector: string) {
  useEffect(() => {
    const check = () => {
      if (!document.querySelector(selector)) return false;
      document.body.dataset.protoReady = selector;
      return true;
    };
    if (check()) return;
    const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, [selector]);
}

/** A window-sized element's rectangle, re-read when the layout settles. */
function useRect(find: () => Element | null): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      const element = find();
      const next = element?.getBoundingClientRect() ?? null;
      setRect((current) => (current && next && current.top === next.top && current.left === next.left && current.width === next.width ? current : next));
      frame = requestAnimationFrame(read);
    };
    read();
    return () => cancelAnimationFrame(frame);
  }, [find]);
  return rect;
}

/* ---------- variant 1: the ⋯ row and the template picker ---------- */

/** The desktop reader menu's new row, as the compact menu's `Row` draws a tall row with its hint (compactMenu.tsx). */
function DesktopMenuRow({ label, why, find }: { label: string; why: ReactNode; find: () => { parent: Element; before: Element | null } | null }) {
  const host = useInsertedHost(find);
  if (!host) return null;
  return createPortal(
    <button type="button" className="cm-tall" role="menuitem" data-cm-item="startPipeline" data-proto-new="" data-proto-row="">
      <Workflow className="cm-lane" aria-hidden />
      <span className="lbl">
        {label}
        <span className="why">{why}</span>
      </span>
    </button>,
    host,
  );
}
function findReaderMenuSpot() {
  const menu = document.querySelector('.menu.cm[role="menu"] [data-cm-shown]');
  const sep = menu?.querySelector(".sep");
  return menu && sep ? { parent: sep.parentElement!, before: sep.nextElementSibling } : null;
}
/** The card's ⋯: the row sits after the icon cells, before the named sections. */
function findCardMenuSpot() {
  const menu = document.querySelector('.menu.cm[role="menu"] [data-cm-shown]');
  const section = menu?.querySelector("[data-cm-section]");
  const wrapper = section?.parentElement;
  return menu && wrapper ? { parent: wrapper.parentElement!, before: wrapper } : null;
}

function PhoneMenuRow({ label, why, find }: { label: string; why: ReactNode; find: () => { parent: Element; before: Element | null } | null }) {
  const host = useInsertedHost(find);
  if (!host) return null;
  return createPortal(
    <MobileSheetRow
      icon={<Workflow className="h-[18px] w-[18px]" aria-hidden />}
      label={(
        <span className="flex min-w-0 flex-col" data-proto-new="" data-proto-row="">
          <span className="min-w-0 truncate">{label}</span>
          <span className="min-w-0 truncate text-label font-medium text-secondary">{why}</span>
        </span>
      )}
      attrs={{ "data-mobile2-menu-row": "start-pipeline" }}
    />,
    host,
  );
}
function findPhoneChatMenuSpot() {
  const menu = document.querySelector("[data-mobile2-chat-menu]");
  return menu ? { parent: menu, before: menu.firstElementChild } : null;
}
/** The phone task menu: after the icon cells and the hide note, before the divider. */
function findPhoneTaskMenuSpot() {
  const menu = document.querySelector("[data-phone-task-menu-sheet]");
  const divider = menu?.querySelector(":scope > div[aria-hidden]");
  return menu && divider ? { parent: menu, before: divider } : null;
}

/** The branch, as the conversation header's own worktree chip draws it (BranchPane.tsx). */
function BranchChip({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/80 px-1.5 py-0.5 font-mono text-[9.5px] text-muted ${className}`} title={t("branch.worktree", { name: BRANCH })}>
      <GitBranch className="h-2.5 w-2.5" aria-hidden /> {BRANCH}
    </span>
  );
}

/** The conversation's state as the header behind the dialog names it: the
    desktop reader's header reads `mobileRowState` (KanbanReaders.tsx), the
    phone's bar reads `chatStateBits`; the dialog's dot takes the same tone and
    the same word, so one screen gives the conversation one colour. */
function sourceState(phone: boolean): { tone: keyof typeof CHAT_TONE_DOT; word: string } {
  if (phone) {
    const bits = chatStateBits(t as never, SOURCE, { nowMs: NOW_MS });
    return { tone: bits.tone, word: bits.phrase };
  }
  const row = mobileRowState(SOURCE, NOW);
  return { tone: row.dot, word: rowStateWord(t as never, row) };
}

/** The «New pipeline» template picker (PipelineTemplatePicker.tsx), with the
    conversation where its repository field is: the checkout is the conversation's. */
function TemplatePickerFromConversation({ phone }: { phone: boolean }) {
  const templates = PIPELINE_TEMPLATES.filter((template) => template.id !== "blank");
  const state = sourceState(phone);
  return (
    <div data-pipeline-picker-state="ready" data-proto-dialog="" className={`fixed inset-0 ${Z.modal} flex items-end justify-center bg-black/40 sm:items-center`} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={t("pipelineTemplates.title")} data-proto-new="" className="w-full max-w-[460px] rounded-t-surface bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2 sm:rounded-surface sm:pb-3">
        <div className="mb-1 flex items-center gap-2">
          <div className="min-w-0 flex-1 text-title font-bold text-primary">{t("pipelineTemplates.title")}</div>
          <button type="button" aria-label={t("common.close")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {/* Where the picker's repository field stands: the conversation, its title whole on its own line, its branch under it. */}
        <div className="mb-2 flex flex-col gap-1">
          <span className="text-label font-semibold text-secondary">{WORDS.conversation}</span>
          <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-control border border-border bg-canvas px-3 py-1.5" data-proto-source="">
            {/* The state dot with its word behind it, as the header's own dot is drawn. */}
            <span className={`h-2 w-2 shrink-0 rounded-full ${CHAT_TONE_DOT[state.tone]}`} role="img" aria-label={state.word} title={state.word} data-proto-state-dot={state.tone} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="min-w-0 text-ui font-semibold leading-snug text-primary">{SOURCE_TITLE}</span>
              <span className="flex min-w-0"><BranchChip className="min-w-0 max-w-full" /></span>
            </span>
          </div>
        </div>
        <div className="mb-2 flex min-h-8 items-center gap-2 text-ui font-semibold text-muted" aria-live="polite">
          <span className="text-success">{WORDS.briefTaken}</span>
        </div>
        <div className="flex flex-col gap-1">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              aria-pressed={template.id === "buildReview"}
              className={`flex min-h-11 w-full flex-col justify-center gap-1 rounded-control px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${template.id === "buildReview" ? "bg-sunken ring-2 ring-accent/40" : ""}`}
            >
              <span className="text-body font-semibold text-primary">{t(template.labelKey)}</span>
              <span className="flex flex-wrap items-center gap-1" aria-hidden>
                {template.stages.map((stage, index) => (
                  <span key={index} className="flex items-center gap-1">
                    {index ? <span className="text-label font-bold text-strong">→</span> : null}
                    <span className={`rounded-full px-2 py-0.5 text-caption font-semibold ${stage.kind === "review-loop" ? "bg-accent-soft text-accent" : "bg-sunken text-secondary"}`}>
                      {stage.kind === "review-loop" ? "⟳ " : ""}
                      {stage.roleId ? roleNameById(t as never, stage.roleId) : t("pipelineTemplates.noRole")}
                    </span>
                  </span>
                ))}
              </span>
            </button>
          ))}
          <button type="button" className="flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-control border border-dashed border-strong px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <span className="text-body font-semibold text-primary">{t("pipelineTemplates.blank")}</span>
            <span className="text-label text-muted">{t("pipelineTemplates.blankHint")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- variant 2: the Send menu and the chain over the composer ---------- */

const findSendButton = () => document.querySelector("[data-composer-send]");
const findComposerForm = () => document.querySelector("[data-conversation-body] form") ?? document.querySelector("form:has([data-composer-field])");

/** The composer's own Send menu (ComposerBar.tsx `ComposerMenu`), with the new
    action among its rows, its right edge on the composer's (over the Send
    button the transcript's timestamps poked out beside it). On the desktop it
    opens where the product opens it, over the Send button; on the phone the
    typed brief is right above that button, so the menu opens over the
    composer's top edge instead and the brief stays readable while the operator
    chooses. */
function SendMenuWithPipeline({ phone }: { phone: boolean }) {
  const rect = useRect(findSendButton);
  const form = useRect(findComposerForm);
  useMarkMenu("composer-send-menu", "protoSendMenu", Boolean(rect && form));
  if (!rect || !form) return null;
  const top = phone ? form.top : rect.top;
  return (
    <ComposerMenu
      label={t("composer.sendMenuTitle")}
      actions={[
        { id: "context-auto", label: t("composer.context.auto"), description: t("composer.context.autoHint"), checked: false, onSelect: () => {} },
        { id: "start-pipeline", label: WORDS.runAsPipeline, description: WORDS.runAsPipelineHint, icon: Workflow, onSelect: () => {} },
      ]}
      onClose={() => {}}
      position={{ bottom: Math.round(window.innerHeight - top + 6), right: Math.round(window.innerWidth - form.right) }}
      owner={document}
    />
  );
}

/** Variant 2b: once «Run as a pipeline» is on, the composer's own Send button
    says what Enter now does. The product's button is kept (its slot, its
    fill, its hint); the prototype adds the words beside its arrow, the way the
    phone's wide slots («Queue», «Respawn») carry theirs. */
function SendAsStart({ phone }: { phone: boolean }) {
  useEffect(() => {
    let labelled: HTMLElement | null = null;
    const apply = () => {
      const button = document.querySelector<HTMLButtonElement>("[data-composer-send]");
      if (!button || button.querySelector("[data-proto-send-label]")) return Boolean(button);
      const visual = phone ? button.querySelector<HTMLElement>("[data-composer-send-visual]") : null;
      const label = document.createElement("span");
      label.dataset.protoSendLabel = "";
      label.dataset.protoNew = "";
      label.className = phone ? "pr-1 text-ui font-semibold" : "pl-1.5 pr-1 text-ui font-semibold";
      /* The phone's toolbar row holds the model chip, the clip and the mic beside it: the short word. */
      label.textContent = phone ? WORDS.startDraft : WORDS.start;
      (visual ?? button).append(label);
      if (phone) {
        /* The product's wide slot: the 44 px target keeps its height and grows to its words. */
        button.classList.remove("w-11");
        button.classList.add("min-w-11", "px-0.5");
        visual?.classList.add("px-2.5");
      } else {
        button.classList.add("gap-0.5", "pr-2.5");
      }
      button.setAttribute("aria-label", WORDS.start);
      button.title = WORDS.start;
      labelled = button;
      return true;
    };
    if (apply()) return;
    const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); labelled?.querySelector("[data-proto-send-label]")?.remove(); };
  }, [phone]);
  return null;
}

const CHAIN = [
  { id: "builder", name: BUILD_NAME, roleId: "builder" },
  { id: "reviewer", name: REVIEW_NAME, roleId: "reviewer" },
] as const;
const ROLES = ["builder", "reviewer", "verifier", "architect"] as const;
/** A 44 px hit area on a 22 px pill: the pill is `position: relative` (pipelineBlock.css). */
const HIT = "after:absolute after:inset-x-0 after:-inset-y-[11px] after:content-['']";

/** The chain over the composer: the pipeline block's own pills (pipelineBlock.css),
    each waiting, the review's fail edge as the «↺» glyph of the block's own
    edge lines, and a dashed «+». On the desktop the heading, the pills and the note share one
    line, so a popover opened above a pill covers none of the strip's words; the
    phone stacks the heading and the pills (the Send menu's hint already said
    the message becomes the pinned task, and the strip's height comes out of
    the composer's budget, which has to keep the brief whole). */
function ChainStrip({ phone, onPill }: { phone: boolean; onPill: (element: HTMLElement | null) => void }) {
  const pills = (
    <div className="pblock" data-density="task" data-proto-chain="" data-proto-hit="44">
      <div className="pb-pills">
        {CHAIN.map((stage, index) => (
          <span key={stage.id} className="pb-step">
            {index ? <span className="pb-arrow" aria-hidden>→</span> : null}
            <button
              type="button"
              ref={stage.id === "reviewer" ? onPill : undefined}
              className={`pb-pill tone-idle waiting ${HIT}${stage.id === "reviewer" ? " selected" : ""}`}
              data-stage={stage.id}
              aria-haspopup="dialog"
              aria-expanded={stage.id === "reviewer"}
              title={`${stage.name} · ${roleNameById(t as never, stage.roleId)}`}
            >
              <span className="pmark" data-mark="ring" aria-hidden />
              <span className="pb-name">{stage.name}</span>
            </button>
            {/* The review's fail edge, the glyph the block's own edge lines use («↺ …»). */}
            {stage.id === "reviewer" ? <span className="pb-arrow" aria-hidden title={t("kanban.loopRest", { from: REVIEW_NAME, to: BUILD_NAME, count: 2 })}>↺</span> : null}
          </span>
        ))}
        <span className="pb-step">
          <button type="button" className={`pb-pill tone-idle waiting more ${HIT}`} data-proto-add-stage="" aria-label={L("Add a stage", "Додати етап")}>
            <span className="pb-name">+ {WORDS.addStage}</span>
          </button>
        </span>
      </div>
    </div>
  );
  const heading = (
    <span className="flex min-w-0 items-center gap-1.5 text-label font-semibold text-secondary">
      <Workflow className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
      <span className="whitespace-nowrap">{WORDS.runAsPipeline}</span>
    </span>
  );
  if (phone) {
    return (
      <div data-proto-new="" data-proto-strip="" className="mx-3 mb-1.5 flex shrink-0 flex-col gap-1.5 rounded-control border border-border bg-sunken px-3 py-2">
        {heading}
        {pills}
      </div>
    );
  }
  return (
    <div data-proto-new="" data-proto-strip="" className="mb-1.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border border-border bg-sunken px-3 py-1.5">
      {heading}
      {/* The block sizes itself from its container, so its slot is the row's remaining width. */}
      <div className="min-w-[320px] flex-1">{pills}</div>
      <span className="ml-auto text-caption text-muted">{WORDS.pinned} {WORDS.enterStarts}</span>
    </div>
  );
}

/** A menu the product draws through a portal (`ComposerMenu` renders into the
    document's body) is marked as this prototype's once it is in the DOM, so
    the readings measure its words and its rows like every other new element,
    and a frame can wait for it. The menu moves focus to its first plain row
    on mount; in a frame nobody pressed anything, so the ring that focus would
    draw is taken off again. */
function useMarkMenu(testId: string, mark: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const menu = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!menu) return;
    menu.dataset.protoNew = "";
    menu.dataset[mark] = "";
    if (menu.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, [testId, mark, ready]);
}

const findStrip = () => document.querySelector("[data-proto-strip]");

/** The role rows of one pill: the board's popover on the desktop
    (kanbanMenus.tsx); on the phone the composer's own menu (`ComposerMenu`,
    the one its Send button opens in frame 2a), standing above the strip so
    the chain, «+ Stage» and the Send button's «Start» stay in view while the
    operator chooses. A sheet would cover the composer, and with it the very
    thing this frame is about. */
function RoleChoice({ phone, anchor }: { phone: boolean; anchor: HTMLElement | null }) {
  const title = `${REVIEW_NAME} · ${WORDS.stageOf(2, CHAIN.length)}`;
  /* The pill stands inside the board, whose `.kb` scopes the popover's styles. */
  const scope = anchor?.closest(".kb") ?? null;
  const strip = useRect(findStrip);
  const pill = useRect(() => anchor);
  useMarkMenu("proto-role-menu", "protoRoles", Boolean(phone && strip && pill));
  if (phone) {
    if (!strip || !pill) return null;
    /* The menu's left edge on the pill's, its right edge no further than the strip's. */
    const right = Math.round(window.innerWidth - Math.min(pill.left + 220, strip.right));
    return (
      <ComposerMenu
        label={title}
        testId="proto-role-menu"
        actions={[
          ...ROLES.map((roleId) => ({ id: roleId, label: roleNameById(t as never, roleId), description: ROLE_WHY[roleId], checked: roleId === "reviewer", onSelect: () => {} })),
          { id: "remove", label: WORDS.removeStage, description: WORDS.removeStageWhy, icon: X, onSelect: () => {} },
        ]}
        onClose={() => {}}
        position={{ bottom: Math.round(window.innerHeight - strip.top + 6), right }}
        owner={document}
      />
    );
  }
  if (!anchor || !scope) return null;
  /* The board's popover styles are scoped under `.kb`, so it is drawn inside the board. */
  return createPortal(
    <KanbanPopover anchor={anchor} within={anchor.closest<HTMLElement>("[data-proto-strip]")} label={title} onClose={() => {}} initialFocus="[aria-checked='true']">
      <div data-proto-new="" data-proto-roles="">
        <div className="head">{REVIEW_NAME} <span className="n">· {WORDS.stageOf(2, CHAIN.length)}</span></div>
        {ROLES.map((roleId) => (
          <button key={roleId} type="button" role="menuitemradio" aria-checked={roleId === "reviewer"} className="row w-full text-left">
            <span className="t">
              <span className="title">{roleNameById(t as never, roleId)}</span>
              <span className="meta">{ROLE_WHY[roleId]}</span>
            </span>
            {roleId === "reviewer" ? <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : null}
          </button>
        ))}
        <div className="sep my-1 h-px bg-border" role="separator" />
        {/* The destructive row in the board's danger colour (`.row.danger`, prototype.css). */}
        <button type="button" role="menuitem" className="row danger w-full text-left">
          <span className="t"><span className="title">{WORDS.removeStage}</span></span>
        </button>
      </div>
    </KanbanPopover>,
    scope,
  );
}

/** Variant 2b: the strip goes over the composer's form, the Send button says
    «Start pipeline», and the review pill's choice is open: the board's popover
    on the desktop, the composer's own menu above the strip on the phone (both
    name the pill in their title and leave the strip's words uncovered). */
function ChainOverComposer({ phone }: { phone: boolean }) {
  const host = useInsertedHost(findComposerSpot);
  const [pill, setPill] = useState<HTMLElement | null>(null);
  if (!host) return null;
  return (
    <>
      {createPortal(<ChainStrip phone={phone} onPill={setPill} />, host)}
      <SendAsStart phone={phone} />
      <RoleChoice phone={phone} anchor={pill} />
    </>
  );
}
function findComposerSpot() {
  const form = findComposerForm();
  return form ? { parent: form.parentElement!, before: form } : null;
}

/* ---------- variant 3: the draft lane's Start ---------- */

/** The start control in the lane's tail, before its state word (pipelineBlock.css `.pb-tail`), the board's own primary button. */
function LaneStart() {
  const host = useInsertedHost(findLaneHeadSpot, "span");
  if (!host) return null;
  return createPortal(
    <button type="button" className="btn primary sm" data-proto-new="" data-proto-start="">
      <Play className="h-3 w-3" aria-hidden />
      {WORDS.startDraft}
    </button>,
    host,
  );
}
function findLaneHeadSpot() {
  const tail = document.querySelector('.kb [data-pipeline="pl_csv"][data-density="task"] .pb-tail');
  return tail ? { parent: tail, before: tail.firstElementChild } : null;
}

/** Phone 3b: the brief the start launches, under the stage list, as the
    screen's own sections are drawn (the linked-tasks section's heading and
    row shapes): the first message's text, whole, and the product's Edit. */
function PhoneBriefSection() {
  const host = useInsertedHost(findPhoneBriefSpot, "div");
  if (!host) return null;
  return createPortal(
    <section data-proto-new="" data-proto-brief="" className="flex shrink-0 flex-col gap-1.5">
      <h3 className="flex min-h-[30px] items-center gap-1.5 text-ui font-semibold text-secondary">{WORDS.firstMessage}</h3>
      <div className="flex flex-col gap-2 rounded-[12px] bg-quiet px-3 py-2.5 ring-1 ring-inset ring-border">
        <p className="m-0 whitespace-pre-line text-body leading-[1.4] text-primary">{BRIEF}</p>
        <div className="flex min-h-11 items-center gap-2">
          <span className="min-w-0 flex-1 text-label text-muted">{WORDS.firstMessageWhy}</span>
          <button type="button" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {WORDS.edit}
          </button>
        </div>
      </div>
    </section>,
    host,
  );
}
/** After the stage list, before the screen's other sections. */
function findPhoneBriefSpot() {
  const body = document.querySelector("[data-mobile2-pipeline-body]");
  const block = body?.querySelector('[data-pipeline="pl_csv"]');
  const top = block ? [...body!.children].find((child) => child.contains(block)) ?? null : null;
  return body && top ? { parent: body, before: top.nextElementSibling } : null;
}

/** Phone 3b: the pipeline screen's foot carries the start, the way the task screen's foot carries «+ Agent». */
function PhoneLaneStart() {
  return (
    <div data-proto-new="" data-proto-start-dock="" className="flex shrink-0 flex-col border-t border-border bg-card px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2.5">
      <button type="button" className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-control bg-brand px-4 text-body font-semibold text-on-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        <Play className="h-4 w-4" aria-hidden />
        {WORDS.startDraftLong}
      </button>
    </div>
  );
}

/* ---------- desktop ---------- */

function DesktopScreen() {
  const reading = VARIANT !== 3;
  usePress(
    VARIANT === 1 && FRAME === "a" ? "[data-reader-menu]"
      : VARIANT === 3 && FRAME === "a" ? '[data-kanban-card="task:t-csv"] [data-menu]'
      : VARIANT === 3 && FRAME === "b" ? '[data-kanban-card="task:t-csv"] button.fold[aria-expanded="false"]'
      : null,
  );
  /* The unfolded card draws its lane at task density, whose waiting pills open their draft panel. */
  usePress(VARIANT === 3 && FRAME === "b" ? '[data-pipeline="pl_csv"][data-density="task"] button.pb-pill[data-stage="builder"]' : null);
  useReady(
    FRAME === "a" ? (VARIANT === 2 ? "[data-testid='composer-send-menu']" : "[data-proto-row]")
      : VARIANT === 1 ? "[data-proto-dialog]" : VARIANT === 2 ? "[data-proto-roles]" : "[data-draft-stage='builder'] .bubble",
  );
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas text-primary" data-proto-screen={`${VARIANT}${FRAME}`}>
      <Caption />
      <div className="flex min-h-0 flex-1 flex-col">
        <KanbanBoard
          project={PROJECT}
          groups={[]}
          manual={[]}
          files={FILES}
          flows={[]}
          pipelines={PIPELINES}
          tasks={TASKS}
          allTasks={TASKS}
          drafts={[]}
          now={NOW}
          loaded
          catalogFailures={0}
          selection={new Set()}
          seatRefs={null}
          focus={reading ? SOURCE_PATH : null}
          readerStorage={null}
        />
      </div>
      {VARIANT === 1 && FRAME === "a" ? <DesktopMenuRow label={WORDS.start} why={WORDS.startWhy} find={findReaderMenuSpot} /> : null}
      {VARIANT === 1 && FRAME === "b" ? <TemplatePickerFromConversation phone={false} /> : null}
      {VARIANT === 2 && FRAME === "a" ? <SendMenuWithPipeline phone={false} /> : null}
      {VARIANT === 2 && FRAME === "b" ? <ChainOverComposer phone={false} /> : null}
      {VARIANT === 3 && FRAME === "a" ? <DesktopMenuRow label={WORDS.fromConversationRow} why={<>{SOURCE_TITLE} · <span className="whitespace-nowrap">{BRANCH}</span></>} find={findCardMenuSpot} /> : null}
      {VARIANT === 3 && FRAME === "b" ? <LaneStart /> : null}
    </div>
  );
}

/* ---------- phone ---------- */

function PhoneChat() {
  const noop = () => undefined;
  useReady(
    FRAME === "a" ? (VARIANT === 2 ? "[data-testid='composer-send-menu']" : "[data-proto-row]")
      : VARIANT === 1 ? "[data-proto-dialog]" : "[data-proto-roles]",
  );
  /* The bar's state word is the product's own (`chatStateBits`, as the chat
     screen's bar and the conversation sheet read it), so the bar and the sheet agree. */
  const bits = chatStateBits(t as never, SOURCE, { nowMs: NOW_MS });
  return (
    <div data-testid="mobile-chat-shell" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overflow-x-clip bg-canvas text-primary">
      <MobileShell
        screen="chat"
        screenId={SOURCE_ID}
        title={(
          <MobileBarTitle meta={(
            <span className="flex min-w-0 items-center gap-1 truncate text-label text-muted">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CHAT_TONE_DOT[bits.tone]}`} aria-hidden />
              <span className={`truncate ${CHAT_TONE_TEXT[bits.tone]}`}>{bits.phrase}</span>
              <span className="shrink-0">· Opus 5.5 · high</span>
            </span>
          )}>{SOURCE_TITLE}</MobileBarTitle>
        )}
        back
        renderSheet={() => null}
      >
        <BranchPane file={SOURCE} tasks={[]} isRoot chromeInMenu onClose={noop} />
      </MobileShell>
      {VARIANT === 1 && FRAME === "a" ? (
        <>
          <MobileConversationMenu file={SOURCE} stage={null} crowned={false} hostTaskCount={0} onRename={noop} onOpenHost={noop} projectName={PROJECT} onClose={noop} onOpenSearch={noop} onHandoff={noop} />
          <PhoneMenuRow label={WORDS.start} why={WORDS.startWhy} find={findPhoneChatMenuSpot} />
        </>
      ) : null}
      {VARIANT === 1 && FRAME === "b" ? <TemplatePickerFromConversation phone /> : null}
      {VARIANT === 2 && FRAME === "a" ? <SendMenuWithPipeline phone /> : null}
      {VARIANT === 2 && FRAME === "b" ? <ChainOverComposer phone /> : null}
    </div>
  );
}

function PhoneTask() {
  const noop = () => undefined;
  usePress(FRAME === "a" ? '[data-mobile2-open="menu"]' : null);
  useReady(FRAME === "a" ? "[data-proto-row]" : "[data-proto-start-dock]");
  if (FRAME === "b") {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas text-primary">
        <div className="flex min-h-0 flex-1 flex-col">
          <MobilePipelineScreen pipeline={DRAFT_LANE} files={FILES} tasks={TASKS} now={NOW} onOpenConversation={noop} cameFromTask="t-csv" />
        </div>
        <PhoneBriefSection />
        <PhoneLaneStart />
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas text-primary">
      <MobileTaskScreen
        taskId="t-csv"
        project={PROJECT}
        groups={[]}
        manual={[]}
        files={FILES}
        flows={[]}
        pipelines={PIPELINES}
        tasks={TASKS}
        allTasks={TASKS}
        drafts={[]}
        now={NOW}
        seatRefs={null}
        onOpenConversation={noop}
        onOpenPipeline={noop}
      />
      <PhoneMenuRow label={WORDS.fromConversationRow} why={<>{SOURCE_TITLE} · <span className="whitespace-nowrap">{BRANCH}</span></>} find={findPhoneTaskMenuSpot} />
    </div>
  );
}

function PhoneScreen() {
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas text-primary" data-proto-screen={`${VARIANT}${FRAME}`}>
      <Caption />
      {VARIANT === 3 ? <PhoneTask /> : <PhoneChat />}
    </div>
  );
}

/* ---------- mount ---------- */

function Screen() {
  const phone = useIsMobile();
  useLayoutEffect(() => { document.body.style.margin = "0"; }, []);
  useWholeTopRow();
  return phone ? <PhoneScreen /> : <DesktopScreen />;
}

createRoot(document.getElementById("root")!).render(<Screen />);
