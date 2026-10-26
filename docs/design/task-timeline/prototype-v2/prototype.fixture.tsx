"use client";

/*
 * Prototype v2: a «Summary» block at the top of a finished task, and a
 * timeline whose entries carry each stage's one-line result and say why a
 * Fix or an extra lane ran (docs/design/task-timeline/prototype-v2/README.md).
 *
 * The structure is the operator's choice of 2026-10-26 (the first round's
 * variant 2): the block tells a returning person how the task works now; each
 * stage writes its own one-line result in its report and the last stage
 * writes the task's summary; on the phone the block comes first, right under
 * the task's title. The three variants here are three visual treatments of
 * that one structure:
 *
 *   1  as a paragraph under the task's state line, the facts in one quiet
 *      line under it; a result on a second line of its entry;
 *   2  as labelled rows of facts; a result running on in its entry's line;
 *   3  as a panel on the well surface with a one-line headline; an entry
 *      that answers another (a Fix after its Review, the extra lane after
 *      the update from main) carries a rule beside its words.
 *
 * Every screen is the product's own: the desktop board with the task's card
 * opened (`KanbanBoard`) and the phone's task screen (`MobileTaskScreen`),
 * over one invented finished task. The timeline's entries, their order and
 * their words are the product's (`taskChronology`, `chronologyEntryText`);
 * the prototype draws them with the timeline's own classes and adds the
 * result lines.
 *
 * Query string: ?variant=1|2|3&device=desktop|phone&lang=uk|en&theme=light|dark[&fold=1]
 * `variant=0` draws the product as it is today. `fold=1` keeps the
 * timeline's own «Earlier · N» fold closed, as a returning person first
 * sees it.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import { setLocale, translate, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "@/lib/pipelines/types";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { MobileTaskScreen } from "@/components/mobile/MobileTaskScreen";
import { getMobileNav } from "@/components/mobile/mobileNav";
import { chronologyEntryText } from "@/components/kanban/TaskChronology";
import { foldChronology, taskChronology, type ChronologyEntry } from "@/components/kanban/taskChronologyModel";
import { pastAttempts } from "@/components/kanban/pipelineGraph";
import { stageDisplayName } from "@/components/pipelines/pipelineModel";
import { buildBranchGroups } from "@/components/projectModel";

import { PROTOTYPE_CSS } from "./prototype.styles";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = ([0, 1, 2, 3] as const).find((n) => String(n) === params.get("variant")) ?? 1;
const PHONE = params.get("device") === "phone";
const FOLDED = params.get("fold") === "1";
type Variant = typeof VARIANT;

document.documentElement.dataset.theme = THEME;
document.documentElement.lang = LANG;
try { localStorage.setItem("llv_lang", LANG); } catch { /* opaque origin */ }
setLocale(LANG);
const L = (en: string, uk: string) => (LANG === "uk" ? uk : en);
const t = (key: string, vars?: Record<string, string | number>) => translate(LANG, key as never, vars as never);

/* A frozen clock: every time and age reads the same in each render. */
const NOW_MS = Date.parse("2026-10-24T13:30:00.000Z");
const NOW = NOW_MS / 1000;
Date.now = () => NOW_MS;
const iso = (minutesAgo: number) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();
/** The clock the timeline shows its times in (the frames run in Europe/Kyiv). */
const clock = (minutesAgo: number) => new Intl.DateTimeFormat(LANG === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(NOW_MS - minutesAgo * 60_000));

/* No server stands behind the prototype: every read answers empty. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return Response.json({}, { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;
class SilentEventSource { onerror: ((event: Event) => void) | null = null; onmessage = null; onopen = null; readyState = 2; close() {} addEventListener() {} removeEventListener() {} }
(globalThis as unknown as { EventSource: unknown }).EventSource = SilentEventSource;
setRuntimeUiEnabledForTests(false);

/* ---------- the invented task and its three lanes ---------- */

const PROJECT = "orbit-store";
const TASK_ID = "t-csv";
const CARD = `task:${TASK_ID}`;
const PR = 412;
const OTHER_PR = 408;
const RELEASE = "2.14.1";
const TASK_TITLE = L("CSV export fails on large projects", "Експорт CSV падає на великих проєктах");

/* Minutes ago, oldest first. The deploy ends at 15:05 Kyiv time. */
const AT = {
  created: 300,
  laneA: 296, build: [295, 256], review1: [254, 236], fix1: [234, 211], review2: [209, 196], fix2: [194, 181], review3: [179, 168],
  queued: 166, updated: 160,
  laneB: 158, refresh: [157, 141], refreshReview: [139, 129],
  merged: 120,
  laneC: 112, deploy: [110, 85],
  note: 83,
} as const;

let pid = 4_400;
const conversation = (id: string, title: string, minutesAgo: number): FileEntry => ({
  path: `/sessions/${PROJECT}/${id}.jsonl`, root: "claude-projects", name: `${id}.jsonl`, project: PROJECT, title, engine: "claude", kind: "session",
  fmt: "claude", parent: null, mtime: NOW - minutesAgo * 60, size: 4_096, activity: "idle", proc: null, pid: ++pid, model: "claude-opus-5-5", effort: "high",
  pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`, generation: 1,
} as unknown as FileEntry);

const role = (roleId: string, access: "read-only" | "read-write") => ({ roleId, engine: "claude", model: "claude-opus-5-5", effort: "high", access, promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) => ({
  id, kind: "run", role: { roleId }, prompt: id === "build" || id === "refresh" || id === "deploy" ? "{{task}}" : "{{prev.output}}", next, onFail: null,
  effectiveRole: role(roleId, roleId === "reviewer" ? "read-only" : "read-write"), ...over,
});

const FILES: FileEntry[] = [];
type Finding = { severity: "P0" | "P1" | "P2" | "P3"; text: string };
function attempt(pipelineId: string, stageId: string, n: number, [from, to]: readonly [number, number], status: "pass" | "fail", summary: string, over: {
  findings?: Finding[]; activatedBy?: { stageId: string; attempt: number; edge: "pass" | "fail" } | null; roleId?: string;
} = {}) {
  const file = conversation(`${pipelineId}-${stageId}-${n}`, `${stageId} · ${TASK_TITLE}`, to);
  FILES.push(file);
  const findings = (over.findings ?? []).map((finding) => `${finding.severity} — ${finding.text}`);
  const verdict = { status, findings, rankedFindings: over.findings ?? [] };
  return {
    n, state: status === "pass" ? "passed" : "failed", effectiveRole: role(over.roleId ?? "builder", over.roleId === "reviewer" ? "read-only" : "read-write"),
    launchId: `launch-${file.name}`, conversationId: file.conversationId, sessionId: null, agentPath: file.path, paneId: null, flowId: null,
    startedAt: iso(from), completedAt: iso(to), input: null, activatedBy: over.activatedBy ?? null, output: summary, verdict, error: null,
    report: { seq: n, at: iso(to), actor: { kind: "agent", conversationId: file.conversationId }, verdict, summary, provenance: null, calls: 1 },
  };
}
const lane = (id: string, title: string, createdAgo: number, closedAgo: number, stages: unknown[], runs: unknown[], over: Record<string, unknown> = {}): Pipeline => ({
  id, task: title, taskIds: [TASK_ID], project: PROJECT, repoDir: `/work/${PROJECT}`, worktreeDir: `/work/${PROJECT}/pipelines/${id}`,
  branch: "pipeline/csv-export-streaming", baseBranch: "main", baseRef: "main", lastPassedCommit: "9f3e1c2a7b5d4e6f8a0b1c2d3e4f5a6b7c8d9e0f",
  stages, runs, cursor: null, state: "completed", pausedState: null, stateDetail: "completed",
  srcPath: null, srcConversationId: null, createdAt: iso(createdAgo), closedAt: iso(closedAgo), updatedAt: iso(closedAgo), ...over,
} as unknown as Pipeline);

const HEAD = "9f3e1c2a7b5d4e6f8a0b1c2d3e4f5a6b7c8d9e0f";
const A = "p-export";
const B = "p-refresh";
const C = "p-deploy";

const FINDINGS_1: Finding[] = [
  { severity: "P1", text: L("A retry after 503 writes the chunk again: rows come out twice (src/export/upload.ts:88).", "Повтор після 503 записує частину ще раз: рядки дублюються (src/export/upload.ts:88).") },
  { severity: "P2", text: L("No test covers the retry after 503.", "Немає тесту на повтор після 503.") },
  { severity: "P2", text: L("Uploads have no timeout: a storage that hangs holds the worker forever.", "Вивантаження без таймауту: якщо сховище зависло, воркер чекає вічно.") },
];
const FINDINGS_2: Finding[] = [
  { severity: "P1", text: L("The test covers one retry only; the third retry fails with a different error.", "Тест перевіряє лише один повтор; третій повтор падає з іншою помилкою.") },
];

const PIPELINES: Pipeline[] = [
  lane(A, L("CSV export: streaming writes and a retry on 503", "Експорт CSV: потоковий запис і повтор на 503"), AT.laneA, AT.review3[1],
    [stage("build", "builder", "review"), stage("review", "reviewer", null, { onFail: { to: "fix", maxRounds: 3 } }), stage("fix", "builder", "review")],
    [
      { stageId: "build", attempts: [attempt(A, "build", 1, AT.build, "pass", L(
        "csvWriter now streams rows in chunks of 5,000 instead of building the file in memory; uploads retry on 503 with pauses of 1 → 2 → 4 s. The file format is unchanged.",
        "csvWriter тепер пише рядки потоком частинами по 5 000, а не збирає файл у пам’яті; вивантаження повторюється на 503 з паузами 1 → 2 → 4 с. Формат файлу не змінено.",
      ))] },
      { stageId: "review", attempts: [
        attempt(A, "review", 1, AT.review1, "fail", L("3 findings: duplicated rows after a retry, no retry test, no upload timeout.", "3 зауваження: дублі рядків після повтору, немає тесту на повтор, немає таймауту."), { roleId: "reviewer", findings: FINDINGS_1, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } }),
        attempt(A, "review", 2, AT.review2, "fail", L("1 finding: the third retry fails with a different error.", "1 зауваження: третій повтор падає з іншою помилкою."), { roleId: "reviewer", findings: FINDINGS_2, activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(A, "review", 3, AT.review3, "pass", L("No findings. 80k rows export in 6 s and stay under 120 MB.", "Зауважень немає. 80 тис. рядків експортуються за 6 с і до 120 МБ."), { roleId: "reviewer", activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
      { stageId: "fix", attempts: [
        attempt(A, "fix", 1, AT.fix1, "pass", L("A retry resumes from the last confirmed chunk; a test for 503; a 30 s timeout per chunk.", "Повтор продовжує з останньої підтвердженої частини; додано тест на 503; таймаут 30 с на частину."), { activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(A, "fix", 2, AT.fix2, "pass", L("The third retry waits 4 s and then fails with a clear error; the test covers all three.", "Третій повтор чекає 4 с і завершується зрозумілою помилкою; тест покриває всі три."), { activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
      ] },
    ],
    {
      merge: {
        state: "merged", by: "auto-merge", repository: "orbit/orbit-store", prNumber: PR, policyChangedAt: iso(24 * 60), reviewedHead: HEAD, chain: [HEAD],
        updates: [{ requestedAt: iso(AT.updated), head: null }], seenChecks: ["tests", "privacy-publication"], head: HEAD, headSeenAt: iso(AT.queued), lastChecks: [],
        readAt: iso(AT.merged), nextReadAt: null, readFailures: 0, requestedAt: iso(AT.queued), mergedHead: HEAD, mergeCommit: "e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9",
        method: "squash", mergedAt: iso(AT.merged), attempts: 1, reason: null, blockedAt: null, updatedAt: iso(AT.merged),
      },
    }),
  lane(B, L("Refresh the PR branch", "Оновити гілку PR"), AT.laneB, AT.refreshReview[1],
    [stage("refresh", "builder", "review"), stage("review", "reviewer", null)],
    [
      { stageId: "refresh", attempts: [attempt(B, "refresh", 1, AT.refresh, "pass", L(
        `Merged main: a conflict in src/export/upload.ts with #${OTHER_PR} (upload rate limit). Both changes kept; tests green.`,
        `Влито main: конфлікт у src/export/upload.ts з #${OTHER_PR} (обмеження швидкості вивантаження). Збережено обидві зміни; тести зелені.`,
      ))] },
      { stageId: "review", attempts: [attempt(B, "review", 1, AT.refreshReview, "pass", L("The conflict resolution is right; nothing else changed.", "Розв’язання конфлікту правильне; більше нічого не змінено."), { roleId: "reviewer", activatedBy: { stageId: "refresh", attempt: 1, edge: "pass" } })] },
    ]),
  lane(C, L(`Deploy ${RELEASE}`, `Розгортання ${RELEASE}`), AT.laneC, AT.deploy[1],
    [stage("deploy", "deployer", null)],
    [{ stageId: "deploy", attempts: [attempt(C, "deploy", 1, AT.deploy, "pass", L(
      `Release ${RELEASE} serves since 15:05. On production an 80k-row export finished in 6 s at 118 MB.`,
      `Версія ${RELEASE} працює з 15:05. На проді експорт 80 тис. рядків пройшов за 6 с, 118 МБ.`,
    ), { roleId: "deployer" })] }]),
];

const task = (id: string, status: BoardTask["status"], text: string, minutesAgo: number, over: Partial<BoardTask> = {}): BoardTask => ({
  id, project: PROJECT, text, status, placement: "unplaced", assignments: [], revision: `r-${id}`,
  createdAt: iso(minutesAgo + 30), updatedAt: iso(minutesAgo), ...over,
} as unknown as BoardTask);

const TASKS: BoardTask[] = [
  task(TASK_ID, "done", `${TASK_TITLE}\n${L("Past 50k rows the export worker runs out of memory.", "Понад 50 тис. рядків воркер експорту вилітає по пам’яті.")}`, AT.note, {
    createdAt: iso(AT.created), doneAt: iso(AT.note),
    note: { text: L(`Deployed ${RELEASE}; an 80k-row export passed on production.`, `Розгорнуто ${RELEASE}; експорт 80 тис. рядків на проді пройшов.`), author: { kind: "agent", conversationId: `conversation_${C}-deploy-1` }, updatedAt: iso(AT.note) },
    details: "Brief: stream the CSV writer; retry 503 with 1/2/4 s backoff; keep the format byte for byte. Lanes p-export, p-refresh, p-deploy.",
  }),
  task("t-pay", "assigned", `${L("Card payments: 3-D Secure", "Оплата карткою: 3-D Secure")}\n${L("The bank's second step opens in a new tab.", "Другий крок банку відкривається в новій вкладці.")}`, 50),
  task("t-search", "inbox", `${L("Search filters lose their state", "Фільтри пошуку губляться")}\n${L("Going back from a product resets them.", "Після повернення з товару скидаються.")}`, 120),
  task("t-orders", "inbox", `${L("Orders page is slow on phones", "Сторінка замовлень повільна на телефоні")}\n${L("Over 3 s on a mid-range phone.", "Понад 3 с на середньому телефоні.")}`, 300),
];

/* ---------- the timeline as the product builds it ---------- */

const ENTRIES: ChronologyEntry[] = taskChronology({
  taskCreatedAt: iso(AT.created), pipelines: PIPELINES, past: pastAttempts(PIPELINES, new Map()), cleared: [], seatConversationIds: [],
});
const byId = new Map(PIPELINES.map((pipeline) => [pipeline.id, pipeline] as const));
const stageName = (pipelineId: string, stageId: string) => {
  const found = byId.get(pipelineId)?.stages.find((entry) => entry.id === stageId);
  return found ? stageDisplayName(t as never, found) : stageId;
};
const attemptKey = (pipelineId: string, stageId: string, n: number) => `${pipelineId}:${stageId}:attempt:${n}`;

/* ---------- what the stages wrote ---------- */

/** The one line a stage's report carries for the timeline. A line that
    answers another entry (a Fix after its Review, the extra lane after the
    update from main, the deploy lane after the merge) names that entry in a
    link, in the timeline's own words for it, so the reader sees why it ran. */
type Part = string | { link: string; text: string };
type Note = { why?: Part[]; result: string };
const NOTES: Record<string, Note> = {
  [attemptKey(A, "build", 1)]: { result: L("Streaming writes in 5,000-row chunks; the file format is unchanged", "Потоковий запис частинами по 5 000 рядків; формат файлу той самий") },
  [attemptKey(A, "review", 1)]: { result: L("Duplicate rows after a retry, no retry test, no upload timeout", "Дублі рядків після повтору, без тесту на повтор і без таймауту") },
  [attemptKey(A, "fix", 1)]: {
    why: [L("Answers ", "Відповідь на "), { link: attemptKey(A, "review", 1), text: `${stageName(A, "review")} · 1` }],
    result: L("A retry resumes from the last confirmed chunk; a 503 test; a 30 s timeout per chunk", "Повтор іде з останньої підтвердженої частини; тест на 503; таймаут 30 с на частину"),
  },
  [attemptKey(A, "review", 2)]: { result: L("The third retry failed with a different error", "Третій повтор падав з іншою помилкою") },
  [attemptKey(A, "fix", 2)]: {
    why: [L("Answers ", "Відповідь на "), { link: attemptKey(A, "review", 2), text: `${stageName(A, "review")} · 2` }],
    result: L("Pauses of 1 → 2 → 4 s; the test covers all three retries", "Паузи 1 → 2 → 4 с; тест покриває всі три повтори"),
  },
  [attemptKey(A, "review", 3)]: { result: L("No findings; 80k rows in 6 s, under 120 MB", "Без зауважень; 80 тис. рядків за 6 с, до 120 МБ") },
  [`${A}:merge:update:0`]: { result: L(`#${OTHER_PR} changed the same upload.ts: a conflict`, `#${OTHER_PR} змінив той самий upload.ts: конфлікт`) },
  [`${B}:started`]: {
    why: [L("After ", "Після "), { link: `${A}:merge:update:0`, text: L("the update from main", "оновлення з main") }],
    result: L("An agent resolves the conflict and a review checks it", "Агент розв’язує конфлікт, перевірка його звіряє"),
  },
  [attemptKey(B, "refresh", 1)]: { result: L(`Both changes kept: the rate limit from #${OTHER_PR} and the retry; tests green`, `Збережено обидві зміни: ліміт швидкості з #${OTHER_PR} і повтор; тести зелені`) },
  [attemptKey(B, "review", 1)]: { result: L("The conflict resolution is right; nothing else changed", "Розв’язання конфлікту правильне; більше нічого не змінено") },
  [`${C}:started`]: {
    why: [L("After ", "Після "), { link: `${A}:merge:merged`, text: L(`the merge of PR #${PR}`, `мерджу PR #${PR}`) }, L("; you approved the deploy", "; розгортання схвалили ви")],
    result: "",
  },
  [attemptKey(C, "deploy", 1)]: { result: L(`${RELEASE} serves since 15:05; 80k rows in 6 s on production`, `${RELEASE} працює з 15:05; на проді 80 тис. рядків за 6 с`) },
};
/** Entries that answer another one: variant 3 draws a rule beside their words. */
const ANSWERS = new Set(Object.entries(NOTES).filter(([, note]) => note.why).map(([key]) => key));

/** The task's summary, written by the last stage (Deploy) when the task finished. */
const SUMMARY = {
  heading: L("Summary", "Підсумок"),
  by: L(`by ${stageName(C, "deploy")} · ${clock(AT.note)}`, `від ${stageName(C, "deploy")} · ${clock(AT.note)}`),
  byAria: L(`written by the ${stageName(C, "deploy")} stage at ${clock(AT.note)}`, `написав етап ${stageName(C, "deploy")} о ${clock(AT.note)}`),
  headline: L("CSV export holds up on large projects", "Експорт CSV витримує великі проєкти"),
  lead: L(
    "CSV export no longer fails on large projects. The file is written as a stream in 5,000-row chunks, and a storage failure loses no work: the upload retries by itself with pauses of 1 → 2 → 4 s, and only after the third failure does the person see an error. 80k rows take 6 s; the file format is unchanged.",
    "Експорт CSV більше не падає на великих проєктах. Файл пишеться потоком частинами по 5 000 рядків, а збій сховища не губить роботу: вивантаження повторюється саме, з паузами 1 → 2 → 4 с, і лише після третьої невдачі людина бачить помилку. 80 тис. рядків проходять за 6 с; формат файлу той самий.",
  ),
  /* Variant 3's shorter prose under its headline. */
  short: L(
    "The file is written as a stream in 5,000-row chunks; a storage failure gets three retries (1 → 2 → 4 s), then a clear error. 80k rows take 6 s; the file format is unchanged.",
    "Файл пишеться потоком частинами по 5 000 рядків; збій сховища дає три повтори (1 → 2 → 4 с), далі зрозуміла помилка. 80 тис. рядків проходять за 6 с; формат файлу той самий.",
  ),
  facts: [
    { label: L("Live since", "Працює з"), value: `${RELEASE} · 15:05` },
    { label: L("PR", "PR"), value: `#${PR}` },
    { label: L("Left", "Лишилось"), value: L("nothing required; an idea: show the export's progress in the UI", "нічого обов’язкового; ідея: показувати прогрес експорту в інтерфейсі") },
  ],
  rows: [
    { label: L("Done", "Зроблено"), value: L("Streaming CSV writes in 5,000-row chunks and an upload retry on 503.", "Потоковий запис CSV частинами по 5 000 рядків і повтор вивантаження на 503.") },
    { label: L("Works now", "Працює тепер"), value: L("80k rows in 6 s, the same format. A storage failure gets three retries with pauses of 1 → 2 → 4 s, then a clear error.", "80 тис. рядків за 6 с, формат той самий. Збій сховища дає три повтори з паузами 1 → 2 → 4 с, далі зрозуміла помилка.") },
    { label: L("Release", "Версія"), value: `${RELEASE} · 15:05 · PR #${PR}` },
    { label: L("Left", "Лишилось"), value: L("Nothing required. An idea: show the export's progress in the UI.", "Нічого обов’язкового. Ідея: показувати прогрес експорту в інтерфейсі.") },
  ],
};

/* ---------- inserting into the product's own markup ---------- */

/** Waits for a place the product renders, hands back a node inserted there, and inserts it again if the product redraws it. */
function useInsertedHost(find: () => { parent: Element; before: Element | null } | null, tag: "div" | "span" = "div"): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let made: HTMLElement | null = null;
    const attempt = () => {
      if (made?.isConnected) return;
      const spot = find();
      if (!spot) return;
      made = document.createElement(tag);
      made.dataset.protoInserted = "";
      spot.parent.insertBefore(made, spot.before);
      setHost(made);
    };
    attempt();
    const observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [find, tag]);
  return host;
}

/** Presses the product's own controls: the desktop card's fold. The selector
    names only the unpressed state, so pressing again whenever it shows
    presses nothing twice. */
function usePresses(selectors: readonly string[]) {
  useEffect(() => {
    const press = () => {
      for (const selector of selectors) document.querySelector<HTMLElement>(selector)?.click();
    };
    press();
    const observer = new MutationObserver(press);
    observer.observe(document.body, { childList: true, subtree: true });
    const stop = setTimeout(() => observer.disconnect(), 8_000);
    return () => { clearTimeout(stop); observer.disconnect(); };
  }, [selectors]);
}

/** The product's own timeline, which the prototype's one replaces. */
const productTimeline = PHONE ? "[data-phone-task-group=history] section.chronology:not([data-proto-timeline])" : `[data-kanban-card="${CARD}"] section.chronology:not([data-proto-timeline])`;

/* ---------- the «Summary» block ---------- */

function SummaryBody({ variant }: { variant: 1 | 2 | 3 }) {
  const head = (
    <h4 className="tsum-head">
      {SUMMARY.heading}
      <span className="tsum-by" aria-label={SUMMARY.byAria}>{SUMMARY.by}</span>
    </h4>
  );
  const facts = (
    <p className="tsum-facts" data-proto-summary-facts="">
      {SUMMARY.facts.map((fact, index) => (
        <span key={fact.label}>
          {index ? " · " : ""}
          <b>{fact.label}</b> <span className="num">{fact.value}</span>
        </span>
      ))}
    </p>
  );
  return (
    <section className={`tsum v${variant}${PHONE ? " phone" : ""}`} data-proto-summary={variant} aria-label={SUMMARY.heading}>
      {variant === 1 ? (
        <>
          {head}
          <p className="tsum-lead" data-proto-summary-lead="">{SUMMARY.lead}</p>
          {facts}
        </>
      ) : variant === 2 ? (
        <>
          {head}
          <dl className="tsum-rows">
            {SUMMARY.rows.map((row) => (
              <div key={row.label} style={{ display: "contents" }}>
                <dt>{row.label}</dt>
                <dd data-proto-summary-lead={row.label === SUMMARY.rows[1]!.label ? "" : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <div className="tsum-panel">
          {head}
          <p className="tsum-title" data-proto-summary-headline="">{SUMMARY.headline}</p>
          <p className="tsum-lead" data-proto-summary-lead="">{SUMMARY.short}</p>
          {facts}
        </div>
      )}
    </section>
  );
}

function Summary({ variant }: { variant: 1 | 2 | 3 }) {
  const find = useMemo(() => () => {
    if (PHONE) {
      const groups = document.querySelector("[data-phone-task-groups]");
      return groups ? { parent: groups, before: groups.firstElementChild } : null;
    }
    const card = document.querySelector(`[data-kanban-card="${CARD}"][data-collapsed="0"]`);
    /* Under the title and the state line: the first thing the open card says. */
    const after = card?.querySelector(":scope > .card-state, :scope > .card-meta-line");
    return card && after ? { parent: card, before: after.nextElementSibling } : null;
  }, []);
  const host = useInsertedHost(find);
  return host ? createPortal(<SummaryBody variant={variant} />, host) : null;
}

/* ---------- the timeline with the stages' lines ---------- */

const TONE: Partial<Record<ChronologyEntry["kind"], "ok" | "bad" | "warn">> = {
  "attempt-passed": "ok", "merge-merged": "ok", "attempt-failed": "bad", "attempt-cut": "warn", "attempt-lost": "warn", "attempt-stopped": "warn", "merge-stopped": "warn",
};
const entryId = (key: string) => `tl-${key.replace(/[^a-z0-9]+/gi, "-")}`;

function NoteLine({ note, variant }: { note: Note; variant: 1 | 2 | 3 }) {
  const why = note.why ? (
    <span className="tl-why">
      {note.why.map((part, index) => typeof part === "string" ? <span key={index}>{part}</span> : (
        <a key={index} href={`#${entryId(part.link)}`} data-proto-why-link={part.link}>{part.text}</a>
      ))}
    </span>
  ) : null;
  const joiner = why && note.result ? (variant === 2 ? "; " : ": ") : "";
  return (
    <span className="tl-note" data-proto-note="">
      {why}{joiner}{why && note.result && variant !== 2 ? <span>{note.result}</span> : note.result}
    </span>
  );
}

function Timeline({ variant }: { variant: 1 | 2 | 3 }) {
  const [open, setOpen] = useState(!FOLDED);
  const find = useMemo(() => () => {
    const real = document.querySelector(productTimeline);
    return real ? { parent: real.parentElement!, before: real } : null;
  }, []);
  const host = useInsertedHost(find);
  if (!host) return null;
  const { hidden, shown } = foldChronology(ENTRIES, open);
  const when = (atMs: number) => new Intl.DateTimeFormat(LANG === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(atMs));
  return createPortal(
    <section className={`chronology v${variant}${PHONE ? " phone" : ""}`} data-proto-timeline={variant} data-chronology={ENTRIES.length} data-chronology-hidden={hidden} aria-label={t("chronology.heading")}>
      <h4 className="chronology-head">{t("chronology.heading")}</h4>
      <ol>
        {hidden ? (
          <li className="chronology-earlier">
            <button type="button" data-chronology-earlier={hidden} aria-expanded={false} onClick={() => setOpen(true)}>{t("chronology.earlier", { count: hidden })}</button>
          </li>
        ) : null}
        {shown.map((entry) => {
          const pipeline = entry.pipelineId ? byId.get(entry.pipelineId) : undefined;
          const text = chronologyEntryText(t as never, entry, pipeline);
          const note = NOTES[entry.key];
          const words = note ? <>{text}{variant === 2 && note ? <NoteLine note={note} variant={variant} /> : null}</> : text;
          const tone = TONE[entry.kind];
          return (
            <li
              key={entry.key}
              id={entryId(entry.key)}
              className={`chronology-entry${tone ? ` tone-${tone}` : ""}${ANSWERS.has(entry.key) ? " answers" : ""}`}
              data-chronology-entry={entry.key}
              data-chronology-kind={entry.kind}
            >
              <time className="chronology-time num" dateTime={new Date(entry.atMs).toISOString()}>{when(entry.atMs)}</time>
              <span className="chronology-mark" aria-hidden />
              <span className="chronology-what">
                {entry.conversation ? (
                  <button type="button" className="chronology-open" aria-label={t("chronology.openAria", { label: text })}>
                    {words}
                    {note && variant !== 2 ? <NoteLine note={note} variant={variant} /> : null}
                  </button>
                ) : (
                  <>
                    <span>{words}</span>
                    {note && variant !== 2 ? <NoteLine note={note} variant={variant} /> : null}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>,
    host,
  );
}

/* ---------- the screens ---------- */

/* The task's nine stage conversations placed on the scene, as the Viewer keeps
   every launched stage's conversation there: the phone lists the task's agents
   from these groups, and the board card counts the same nine. */
const GROUPS = buildBranchGroups(FILES, PROJECT, { now: NOW, expandedConversationPaths: new Set(FILES.map((file) => file.path)) });

const PRESSES: readonly string[] = PHONE ? [] : [`[data-kanban-card="${CARD}"] button.fold[aria-expanded="false"]`];

function Additions({ variant }: { variant: Variant }) {
  if (!variant) return null;
  return (
    <>
      <Summary variant={variant} />
      <Timeline variant={variant} />
      {/* The summary takes the agent note's place (it said the release a second time), and the prototype's timeline the product's. */}
      <style>{`[data-proto-screen] [data-task-note] { display: none !important; } ${productTimeline} { display: none !important; }`}</style>
    </>
  );
}

function DesktopScreen() {
  usePresses(PRESSES);
  return (
    <div className="proto-screen" style={{ display: "flex", height: "100dvh", minHeight: 0, flexDirection: "column", background: "var(--color-canvas)", color: "var(--color-primary)" }} data-proto-screen="desktop">
      <KanbanBoard
        project={PROJECT}
        groups={GROUPS}
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
        focus={null}
        readerStorage={null}
      />
    </div>
  );
}

function PhoneScreen() {
  usePresses(PRESSES);
  useEffect(() => { getMobileNav().push({ kind: "task", id: TASK_ID }); }, []);
  const noop = () => undefined;
  return (
    <div style={{ position: "relative", display: "flex", height: "100dvh", minHeight: 0, minWidth: 0, maxWidth: "100dvw", flexDirection: "column", overflow: "hidden", background: "var(--color-canvas)", color: "var(--color-primary)" }} data-proto-screen="phone">
      <MobileTaskScreen
        taskId={TASK_ID}
        project={PROJECT}
        projectName={PROJECT}
        groups={GROUPS}
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
    </div>
  );
}

const VARIANT_NAMES: Record<Variant, string> = {
  0: L("Today: the task as the product draws it now", "Як зараз: задача, як продукт малює її сьогодні"),
  1: L("As a paragraph: the summary in prose under the task's state", "Абзацом: підсумок текстом під станом задачі"),
  2: L("As rows: the summary as labelled facts", "Рядками: підсумок як підписані факти"),
  3: L("As a panel: a headline on the well surface, answers marked in the timeline", "Панеллю: заголовок на заглибленій поверхні, відповіді позначено в хронології"),
};

function Frame({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{PROTOTYPE_CSS}</style>
      {/* The variant's number and name, printed on every frame. */}
      <header className="proto-band" data-proto-header="">
        <span className="proto-band-n">{VARIANT ? L(`Variant ${VARIANT} of 3`, `Варіант ${VARIANT} з 3`) : L("Today", "Зараз")}</span>
        <span className="proto-band-name">{VARIANT_NAMES[VARIANT]}</span>
      </header>
      {children}
      <Additions variant={VARIANT} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Frame>{PHONE ? <PhoneScreen /> : <DesktopScreen />}</Frame>);
