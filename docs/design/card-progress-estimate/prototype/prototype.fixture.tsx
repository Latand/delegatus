"use client";

/*
 * Prototype: the agent's estimate of how far a task is, as a thin bar on its
 * kanban card (docs/design/card-progress-estimate.md,
 * docs/design/card-progress-estimate/prototype/README.md).
 *
 * Every screen is the product's own components over invented fixture data:
 * the desktop board (`KanbanBoard`, its closed `KanbanCard`s and their real
 * `CardStateLine`) and the phone's board (`MobileKanban`). The bar is the one
 * new element, drawn in the product's tokens and inserted into the real card:
 *
 *   1  a thin inset bar along the card's bottom edge;
 *   2  the same bar under the title;
 *   3  a short bar in the state line, beside the status dot.
 *
 * Each variant draws the same cards: no estimate (a dashed empty track),
 * 0 %, 35 % working, 65 % waiting for the PR's checks (its dot's words
 * shown: the desktop's popover open beside the state line, a caption under
 * the card on the phone), 100 % that still waits for an answer, a report two
 * days old (striped), and on the desktop a Done card at 100 %. The words keep
 * the product's own first and add the estimate and its age on a line of
 * their own.
 *
 * Query string: ?variant=1|2|3&device=desktop|phone&lang=uk|en&theme=light|dark
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
import { MobileKanban } from "@/components/mobile/MobileKanban";
import { cardStatePopover, type CardState } from "@/components/kanban/cardState";
import { humanizeDuration } from "@/components/turnDuration";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = ([1, 2, 3] as const).find((n) => String(n) === params.get("variant")) ?? 1;
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

/* ---------- the invented board ---------- */

const PROJECT = "orbit-store";
const DAY = 24 * 60;

let pid = 4_400;
const FILES: FileEntry[] = [];
function conversation(id: string, title: string, minutesAgo: number, live: boolean): FileEntry {
  const file = {
    path: `/sessions/${PROJECT}/${id}.jsonl`, root: "claude-projects", name: `${id}.jsonl`, project: PROJECT, title, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: NOW - minutesAgo * 60, size: 4_096, activity: live ? "live" : "idle", proc: live ? "running" : null, pid: live ? ++pid : null,
    model: "claude-opus-5-5", effort: "high", pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`, generation: 1,
    ...(live ? {
      authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
      lastTurn: { startedAt: NOW_MS - minutesAgo * 60_000, endedAt: null },
    } : {}),
  } as unknown as FileEntry;
  FILES.push(file);
  return file;
}

const role = (roleId: string) => ({ roleId, engine: "claude", model: "claude-opus-5-5", effort: "high", access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null) => ({
  id, kind: "run", role: { roleId }, prompt: "{{task}}", next, onFail: null, effectiveRole: role(roleId),
});
const STAGES = [stage("build", "builder", "review"), stage("review", "reviewer", "deploy"), stage("deploy", "deployer", null)];

type Run = { stageId: string; attempts: unknown[] };
function attempt(taskId: string, stageId: string, [from, to]: readonly [number, number | null], state: "running" | "passed" | "needs_decision", live: boolean) {
  const file = conversation(`${taskId}-${stageId}`, stageId, to ?? from, live);
  const status = state === "passed" ? "pass" : state === "needs_decision" ? "needs_decision" : null;
  const verdict = status ? { status, findings: [], rankedFindings: [] } : null;
  return {
    n: 1, state, effectiveRole: role(STAGES.find((entry) => entry.id === stageId)!.effectiveRole.roleId),
    launchId: `launch-${file.name}`, conversationId: file.conversationId, sessionId: null, agentPath: file.path, paneId: null, flowId: null,
    startedAt: iso(from), completedAt: to === null ? null : iso(to), input: null, activatedBy: null, output: null, verdict, error: null,
    ...(verdict ? { report: { seq: 1, at: iso(to ?? from), actor: { kind: "agent", conversationId: file.conversationId }, verdict, summary: "", provenance: null, calls: 1 } } : {}),
  };
}
function lane(taskId: string, title: string, state: Pipeline["state"], createdAgo: number, runs: Run[], cursor: string | null, over: Record<string, unknown> = {}): Pipeline {
  return {
    id: `p-${taskId}`, task: title, taskIds: [taskId], project: PROJECT, repoDir: `/work/${PROJECT}`, worktreeDir: `/work/${PROJECT}/pipelines/p-${taskId}`,
    branch: `pipeline/${taskId}`, baseBranch: "main", baseRef: "main", lastPassedCommit: "", stages: STAGES, runs,
    cursor: cursor ? { stageId: cursor, state, input: null, activatedBy: null } : null, state, pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: iso(createdAgo), closedAt: null, updatedAt: iso(createdAgo), ...over,
  } as unknown as Pipeline;
}

/** One estimate as the design's record would hold it: the reported percent and how long ago. */
type Estimate = { percent: number; minutesAgo: number } | null;
/** How the card's bar draws it. */
type Shown = "unknown" | "known" | "stale";
const STALE_AFTER_MINUTES = DAY;
const shownOf = (estimate: Estimate): Shown => (!estimate ? "unknown" : estimate.minutesAgo > STALE_AFTER_MINUTES ? "stale" : "known");

interface CardSpec { id: string; title: string; description: string; estimate: Estimate; updatedAgo: number; status?: BoardTask["status"]; pipeline: Pipeline }
const HEAD = "9f3e1c2a7b5d4e6f8a0b1c2d3e4f5a6b7c8d9e0f";

/* Top to bottom as the column draws them: the card that waits for the operator first, then the most recently updated. */
const CARDS: CardSpec[] = [
  {
    id: "t-100", title: L("Dark theme in settings", "Темна тема в налаштуваннях"), description: L("Follows the system by default.", "За замовчуванням як у системі."),
    estimate: { percent: 100, minutesAgo: 9 }, updatedAgo: 60,
    pipeline: lane("t-100", L("Dark theme in settings", "Темна тема в налаштуваннях"), "needs_decision", 180, [
      { stageId: "build", attempts: [attempt("t-100", "build", [180, 120], "passed", false)] },
      { stageId: "review", attempts: [attempt("t-100", "review", [118, 70], "passed", false)] },
      { stageId: "deploy", attempts: [attempt("t-100", "deploy", [68, 9], "needs_decision", false)] },
    ], "deploy"),
  },
  {
    id: "t-none", title: L("Quarterly sales report", "Звіт про продажі за квартал"), description: L("Totals by region and by manager.", "Підсумки за регіонами і менеджерами."),
    estimate: null, updatedAgo: 4,
    pipeline: lane("t-none", L("Quarterly sales report", "Звіт про продажі за квартал"), "running", 4, [{ stageId: "build", attempts: [attempt("t-none", "build", [4, null], "running", true)] }], "build"),
  },
  {
    id: "t-zero", title: L("Import contacts from Google", "Імпорт контактів з Google"), description: L("Keep the groups and the photos.", "Зберегти групи і фото."),
    estimate: { percent: 0, minutesAgo: 6 }, updatedAgo: 8,
    pipeline: lane("t-zero", L("Import contacts from Google", "Імпорт контактів з Google"), "running", 8, [{ stageId: "build", attempts: [attempt("t-zero", "build", [8, null], "running", true)] }], "build"),
  },
  {
    id: "t-35", title: L("Card payments: 3-D Secure", "Оплата карткою: 3-D Secure"), description: L("The bank's second step opens in a new tab.", "Другий крок банку відкривається в новій вкладці."),
    estimate: { percent: 35, minutesAgo: 18 }, updatedAgo: 26,
    pipeline: lane("t-35", L("Card payments: 3-D Secure", "Оплата карткою: 3-D Secure"), "running", 52, [{ stageId: "build", attempts: [attempt("t-35", "build", [52, null], "running", true)] }], "build"),
  },
  {
    id: "t-65", title: L("Search filters reset after going back from a product page", "Фільтри пошуку скидаються після повернення з товару"), description: L("Price and size have to be picked again.", "Ціну й розмір доводиться обирати знову."),
    estimate: { percent: 65, minutesAgo: 12 }, updatedAgo: 40,
    pipeline: lane("t-65", L("Search filters reset after going back from a product page", "Фільтри пошуку скидаються після повернення з товару"), "completed", 110, [
      { stageId: "build", attempts: [attempt("t-65", "build", [110, 70], "passed", false)] },
      { stageId: "review", attempts: [attempt("t-65", "review", [68, 41], "passed", false)] },
    ], null, {
      merge: {
        state: "waiting-checks", by: "auto-merge", repository: "orbit/orbit-store", prNumber: 418, policyChangedAt: iso(DAY), reviewedHead: HEAD, chain: [HEAD],
        updates: [], seenChecks: ["tests"], head: HEAD, headSeenAt: iso(40), lastChecks: [], readAt: iso(1), nextReadAt: null, readFailures: 0,
        requestedAt: iso(40), mergedHead: null, mergeCommit: null, method: "squash", mergedAt: null, attempts: 0, reason: null, blockedAt: null, updatedAt: iso(40),
      },
    }),
  },
  {
    id: "t-stale", title: L("Orders page is slow on phones", "Сторінка замовлень повільна на телефоні"), description: L("Over 3 s on a mid-range phone.", "Понад 3 с на середньому телефоні."),
    estimate: { percent: 50, minutesAgo: 2 * DAY + 3 * 60 }, updatedAgo: 2 * DAY + 3 * 60,
    pipeline: lane("t-stale", L("Orders page is slow on phones", "Сторінка замовлень повільна на телефоні"), "paused", 3 * DAY, [
      { stageId: "build", attempts: [attempt("t-stale", "build", [3 * DAY, 2 * DAY + 3 * 60], "passed", false)] },
    ], "review", { pausedState: "running", pausedAt: iso(2 * DAY + 3 * 60) }),
  },
  /* A finished task in Done keeps its last report: the desktop's 280 px shelf
     card. The phone draws it in its Done tab, off the frame. */
  {
    id: "t-done", title: L("Receipts by email", "Чеки на пошту"), description: L("A PDF after each paid order.", "PDF після кожного оплаченого замовлення."),
    estimate: { percent: 100, minutesAgo: 3 * 60 }, updatedAgo: 2 * 60, status: "done",
    pipeline: lane("t-done", L("Receipts by email", "Чеки на пошту"), "completed", 6 * 60, [
      { stageId: "build", attempts: [attempt("t-done", "build", [6 * 60, 5 * 60], "passed", false)] },
      { stageId: "review", attempts: [attempt("t-done", "review", [5 * 60 - 2, 3 * 60], "passed", false)] },
    ], null, {
      closedAt: iso(2 * 60),
      merge: {
        state: "merged", by: "auto-merge", repository: "orbit/orbit-store", prNumber: 411, policyChangedAt: iso(DAY), reviewedHead: HEAD, chain: [HEAD],
        updates: [], seenChecks: ["tests"], head: HEAD, headSeenAt: iso(3 * 60), lastChecks: [], readAt: iso(2 * 60), nextReadAt: null, readFailures: 0,
        requestedAt: iso(3 * 60), mergedHead: HEAD, mergeCommit: "e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9", method: "squash", mergedAt: iso(2 * 60), attempts: 1, reason: null, blockedAt: null, updatedAt: iso(2 * 60),
      },
    }),
  },
];
/** The card whose dot's words every frame shows (the desktop's open popover, the phone's caption): the design's own example, a waiting card at 65 %. */
const POPOVER_CARD = "t-65";

const PIPELINES = CARDS.map((card) => card.pipeline);
const TASKS: BoardTask[] = CARDS.map((card, index) => ({
  id: card.id, project: PROJECT, text: `${card.title}\n${card.description}`, status: card.status ?? "assigned", placement: "unplaced",
  assignments: [], revision: `task-v1:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  createdAt: iso(card.updatedAgo + 30), updatedAt: iso(card.updatedAgo), ...(card.status === "done" ? { doneAt: iso(card.updatedAgo) } : {}),
} as unknown as BoardTask));
const byId = new Map(CARDS.map((card) => [card.id, card] as const));

/* ---------- the words the bar and the popover add ---------- */

/** A report's age, in the popover's words: minutes and hours as the dot already
    says them, whole days past a day. */
function reportAge(minutesAgo: number): string {
  if (minutesAgo < DAY) return humanizeDuration(minutesAgo * 60, LANG);
  const days = Math.floor(minutesAgo / DAY);
  if (LANG === "en") return `${days} day${days === 1 ? "" : "s"}`;
  const word = days % 10 === 1 && days % 100 !== 11 ? "день" : [2, 3, 4].includes(days % 10) && ![12, 13, 14].includes(days % 100) ? "дні" : "днів";
  return `${days} ${word}`;
}
/** The popover's added line: the estimate, approximate, and how old the report is. */
function estimateLine(estimate: Estimate): string {
  if (!estimate) return L("No agent estimate yet", "Агент ще не оцінив");
  /* The age never splits («12 хв» / «тому»): a narrow bubble wraps after the «·». */
  const age = L(`${reportAge(estimate.minutesAgo)} ago`, `${reportAge(estimate.minutesAgo)} тому`).replace(/ /g, "\u00a0");
  return shownOf(estimate) === "stale"
    ? L(`Last agent estimate ≈${estimate.percent}% · ${age}`, `Остання оцінка агента ≈${estimate.percent}% · ${age}`)
    : L(`Agent estimate ≈${estimate.percent}% · ${age}`, `Оцінка агента ≈${estimate.percent}% · ${age}`);
}

/* ---------- the bar ---------- */

/** The track and its fill, in the product's own tokens. The track is a 1 px
    outline (dashed, with nothing inside, when nothing was reported) in the
    muted text tone eased toward the card: 3.2:1 against the light card, 3.6:1
    against the dark one. Inside it lies the default border tone, and the fill
    on that: the secondary text tone. A report older than a day fills with
    diagonal stripes of the muted text tone, so it differs from a fresh fill by
    its form as well as its tone; each stroke is at least 3.9:1 against the
    inside. A solid 2 px track under a solid fill cannot hold 3:1 at both steps
    with a softened fill (README.md, «The bar's look»). No status colour: the
    dot keeps those. */
const BAR_CSS = `
:root { --proto-track: color-mix(in srgb, var(--color-muted) 78%, var(--surface-card)); }
[data-proto-progress] { display: block; box-sizing: border-box; height: 5px; border: 1px solid var(--proto-track); border-radius: 999px; background: var(--border-default); pointer-events: none; overflow: hidden; }
[data-proto-progress="unknown"] { border-style: dashed; background: none; }
[data-proto-progress] > [data-proto-fill] { display: block; height: 100%; border-radius: 999px; background: var(--color-secondary); }
[data-proto-progress="stale"] > [data-proto-fill] { background: repeating-linear-gradient(135deg, var(--color-muted) 0 2px, transparent 2px 4px); }
/* Variant 1: in the card's bottom padding, inset by the card's own horizontal
   padding. The padding grows by 4 px so the bar keeps a clear gap below the
   last row, a framed phone card's «Answer» button included. */
[data-proto-variant="1"] [data-proto-host] { position: absolute; left: 12px; right: 12px; bottom: 5px; }
[data-proto-variant="1"] .kb .card:has(> [data-proto-host]) { padding-bottom: 16px; }
/* The phone's face and frame set no position of their own; the desktop card already does. */
[data-proto-variant="1"] :is([data-phone-card], [data-phone-card-frame]):has(> [data-proto-host]) { position: relative; padding-bottom: 16px; }
/* Variant 2: under the title row, centred between the title's last line and
   the state line (CardBar sets the margins, since the title row's height
   depends on its controls). */
[data-proto-variant="2"] [data-proto-host] { display: block; padding-left: ${PHONE ? "0" : "22px"}; }
/* A phone card with a dismissal beside its face: the bar runs on under the
   dismissal, to the same right edge as every other card's. */
[data-proto-variant="2"] [data-phone-card]:has(+ [data-phone-card-dismiss]) > [data-proto-host] { margin-right: -32px; }
/* Variant 3: a short capsule beside the dot, level with its centre. */
[data-proto-variant="3"] [data-proto-progress] { height: 8px; }
[data-proto-variant="3"] [data-proto-host] { flex: none; width: 36px; margin-top: 4px; margin-left: -1px; }
/* The desktop's open popover, beside the state line (DesktopPopover). */
[data-proto-pop-placed] .card-state-pop { left: var(--proto-pop-left) !important; top: var(--proto-pop-top) !important; }
/* Its width cap applies from the first measurement on; the product's is 260 px. */
.card-state-pop { max-width: var(--proto-pop-max, 260px) !important; }
`;

function Bar({ card }: { card: CardSpec }) {
  const shown = shownOf(card.estimate);
  if (!card.estimate) return <span data-proto-progress="unknown" data-proto-card={card.id} aria-hidden />;
  const value = card.estimate.percent;
  return (
    <span
      data-proto-progress={shown}
      data-proto-card={card.id}
      role="progressbar"
      aria-label={L(`Agent estimate for «${card.title}»`, `Оцінка агента для «${card.title}»`)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={L(`Agent estimate, approximately ${value}%`, `Оцінка агента, приблизно ${value}%`)}
    >
      <span data-proto-fill="" style={{ width: `${value}%` }} />
    </span>
  );
}

/* ---------- inserting into the product's own markup ---------- */

/** Waits for a place the product renders, hands back a node inserted there, and inserts it again if the product redraws it. */
function useInsertedHost(find: () => { parent: Element; before: Element | null } | null, tag: "div" | "span" = "span", mark = "protoHost"): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let made: HTMLElement | null = null;
    const attempt = () => {
      if (made?.isConnected) return;
      const spot = find();
      if (!spot) return;
      made = document.createElement(tag);
      made.dataset[mark] = "";
      spot.parent.insertBefore(made, spot.before);
      setHost(made);
    };
    attempt();
    const observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [find, tag, mark]);
  return host;
}

/** The card's own element: the desktop's `KanbanCard`, or the phone's card face. */
const cardElement = (id: string) => document.querySelector<HTMLElement>(PHONE ? `[data-phone-card="task:${CSS.escape(id)}"]` : `[data-kanban-card="task:${CSS.escape(id)}"]`);

/** Where each variant puts the bar in a card. */
function barSpot(id: string, variant: Variant): { parent: Element; before: Element | null } | null {
  const card = cardElement(id);
  if (!card) return null;
  /* The phone frames a card that carries a row under its face (an answer, a dismissal): its bottom edge is the frame's. */
  if (variant === 1) return { parent: (PHONE && card.closest("[data-phone-card-frame]")) || card, before: null };
  if (variant === 2) {
    /* The desktop's title row, or the phone's (its icon, title and marks). */
    const row = PHONE ? card.querySelector("[data-phone-card-title]")?.parentElement : card.querySelector(":scope > .head");
    return row ? { parent: row.parentElement!, before: row.nextElementSibling } : null;
  }
  const dot = card.querySelector(".card-state > .card-state-dot");
  return dot ? { parent: dot.parentElement!, before: dot.nextElementSibling } : null;
}

/** Variant 2: moves the bar to the middle of the space between the title's
    last line and the state line, keeping the state line where it is. */
function centreUnderTitle(host: HTMLElement, id: string) {
  const card = cardElement(id);
  const title = card?.querySelector(PHONE ? "[data-phone-card-title]" : ".title");
  const line = card?.querySelector(".card-state");
  if (!title || !line) return;
  host.style.marginTop = host.style.marginBottom = "";
  /* The words' line boxes, not their elements' boxes: the desktop title is a 28 px rename button. */
  const lines = (element: Element) => {
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width) rects.push(rect);
    }
    return rects;
  };
  const titleLines = lines(title);
  const stateLines = lines(line.querySelector(".card-state-words") ?? line);
  if (!titleLines.length || !stateLines.length) return;
  const titleBottom = Math.max(...titleLines.map((rect) => rect.bottom));
  const stateTop = Math.min(...stateLines.map((rect) => rect.top));
  const bar = host.getBoundingClientRect();
  const shift = Math.round((titleBottom + stateTop - bar.height) / 2 - bar.top);
  host.style.marginTop = `${shift}px`;
  host.style.marginBottom = `${-shift}px`;
}

function CardBar({ card }: { card: CardSpec }) {
  const find = useMemo(() => () => barSpot(card.id, VARIANT), [card.id]);
  const host = useInsertedHost(find);
  useEffect(() => {
    if (!host || VARIANT !== 2) return;
    /* Again whenever the card or its title changes size: the board settles its layout over several frames. */
    const centre = () => centreUnderTitle(host, card.id);
    const observer = new ResizeObserver(centre);
    const element = cardElement(card.id);
    if (element) observer.observe(element);
    const title = element?.querySelector(PHONE ? "[data-phone-card-title]" : ".title");
    if (title) observer.observe(title);
    centre();
    return () => observer.disconnect();
  }, [host, card.id]);
  return host ? createPortal(<Bar card={card} />, host) : null;
}

/* ---------- the popover ---------- */

/** True once every card's bar is in place and two frames have painted: the
    bubble measures its anchor when it opens, as a hover on a settled board
    would, and not while the board is still laying the cards out. */
function useSettled(): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled) return;
    let frame = 0;
    const check = () => {
      if (document.querySelectorAll("[data-proto-progress]").length < CARDS.length) return;
      observer.disconnect();
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setSettled(true)); });
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [settled]);
  return settled;
}

/** The desktop dot's own popover, opened as a mouse opens it, with the
    estimate's line added under the product's words. */
function DesktopPopover({ card }: { card: CardSpec }) {
  const settled = useSettled();
  useEffect(() => {
    if (!settled) return;
    let stop = false;
    const open = () => {
      if (stop || document.querySelector("[data-card-state-pop]")) return;
      const dot = cardElement(card.id)?.querySelector<HTMLElement>("[data-card-state-dot]");
      if (!dot) return;
      dot.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
    };
    open();
    const observer = new MutationObserver(open);
    observer.observe(document.body, { childList: true, subtree: true });
    const end = setTimeout(() => { stop = true; observer.disconnect(); }, 8_000);
    return () => { clearTimeout(end); observer.disconnect(); };
  }, [card.id, settled]);
  const find = useMemo(() => () => {
    const words = document.querySelector("[data-card-state-pop]");
    return words ? { parent: words.parentElement!, before: null } : null;
  }, []);
  const host = useInsertedHost(find);
  /* The product opens the bubble above the dot, over the card's own title (and
     in variant 2 over its bar). The prototype opens it beside the state line
     instead: level with the line's top, 12 px after the words of every row it
     spans, so it covers neither the title, nor any bar, nor any words. Its
     right edge stays 4 px inside the card, so on a narrow board its words wrap
     inside the card and never reach the next column. It rises when the space
     under the state line is too short to keep it inside the card, and in
     variant 1 to keep its shadow 6 px above the bar along the card's bottom
     edge. The product's
     bubble keeps its words and its layer; only its place moves. It measures
     again once the added line makes it taller, and on every resize. */
  useEffect(() => {
    if (!host) return;
    const place = () => {
      const cardBox = cardElement(card.id);
      const line = cardBox?.querySelector<HTMLElement>(".card-state");
      const bubble = document.querySelector<HTMLElement>(".card-state-pop");
      if (!cardBox || !line || !bubble) return;
      const root = document.documentElement;
      const cardRight = cardBox.getBoundingClientRect().right;
      const bar = cardBox.querySelector("[data-proto-progress]")?.getBoundingClientRect();
      const lineTop = line.getBoundingClientRect().top - 4;
      /* Its bottom stays 4 px inside the card; in variant 1 its shadow (--shadow-1
         reaches 3 px under its border) ends 7 px above the bar, which keeps 6 whole
         pixels after rounding. In variant 2 it never rises over the bar between
         the title and the state line. */
      let bottomLimit = cardBox.getBoundingClientRect().bottom - 4;
      if (VARIANT === 1 && bar) bottomLimit = Math.min(bottomLimit, bar.top - 7 - 3);
      const topFloor = VARIANT === 2 && bar ? bar.bottom + 2 : -Infinity;
      /* The right end of the words on every row between top and bottom. */
      const textRightBetween = (top: number, bottom: number) => {
        let right = line.getBoundingClientRect().left;
        const walker = document.createTreeWalker(cardBox, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) if (rect.width && rect.top < bottom && rect.bottom > top) right = Math.max(right, rect.right);
        }
        return right;
      };
      /* Width, then height, then the rows spanned settle within a few rounds. */
      let top = lineTop;
      let left = 0;
      for (let round = 0; round < 4; round += 1) {
        const height = bubble.getBoundingClientRect().height;
        top = Math.floor(Math.max(topFloor, Math.min(lineTop, bottomLimit - height)));
        left = Math.round(textRightBetween(top, top + height) + 12);
        root.style.setProperty("--proto-pop-max", `${Math.max(120, Math.min(260, Math.floor(cardRight - 4 - left)))}px`);
      }
      root.style.setProperty("--proto-pop-left", `${left}px`);
      root.style.setProperty("--proto-pop-top", `${Math.round(top)}px`);
      root.dataset.protoPopPlaced = "";
    };
    const frame = requestAnimationFrame(() => { window.dispatchEvent(new Event("resize")); place(); });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [host, card.id]);
  return host ? createPortal(<span className="block" data-proto-estimate-line="">{estimateLine(card.estimate)}</span>, host) : null;
}

/** The phone's dot is passive inside its one-button card, so the product
    draws no popover there. The frame prints the same words as a caption under
    the card, outside it, so the card's title and bar stay in view
    (README.md, «The phone»). */
function PhoneCaption({ card }: { card: CardSpec }) {
  const [owner, setOwner] = useState<CardState["owner"] | null>(null);
  const find = useMemo(() => () => {
    const face = cardElement(card.id);
    if (!face) return null;
    /* The card's own entry in the column's list: the outermost box that holds this card and no other. */
    let entry: Element = face;
    while (entry.parentElement && entry.parentElement.querySelectorAll("[data-phone-card]").length === 1) entry = entry.parentElement;
    return entry.parentElement ? { parent: entry.parentElement, before: entry.nextElementSibling } : null;
  }, [card.id]);
  /* Its own mark: the bar's host rules (variant 1 places it absolutely) must not reach it. */
  const host = useInsertedHost(find, "div", "protoCaptionHost");
  useEffect(() => {
    const read = () => {
      const dot = cardElement(card.id)?.querySelector(".card-state-dot");
      if (dot) setOwner(dot.getAttribute("data-owner") as CardState["owner"]);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [card.id]);
  if (!host || !owner) return null;
  /* The waiting card stands since its PR's merge request, as `laneState` reads it. */
  const since = card.pipeline.merge?.requestedAt ? Date.parse(card.pipeline.merge.requestedAt) : NOW_MS;
  const words = cardStatePopover(t as never, { owner } as CardState, humanizeDuration((NOW_MS - since) / 1000, LANG));
  return createPortal(
    <div className="flex flex-col gap-1 px-1 pt-0.5 text-caption text-muted" data-proto-phone-caption="">
      <span>{L("↑ What the dot says (on the phone: in the card's description and the opened task)", "↑ Що каже крапка (на телефоні — в описі картки й відкритій задачі)")}</span>
      <span className="card-state-pop block self-start">
        <span className="block" data-card-state-pop={owner}>{words}</span>
        <span className="block" data-proto-estimate-line="">{estimateLine(card.estimate)}</span>
      </span>
    </div>,
    host,
  );
}

/* ---------- the screens ---------- */

function DesktopScreen() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas text-primary" data-proto-screen="desktop">
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
        focus={null}
        readerStorage={null}
      />
    </div>
  );
}

function PhoneScreen() {
  const noop = () => undefined;
  return (
    <div className="relative flex min-h-0 min-w-0 max-w-[100dvw] flex-1 flex-col overflow-hidden bg-canvas text-primary" data-proto-screen="phone">
      <MobileKanban
        project={PROJECT}
        groups={[]}
        manual={[]}
        files={FILES}
        flows={[]}
        pipelines={PIPELINES}
        tasks={[]}
        allTasks={TASKS}
        drafts={[]}
        now={NOW}
        seatRefs={null}
        attention={[]}
        onOpenTask={noop}
        onOpenConversation={noop}
        onOpenPipeline={noop}
      />
    </div>
  );
}

const VARIANT_NAMES: Record<Variant, string> = {
  1: L("A thin bar along the card's bottom edge", "Тонка смужка вздовж нижнього краю картки"),
  2: L("The bar under the title", "Смужка під назвою"),
  3: L("A short bar in the state line, beside the dot", "Коротка смужка в рядку стану, біля крапки"),
};
/** What each card shows, for the legend. The cards print no number: the legend is the prototype's, never the product's. */
const LEGEND_LABELS: Record<string, string> = {
  "t-100": L("100%, not done yet", "100%, ще не готово"),
  "t-none": L("no estimate", "без оцінки"),
  "t-zero": "0%",
  "t-35": L("35%, working", "35%, працює"),
  "t-65": PHONE
    ? L("65%, waiting for checks (the dot's words under it)", "65%, чекає перевірок (слова крапки під нею)")
    : L("65%, waiting for checks (popover open)", "65%, чекає перевірок (підказку відкрито)"),
  "t-stale": L("50%, reported 2 days ago", "50%, оцінка 2-денної давності"),
  "t-done": L("100%, merged", "100%, змерджено"),
};

/** The legend in the order the board drew the cards: the desktop puts working
    cards first, the phone the card that waits for the operator. */
function Legend() {
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    const read = () => {
      const ids = [...document.querySelectorAll(PHONE ? "[data-phone-card^='task:']" : "[data-kanban-card^='task:']")]
        .map((element) => (element.getAttribute(PHONE ? "data-phone-card" : "data-kanban-card") ?? "").slice("task:".length));
      setOrder((previous) => (previous.join() === ids.join() ? previous : ids));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const column = (status: BoardTask["status"]) => order.filter((id) => (byId.get(id)?.status ?? "assigned") === status).map((id) => LEGEND_LABELS[id]).join(" · ");
  /* The phone's Done tab is off the frame, so its legend names only the column it shows. */
  const done = PHONE ? "" : column("done");
  return (
    <span className="text-caption text-secondary [overflow-wrap:anywhere]" data-proto-legend="">
      {L("In progress, top to bottom: ", "У роботі, згори вниз: ")}{column("assigned")}
      {done ? L(`. Done: ${done}`, `. Готові: ${done}`) : null}
    </span>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className={`flex ${PHONE ? "min-h-dvh" : "h-dvh"} min-h-0 flex-col`} data-proto-variant={VARIANT}>
      {/* The variant's number and name, printed on every frame, with the cards' legend. */}
      <header data-proto-header="" className="flex flex-col gap-0.5 border-b border-border bg-sunken px-3 py-1.5 text-primary">
        <span className="flex min-h-6 items-center gap-2 text-ui font-semibold">
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-label font-bold text-accent">{L(`Variant ${VARIANT} of 3`, `Варіант ${VARIANT} з 3`)}</span>
          <span className="min-w-0 flex-1 text-label [overflow-wrap:anywhere]" data-proto-variant-name="">{VARIANT_NAMES[VARIANT]}</span>
        </span>
        <Legend />
      </header>
      {children}
      <style>{BAR_CSS}</style>
      {CARDS.map((card) => <CardBar key={card.id} card={card} />)}
      {PHONE ? <PhoneCaption card={byId.get(POPOVER_CARD)!} /> : <DesktopPopover card={byId.get(POPOVER_CARD)!} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Frame>{PHONE ? <PhoneScreen /> : <DesktopScreen />}</Frame>);
