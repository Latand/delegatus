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
import { Check, GitBranch, Play, Workflow, X } from "lucide-react";

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
import { MobileConversationMenu } from "@/components/mobile/MobileConversationMenu";
import { MobileSheet, MobileSheetRow } from "@/components/mobile/MobileSheet";
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
    "Understood: the format stays byte for byte. Done: streaming writes, and a retry on 503 with pauses of 1 → 2 → 4 s. Three files changed: `src/export/csvWriter.ts`, `src/export/upload.ts` and a new `src/export/retry.ts`.",
    "Зрозумів: формат лишаю байт у байт. Зробив потоковий запис і повтор на 503 з паузами 1 → 2 → 4 с. Змінено три файли: `src/export/csvWriter.ts`, `src/export/upload.ts` і новий `src/export/retry.ts`.",
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
    "Done: streaming writes in chunks of 5,000 rows; retry on 503 with pauses of 1 → 2 → 4 s. Tests green (42 pass).",
    "Left: a test for the retry after 503, then a review of the three changed files.",
  ].join("\n"),
  [
    "Експорт CSV падає на великих проєктах (понад 50 тис. рядків): воркер вилітає по пам’яті.",
    "Вирішено в розмові: формат файлу лишається байт у байт, клієнти його парсять.",
    "Зроблено: потоковий запис частинами по 5 000 рядків; повтор на 503 з паузами 1 → 2 → 4 с. Тести зелені (42 pass).",
    "Лишилось: тест на повтор після 503, потім рев’ю трьох змінених файлів.",
  ].join("\n"),
);
/* Variant 2: what the operator types in the composer and hands to the pipeline. */
const TYPED = L(
  "Finish the retry test after 503 and keep the file format byte for byte. Then a review of the three changed files; fix whatever the review finds.",
  "Доведи тест на повтор після 503 і не міняй формат файлу. Потім рев’ю трьох змінених файлів; що знайде рев’ю — виправ.",
);

const role = (roleId: string, access: "read-only" | "read-write") => ({ roleId, engine: "claude", model: "claude-opus-5-5", effort: "high", access, promptScaffold: null });
const STAGES = [
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: `{{task}}\n\n${BRIEF}`, next: "review", effectiveRole: role("builder", "read-write") },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "{{task}}", next: null, onFail: { to: "fix", maxRounds: 2 }, effectiveRole: role("reviewer", "read-only") },
  { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "{{prev.output}}", next: "review", effectiveRole: role("builder", "read-write") },
] as unknown as Pipeline["stages"];
const [BUILD_NAME, REVIEW_NAME, FIX_NAME] = STAGES.map((stage) => stageDisplayName(t as never, stage)) as [string, string, string];

/* Variant 3, frame b: the draft lane the card holds before the start. */
const DRAFT_LANE: Pipeline = {
  id: "pl_csv", task: TASK_TITLE, taskIds: ["t-csv"], project: PROJECT, repoDir: `/work/${PROJECT}`,
  worktreeDir: `/work/${PROJECT}/${WORKTREE_LABEL}`, branch: BRANCH, baseBranch: "main", baseRef: "main", lastPassedCommit: "",
  stages: STAGES, runs: [],
  cursor: { stageId: "build", state: "pending", input: null, activatedBy: null },
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
  fromConversation: L("From the conversation", "З розмови"),
  conversation: L("Conversation", "Розмова"),
  briefTaken: L(`Brief taken from 7 messages · ${DIRTY.length} uncommitted files stay in the checkout`, `Опис узято з 7 повідомлень · ${DIRTY.length} незакомічені файли лишаються в робочій копії`),
  runAsPipeline: L("Run as a pipeline", "Запустити як пайплайн"),
  runAsPipelineHint: L("This message becomes the pinned task; the stages are chosen next", "Це повідомлення стане закріпленою задачею; етапи — наступним кроком"),
  pinned: L("this message becomes the pinned task", "це повідомлення стане закріпленою задачею"),
  addStage: L("Stage", "Етап"),
  enterStarts: L("Enter starts the pipeline instead of sending. Esc returns to a plain message.", "Enter запускає пайплайн замість відправки. Esc повертає до звичайного повідомлення."),
  stageOf: (k: number, n: number) => L(`stage ${k} of ${n}`, `етап ${k} з ${n}`),
  removeStage: L("Remove this stage", "Прибрати цей етап"),
  fromConversationRow: L("Pipeline from conversation…", "Пайплайн з розмови…"),
  startDraft: L("Start", "Запустити"),
  startDraftLong: L("Start pipeline", "Запустити пайплайн"),
  draftNote: L("Build's first message is the brief from the conversation. Edit it, then start.", "Перше повідомлення Build — опис із розмови. Поправте, якщо треба, і запускайте."),
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
    b: L("A stage chain appears above the composer: a pill opens its role, “+” adds a stage; Enter starts.", "Над композером стає ланцюжок етапів: плашка відкриває свою роль, «+» додає етап; Enter запускає."),
  },
  3: {
    a: L("The task card's ⋯ menu gets “Pipeline from conversation…”, naming the conversation and its branch.", "У меню картки задачі ⋯ — пункт «Пайплайн з розмови…» з назвою розмови і гілкою."),
    b: L("A draft lane lands on the card: Build's first message is the brief from the conversation, editable in place; “Start” launches it.", "На картці з’являється чернетка пайплайна: перше повідомлення Build — опис із розмови, його можна правити; «Запустити» стартує."),
  },
};
/* The phone's pipeline screen keeps the brief behind each stage's ⚙, so its caption says so. */
const PHONE_CAPTIONS: Partial<Record<`${Variant}${Frame}`, string>> = {
  "3b": L("The pipeline screen holds the draft lane: three stages with their roles, ⚙ opens Build's first message (the brief from the conversation), “Start pipeline” launches it.", "Екран пайплайна тримає чернетку: три етапи з ролями, ⚙ відкриває перше повідомлення Build (опис із розмови), «Запустити пайплайн» стартує."),
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

/** Presses the product's own control once it exists: the reader's ⋯, the card's ⋯, a stage pill. */
function usePress(selector: string | null) {
  useEffect(() => {
    if (!selector) return;
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

/** The «New pipeline» template picker (PipelineTemplatePicker.tsx), with the
    conversation where its repository field is: the checkout is the conversation's. */
function TemplatePickerFromConversation() {
  const templates = PIPELINE_TEMPLATES.filter((template) => template.id !== "blank");
  return (
    <div data-pipeline-picker-state="ready" data-proto-dialog="" className={`fixed inset-0 ${Z.modal} flex items-end justify-center bg-black/40 sm:items-center`} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={t("pipelineTemplates.title")} data-proto-new="" className="w-full max-w-[460px] rounded-t-surface bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2 sm:rounded-surface sm:pb-3">
        <div className="mb-1 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-title font-bold text-primary">{t("pipelineTemplates.title")}</div>
            <div className="text-ui text-muted">{WORDS.fromConversation}</div>
          </div>
          <button type="button" aria-label={t("common.close")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="mb-2 flex flex-col gap-1">
          <span className="text-label font-semibold text-secondary">{WORDS.conversation}</span>
          <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-control border border-border bg-canvas px-3" data-proto-source="">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{SOURCE_TITLE}</span>
            <BranchChip />
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

/** The composer's own Send menu (ComposerBar.tsx `ComposerMenu`), with the new action among its rows. */
function SendMenuWithPipeline() {
  const rect = useRect(findSendButton);
  if (!rect) return null;
  return (
    <div data-proto-new="" data-proto-send-menu="">
      <ComposerMenu
        label={t("composer.sendMenuTitle")}
        actions={[
          { id: "context-auto", label: t("composer.context.auto"), description: t("composer.context.autoHint"), checked: false, onSelect: () => {} },
          { id: "start-pipeline", label: WORDS.runAsPipeline, description: WORDS.runAsPipelineHint, icon: Workflow, onSelect: () => {} },
        ]}
        onClose={() => {}}
        position={{ bottom: Math.round(window.innerHeight - rect.top + 6), right: Math.round(window.innerWidth - rect.right) }}
        owner={document}
      />
    </div>
  );
}

const CHAIN = [
  { id: "build", name: BUILD_NAME, roleId: "builder", side: false },
  { id: "review", name: REVIEW_NAME, roleId: "reviewer", side: false },
  { id: "fix", name: FIX_NAME, roleId: "builder", side: true },
] as const;
const ROLES = ["builder", "reviewer", "verifier", "architect"] as const;
/** A 44 px hit area on a 22 px pill: the pill is `position: relative` (pipelineBlock.css). */
const HIT = "after:absolute after:inset-x-0 after:-inset-y-[11px] after:content-['']";

/** The chain over the composer: the pipeline block's own pills (pipelineBlock.css), each waiting, and a dashed «+». */
function ChainStrip({ phone, onPill }: { phone: boolean; onPill: (element: HTMLElement | null) => void }) {
  return (
    <div data-proto-new="" data-proto-strip="" className={`${phone ? "mx-3" : ""} mb-1.5 flex shrink-0 flex-col gap-1.5 rounded-control border border-border bg-sunken px-3 py-2`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-label font-semibold text-secondary">
        <Workflow className="h-3.5 w-3.5 shrink-0 self-center text-accent" aria-hidden />
        <span>{WORDS.runAsPipeline}</span>
        <span className="font-normal text-muted">· {WORDS.pinned}</span>
      </div>
      {/* Each pill keeps the block's 22 px look; its hit area reaches 44 px through an invisible extension. */}
      <div className="pblock" data-density="task" data-proto-chain="" data-proto-hit="44">
        <div className="pb-pills">
          {CHAIN.map((stage, index) => (
            <span key={stage.id} className="pb-step">
              {index ? <span className="pb-arrow" aria-hidden>{stage.side ? "↺" : "→"}</span> : null}
              <button
                type="button"
                ref={stage.id === "review" ? onPill : undefined}
                className={`pb-pill tone-idle waiting ${HIT}${stage.side ? " side" : ""}${stage.id === "review" ? " selected" : ""}`}
                data-stage={stage.id}
                aria-haspopup="dialog"
                aria-expanded={stage.id === "review"}
                title={`${stage.name} · ${roleNameById(t as never, stage.roleId)}`}
              >
                <span className="pmark" data-mark="ring" aria-hidden />
                <span className="pb-name">{stage.name}</span>
              </button>
            </span>
          ))}
          <span className="pb-step">
            <button type="button" className={`pb-pill tone-idle waiting more ${HIT}`} data-proto-add-stage="" aria-label={L("Add a stage", "Додати етап")}>
              <span className="pb-name">+ {WORDS.addStage}</span>
            </button>
          </span>
        </div>
      </div>
      <span className="text-caption text-muted">{WORDS.enterStarts}</span>
    </div>
  );
}

/** The role rows of one pill: the board's popover on the desktop (kanbanMenus.tsx), a sheet on the phone. */
function RoleChoice({ phone, anchor }: { phone: boolean; anchor: HTMLElement | null }) {
  const title = `${REVIEW_NAME} · ${WORDS.stageOf(2, 3)}`;
  /* The pill stands inside the board, whose `.kb` scopes the popover's styles. */
  const scope = anchor?.closest(".kb") ?? null;
  if (phone) {
    return (
      <MobileSheet name="menu" title={title} onClose={() => {}}>
        <div role="menu" aria-label={title} className="flex flex-col py-1" data-proto-new="" data-proto-roles="">
          {ROLES.map((roleId) => (
            <MobileSheetRow
              key={roleId}
              label={(
                <span className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate">{roleNameById(t as never, roleId)}</span>
                  <span className="min-w-0 truncate text-label font-medium text-secondary">{ROLE_WHY[roleId]}</span>
                </span>
              )}
              checked={roleId === "reviewer"}
              selected={roleId === "reviewer"}
              trailing={roleId === "reviewer" ? <Check className="h-4 w-4 text-accent" aria-hidden /> : undefined}
              onSelect={() => {}}
            />
          ))}
          <div className="my-1.5 h-px shrink-0 bg-border" aria-hidden />
          <MobileSheetRow icon={<X className="h-[18px] w-[18px]" aria-hidden />} label={WORDS.removeStage} danger onSelect={() => {}} />
        </div>
      </MobileSheet>
    );
  }
  if (!anchor || !scope) return null;
  /* The board's popover styles are scoped under `.kb`, so it is drawn inside the board. */
  return createPortal(
    <KanbanPopover anchor={anchor} within={anchor.closest<HTMLElement>("[data-proto-strip]")} label={title} onClose={() => {}} initialFocus="[aria-checked='true']">
      <div data-proto-new="" data-proto-roles="">
        <div className="head">{REVIEW_NAME} <span className="n">· {WORDS.stageOf(2, 3)}</span></div>
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
        <button type="button" role="menuitem" className="row w-full text-left text-danger">
          <span className="t"><span className="title">{WORDS.removeStage}</span></span>
        </button>
      </div>
    </KanbanPopover>,
    scope,
  );
}

/** Variant 2b: the strip goes over the composer's form, and the review pill's choice opens. */
function ChainOverComposer({ phone }: { phone: boolean }) {
  const host = useInsertedHost(findComposerSpot);
  const [pill, setPill] = useState<HTMLElement | null>(null);
  if (!host) return null;
  return (
    <>
      {createPortal(<ChainStrip phone={phone} onPill={setPill} />, host)}
      {/* The phone's role sheet would cover the strip it opens from, so the phone frame shows the strip. */}
      {phone ? null : <RoleChoice phone={phone} anchor={pill} />}
    </>
  );
}
function findComposerSpot() {
  const form = document.querySelector("[data-conversation-body] form") ?? document.querySelector("form:has([data-composer-field])");
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

/** Phone 3b: the pipeline screen's foot carries the start, the way the task screen's foot carries «+ Agent». */
function PhoneLaneStart() {
  return (
    <div data-proto-new="" data-proto-start-dock="" className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2.5">
      <p className="m-0 text-label text-muted">{WORDS.draftNote}</p>
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
  usePress(VARIANT === 3 && FRAME === "b" ? '[data-pipeline="pl_csv"][data-density="task"] button.pb-pill[data-stage="build"]' : null);
  useReady(
    FRAME === "a" ? (VARIANT === 2 ? "[data-testid='composer-send-menu']" : "[data-proto-row]")
      : VARIANT === 1 ? "[data-proto-dialog]" : VARIANT === 2 ? "[data-proto-roles]" : "[data-draft-stage='build'] .bubble",
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
      {VARIANT === 1 && FRAME === "b" ? <TemplatePickerFromConversation /> : null}
      {VARIANT === 2 && FRAME === "a" ? <SendMenuWithPipeline /> : null}
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
      : VARIANT === 1 ? "[data-proto-dialog]" : "[data-proto-strip]",
  );
  return (
    <div data-testid="mobile-chat-shell" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overflow-x-clip bg-canvas text-primary">
      <MobileShell
        screen="chat"
        screenId={SOURCE_ID}
        title={<MobileBarTitle meta={<span className="truncate text-label text-muted">{L("idle · 11 min", "чекає · 11 хв")} · Opus 5.5 · high</span>}>{SOURCE_TITLE}</MobileBarTitle>}
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
      {VARIANT === 1 && FRAME === "b" ? <TemplatePickerFromConversation /> : null}
      {VARIANT === 2 && FRAME === "a" ? <SendMenuWithPipeline /> : null}
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
  return phone ? <PhoneScreen /> : <DesktopScreen />;
}

createRoot(document.getElementById("root")!).render(<Screen />);
