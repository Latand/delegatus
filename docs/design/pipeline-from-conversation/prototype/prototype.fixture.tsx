"use client";

/*
 * Prototype: start a pipeline from the current conversation
 * (docs/design/pipeline-from-conversation.md). Every screen is the product's
 * own components over invented fixture data: the desktop board (`KanbanBoard`,
 * its card, its agent window and reader, the reader's ⋯ `BoardMenu`), the
 * phone shell, conversation and ⋯ sheet (`MobileShell`, `BranchPane`,
 * `MobileConversationMenu`) and the phone board (`MobileKanban`). What does
 * not exist yet is drawn with the product's own primitives and classes: the
 * menu row «Start pipeline», the preview (the pipeline template picker's
 * dialog on the desktop, `MobileSheet` on the phone) and the line that links
 * the lane back to its conversation.
 *
 * The query string picks what is drawn:
 *   ?variant=1|2|3&screen=1..5&lang=uk|en&theme=light|dark  one screen
 *   ?strip&variant=…&device=desktop|phone&lang=…&theme=…    the four steps
 *                                                            and their captions
 * Step 4 is two frames: the board (screen 4, «4а») and the source
 * conversation after the start (screen 5, «4б»).
 *   …&w=820                                                  an in-between width
 * The strip lays every screen out in its own frame at its real viewport, so
 * each screen keeps its own width rules. See README.md.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { CornerDownRight, Workflow } from "lucide-react";

import { setLocale, translate, type Locale } from "@/lib/i18n";
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
import { MobileKanban } from "@/components/mobile/MobileKanban";
import { stageDisplayName } from "@/components/pipelines/pipelineModel";
import { Z } from "@/components/layers";
import { useIsMobile } from "@/hooks/useIsMobile";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = ([1, 2, 3] as const).find((n) => String(n) === params.get("variant")) ?? 1;
const SCREEN = ([1, 2, 3, 4, 5] as const).find((n) => String(n) === params.get("screen")) ?? 1;
type Variant = typeof VARIANT;
type Screen = typeof SCREEN;

document.documentElement.dataset.theme = THEME;
document.documentElement.lang = LANG;
try { localStorage.setItem("llv_lang", LANG); } catch { /* opaque origin */ }
setLocale(LANG);
const L = (en: string, uk: string) => (LANG === "uk" ? uk : en);

/* A frozen clock: every age on every screen reads the same in each render. */
const NOW_MS = Date.parse("2026-10-24T10:46:00.000Z");
const NOW = NOW_MS / 1000;
Date.now = () => NOW_MS;
const iso = (minutesAgo: number) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();
function clock(minutesAgo: number): string {
  const at = new Date(NOW_MS - minutesAgo * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

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

/* ---------- invented project, conversation and lane ---------- */

const PROJECT = "orbit-store";
const BRANCH = "fix/csv-export-retry";
const WORKTREE_LABEL = "worktrees/csv-export-retry";
const NEW_BRANCH = "pipeline/csv-export-retry";
/* The conversation's last commit, in the clock the feed shows its times in. */
const LAST_COMMIT_AT = clock(22);
const DIRTY = ["src/export/csvWriter.ts", "src/export/upload.ts", "src/export/retry.ts"];

/* The source conversation is mid-turn on screens 1 and 2, done after. On
   screens 4 and 5 the lane exists; in variant 3 the source is its Build stage,
   so it is working again. */
const SOURCE_WORKING = SCREEN <= 2;
const STARTED = SCREEN >= 4;
const SOURCE_IS_BUILD = STARTED && VARIANT === 3;

const SOURCE_TITLE = L("CSV export retry", "Повтор експорту CSV");
const TASK_TITLE = L("CSV export fails on large projects", "Експорт CSV падає на великих проєктах");

const USAGE = { input_tokens: 120, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0, output_tokens: 90 };
let seq = 0;
const user = (minutesAgo: number, text: string) => JSON.stringify({ type: "user", uuid: `u-${++seq}`, timestamp: iso(minutesAgo), message: { role: "user", content: text } });
const said = (minutesAgo: number, text: string, tool?: { id: string; name: string; input: Record<string, unknown> }) => JSON.stringify({
  type: "assistant", uuid: `a-${++seq}`, timestamp: iso(minutesAgo), requestId: `req-${seq}`,
  message: { id: `msg-${seq}`, role: "assistant", stop_reason: tool ? "tool_use" : "end_turn", usage: USAGE,
    content: [...(text ? [{ type: "text", text }] : []), ...(tool ? [{ type: "tool_use", ...tool }] : [])] },
});
const result = (minutesAgo: number, id: string, text: string) => JSON.stringify({ type: "user", uuid: `r-${++seq}`, timestamp: iso(minutesAgo), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });

function sourceTranscript(): string[] {
  const lines = [
    user(38, L(
      "CSV export fails on large projects (over 50k rows): the worker runs out of memory. Find out why and fix it.",
      "Експорт CSV падає на великих проєктах (понад 50 тис. рядків): воркер вилітає по пам’яті. Розберись і полагодь.",
    )),
    said(37, "", { id: "t-read", name: "Read", input: { file_path: "src/export/csvWriter.ts" } }),
    result(36.9, "t-read", "export async function writeCsv(rows) { const all = rows.map(toLine).join(\"\\n\"); … }"),
    said(35, L(
      "The cause: `csvWriter` builds the whole file in memory before it uploads. I am rewriting it to stream the rows in chunks of 5,000.",
      "Причина: `csvWriter` збирає весь файл у пам’яті, перш ніж вивантажити. Переписую на потоковий запис частинами по 5 000 рядків.",
    )),
    user(30, L(
      "Do not change the file format: customers parse it. And retry when storage answers 503.",
      "Формат файлу не міняй — клієнти його парсять. І додай повтор, якщо сховище відповіло 503.",
    )),
    said(22, L(
      "Understood: the format stays byte for byte. Done: streaming writes, and a retry on 503 with pauses of 1 → 2 → 4 s. Three files changed: `src/export/csvWriter.ts`, `src/export/upload.ts` and a new `src/export/retry.ts`. Tests not run yet.",
      "Зрозумів: формат лишаю байт у байт. Зробив потоковий запис і повтор на 503 з паузами 1 → 2 → 4 с. Змінено три файли: `src/export/csvWriter.ts`, `src/export/upload.ts` і новий `src/export/retry.ts`. Тести ще не запускав.",
    )),
    user(6, L("Run the tests and check a file of 80k rows.", "Запусти тести і перевір на файлі з 80 тис. рядків.")),
    said(5, L("Running the export tests first.", "Спершу запускаю тести експорту."), { id: "t-test", name: "Bash", input: { command: "bun test src/export", description: L("Run the export tests", "Тести експорту") } }),
  ];
  if (SOURCE_WORKING) return lines;
  const done = [
    ...lines,
    result(3, "t-test", "42 pass\n0 fail\nRan 42 tests across 6 files. [4.81s]"),
    said(1, L(
      "Tests are green (42 pass). An 80k-row file writes in 6 s and stays under 120 MB. Left: a test for the retry after 503.",
      "Тести зелені (42 pass). Файл на 80 тис. рядків пишеться за 6 с і тримається до 120 МБ. Лишилось: тест на повтор після 503.",
    )),
  ];
  if (!SOURCE_IS_BUILD) return done;
  /* Variant 3: the Build stage's rules arrive from the pipeline, drawn as the feed's
     message card with its sender («від пайплайна»), never as the operator's bubble. */
  const fromPipeline = (body: string) => `<agent-message from="${L("pipeline", "пайплайна")}">${body}</agent-message>`;
  return [
    ...done,
    user(0.7, fromPipeline(L(
      `Pipeline stage ${BUILD_NAME}. Task: CSV export fails on large projects. Finish what is left (a test for the retry after 503), keep the file format byte for byte, commit, and report to the pipeline. ${REVIEW_NAME} comes next.`,
      `Етап пайплайна ${BUILD_NAME}. Задача: експорт CSV падає на великих проєктах. Доробіть, що лишилось (тест на повтор після 503), формат файлу не міняйте, закомітьте і звітуйте пайплайну. Далі — ${REVIEW_NAME}.`,
    ))),
    said(0.4, L("Taking the Build stage: writing the test for the retry after 503.", "Беру етап Build: пишу тест на повтор після 503.")),
  ];
}

const SOURCE_PATH = "/sessions/orbit-store/csv-export-retry.jsonl";
const SOURCE_ID = "conv_csv_export_retry";
const BUILD_PATH = "/sessions/orbit-store/pipeline-build.jsonl";

const conversation = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
  root: "claude-projects", name: over.path.split("/").pop(), project: PROJECT, engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: NOW - 60, size: 4_096, activity: "idle", proc: null, pid: null, model: "claude-opus-5-5", effort: "high",
  pendingQuestion: null, waitingInput: null, generation: 1,
  ...over,
} as unknown as FileEntry);

/* Variant 3 adopts the source as the Build stage: from screen 4 on it is the stage's conversation. */
const SOURCE = conversation({
  path: SOURCE_PATH, conversationId: SOURCE_ID, title: SOURCE_TITLE,
  cwd: `/work/${PROJECT}/${WORKTREE_LABEL}`, gitBranch: BRANCH,
  activity: SOURCE_WORKING || SOURCE_IS_BUILD ? "live" : "idle",
  proc: "running", pid: 48_213,
  mtime: SOURCE_WORKING ? NOW - 20 : SOURCE_IS_BUILD ? NOW - 10 : NOW - 60,
  lastTurn: SOURCE_WORKING ? { startedAt: NOW_MS - 6 * 60_000, endedAt: null }
    : SOURCE_IS_BUILD ? { startedAt: NOW_MS - 40_000, endedAt: null }
    : { startedAt: NOW_MS - 6 * 60_000, endedAt: NOW_MS - 60_000 },
} as Partial<FileEntry> & { path: string });
const BUILD = conversation({
  path: BUILD_PATH, conversationId: "conv_pipeline_build", title: L("Build · CSV export retry", "Build · Повтор експорту CSV"),
  activity: "live", proc: "running", pid: 48_377, mtime: NOW - 10,
  cwd: VARIANT === 2 ? `/work/${PROJECT}/pipelines/csv-export-retry` : `/work/${PROJECT}/${WORKTREE_LABEL}`,
  lastTurn: { startedAt: NOW_MS - 40_000, endedAt: null },
} as Partial<FileEntry> & { path: string });
const CHECKOUT = conversation({ path: "/sessions/orbit-store/checkout.jsonl", conversationId: "conv_checkout", title: L("Card payments: 3-D Secure", "Оплата карткою: 3-D Secure"), mtime: NOW - 3_000 });
const SEARCH = conversation({ path: "/sessions/orbit-store/search.jsonl", conversationId: "conv_search", title: L("Search filters lose their state", "Фільтри пошуку губляться"), mtime: NOW - 7_200, activity: "recent" } as Partial<FileEntry> & { path: string });

const assignment = (file: FileEntry) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "delivered", error: null, at: iso(40) });
const task = (id: string, status: BoardTask["status"], text: string, files: FileEntry[], minutesAgo: number, hold?: BoardTask["hold"]): BoardTask => ({
  id, project: PROJECT, text, status, placement: "unplaced", assignments: files.map(assignment),
  createdAt: iso(minutesAgo + 30), updatedAt: iso(minutesAgo), ...(hold ? { hold } : {}),
} as unknown as BoardTask);

const role = (roleId: string, access: "read-only" | "read-write") => ({ roleId, engine: "claude", model: "claude-opus-5-5", effort: "high", access, promptScaffold: null });
const STAGES = [
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: "review", effectiveRole: role("builder", "read-write") },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "{{task}}", next: null, onFail: { to: "fix", maxRounds: 2 }, effectiveRole: role("reviewer", "read-only") },
  { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "{{prev.output}}", next: "review", effectiveRole: role("builder", "read-write") },
] as unknown as Pipeline["stages"];

function lane(): Pipeline {
  const buildConversation = VARIANT === 3 ? SOURCE : BUILD;
  return {
    id: "pl_csv_export", task: TASK_TITLE, taskIds: ["t-csv"], project: PROJECT, repoDir: `/work/${PROJECT}`,
    worktreeDir: VARIANT === 2 ? `/work/${PROJECT}/pipelines/csv-export-retry` : `/work/${PROJECT}/${WORKTREE_LABEL}`,
    branch: VARIANT === 2 ? NEW_BRANCH : BRANCH, baseBranch: "main", baseRef: "main", lastPassedCommit: "",
    stages: STAGES,
    runs: [{ stageId: "build", attempts: [{
      n: 1, state: "running", launchId: null, conversationId: buildConversation.conversationId, sessionId: null, agentPath: buildConversation.path,
      paneId: null, flowId: null, startedAt: iso(1), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
      effectiveRole: role("builder", "read-write"),
    }] }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    state: "running", pausedState: null, stateDetail: null,
    srcPath: SOURCE.path, srcConversationId: SOURCE_ID,
    createdAt: iso(1), closedAt: null, updatedAt: iso(1),
  } as unknown as Pipeline;
}

/* Variant 3, screen 5: the conversation keeps its own name and costume after the start,
   so the window there is drawn without the lane the product would read the stage's
   title and builder costume from; the header gains the stage's name instead
   (`StageHeaderName`). The window covers the board on that screen. */
const PIPELINES: Pipeline[] = STARTED && !(SCREEN === 5 && VARIANT === 3) ? [lane()] : [];
const FILES: FileEntry[] = [SOURCE, CHECKOUT, SEARCH, ...(STARTED && VARIANT !== 3 ? [BUILD] : [])];
const TASKS: BoardTask[] = [
  task("t-csv", "assigned", `${TASK_TITLE}\n${L("The worker runs out of memory past 50k rows.", "Понад 50 тис. рядків воркер вилітає по пам’яті.")}`, [SOURCE], 6),
  task("t-pay", "assigned", `${L("Card payments: 3-D Secure", "Оплата карткою: 3-D Secure")}\n${L("The bank's second step opens in a new tab.", "Другий крок банку відкривається в новій вкладці.")}`, [CHECKOUT], 50,
    { kind: "external", note: L("The bank sends the sandbox key", "Банк надішле тестовий ключ"), since: iso(50), by: "agent" }),
  task("t-search", "inbox", `${L("Search filters lose their state", "Фільтри пошуку губляться")}\n${L("Going back from a product resets them.", "Після повернення з товару скидаються.")}`, [SEARCH], 120),
  task("t-orders", "inbox", `${L("Orders page is slow on phones", "Сторінка замовлень повільна на телефоні")}\n${L("Over 3 s on a mid-range phone.", "Понад 3 с на середньому телефоні.")}`, [], 300),
];

/* The stage names as the product draws them, in both languages. */
const STAGE_NAMES = (() => {
  const t = (key: string, vars?: Record<string, string | number>) => translate(LANG, key as never, vars as never);
  return (STAGES as Pipeline["stages"]).map((stage) => stageDisplayName(t as never, stage));
})();
const [BUILD_NAME, REVIEW_NAME, FIX_NAME] = STAGE_NAMES as [string, string, string];

/* The feed reads the transcript through the feed's own dependency seam. */
const SOURCE_LINES = sourceTranscript();
const BUILD_LINES = [
  user(1, L("Pinned task: CSV export fails on large projects…", "Закріплена задача: експорт CSV падає на великих проєктах…")),
  said(0.5, L("Reading the captured brief and the three changed files.", "Читаю опис із розмови і три змінені файли.")),
];
const tails = new Map<string, LogTailState>();
const tailOf = (file: FileEntry): LogTailState => {
  let state = tails.get(file.path);
  if (!state) {
    const lines = file.path === SOURCE_PATH ? SOURCE_LINES : file.path === BUILD_PATH ? BUILD_LINES : [said(60, L("Looking at it.", "Дивлюся."))];
    state = { lines, linesStart: 0, size: lines.length, loading: false, error: null, tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0 } as LogTailState;
    tails.set(file.path, state);
  }
  return state;
};
setRuntimeUiEnabledForTests(false);
setLogFeedDependenciesForTests({ useLogTail: (file) => { const state = tailOf(file as FileEntry); return useSyncExternalStore(() => () => {}, () => state, () => state); } });

/* ---------- the words this prototype adds ---------- */

/* The last completed turn, in the clock the feed shows its times in. */
const CUTOFF = clock(1);

const WORDS = {
  menuRow: L("Start pipeline", "Запустити пайплайн"),
  menuWhy: {
    1: L(`New agents work in this branch and checkout`, `Нові агенти працюють у цій гілці й робочій копії`),
    2: L(`A new branch from this conversation's last commit`, `Нова гілка від останнього коміту розмови`),
    3: L(`This agent becomes the ${BUILD_NAME} stage`, `Цей агент стає етапом ${BUILD_NAME}`),
  } satisfies Record<Variant, string>,
  title: L("Start pipeline", "Запустити пайплайн"),
  from: L(`From “${SOURCE_TITLE}”`, `З розмови «${SOURCE_TITLE}»`),
  brief: L("Brief", "Опис задачі"),
  briefNote: L(`Taken from 7 messages up to ${CUTOFF}; edit it before starting. The unsent draft is not included.`, `Узято з 7 повідомлень до ${CUTOFF}; можна виправити перед стартом. Ненадіслану чернетку не взято.`),
  waitingTitle: L("The agent is still working", "Агент ще працює"),
  waitingBody: L("I will take the brief when its turn ends, so nothing it is writing now is lost.", "Візьму опис, коли хід закінчиться, щоб не загубити те, що він пише зараз."),
  waitingButton: L("Waiting for the turn…", "Чекаю кінця ходу…"),
  briefPending: L("The brief appears when the turn ends.", "Опис з’явиться, коли хід закінчиться."),
  where: L("Where it works", "Де працює"),
  who: L("Who works", "Хто працює"),
  branch: L("Branch", "Гілка"),
  checkout: L("Checkout", "Робоча копія"),
  changes: L("Changes", "Зміни"),
  stages: L("Stages", "Етапи"),
  publish: L("Publication", "Публікація"),
  publishValue: L("Local only: no push, no pull request", "Лише локально: без push і pull request"),
  cancel: L("Cancel", "Скасувати"),
  start: L("Start pipeline", "Запустити пайплайн"),
  newAgent: L("new agent", "новий агент"),
  thisAgent: L("this agent", "цей агент"),
  loop: L(`If ${REVIEW_NAME} fails: ${FIX_NAME}, then ${REVIEW_NAME} again, at most 2 rounds`, `Якщо ${REVIEW_NAME} не пройде: ${FIX_NAME}, потім знову ${REVIEW_NAME}, до 2 раундів`),
};

const BRIEF = L(
  [
    "CSV export fails on large projects (over 50k rows): the worker runs out of memory.",
    "",
    "Done in the conversation: streaming writes in chunks of 5,000 rows; retry on 503 with pauses of 1 → 2 → 4 s.",
    "Keep: the file format byte for byte, customers parse it.",
    "Left: a test for the retry after 503.",
  ].join("\n"),
  [
    "Експорт CSV падає на великих проєктах (понад 50 тис. рядків): воркер вилітає по пам’яті.",
    "",
    "Зроблено в розмові: потоковий запис частинами по 5 000 рядків; повтор на 503 з паузами 1 → 2 → 4 с.",
    "Не змінювати: формат файлу байт у байт, клієнти його парсять.",
    "Лишилось: тест на повтор після 503.",
  ].join("\n"),
);

/* Branch, checkout and file names are never broken across lines: each sits in a span that does not wrap, and the sentence wraps around it. */
const WHOLE_NAMES = [NEW_BRANCH, BRANCH, "pipelines/csv-export-retry", WORKTREE_LABEL, ...DIRTY].sort((a, b) => b.length - a.length);
const WHOLE_RE = new RegExp(`(${WHOLE_NAMES.map((name) => name.replace(/[.\\/]/g, "\\$&")).join("|")})`);
function whole(text: string): ReactNode {
  const parts = text.split(WHOLE_RE);
  return parts.length === 1 ? text : parts.map((part, index) => (index % 2 ? <span key={index} className="whitespace-nowrap" data-proto-whole="">{part}</span> : part));
}

/** What each variant says about where the lane works: the decisive difference. */
function whereRows(variant: Variant): { label: string; value: ReactNode; note?: string; warn?: boolean }[] {
  const code = (text: string) => <code className="whitespace-nowrap font-mono text-[12px] text-primary">{text}</code>;
  if (variant === 2) {
    return [
      { label: WORDS.branch, value: <>{code(NEW_BRANCH)}</>, note: L(`New, from this conversation's last commit (${LAST_COMMIT_AT})`, `Нова, від останнього коміту розмови (${LAST_COMMIT_AT})`) },
      { label: WORDS.checkout, value: <>{code("pipelines/csv-export-retry")}</>, note: L("New; this conversation keeps its own and can go on working", "Нова; розмова лишає свою і може працювати далі") },
      { label: WORDS.changes, value: L("3 uncommitted files stay behind", "3 незакомічені файли сюди не потраплять"), note: DIRTY.join(" · "), warn: true },
    ];
  }
  return [
    { label: WORDS.branch, value: <>{code(BRANCH)}</>, note: L("This conversation's branch", "Гілка цієї розмови") },
    { label: WORDS.checkout, value: <>{code(WORKTREE_LABEL)}</>, note: L("The same checkout this conversation works in", "Та сама робоча копія, у якій працює розмова") },
    { label: WORDS.changes, value: L("3 uncommitted files stay in place", "3 незакомічені файли лишаються на місці"), note: DIRTY.join(" · ") },
  ];
}

function holdNote(variant: Variant): string {
  if (variant === 1) return L("While the pipeline holds this checkout, this conversation can be read but not written to.", "Поки пайплайн тримає робочу копію, розмову можна читати, але не писати в неї.");
  if (variant === 2) return L("This conversation stays free: it can keep working in its own branch.", "Розмова лишається вільною: вона може працювати далі у своїй гілці.");
  return L(`This agent receives the ${BUILD_NAME} stage's rules and reports to the pipeline when it is done.`, `Цей агент отримає умови етапу ${BUILD_NAME} і звітуватиме пайплайну, коли закінчить.`);
}

/** What the source conversation says about the lane once it started (screen 5, «4б»). */
function afterWords(variant: Variant): { banner: string; locked: string | null } {
  if (variant === 1) return {
    banner: L(`Pipeline “${TASK_TITLE}” works in this checkout`, `Пайплайн «${TASK_TITLE}» працює в цій робочій копії`),
    locked: L("Read-only while the pipeline runs", "Розмову можна лише читати, поки пайплайн працює"),
  };
  if (variant === 2) return {
    banner: L(`Pipeline “${TASK_TITLE}” works on branch ${NEW_BRANCH}; this conversation stays on ${BRANCH}`, `Пайплайн «${TASK_TITLE}» працює в гілці ${NEW_BRANCH}; ця розмова лишається в ${BRANCH}`),
    locked: null,
  };
  return {
    banner: L(`This conversation is the ${BUILD_NAME} stage of pipeline “${TASK_TITLE}”`, `Ця розмова — етап ${BUILD_NAME} пайплайна «${TASK_TITLE}»`),
    locked: null,
  };
}

function AfterBanner({ variant }: { variant: Variant }) {
  return (
    <a href="#pipeline=pl_csv_export" data-proto-new="" data-proto-after="banner" className="flex min-h-7 min-w-0 shrink-0 items-start gap-1.5 border-b border-border bg-sunken px-3 py-1.5 text-label font-semibold text-primary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0">{whole(afterWords(variant).banner)}</span>
    </a>
  );
}

/** Variant 1 only: where the composer was, the reason it is gone. */
function LockedNotice({ text }: { text: string }) {
  return (
    <div role="status" data-proto-new="" data-proto-after="locked" className="mx-3 my-2 flex shrink-0 items-center gap-2 rounded-control border border-dashed border-strong bg-warning-soft px-3 py-2.5 text-ui font-semibold text-warning">
      <Workflow className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0">{text}</span>
    </div>
  );
}

/** Desktop: the banner goes under the reader's header and, in variant 1, the notice takes the composer's place. */
function DesktopAfterState({ variant }: { variant: Variant }) {
  const words = afterWords(variant);
  const banner = useInsertedHost(findReaderBannerSpot);
  const locked = useInsertedHost(words.locked ? findReaderComposerSpot : nothing);
  return (
    <>
      {banner ? createPortal(<AfterBanner variant={variant} />, banner) : null}
      {locked && words.locked ? createPortal(<LockedNotice text={words.locked} />, locked) : null}
    </>
  );
}
const nothing = () => null;
function findReaderBannerSpot() {
  const body = document.querySelector("[data-agent-window] [data-conversation-body]") ?? document.querySelector("[data-conversation-body]");
  return body ? { parent: body.parentElement!, before: body } : null;
}
function findReaderComposerSpot() {
  const body = document.querySelector("[data-agent-window] [data-conversation-body]") ?? document.querySelector("[data-conversation-body]");
  return body ? { parent: body, before: null } : null;
}

/* ---------- the preview ---------- */

function StageChain({ variant }: { variant: Variant }) {
  const who = (index: number) => (variant === 3 && index === 0 ? WORDS.thisAgent : WORDS.newAgent);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1" data-proto-stages="">
        {[BUILD_NAME, REVIEW_NAME, FIX_NAME].map((name, index) => (
          /* Each arrow wraps with the chip before it, so no line starts with a bare arrow. */
          <span key={name} className="flex items-center gap-1">
            <span className={`rounded-full px-2 py-0.5 text-caption font-semibold ${variant === 3 && index === 0 ? "bg-accent-soft text-accent" : "bg-sunken text-secondary"}`}>
              {name} · {who(index)}
            </span>
            {index < 2 ? <span className="text-label font-bold text-strong" aria-hidden>→</span> : null}
          </span>
        ))}
      </span>
      <span className="text-label text-muted">{WORDS.loop}</span>
    </div>
  );
}

function PreviewBody({ variant, waiting }: { variant: Variant; waiting: boolean }) {
  const [brief, setBrief] = useState(BRIEF);
  return (
    <div className="flex flex-col gap-3" data-proto-preview={waiting ? "waiting" : "ready"}>
      {waiting ? (
        <div role="status" className="flex items-start gap-2 rounded-control border border-border bg-sunken px-3 py-2" data-proto-waiting="">
          <span className="mt-1 h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui font-semibold text-primary">{WORDS.waitingTitle}</span>
            <span className="text-label text-secondary">{WORDS.waitingBody}</span>
          </span>
        </div>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-label font-semibold text-secondary">{WORDS.brief}</span>
        {waiting ? (
          <span className="flex min-h-11 items-center rounded-control border border-dashed border-strong px-3 text-ui text-muted">{WORDS.briefPending}</span>
        ) : (
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            rows={5}
            className="w-full resize-none [field-sizing:content] rounded-control border border-border bg-canvas px-3 py-2 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        )}
        {waiting ? null : <span className="text-label text-muted">{WORDS.briefNote}</span>}
      </label>
      {/* One label column for both sections, so their values start on one line. */}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="col-span-2 text-label font-semibold text-secondary" data-proto-heading="where">{WORDS.where}</dt>
        {whereRows(variant).map((row) => (
          <div key={row.label} className="contents">
            <dt className="pt-px text-label font-semibold text-muted">{row.label}</dt>
            <dd className="flex min-w-0 flex-col">
              <span className={`text-ui font-semibold ${row.warn ? "text-warning" : "text-primary"}`}>{row.value}</span>
              {row.note ? <span className="text-label text-muted">{whole(row.note)}</span> : null}
            </dd>
          </div>
        ))}
        <dt className="col-span-2 pt-1.5 text-label font-semibold text-secondary" data-proto-heading="who">{WORDS.who}</dt>
        <dt className="pt-px text-label font-semibold text-muted">{WORDS.stages}</dt>
        <dd className="min-w-0"><StageChain variant={variant} /></dd>
        <dt className="pt-px text-label font-semibold text-muted">{WORDS.publish}</dt>
        <dd className="min-w-0 text-ui text-primary">{WORDS.publishValue}</dd>
      </dl>
      <p className={`rounded-control px-3 py-2 text-label font-semibold ${variant === 1 ? "bg-warning-soft text-warning" : "bg-sunken text-secondary"}`} data-proto-hold="">
        {holdNote(variant)}
      </p>
    </div>
  );
}

function PreviewActions({ waiting, phone }: { waiting: boolean; phone: boolean }) {
  return (
    <div className={`flex w-full items-center gap-2 ${phone ? "" : "justify-end"}`}>
      <button type="button" className={`${phone ? "flex-1" : ""} min-h-11 rounded-control border border-border bg-canvas px-4 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-9`}>
        {WORDS.cancel}
      </button>
      {/* Waiting is a state of its own, not the brand button greyed out: the dark theme fills brand buttons whatever their `disabled:` utilities say. */}
      {waiting ? (
        <button type="button" disabled className={`${phone ? "flex-[2]" : ""} inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control border border-dashed border-strong bg-transparent px-4 text-ui font-semibold text-secondary sm:min-h-9`}>
          {WORDS.waitingButton}
        </button>
      ) : (
        <button type="button" className={`${phone ? "flex-[2]" : ""} inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control border border-brand bg-brand px-4 text-ui font-bold text-on-brand hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-9`}>
          <Workflow className="h-4 w-4" aria-hidden />{WORDS.start}
        </button>
      )}
    </div>
  );
}

/** The desktop preview: the pipeline template picker's dialog (PipelineTemplatePicker.tsx), wider for the brief. */
function DesktopPreview({ variant, waiting }: { variant: Variant; waiting: boolean }) {
  return (
    <div className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40`} data-proto-dialog="">
      <div role="dialog" aria-modal="true" aria-label={WORDS.title} className="flex max-h-[calc(100dvh-32px)] w-full max-w-[600px] flex-col rounded-surface bg-card shadow-2">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Workflow className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-title font-bold text-primary">{WORDS.title}</div>
            <div className="truncate text-ui text-muted">{WORDS.from}</div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><PreviewBody variant={variant} waiting={waiting} /></div>
        <div className="border-t border-border px-4 py-3"><PreviewActions waiting={waiting} phone={false} /></div>
      </div>
    </div>
  );
}

/* ---------- the menu row the conversation's ⋯ gains ---------- */

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
    /* Keeps watching: a card that unfolds draws its lane anew, and the row goes back in. */
    const observer = new MutationObserver(() => { attempt(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [find, tag]);
  return host;
}

/** The desktop reader menu's new row, as its `Row` draws a tall row with its hint (compactMenu.tsx). */
function DesktopMenuRow({ variant }: { variant: Variant }) {
  const host = useInsertedHost(findDesktopMenuSpot);
  if (!host) return null;
  return createPortal(
    <button type="button" className="cm-tall" role="menuitem" data-cm-item="startPipeline" data-proto-new="">
      <Workflow aria-hidden />
      <span className="lbl">
        {WORDS.menuRow}
        <span className="why">{WORDS.menuWhy[variant]}</span>
      </span>
    </button>,
    host,
  );
}
function findDesktopMenuSpot() {
  const menu = document.querySelector('.menu.cm[role="menu"] [data-cm-shown]');
  const sep = menu?.querySelector(":scope > .sep, :scope .sep");
  return menu && sep ? { parent: sep.parentElement!, before: sep.nextElementSibling } : null;
}

function PhoneMenuRow({ variant }: { variant: Variant }) {
  const host = useInsertedHost(findPhoneMenuSpot);
  if (!host) return null;
  return createPortal(
    <MobileSheetRow
      icon={<Workflow className="h-[18px] w-[18px]" aria-hidden />}
      label={(
        <span className="flex min-w-0 flex-col">
          <span className="min-w-0">{WORDS.menuRow}</span>
          <span className="min-w-0 text-label font-medium text-secondary">{WORDS.menuWhy[variant]}</span>
        </span>
      )}
      attrs={{ "data-mobile2-menu-row": "start-pipeline", "data-proto-new": "" }}
    />,
    host,
  );
}
function findPhoneMenuSpot() {
  const menu = document.querySelector("[data-mobile2-chat-menu]");
  if (!menu) return null;
  /* Under what names something else (none here), above Interrupt. */
  const stop = menu.querySelector('[data-mobile2-menu-row="stop"]');
  return { parent: menu, before: stop ?? menu.firstElementChild };
}

/* ---------- the lane's link back to its conversation ---------- */

function linkWords(variant: Variant): { line: string; state: string | null } {
  if (variant === 1) return { line: L(`Continues “${SOURCE_TITLE}”`, `Продовжує розмову «${SOURCE_TITLE}»`), state: L("the conversation is read-only while the pipeline holds its checkout", "розмова лише для читання, поки пайплайн тримає її робочу копію") };
  if (variant === 2) return { line: L(`Started from “${SOURCE_TITLE}”`, `Запущено з розмови «${SOURCE_TITLE}»`), state: L(`branch ${NEW_BRANCH}; the conversation keeps working on its own branch ${BRANCH}`, `гілка ${NEW_BRANCH}; розмова працює далі у своїй гілці ${BRANCH}`) };
  /* The Build chip already names the conversation; the line says who runs it. */
  return { line: L(`The same agent that ran the conversation, now the ${BUILD_NAME} stage`, `Той самий агент, що вів розмову, тепер етап ${BUILD_NAME}`), state: null };
}

function LaneLink({ variant, phone }: { variant: Variant; phone: boolean }) {
  const host = useInsertedHost(phone ? findPhoneLaneSpot : findDesktopLaneSpot);
  if (!host) return null;
  const words = linkWords(variant);
  return createPortal(
    <a href={`#c=${SOURCE_ID}`} data-proto-new="" data-proto-lane-link="" className="flex min-h-6 min-w-0 items-start gap-1 pt-1 text-label text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="font-semibold text-primary">{whole(words.line)}</span>
        {words.state ? <span className="text-muted"> · {whole(words.state)}</span> : null}
      </span>
    </a>,
    host,
  );
}
/** Variant 3 names the conversation on the lane's own Build chip: the stage is that conversation. */
function BuildChipName() {
  const host = useInsertedHost(findBuildChipSpot, "span");
  if (!host) return null;
  return createPortal(<span data-proto-new="" data-proto-chip-name="" className="font-normal"> · {SOURCE_TITLE}</span>, host);
}
function findBuildChipSpot() {
  const chip = document.querySelector('[data-pipeline="pl_csv_export"] .pb-pill:not(.side)');
  const label = chip?.querySelector(".pb-name") ?? null;
  return chip ? { parent: label ?? chip, before: null } : null;
}

function findDesktopLaneSpot() {
  const block = document.querySelector('.kb [data-pipeline="pl_csv_export"][data-density="task"]');
  return block ? { parent: block, before: null } : null;
}
function findPhoneLaneSpot() {
  const block = document.querySelector('[data-pipeline="pl_csv_export"][data-density="card"]');
  return block ? { parent: block.parentElement!, before: block.nextElementSibling } : null;
}

/* ---------- desktop ---------- */

/** Presses the product's own controls to reach a state: the reader's ⋯ opens its real menu. */
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

function DesktopScreen({ variant, screen }: { variant: Variant; screen: Screen }) {
  const reading = screen !== 4;
  /* Screen 1: the reader's ⋯. Screen 4: the task card unfolds, so its lane row and members show. */
  usePress(screen === 1 ? "[data-reader-menu]" : screen === 4 ? '[data-kanban-card="task:t-csv"] button.fold[aria-expanded="false"]' : null);
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas text-primary" data-proto-screen={screen}>
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
      {screen === 1 ? <DesktopMenuRow variant={variant} /> : null}
      {screen === 2 || screen === 3 ? <DesktopPreview variant={variant} waiting={screen === 2} /> : null}
      {screen === 4 ? <LaneLink variant={variant} phone={false} /> : null}
      {screen >= 4 && variant === 3 ? <BuildChipName /> : null}
      {screen === 5 ? <DesktopAfterState variant={variant} /> : null}
      {screen === 5 && variant === 1 ? <style>{LOCKED_CSS}</style> : null}
      {screen === 5 && variant === 3 ? <StageHeaderName /> : null}
    </div>
  );
}

/** Variant 3 after the start: the reader's header reads «Build · <the conversation's own title>», as the phone's bar does. */
function StageHeaderName() {
  const host = useInsertedHost(findReaderTitleSpot, "span");
  if (!host) return null;
  return createPortal(<span data-proto-new="" data-proto-stage-name="">{BUILD_NAME} · </span>, host);
}
function findReaderTitleSpot() {
  const title = document.querySelector("[data-agent-window] .conv-head .ch-title");
  return title ? { parent: title, before: title.firstChild as Element | null } : null;
}

/* Variant 1's composer is gone while the pipeline holds the checkout: the reader keeps its feed. */
const LOCKED_CSS = `[data-conversation-body] > :not([data-composer-yields]):not([data-proto-inserted]):not([data-proto-keep]) { display: none !important; }`;

/* ---------- phone ---------- */

function PhoneChat({ variant, screen }: { variant: Variant; screen: Screen }) {
  const noop = () => undefined;
  return (
    <div data-testid="mobile-chat-shell" className="relative flex h-dvh min-h-0 min-w-0 max-w-[100dvw] flex-col overflow-hidden overflow-x-clip bg-canvas text-primary" data-proto-screen={screen}>
      <MobileShell
        screen="chat"
        screenId={SOURCE_ID}
        /* Variant 3 after the start: the bar names the stage, as the desktop reader's header does. */
        title={<MobileBarTitle meta={<span className="truncate text-label text-muted">{SOURCE_WORKING || SOURCE_IS_BUILD ? L("working", "працює") : L("idle", "чекає")}</span>}>{SOURCE_IS_BUILD ? `${BUILD_NAME} · ${SOURCE_TITLE}` : SOURCE_TITLE}</MobileBarTitle>}
        back
        renderSheet={() => null}
      >
        <BranchPane
          file={SOURCE}
          tasks={[]}
          isRoot
          chromeInMenu
          onClose={noop}
          {...(screen === 5 ? { banner: <AfterBanner variant={variant} /> } : {})}
          {...(screen === 5 && variant === 1 ? { noComposer: true } : {})}
        />
        {screen === 5 && afterWords(variant).locked ? <LockedNotice text={afterWords(variant).locked!} /> : null}
      </MobileShell>
      {screen === 1 ? (
        <>
          <MobileConversationMenu file={SOURCE} stage={null} crowned={false} hostTaskCount={0} onRename={noop} onOpenHost={noop} projectName={PROJECT} onClose={noop} onOpenSearch={noop} />
          <PhoneMenuRow variant={variant} />
        </>
      ) : null}
      {screen === 2 || screen === 3 ? (
        <MobileSheet name="menu" title={WORDS.title} onClose={noop} footer={<PreviewActions waiting={screen === 2} phone />}>
          <div className="px-4 pb-3">
            <p className="pb-2 text-ui text-muted">{WORDS.from}</p>
            <PreviewBody variant={variant} waiting={screen === 2} />
          </div>
        </MobileSheet>
      ) : null}
    </div>
  );
}

function PhoneBoard({ variant }: { variant: Variant }) {
  const noop = () => undefined;
  return (
    <div className="relative flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-canvas text-primary" data-proto-screen="4">
      <MobileShell screen="board" title={<MobileBarTitle>{PROJECT}</MobileBarTitle>} renderSheet={() => null}>
        <MobileKanban
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
          attention={[]}
          onOpenTask={noop}
          onOpenConversation={noop}
          onOpenPipeline={noop}
        />
      </MobileShell>
      <LaneLink variant={variant} phone />
      {variant === 3 ? <BuildChipName /> : null}
    </div>
  );
}

/* ---------- the strip ---------- */

const VARIANT_NAMES: Record<Variant, string> = {
  1: "Ця ж гілка й робоча копія, нові агенти",
  2: "Нова гілка від останнього коміту",
  3: "Цей агент стає етапом Build",
};

/** One plain Ukrainian sentence per screen, whatever language the screens are in. */
const CAPTIONS: Record<Variant, Record<Screen, string>> = {
  1: {
    1: "У меню розмови з’являється пункт «Запустити пайплайн»: нові агенти працюватимуть у гілці й робочій копії цієї розмови.",
    2: "Агент ще дописує хід, тому вікно чекає і візьме опис задачі, щойно хід закінчиться.",
    3: "Перед стартом видно опис задачі з розмови (його можна правити), ту саму гілку й робочу копію з трьома незакоміченими файлами та етапи Build → Review → Fix.",
    4: "На картці задачі з’являється лінія пайплайна з посиланням на розмову; Build виконує новий агент у тій самій робочій копії.",
    5: "Сама розмова тепер лише для читання: під заголовком — що пайплайн працює в її робочій копії, а замість поля вводу — що писати поки не можна.",
  },
  2: {
    1: "У меню розмови з’являється пункт «Запустити пайплайн»: він відкриє нову гілку від останнього коміту цієї розмови.",
    2: "Агент ще дописує хід, тому вікно чекає: опис і останній коміт стануть остаточними, коли хід закінчиться.",
    3: "Перед стартом видно опис задачі, нову гілку від останнього коміту розмови і попередження, що три незакомічені файли в неї не потраплять.",
    4: "На картці задачі з’являється лінія в новій гілці з посиланням на розмову; Build виконує новий агент в окремій робочій копії.",
    5: "Сама розмова вільна: поле вводу на місці, і вона працює далі у своїй гілці fix/csv-export-retry.",
  },
  3: {
    1: "У меню розмови з’являється пункт «Запустити пайплайн»: цей самий агент стане першим етапом, Build.",
    2: "Агент ще дописує хід, тому вікно чекає: умови етапу він отримає лише після кінця ходу.",
    3: "Перед стартом видно опис задачі, ту саму гілку й робочу копію і що Build — це цей агент, а Review і Fix — нові агенти.",
    4: "На картці задачі з’являється лінія, де етап Build названо цією розмовою: його веде той самий агент, а Review і Fix потім виконають нові агенти.",
    5: "Сама розмова стала етапом Build: у заголовку назва етапу, пайплайн надіслав умови етапу, і агент узявся до роботи.",
  },
};
/* Step 4 is two frames: the board, then the conversation after the start. */
const LABELS: Record<Screen, string> = { 1: "1", 2: "2", 3: "3", 4: "4а", 5: "4б" };

function Strip() {
  const phone = params.get("device") === "phone";
  /* `w` checks an in-between width (820) with the desktop's height. */
  const width = Number(params.get("w")) || (phone ? 390 : 1440);
  const height = phone ? 844 : 900;
  const screens: Screen[] = [1, 2, 3, 4, 5];
  const src = (screen: Screen) => `?variant=${VARIANT}&screen=${screen}&lang=${LANG}&theme=${THEME}`;
  return (
    <main className="bg-sunken p-6 text-primary" data-proto-strip={phone ? "phone" : "desktop"} style={{ width: "max-content" }}>
      <h1 className="pb-4 text-title font-bold">
        Варіант {VARIANT} з 3 · {VARIANT_NAMES[VARIANT]} · {phone ? `телефон ${width}` : `комп’ютер ${width}`} · {LANG} · {THEME === "dark" ? "темна" : "світла"}
      </h1>
      <div className={phone ? "flex items-start gap-6" : "flex flex-col gap-6"}>
        {screens.map((screen) => (
          <figure key={screen} className="flex flex-col gap-2" style={{ width }} data-proto-figure={screen}>
            <iframe title={`${VARIANT}.${LABELS[screen]}`} src={src(screen)} width={width} height={height} className="block rounded-[4px] border border-border bg-canvas" style={{ width, height }} />
            <figcaption className="text-body text-primary" style={{ maxWidth: width }}>
              <b>{VARIANT}.{LABELS[screen]}</b> {whole(CAPTIONS[VARIANT][screen])}
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}

/* ---------- mount ---------- */

function Screen() {
  const phone = useIsMobile();
  useLayoutEffect(() => { document.body.style.margin = "0"; }, []);
  if (phone) return SCREEN === 4 ? <PhoneBoard variant={VARIANT} /> : <PhoneChat variant={VARIANT} screen={SCREEN} />;
  return <DesktopScreen variant={VARIANT} screen={SCREEN} />;
}

createRoot(document.getElementById("root")!).render(params.has("strip") ? <Strip /> : <Screen />);
