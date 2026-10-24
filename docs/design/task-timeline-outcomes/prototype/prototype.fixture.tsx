"use client";

/*
 * Prototype: the task's timeline says what each lane and stage concluded and
 * why the extra ones ran, and the task carries a brief of the outcome for a
 * person (docs/design/task-timeline-outcomes/prototype/README.md).
 *
 * Every screen is the product's own components over invented fixture data:
 * the desktop board with the task's card open (`KanbanBoard`, `KanbanCard`,
 * its real `TaskChronology`) and the phone's task screen (`MobileTaskScreen`).
 * The timeline entries are the product's own (`taskChronology`,
 * `chronologyEntryText`); what the variants add is drawn with the timeline's
 * own classes and inserted into the real card:
 *
 *   0  today, for reference: nothing added;
 *   1  an entry that needs it carries «Чому» and «Результат», a few words on a
 *      line each, opened with its chevron into the full sentences;
 *   2  a «Підсумок» brief pinned at the top of the task; the timeline below
 *      stays as it is and its entries link to the brief's points;
 *   3  the timeline grouped into milestones by lane and stage, each with its
 *      why and its outcome; the single events fold inside.
 *
 * On the phone, variants 1 and 3 draw the timeline first among the task
 * screen's groups, where variant 2 puts its brief.
 *
 * Query string: ?variant=0|1|2|3&device=desktop|phone&lang=uk|en&theme=light|dark[&all=1]
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
import { chronologyEntryText, TaskChronology } from "@/components/kanban/TaskChronology";
import { taskChronology, type ChronologyEntry } from "@/components/kanban/taskChronologyModel";
import { pastAttempts } from "@/components/kanban/pipelineGraph";
import { stageDisplayName } from "@/components/pipelines/pipelineModel";
import { buildBranchGroups } from "@/components/projectModel";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = ([0, 1, 2, 3] as const).find((n) => String(n) === params.get("variant")) ?? 0;
const PHONE = params.get("device") === "phone";
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
        "csvWriter now streams rows in chunks of 5,000 instead of building the file in memory; uploads retry on 503 with pauses of 1\u00a0→ 2\u00a0→ 4\u00a0s. The file format is unchanged.",
        "csvWriter тепер пише рядки потоком частинами по 5\u00a0000, а не збирає файл у пам’яті; вивантаження повторюється на 503 з паузами 1\u00a0→ 2\u00a0→ 4\u00a0с. Формат файлу не змінено.",
      ))] },
      { stageId: "review", attempts: [
        attempt(A, "review", 1, AT.review1, "fail", L("3 findings: duplicated rows after a retry, no retry test, no upload timeout.", "3 зауваження: дублі рядків після повтору, немає тесту на повтор, немає таймауту."), { roleId: "reviewer", findings: FINDINGS_1, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } }),
        attempt(A, "review", 2, AT.review2, "fail", L("1 finding: the third retry fails with a different error.", "1 зауваження: третій повтор падає з іншою помилкою."), { roleId: "reviewer", findings: FINDINGS_2, activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(A, "review", 3, AT.review3, "pass", L("No findings. 80k rows export in 6\u00a0s and stay under 120\u00a0MB.", "Зауважень немає. 80\u00a0тис. рядків експортуються за 6\u00a0с і до 120\u00a0МБ."), { roleId: "reviewer", activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
      { stageId: "fix", attempts: [
        attempt(A, "fix", 1, AT.fix1, "pass", L("A retry resumes from the last confirmed chunk; a test for 503; a 30\u00a0s timeout per chunk.", "Повтор продовжує з останньої підтвердженої частини; додано тест на 503; таймаут 30\u00a0с на частину."), { activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(A, "fix", 2, AT.fix2, "pass", L("The third retry waits 4\u00a0s and then fails with a clear error; the test covers all three.", "Третій повтор чекає 4\u00a0с і завершується зрозумілою помилкою; тест покриває всі три."), { activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
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
      `Release ${RELEASE} serves since 15:05. On production an 80k-row export finished in 6\u00a0s at 118\u00a0MB.`,
      `Версія ${RELEASE} працює з 15:05. На проді експорт 80\u00a0тис. рядків пройшов за 6\u00a0с, 118\u00a0МБ.`,
    ), { roleId: "deployer" })] }]),
];

const task = (id: string, status: BoardTask["status"], text: string, minutesAgo: number, over: Partial<BoardTask> = {}): BoardTask => ({
  id, project: PROJECT, text, status, placement: "unplaced", assignments: [], revision: `r-${id}`,
  createdAt: iso(minutesAgo + 30), updatedAt: iso(minutesAgo), ...over,
} as unknown as BoardTask);

const TASKS: BoardTask[] = [
  task(TASK_ID, "done", `${TASK_TITLE}\n${L("Past 50k rows the export worker runs out of memory.", "Понад 50\u00a0тис. рядків воркер експорту вилітає по пам’яті.")}`, AT.note, {
    createdAt: iso(AT.created), doneAt: iso(AT.note),
    note: { text: L(`Deployed ${RELEASE}; an 80k-row export passed on production.`, `Розгорнуто ${RELEASE}; експорт 80\u00a0тис. рядків на проді пройшов.`), author: { kind: "agent", conversationId: `conversation_${C}-deploy-1` }, updatedAt: iso(AT.note) },
    details: "Brief: stream the CSV writer; retry 503 with 1/2/4\u00a0s backoff; keep the format byte for byte. Lanes p-export, p-refresh, p-deploy.",
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

/* ---------- what the variants add ---------- */

/** Why an entry's work ran and what it concluded, for variant 1. Folded,
    each says a few words that fit whole on the narrowest card; opened, the
    same lines say the full sentence in their place. «Чому» stands only on an
    entry that left the default path (a fix, the main move, an extra lane, a
    lane started after the merge); a result only where the entry's own words
    and its neighbours do not already say it. */
type Line = { short: string; full: string };
type Outcome = { why?: Line; result?: Line };
const OUTCOMES: Record<string, Outcome> = {
  [attemptKey(A, "build", 1)]: {
    result: { short: L("5,000-row chunks, the same format", "частини по 5\u00a0000, формат той самий"), full: L("Rows are written in chunks of 5,000 instead of building the file in memory. The file format is unchanged.", "Рядки пишуться частинами по 5\u00a0000, а не збираються в пам’яті. Формат файлу той самий.") },
  },
  [attemptKey(A, "fix", 1)]: {
    why: { short: L("duplicate rows, no test, no timeout", "дублі рядків, без тесту й таймауту"), full: L("Review round 1: a retry wrote its chunk again, so rows came out twice; no test covered the retry; uploads had no timeout.", "Review, раунд 1: повтор записував частину ще раз і рядки дублювались; тесту на повтор не було; вивантаження не мало таймауту.") },
    result: { short: L("no duplicates, a test, a timeout", "без дублів, є тест і таймаут"), full: L("A retry resumes from the last confirmed chunk; a test for 503; a 30\u00a0s timeout per chunk.", "Повтор продовжує з останньої підтвердженої частини; додано тест на 503; таймаут 30\u00a0с на частину.") },
  },
  [attemptKey(A, "fix", 2)]: {
    why: { short: L("the third retry failed", "третій повтор падав"), full: L("Review round 2: the test covered one retry only, and the third one failed with a different error.", "Review, раунд 2: тест перевіряв лише один повтор, а третій падав з іншою помилкою.") },
    result: { short: L("all three retries work", "усі три повтори працюють"), full: L("Retries wait 1\u00a0→ 2\u00a0→ 4\u00a0s; after the third the person gets a clear error. The test covers all three.", "Повтори чекають 1\u00a0→ 2\u00a0→ 4\u00a0с; після третього людина бачить зрозумілу помилку. Тест покриває всі три.") },
  },
  [attemptKey(A, "review", 3)]: {
    result: { short: L("80k rows: 6\u00a0s, under 120\u00a0MB", "80\u00a0тис. рядків: 6\u00a0с, до 120\u00a0МБ"), full: L("No findings. An export of 80k rows took 6\u00a0s and stayed under 120\u00a0MB of memory.", "Зауважень немає. Експорт 80\u00a0тис. рядків тривав 6\u00a0с і зайняв до 120\u00a0МБ пам’яті.") },
  },
  [`${A}:merge:update:0`]: {
    why: { short: L(`main moved on: #${OTHER_PR} changed upload.ts`, `main пішов уперед: #${OTHER_PR} змінив upload.ts`), full: L(`While PR #${PR} waited in the merge queue, #${OTHER_PR} (an upload rate limit) merged into main and changed src/export/upload.ts.`, `Поки PR #${PR} чекав у черзі на мердж, у main злили #${OTHER_PR} (обмеження швидкості вивантаження), і він змінив src/export/upload.ts.`) },
  },
  [`${B}:started`]: {
    why: { short: L("the update hit a conflict", "оновлення дало конфлікт"), full: L(`PR #${PR} could not merge: updating it from main hit a conflict, and an agent had to resolve it.`, `PR #${PR} не зливався: оновлення з main дало конфлікт, і розв’язати його мав агент.`) },
  },
  [attemptKey(B, "refresh", 1)]: {
    result: { short: L("both changes kept", "обидві зміни збережено"), full: L(`upload.ts keeps both the rate limit from #${OTHER_PR} and the retry on 503; tests green.`, `В upload.ts лишились і ліміт швидкості з #${OTHER_PR}, і повтор на 503; тести зелені.`) },
  },
  [`${C}:started`]: {
    why: { short: L("you approved the deploy", "розгортання схвалили ви"), full: L(`PR #${PR} merged at ${clock(AT.merged)}, and you approved deploying it.`, `PR #${PR} змерджено о ${clock(AT.merged)}, і ви схвалили розгортання.`) },
  },
};
/** The entry the «-all» frames show open: the extra lane, whose reason is what the operator could not find. */
const OPEN_OUTCOME = `${B}:started`;
/** A frame with `&all=1` opens variant 1's «Earlier» and its extra lane's entry, so every line it adds is on screen, and variant 3's Merge milestone. */
const ALL = params.get("all") === "1";

/** Variant 2's brief: numbered points the timeline entries point back to. */
type BriefPoint = { n: number; text: string };
const BRIEF: { heading: string; points: BriefPoint[] }[] = [
  { heading: L("What was done", "Що зроблено"), points: [
    { n: 1, text: L(
      "CSV export no longer fails on large projects: the file is written as a stream in chunks instead of being built in memory.",
      "Експорт CSV більше не падає на великих проєктах: файл пишеться потоком частинами, а не збирається в пам’яті.",
    ) },
  ] },
  { heading: L("How it works now", "Як це працює тепер"), points: [
    { n: 2, text: L(
      `An 80k-row export takes about 6\u00a0s; the file format is the same. Live since ${RELEASE}, 15:05.`,
      `Експорт 80\u00a0тис. рядків триває близько 6\u00a0с; формат файлу той самий. Працює з версії ${RELEASE}, 15:05.`,
    ) },
    { n: 3, text: L(
      "If storage is down, the export tries again by itself; after three failures the person sees «Storage is unavailable, try later».",
      "Якщо сховище недоступне, експорт сам пробує знову; після трьох невдач людина бачить «Сховище недоступне, спробуйте пізніше».",
    ) },
  ] },
  { heading: L("Key decisions", "Ключові рішення"), points: [
    { n: 4, text: L(
      "A retry resumes from the last confirmed chunk: retrying the whole chunk wrote rows twice (Review, round 1).",
      "Повтор продовжує з останньої підтвердженої частини: повтор цілої частини дублював рядки (Review, раунд 1).",
    ) },
    { n: 5, text: L(
      "A 30\u00a0s timeout per chunk, so a storage that hangs does not hold the worker (Review, round 1).",
      "Таймаут 30\u00a0с на частину, щоб зависле сховище не тримало воркер (Review, раунд 1).",
    ) },
    { n: 6, text: L(
      "Pauses of 1\u00a0→ 2\u00a0→ 4\u00a0s between retries, and the test covers all three: the third retry used to fail with a different error (Review, round 2).",
      "Паузи між повторами 1\u00a0→ 2\u00a0→ 4\u00a0с, і тест покриває всі три: третій повтор падав з іншою помилкою (Review, раунд 2).",
    ) },
    { n: 7, text: L(
      `The conflict with #${OTHER_PR} kept both changes: its upload rate limit and this retry. That took an extra lane to refresh the PR branch.`,
      `У конфлікті з #${OTHER_PR} збережено обидві зміни: його ліміт швидкості й цей повтор. Для цього запускали додаткову лінію «Оновити гілку PR».`,
    ) },
  ] },
  { heading: L("What is left", "Що лишилось"), points: [
    { n: 8, text: L(
      "Nothing required. Suggested: show the export's progress in the UI, as a separate task.",
      "Нічого обов’язкового. Пропозиція: показувати прогрес експорту в інтерфейсі, окремою задачею.",
    ) },
  ] },
];
const BRIEF_BY = L(`written by the ${stageName(C, "deploy")} stage agent · ${clock(AT.note)}`, `написав агент етапу ${stageName(C, "deploy")} · ${clock(AT.note)}`);
/** Which brief point each timeline entry backs: every Review and Fix round
    that changed something names the decision it led to. One entry per point
    among neighbours, so two links never sit on adjacent short rows. */
const BRIEF_REFS: Record<string, number> = {
  [attemptKey(A, "build", 1)]: 1,
  [attemptKey(A, "review", 1)]: 4,
  [attemptKey(A, "fix", 1)]: 4,
  [attemptKey(A, "review", 2)]: 6,
  [attemptKey(A, "fix", 2)]: 6,
  [`${B}:started`]: 7,
  [attemptKey(C, "deploy", 1)]: 2,
};

/** Variant 3's milestones: which milestone each product entry folds into. */
type MilestoneId = "build" | "review" | "merge" | "deploy";
function milestoneOf(entry: ChronologyEntry): MilestoneId {
  if (entry.pipelineId === C) return "deploy";
  if (entry.pipelineId === B || entry.kind.startsWith("merge-")) return "merge";
  if (entry.pipelineId === A && (entry.stageId === "review" || entry.stageId === "fix")) return "review";
  return "build";
}
/** A milestone states why it ran only when it left the default path: a lane's first stage has none. */
const MILESTONES: { id: MilestoneId; title: string; why?: string; result: string }[] = [
  {
    id: "build", title: stageName(A, "build"),
    result: L("Streaming writes in 5,000-row chunks and a retry on 503; the file format is unchanged", "Потоковий запис частинами по 5\u00a0000 рядків і повтор на 503; формат файлу той самий"),
  },
  {
    id: "review", title: L(`${stageName(A, "review")} and ${stageName(A, "fix")} · 3 rounds`, `${stageName(A, "review")} і ${stageName(A, "fix")} · 3 раунди`),
    why: L("Review found issues twice (3, then 1), so Fix ran twice", "Перевірка двічі знайшла зауваження (3, потім 1), тому Fix запускався двічі"),
    result: L("A retry resumes without duplicate rows, a 30\u00a0s timeout, all three retries tested; round 3 had no findings", "Повтор без дублів, таймаут 30\u00a0с, тест на всі три повтори; третій раунд без зауважень"),
  },
  {
    id: "merge", title: L(`Merge PR #${PR} · extra lane`, `Мердж PR #${PR} · додаткова лінія`),
    why: L(`main moved on: #${OTHER_PR} changed the same file, so the «Refresh the PR branch» lane ran`, `main пішов уперед: #${OTHER_PR} змінив той самий файл, тому запускали лінію «Оновити гілку PR»`),
    result: L("Both changes kept; the conflict resolved", "Обидві зміни збережено, конфлікт розв’язано"),
  },
  {
    id: "deploy", title: stageName(C, "deploy"),
    why: L("You approved the deploy", "Розгортання схвалили ви"),
    result: L("The production export took 6\u00a0s and 118\u00a0MB", "Експорт на проді: 6\u00a0с, 118\u00a0МБ"),
  },
];
/** The milestone variant 3's «-all» frames show unfolded: the one with the extra lane. Default frames fold every milestone. */
const OPEN_MILESTONE: MilestoneId = "merge";

const WORDS = {
  why: L("Why", "Чому"),
  result: L("Result", "Результат"),
  brief: L("Summary", "Підсумок"),
  /** A link's visible words name a summary point, so the digit never reads as a count. */
  point: (n: number) => L(`item ${n}`, `п. ${n}`),
  toPoint: (n: number) => L(`Summary item ${n}`, `Пункт ${n} підсумку`),
  more: L("Why and result in full", "Чому і результат повністю"),
  events: (count: number) => (LANG === "uk"
    ? `${count} ${count % 10 === 1 && count % 100 !== 11 ? "подія" : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? "події" : "подій"}`
    : `${count} event${count === 1 ? "" : "s"}`),
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

/** Presses the product's own controls: unfold the card, then «Earlier». Each
    selector names only the unpressed state, so pressing again whenever it
    shows (the phone screen mounts its timeline twice) presses nothing twice. */
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

/** On the phone, variants 1 and 3 draw the timeline first, where variant 2
    puts its brief: what they add then starts on the first screen, above the
    finished lanes, the description and the agents. */
const PHONE_TIMELINE_FIRST = PHONE && (VARIANT === 1 || VARIANT === 3);
/** The task's own timeline: the card's on the desktop, the task screen's on the phone (variant 1's drawn first). */
const timelineSelector = !PHONE ? `[data-kanban-card="${CARD}"] section.chronology`
  : VARIANT === 1 ? "[data-proto-phone-timeline] section.chronology" : "[data-phone-task-groups] section.chronology";
const entrySelector = (key: string) => `${timelineSelector} [data-chronology-entry="${CSS.escape(key)}"] .chronology-what`;

/* ---------- variant 1: «Why» and «Result» on each entry that needs them ---------- */

function OutcomeLine({ entryKey, outcome }: { entryKey: string; outcome: Outcome }) {
  const [open, setOpen] = useState(ALL && entryKey === OPEN_OUTCOME);
  /* The lines sit right under the entry's words. On the phone an entry that
     opens its conversation is a button, so the lines go inside it, under its
     words, and the button grows with them. */
  const findLines = useMemo(() => () => {
    const what = document.querySelector(entrySelector(entryKey));
    if (!what) return null;
    const button = PHONE ? what.querySelector(":scope > .chronology-open") : null;
    return button ? { parent: button, before: null } : { parent: what, before: null };
  }, [entryKey]);
  /* The chevron takes the entry's last column, where a stop's ⋯ goes: a finished task's entries have none. */
  const findToggle = useMemo(() => () => {
    const entry = document.querySelector(`${timelineSelector} [data-chronology-entry="${CSS.escape(entryKey)}"]`);
    return entry ? { parent: entry, before: null } : null;
  }, [entryKey]);
  const lines = useInsertedHost(findLines, "span");
  const toggle = useInsertedHost(findToggle, "span");
  const id = `outcome-${entryKey.replace(/[^a-z0-9]+/gi, "-")}`;
  const label = (word: string, line: Line) => (
    <span className="block">
      <span className="font-semibold">{word}:</span> <span className={open ? "text-primary" : undefined}>{open ? line.full : line.short}</span>
    </span>
  );
  return (
    <>
      {lines ? createPortal(
        /* Folded, each line says a few words; open, the same lines say the full sentence in their place. */
        <span id={id} className="flex flex-col text-left font-normal" data-proto-outcome={entryKey} data-proto-outcome-open={open ? "1" : "0"}>
          {outcome.why ? <span data-proto-outcome-why="">{label(WORDS.why, outcome.why)}</span> : null}
          {outcome.result ? <span data-proto-outcome-result="">{label(WORDS.result, outcome.result)}</span> : null}
        </span>,
        lines,
      ) : null}
      {toggle ? createPortal(
        <button
          type="button"
          className="chronology-link justify-center text-muted"
          data-proto-outcome-toggle={entryKey}
          aria-expanded={open}
          aria-controls={id}
          aria-label={WORDS.more}
          onClick={() => setOpen((value) => !value)}
          /* The chevron sits on the entry's first line. Its target grows by
             padding a negative margin takes back, so the row keeps its height:
             24 px on the desktop, 44 px on the phone, around the link's 16 px line. */
          style={PHONE ? { minWidth: 44, minHeight: 0, alignSelf: "flex-start", padding: "14px 0", margin: "-14px -8px -14px 0" } : { minWidth: 24, minHeight: 0, padding: "4px 0", margin: "-4px 0" }}
        >
          <span aria-hidden className={`inline-block transition-transform motion-reduce:transition-none${open ? " rotate-90" : ""}`}>›</span>
        </button>,
        toggle,
      ) : null}
    </>
  );
}

/* ---------- variant 2: the «Summary» brief and the timeline's links to it ---------- */

function BriefBody() {
  return (
    <section data-proto-brief="" aria-label={WORDS.brief} className={PHONE ? "flex shrink-0 flex-col gap-2 rounded-[12px] bg-card px-3 py-2.5 shadow-1" : "mb-2 flex min-w-0 flex-col gap-1"}>
      <h4 className={PHONE ? "m-0 flex items-baseline gap-2 text-body font-semibold text-primary" : "chronology-head flex items-baseline gap-2"}>
        {WORDS.brief}
        <span className={`font-normal text-muted ${PHONE ? "text-label" : "text-caption"}`}>{BRIEF_BY}</span>
      </h4>
      <div className={`flex flex-col ${PHONE ? "gap-2 text-ui leading-[1.4]" : "gap-1.5 text-label leading-4"}`}>
        {BRIEF.map((part) => (
          <div key={part.heading} className="flex flex-col gap-0.5">
            <h5 className={`m-0 font-semibold text-secondary ${PHONE ? "text-label" : "text-caption"}`}>{part.heading}</h5>
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {part.points.map((point) => (
                <li key={point.n} id={`brief-${point.n}`} data-proto-brief-point={point.n} className="grid grid-cols-[1.25em_minmax(0,1fr)] text-primary">
                  <span className="font-semibold tabular-nums text-muted">{point.n}</span>
                  <span className="[overflow-wrap:anywhere]">{point.text}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function Brief() {
  const find = useMemo(() => () => {
    if (PHONE) return phoneGroupsStart();
    const card = document.querySelector(`[data-kanban-card="${CARD}"][data-collapsed="0"]`);
    /* Under the title and the state line: the first thing the open card says. */
    const after = card?.querySelector(":scope > .card-state, :scope > .card-meta-line");
    return card && after ? { parent: card, before: after.nextElementSibling } : null;
  }, []);
  const host = useInsertedHost(find);
  return host ? createPortal(<BriefBody />, host) : null;
}

function BriefRef({ entryKey, n }: { entryKey: string; n: number }) {
  /* The entry's last column, where a stop's ⋯ goes: a finished task's entries have none. */
  const find = useMemo(() => () => {
    const entry = document.querySelector(`${timelineSelector} [data-chronology-entry="${CSS.escape(entryKey)}"]`);
    return entry ? { parent: entry, before: null } : null;
  }, [entryKey]);
  const host = useInsertedHost(find, "span");
  if (!host) return null;
  /* The link's words sit on the entry's first line, at the same size and line
     height, so they share its baseline. The target grows by padding that a
     negative margin takes back: the row keeps the height it has without the
     link. On the phone an entry that opens its conversation is a 44 px row
     with its words centred, so the link fills the row and centres its words
     too; a shorter entry keeps its own line and a 44 px target around it. */
  const tall = PHONE && Boolean(host.parentElement?.querySelector(".chronology-open"));
  const style = PHONE
    ? (tall ? { minWidth: 44, minHeight: 44, alignSelf: "stretch" } : { minWidth: 44, minHeight: 0, padding: "14px 0", margin: "-14px 0" })
    : { minWidth: 24, minHeight: 0, padding: "4px 0", margin: "-4px 0" };
  return createPortal(
    <a href={`#brief-${n}`} className="chronology-link justify-end whitespace-nowrap" style={style} data-proto-brief-ref={n} aria-label={WORDS.toPoint(n)}>↑ {WORDS.point(n)}</a>,
    host,
  );
}

/* ---------- variant 3: milestones ---------- */

/** Where variants 1 and 3 put the timeline on the phone: first among the task screen's groups. */
const phoneGroupsStart = () => {
  const groups = document.querySelector("[data-phone-task-groups]");
  return groups ? { parent: groups, before: groups.firstElementChild } : null;
};

/** Variant 1 on the phone: the product's own timeline drawn first, over the
    same entries the task screen builds; the screen's own one, further down, is
    hidden. */
function PhoneTimelineFirst() {
  const host = useInsertedHost(phoneGroupsStart);
  return host ? createPortal(
    <div data-proto-phone-timeline="">
      <TaskChronology phone entries={ENTRIES} pipelines={PIPELINES} nowMs={NOW_MS} onOpen={() => undefined} />
    </div>,
    host,
  ) : null;
}

function Milestones() {
  const find = useMemo(() => PHONE ? phoneGroupsStart : () => {
    const real = document.querySelector(timelineSelector);
    return real ? { parent: real.parentElement!, before: real } : null;
  }, []);
  const host = useInsertedHost(find);
  if (!host) return null;
  const grouped = new Map<MilestoneId, ChronologyEntry[]>();
  for (const entry of ENTRIES) grouped.set(milestoneOf(entry), [...(grouped.get(milestoneOf(entry)) ?? []), entry]);
  const when = (atMs: number) => new Intl.DateTimeFormat(LANG === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(atMs));
  return createPortal(
    <section className={`chronology${PHONE ? " phone" : ""}`} data-proto-milestones={MILESTONES.length} aria-label={t("chronology.heading")}>
      <h4 className="chronology-head">{t("chronology.heading")}</h4>
      <ol>
        {MILESTONES.map((milestone) => {
          const events = grouped.get(milestone.id) ?? [];
          const last = events.at(-1)?.atMs ?? NOW_MS;
          return (
            <li key={milestone.id} className="chronology-entry mb-1.5" data-proto-milestone={milestone.id}>
              <time className="chronology-time num" dateTime={new Date(last).toISOString()}>{when(last)}</time>
              {/* Every milestone here ended well: the timeline's own «passed» mark. */}
              <span className="chronology-mark" style={{ background: "var(--color-success)" }} aria-hidden />
              <span className="chronology-what flex flex-col gap-0.5">
                <span className="font-semibold text-primary">{milestone.title}</span>
                {milestone.why ? <span><span className="font-semibold">{WORDS.why}:</span> {milestone.why}</span> : null}
                <span><span className="font-semibold">{WORDS.result}:</span> <span className="text-primary">{milestone.result}</span></span>
                <details className="chronology-detail group" data-proto-milestone-events={events.length} open={ALL && milestone.id === OPEN_MILESTONE}>
                  <summary className={`list-none gap-1 [&::-webkit-details-marker]:hidden ${PHONE ? "" : "flex min-h-6 items-center"}`}>
                    <span aria-hidden className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none">›</span>
                    {WORDS.events(events.length)}
                  </summary>
                  <ol className="mt-1">
                    {events.map((entry) => (
                      <li key={entry.key} className={`chronology-entry${entry.kind === "attempt-failed" ? " tone-bad" : entry.kind === "attempt-passed" || entry.kind === "merge-merged" ? " tone-ok" : ""}`} data-proto-milestone-event={entry.key}>
                        <time className="chronology-time num" dateTime={new Date(entry.atMs).toISOString()}>{when(entry.atMs)}</time>
                        <span className="chronology-mark" aria-hidden />
                        <span className="chronology-what">{chronologyEntryText(t as never, entry, entry.pipelineId ? byId.get(entry.pipelineId) : undefined)}</span>
                      </li>
                    ))}
                  </ol>
                </details>
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

const EARLIER = `${timelineSelector} [data-chronology-earlier]`;
const PRESSES: readonly string[] = [
  ...(PHONE ? [] : [`[data-kanban-card="${CARD}"] button.fold[aria-expanded="false"]`]),
  /* Variant 2 shows the whole timeline, so every link to the summary is on
     screen; variant 1 keeps the timeline's own «Earlier» fold, and its «-all»
     frames open it. */
  ...(VARIANT === 2 || (VARIANT === 1 && ALL) ? [EARLIER] : []),
];

function Additions({ variant }: { variant: Variant }) {
  if (variant === 1) return (
    <>
      {PHONE ? <PhoneTimelineFirst /> : null}
      {Object.entries(OUTCOMES).map(([key, outcome]) => <OutcomeLine key={key} entryKey={key} outcome={outcome} />)}
      {/* On the phone every entry that opens its conversation is drawn one
          way: its words on its time's line, lines below them, and the 44 px
          target grown by padding a negative margin takes back, so an entry
          without lines keeps a plain row's pitch. */}
      {PHONE ? <style>{".chronology.phone .chronology-open { flex-direction: column; align-items: flex-start; justify-content: flex-start; min-height: 0; padding: 13px 0; margin: -13px 0; }"}</style> : null}
    </>
  );
  /* The brief takes the agent note's place: the note would say the release a second time. */
  if (variant === 2) return <><Brief />{Object.entries(BRIEF_REFS).map(([key, n]) => <BriefRef key={key} entryKey={key} n={n} />)}<style>{`${PHONE ? "[data-proto-screen=phone]" : `[data-kanban-card="${CARD}"]`} [data-task-note] { display: none !important; }`}</style></>;
  if (variant === 3) return <><Milestones /><style>{`${timelineSelector}:not([data-proto-milestones]) { display: none !important; }`}</style></>;
  return null;
}

/** The task screen's own timeline, in its history group, gives way to the one drawn first. */
function PhoneTimelineMoved() {
  return PHONE_TIMELINE_FIRST ? <style>{"[data-phone-task-group=history] section.chronology { display: none !important; }"}</style> : null;
}

function DesktopScreen() {
  usePresses(PRESSES);
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas text-primary" data-proto-screen="desktop">
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
    <div className="relative flex h-dvh min-h-0 min-w-0 max-w-[100dvw] flex-col overflow-hidden bg-canvas text-primary" data-proto-screen="phone">
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
  0: L("Today: the timeline without outcomes (for comparison)", "Як зараз: хронологія без підсумків (для порівняння)"),
  1: L("«Why» and «Result» in the timeline entries that need them", "«Чому» і «результат» у записах хронології, де вони потрібні"),
  2: L("A «Summary» for a person at the top of the task; the timeline links to its items", "«Підсумок» для людини вгорі задачі, хронологія посилається на його пункти"),
  3: L("The timeline by milestones: why each ran and how it ended", "Хронологія етапами: чому запускався і чим закінчився кожен"),
};

function Frame({ children }: { children: ReactNode }) {
  return (
    <>
      {/* The variant's number and name, printed on every frame; one line on the phone too. */}
      <header data-proto-header="" className="flex min-h-9 items-center gap-2 border-b border-border bg-sunken px-3 py-1.5 text-ui font-semibold text-primary">
        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-label font-bold text-accent">{VARIANT ? L(`Variant ${VARIANT} of 3`, `Варіант ${VARIANT} з 3`) : L("Today", "Зараз")}</span>
        <span className="min-w-0 flex-1 text-label [overflow-wrap:anywhere]">{VARIANT_NAMES[VARIANT]}</span>
      </header>
      {children}
      <Additions variant={VARIANT} />
      <PhoneTimelineMoved />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Frame>{PHONE ? <PhoneScreen /> : <DesktopScreen />}</Frame>);
