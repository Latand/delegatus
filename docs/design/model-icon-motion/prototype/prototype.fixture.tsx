"use client";

/*
 * Prototype: a stage's model glyph moves only while its agent really works,
 * at the speed the runtime actually applied (docs/design/model-icon-motion-brief.md,
 * docs/design/model-icon-motion/prototype/README.md).
 *
 * Every screen is the product's own components over invented fixture data:
 * the desktop board (`KanbanBoard`, its cards' stage pills and one opened card
 * with its graph) and the phone's board (`MobileKanban`). The glyph is the
 * unchanged `StageGlyph`. The fixture computes, per stage, whether its agent
 * is active and at which applied tier, and writes that onto the glyph as
 * `data-proto-active`, `data-proto-tier` and `data-proto-reading`;
 * `prototype.css` keys the motion on those attributes:
 *
 *   0  today's main, as it draws now (the "before" of every measurement);
 *   A  ordinary 4 s, fast 2 s, ultra 1 s per turn (1:2:4);
 *   B  ordinary 4 s, fast 2 s, ultra 0.5 s per turn (1:2:8).
 *
 * Every 2 s the active conversations' transcripts grow and the lanes are
 * touched, the way the scanner and the lane feed refresh a working board.
 *
 * Query string: ?variant=0|A|B&device=desktop|phone&lang=uk|en&theme=light|dark
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { setLocale, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { latestAttempt } from "@/lib/pipelines/stageChip";
import { cpuQueueDetail } from "@/lib/runtime/cpuQueueText";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { MobileKanban } from "@/components/mobile/MobileKanban";
import { GLYPH_STATE } from "@/components/kanban/modelGlyph";
import { stageViews } from "@/components/kanban/pipelineGraph";
import { workingStageConversations } from "@/components/kanban/kanbanModel";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = (["0", "A", "B"] as const).find((name) => name === params.get("variant")) ?? "B";
const PHONE = params.get("device") === "phone";
type Variant = typeof VARIANT;

document.documentElement.dataset.theme = THEME;
document.documentElement.dataset.protoVariant = VARIANT;
document.documentElement.lang = LANG;
try { localStorage.setItem("llv_lang", LANG); } catch { /* opaque origin */ }
setLocale(LANG);
const L = (en: string, uk: string) => (LANG === "uk" ? uk : en);

/* The prototype's motion rules: unlayered, after the product's stylesheet. */
const sheet = document.createElement("link");
sheet.rel = "stylesheet";
sheet.href = "/proto.css";
document.head.append(sheet);

/* A frozen wall clock: every time and age reads the same in each render.
   Animations run on the document timeline, which this does not touch. */
const NOW_MS = Date.parse("2026-10-29T20:30:00.000Z");
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

type Engine = "claude" | "codex";
type Model = { engine: Engine; model: string };
const OPUS: Model = { engine: "claude", model: "claude-opus-5-5" };
const SONNET: Model = { engine: "claude", model: "claude-sonnet-5-5" };
const SOL: Model = { engine: "codex", model: "gpt-6.1-sol" };
const ASTRA: Model = { engine: "codex", model: "gpt-6-astra" };
const TERRA: Model = { engine: "codex", model: "gpt-5.6-terra" };

/** Where the conversation's tier came from: `native` is what the process or
    its transcript reports as applied (argv, `thread_settings_applied`); a
    `profile` value is the registry's launch profile, which holds what the
    Viewer asked for and can be a request the runtime never confirmed
    (`entryServiceTierResult`, src/lib/scanner/effort.ts). `FileEntry` does
    not carry this today; the implementation exposes it. */
type TierSource = "native" | "profile" | null;
type Talk = "working" | "idle";
type FileSpec = { model: Model; talk: Talk; tier?: string | null; tierSource?: TierSource };

let pid = 7_100;
const FILES: FileEntry[] = [];
function conversation(id: string, title: string, spec: FileSpec): FileEntry {
  const live = spec.talk === "working";
  const file = {
    path: `/sessions/${PROJECT}/${id}.jsonl`, root: spec.model.engine === "claude" ? "claude-projects" : "codex-sessions", name: `${id}.jsonl`,
    project: PROJECT, title, engine: spec.model.engine, kind: "session", fmt: spec.model.engine, parent: null,
    mtime: NOW - (live ? 20 : 11 * 60), size: 40_960, activity: live ? "live" : "idle", proc: "running", pid: ++pid,
    model: spec.model.model, effort: "high", pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`, generation: 1,
    serviceTier: spec.tier ?? null, fast: spec.tier ? spec.tier !== "default" : null, serviceTierSource: spec.tierSource ?? null,
    authoritativeTurn: live ? { state: "busy", source: "lifecycle", terminalAt: null } : { state: "idle", source: "lifecycle", terminalAt: NOW_MS - 11 * 60_000 },
    lastTurn: live ? { startedAt: NOW_MS - 6 * 60_000, endedAt: null } : { startedAt: NOW_MS - 19 * 60_000, endedAt: NOW_MS - 11 * 60_000 },
  } as unknown as FileEntry;
  FILES.push(file);
  return file;
}

const role = (roleId: string, model: Model, serviceTier?: string) => ({
  roleId, engine: model.engine, model: model.model, effort: "high", access: roleId === "reviewer" || roleId === "visual-critic" ? "read-only" : "read-write",
  promptScaffold: null, ...(serviceTier ? { serviceTier } : {}),
});
type StageSpec = { id: string; roleId: string; model: Model; tier?: string };
const stage = (spec: StageSpec, next: string | null) => ({
  id: spec.id, kind: "run", role: { roleId: spec.roleId }, prompt: "{{task}}", next, onFail: null, effectiveRole: role(spec.roleId, spec.model, spec.tier),
});

type AttemptState = "pending" | "spawning" | "running" | "committing" | "passed" | "needs_decision";
type AttemptSpec = { state: AttemptState; started: number; ended?: number; file?: FileSpec; verdict?: "pass" | "needs_decision"; over?: Record<string, unknown> };
function attempt(laneId: string, spec: StageSpec, a: AttemptSpec) {
  const file = a.file ? conversation(`${laneId}-${spec.id}`, spec.id, a.file) : null;
  const verdict = a.verdict ? { status: a.verdict, findings: [], rankedFindings: [] } : null;
  return {
    n: 1, state: a.state, effectiveRole: role(spec.roleId, spec.model, spec.tier),
    launchId: file ? `launch-${file.name}` : null, conversationId: file?.conversationId ?? null, sessionId: null, agentPath: file?.path ?? null, paneId: null, flowId: null,
    startedAt: iso(a.started), completedAt: a.ended === undefined ? null : iso(a.ended), input: null, activatedBy: null, output: null, verdict, error: null,
    ...(verdict ? { report: { seq: 1, at: iso(a.ended ?? a.started - 1), actor: { kind: "agent", conversationId: file?.conversationId ?? null }, verdict, summary: "", provenance: null, calls: 1 } } : {}),
    ...a.over,
  };
}

/** One card's lane: its stages in order, the attempts each has, and where the cursor is. */
type Expect = { active: boolean; tier: "ordinary" | "fast" | "ultra" };
interface CaseSpec {
  id: string;
  status: BoardTask["status"];
  title: string;
  description: string;
  state: Pipeline["state"];
  created: number;
  stages: Array<StageSpec & { attempt?: AttemptSpec }>;
  cursor: string | null;
  cursorState?: string;
  over?: Record<string, unknown>;
  /** What the request says each glyph must do; the rule's answer is checked against it. */
  expect: Record<string, Expect>;
}

const ON = (tier: Expect["tier"] = "ordinary"): Expect => ({ active: true, tier });
const OFF: Expect = { active: false, tier: "ordinary" };

const working = (tier?: string | null, tierSource: TierSource = tier ? "native" : null) => ({ talk: "working" as const, tier, tierSource });

const CASES: CaseSpec[] = [
  {
    id: "t-sol", status: "assigned", state: "running", created: 50, cursor: "review",
    title: L("Coupon codes at checkout", "Промокоди в кошику"),
    description: L("Sol reviews at the ordinary speed.", "Sol рев’ює на звичайній швидкості."),
    stages: [
      { id: "build", roleId: "builder", model: OPUS, attempt: { state: "passed", started: 50, ended: 12, verdict: "pass", file: { model: OPUS, talk: "idle" } } },
      { id: "review", roleId: "reviewer", model: SOL, attempt: { state: "running", started: 10, file: { model: SOL, ...working("default") } } },
    ],
    expect: { build: OFF, review: ON("ordinary") },
  },
  {
    id: "t-sol-fast", status: "assigned", state: "running", created: 40, cursor: "build",
    title: L("Delivery slots for tomorrow", "Слоти доставки на завтра"),
    description: L("Sol builds on the priority tier.", "Sol збирає на пріоритетному рівні."),
    stages: [{ id: "build", roleId: "builder", model: SOL, tier: "priority", attempt: { state: "running", started: 38, file: { model: SOL, ...working("priority") } } }],
    expect: { build: ON("fast") },
  },
  {
    id: "t-astra-ultra", status: "assigned", state: "running", created: 30, cursor: "build",
    title: L("Search suggestions while typing", "Підказки пошуку під час набору"),
    description: L("Astra builds on ultrafast, applied.", "Astra збирає на ultrafast, застосовано."),
    stages: [{ id: "build", roleId: "builder", model: ASTRA, tier: "ultrafast", attempt: { state: "running", started: 28, file: { model: ASTRA, ...working("ultrafast") } } }],
    expect: { build: ON("ultra") },
  },
  {
    id: "t-rework", status: "assigned", state: "running", created: 90, cursor: "critique",
    title: L("Export guide for the API", "Посібник з експорту для API"),
    description: L("Opus critiques; the passed docs stage works again.", "Opus критикує; пройдений етап документації знову працює."),
    stages: [
      { id: "docs", roleId: "builder", model: SONNET, attempt: { state: "passed", started: 90, ended: 30, verdict: "pass", file: { model: SONNET, ...working() } } },
      { id: "critique", roleId: "architect", model: OPUS, attempt: { state: "running", started: 28, file: { model: OPUS, ...working() } } },
      { id: "verify", roleId: "verifier", model: SOL },
    ],
    expect: { docs: ON("ordinary"), critique: ON("ordinary"), verify: OFF },
  },
  {
    id: "t-terra", status: "assigned", state: "running", created: 25, cursor: "migrate",
    title: L("Move saved carts to the new table", "Перенести збережені кошики в нову таблицю"),
    description: L("Terra migrates on the priority tier.", "Terra переносить на пріоритетному рівні."),
    stages: [{ id: "migrate", roleId: "builder", model: TERRA, tier: "priority", attempt: { state: "running", started: 24, file: { model: TERRA, ...working("priority") } } }],
    expect: { migrate: ON("fast") },
  },
  {
    id: "t-astra-pending", status: "assigned", state: "running", created: 22, cursor: "build",
    title: L("Gift cards in the account page", "Подарункові картки в кабінеті"),
    description: L("Ultrafast requested, not applied yet: ordinary.", "Ultrafast запитано, ще не застосовано: звичайна."),
    stages: [{
      id: "build", roleId: "builder", model: ASTRA,
      attempt: { state: "running", started: 20, file: { model: ASTRA, ...working("default") }, over: { runtimeSwitches: [switchRecord("sw-pending", "requested", "ultrafast")] } },
    }],
    expect: { build: ON("ordinary") },
  },
  {
    id: "t-astra-refused", status: "assigned", state: "running", created: 21, cursor: "build",
    title: L("Order history filters", "Фільтри історії замовлень"),
    description: L("Ultrafast refused: stays ordinary.", "Ultrafast відмовлено: лишається звичайна."),
    stages: [{
      id: "build", roleId: "builder", model: ASTRA,
      attempt: { state: "running", started: 19, file: { model: ASTRA, ...working("default") }, over: { runtimeSwitches: [switchRecord("sw-refused", "failed", "ultrafast")] } },
    }],
    expect: { build: ON("ordinary") },
  },
  {
    id: "t-astra-profile", status: "assigned", state: "running", created: 18, cursor: "build",
    title: L("Stock alerts by email", "Сповіщення про наявність на пошту"),
    description: L("Ultrafast only in the launch profile, never confirmed: ordinary.", "Ultrafast лише в профілі запуску, не підтверджено: звичайна."),
    stages: [{ id: "build", roleId: "builder", model: ASTRA, tier: "ultrafast", attempt: { state: "running", started: 16, file: { model: ASTRA, ...working("ultrafast", "profile") } } }],
    expect: { build: ON("ordinary") },
  },
  /* The reproduced case: a Git-only lane preparing its worktree for about
     7 minutes before its first agent starts. */
  {
    id: "t-provision", status: "assigned", state: "provisioning", created: 7, cursor: "verify",
    title: L("Pipelines run through Git", "Пайплайни працюють через Git"),
    description: L("Preparing the worktree; no agent yet.", "Готується робоче дерево; агента ще немає."),
    stages: [{ id: "verify", roleId: "verifier", model: SOL }],
    expect: { verify: OFF },
  },
  {
    id: "t-spawn", status: "assigned", state: "running", created: 2, cursor: "build",
    title: L("Return labels in the order page", "Етикетки повернення на сторінці замовлення"),
    description: L("The agent is starting.", "Агент запускається."),
    stages: [{ id: "build", roleId: "builder", model: ASTRA, attempt: { state: "spawning", started: 1 } }],
    expect: { build: OFF },
  },
  {
    id: "t-cpu", status: "assigned", state: "running", created: 9, cursor: "review", over: { stateDetail: cpuQueueDetail(2, 6 * 60_000) },
    title: L("Price rounding in invoices", "Округлення цін у рахунках"),
    description: L("The review waits for a CPU slot.", "Рев’ю чекає на вільний слот CPU."),
    stages: [
      { id: "build", roleId: "builder", model: OPUS, attempt: { state: "passed", started: 60, ended: 9, verdict: "pass", file: { model: OPUS, talk: "idle" } } },
      { id: "review", roleId: "reviewer", model: SOL, attempt: { state: "pending", started: 8 } },
    ],
    expect: { build: OFF, review: OFF },
  },
  {
    id: "t-idle", status: "assigned", state: "running", created: 45, cursor: "build",
    title: L("Courier tracking link", "Посилання на відстеження кур’єра"),
    description: L("The stage runs; its turn ended 11 minutes ago.", "Етап триває; його хід завершився 11 хв тому."),
    stages: [{ id: "build", roleId: "builder", model: SOL, attempt: { state: "running", started: 44, file: { model: SOL, talk: "idle", tier: "default", tierSource: "native" } } }],
    expect: { build: OFF },
  },
  /* The relayed example: a pass reported, the attempt still committing, the next stage not started. */
  {
    id: "t-commit", status: "assigned", state: "running", created: 35, cursor: "design", cursorState: "committing",
    title: L("Wishlist sharing", "Поділитися списком бажань"),
    description: L("The design passed and is committing.", "Дизайн пройшов і комітиться."),
    stages: [
      { id: "design", roleId: "architect", model: OPUS, attempt: { state: "committing", started: 34, verdict: "pass", file: { model: OPUS, talk: "idle" } } },
      { id: "build", roleId: "builder", model: SOL },
    ],
    expect: { design: OFF, build: OFF },
  },
  {
    id: "t-paused", status: "blocked", state: "paused", created: 70, cursor: "build", over: { pausedState: "running", pausedAt: iso(5) },
    title: L("Loyalty points on receipts", "Бонусні бали в чеках"),
    description: L("Paused while its agent still answers.", "Призупинено, хоч агент ще відповідає."),
    stages: [{ id: "build", roleId: "builder", model: ASTRA, attempt: { state: "running", started: 68, file: { model: ASTRA, ...working("default") } } }],
    expect: { build: OFF },
  },
  {
    id: "t-needs", status: "blocked", state: "needs_decision", created: 120, cursor: "deploy",
    title: L("Dark theme in settings", "Темна тема в налаштуваннях"),
    description: L("Built and reviewed; the deploy asks a question.", "Зібрано й перевірено; деплой питає."),
    stages: [
      { id: "build", roleId: "builder", model: SOL, attempt: { state: "passed", started: 120, ended: 80, verdict: "pass", file: { model: SOL, talk: "idle" } } },
      { id: "review", roleId: "reviewer", model: ASTRA, attempt: { state: "passed", started: 78, ended: 40, verdict: "pass", file: { model: ASTRA, talk: "idle" } } },
      { id: "deploy", roleId: "deployer", model: OPUS, attempt: { state: "needs_decision", started: 38, ended: 6, verdict: "needs_decision", file: { model: OPUS, talk: "idle" } } },
    ],
    expect: { build: OFF, review: OFF, deploy: OFF },
  },
];

function switchRecord(id: string, phase: "requested" | "failed", serviceTier: string) {
  const seat = { engine: "codex", model: ASTRA.model, effort: "high", accountId: null };
  return {
    id, seq: 1, requestedAt: iso(3), actor: { kind: "operator" }, mode: "fork", inPlace: true, cut: "none",
    from: { ...seat, serviceTier: "default", conversationId: "", launchId: null, sessionId: null, agentPath: null },
    to: { ...seat, serviceTier, accountPinned: false }, phase,
    ...(phase === "failed" ? { settledAt: iso(2), outcome: "the account's catalog does not offer ultrafast for this model" } : {}),
  };
}

function lane(spec: CaseSpec): Pipeline {
  const stages = spec.stages.map((entry, index) => stage(entry, spec.stages[index + 1]?.id ?? null));
  const runs = spec.stages.filter((entry) => entry.attempt).map((entry) => ({ stageId: entry.id, attempts: [attempt(spec.id, entry, entry.attempt!)] }));
  return {
    id: `p-${spec.id}`, task: spec.title, taskIds: [spec.id], project: PROJECT, repoDir: `/work/${PROJECT}`, worktreeDir: `/work/${PROJECT}/pipelines/p-${spec.id}`,
    branch: `pipeline/${spec.id}`, baseBranch: "main", baseRef: "main", lastPassedCommit: "", stages, runs,
    cursor: spec.cursor ? { stageId: spec.cursor, state: spec.cursorState ?? (spec.state === "paused" ? "running" : spec.state), input: null, activatedBy: null } : null,
    state: spec.state, pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: iso(spec.created), closedAt: null, updatedAt: iso(1), ...spec.over,
  } as unknown as Pipeline;
}

const PIPELINES: Pipeline[] = CASES.map(lane);
const TASKS: BoardTask[] = CASES.map((spec, index) => ({
  id: spec.id, project: PROJECT, text: `${spec.title}\n${spec.description}`, status: spec.status, placement: "unplaced",
  assignments: [], revision: `task-v1:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  createdAt: iso(spec.created + 5), updatedAt: iso(Math.max(1, spec.created - 1)),
} as unknown as BoardTask));
const LANE_BY_TASK = new Map(PIPELINES.map((pipeline) => [pipeline.taskIds![0]!, pipeline] as const));

/* ---------- the rule ---------- */

export type Tier = "ordinary" | "fast" | "ultra";
export type Reading = "active" | "still" | "waiting" | "settled";
export type Motion = { active: boolean; tier: Tier; reading: Reading };

/** Speed from the applied tier only: a tier the process or its transcript
    reports. A launch-profile value, a requested switch, a refused one, the
    model's name or a role default never speeds a glyph up. */
function appliedTier(file: FileEntry | undefined): Tier {
  if (!file || file.engine !== "codex") return "ordinary";
  if ((file as FileEntry & { serviceTierSource?: TierSource }).serviceTierSource !== "native") return "ordinary";
  if (file.serviceTier === "priority") return "fast";
  if (file.serviceTier === "ultrafast") return "ultra";
  return "ordinary";
}

/**
 * A glyph moves only when its stage's agent is at work: the chip is running or
 * reviewing, the lane is not paused, and the attempt's conversation is one the
 * board already counts as working (`isWorkingAgent`, through
 * `workingStageConversations`); or the settled stage's conversation works
 * again (rework). Everything else holds still: a stage before its agent
 * exists reads as waiting, a live chip whose agent is not working keeps its
 * colour without motion or halo.
 */
function motionOf(pipeline: Pipeline, files: readonly FileEntry[], now: number): Map<string, Motion> {
  const working = workingStageConversations([pipeline], files, now);
  const views = stageViews(pipeline, new Map(), working);
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const motions = new Map<string, Motion>();
  for (const stage of pipeline.stages as PipelineStage[]) {
    const view = views.get(stage.id)!;
    const attempt = latestAttempt(pipeline, stage.id);
    const path = attempt?.agentPath ?? null;
    const paused = pipeline.state === "paused";
    const live = (view.state === "running" || view.state === "reviewing") && !!path && working.has(path);
    const active = !paused && (live || view.rework);
    const glyph = GLYPH_STATE[view.state];
    const reading: Reading = active ? "active"
      : glyph !== "running" ? (glyph === "waiting" ? "waiting" : "settled")
      : paused || !attempt || attempt.state === "pending" || attempt.state === "spawning" ? "waiting" : "still";
    motions.set(stage.id, { active, tier: active && path ? appliedTier(byPath.get(path)) : "ordinary", reading });
  }
  return motions;
}

/* ---------- the board, kept up to date ---------- */

let files = FILES;
let pipelines = PIPELINES;
let motions = new Map<string, Map<string, Motion>>();
function recompute() {
  motions = new Map(pipelines.map((pipeline) => [pipeline.id, motionOf(pipeline, files, NOW)] as const));
}
recompute();

/** Writes each glyph's motion onto it; touches an attribute only when its value changes. */
function annotate() {
  for (const glyph of document.querySelectorAll<HTMLElement>(".mglyph")) {
    const stageId = glyph.closest<HTMLElement>("[data-stage]")?.dataset.stage
      ?? glyph.closest<HTMLElement>("[data-stage-open]")?.dataset.stageOpen;
    const card = glyph.closest<HTMLElement>("[data-kanban-card], [data-phone-card]");
    const taskId = (card?.dataset.kanbanCard ?? card?.dataset.phoneCard ?? "").replace(/^task:/, "");
    const pipeline = LANE_BY_TASK.get(taskId);
    const motion = pipeline && stageId ? motions.get(pipeline.id)?.get(stageId) : undefined;
    const want: Record<string, string> = motion
      ? { protoActive: motion.active ? "1" : "0", protoTier: motion.tier, protoReading: motion.reading, protoCase: `${taskId}:${stageId}` }
      : { protoActive: "", protoTier: "", protoReading: "", protoCase: "" };
    for (const [key, value] of Object.entries(want)) {
      if (!value) { if (key in glyph.dataset) delete glyph.dataset[key]; }
      else if (glyph.dataset[key] !== value) glyph.dataset[key] = value;
    }
  }
}
let scheduled = false;
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; annotate(); });
});
observer.observe(document.documentElement, { childList: true, subtree: true });

/* What the driver reads: each case's expectation and the rule's answer. */
(window as unknown as { __proto: unknown }).__proto = {
  variant: VARIANT,
  cases: () => CASES.map((spec) => ({
    id: spec.id,
    expect: spec.expect,
    rule: Object.fromEntries([...(motions.get(`p-${spec.id}`) ?? new Map<string, Motion>())]),
  })),
  ticks: () => ticks,
};

/** One routine refresh: the working transcripts grew, the lanes were re-read. */
let ticks = 0;
function tick() {
  ticks += 1;
  files = files.map((file) => (file.activity === "live" ? { ...file, size: file.size + 512, mtime: NOW - (ticks % 2) } : file));
  pipelines = pipelines.map((pipeline) => ({ ...pipeline, updatedAt: new Date(NOW_MS - (ticks % 2) * 1_000).toISOString() }));
  recompute();
  window.dispatchEvent(new Event("llv:files-changed"));
  window.dispatchEvent(new Event("llv:pipelines-changed"));
}

function useBoard() {
  const [state, setState] = useState({ files, pipelines });
  useEffect(() => {
    if (params.get("updates") === "0") return;
    const timer = setInterval(() => { tick(); setState({ files, pipelines }); }, 2_000);
    return () => clearInterval(timer);
  }, []);
  return state;
}

/* The opened card on the desktop: the lane with three stages, one of them
   reworking, drawn as its graph. Each control is pressed once: a second press
   before the board redraws would fold it again. */
const OPEN_CARD = "t-rework";
const OPEN_PRESSES = [
  `[data-kanban-card="task:${OPEN_CARD}"] button.icon-btn.fold[aria-expanded="false"]`,
  `[data-kanban-card="task:${OPEN_CARD}"] button[data-graph-toggle="p-${OPEN_CARD}"][aria-pressed="false"]`,
];
function useOpenCard() {
  useEffect(() => {
    if (PHONE) return;
    const pressed = new Set<string>();
    const press = () => {
      for (const selector of OPEN_PRESSES) {
        if (pressed.has(selector)) continue;
        const button = document.querySelector<HTMLElement>(selector);
        if (!button) return;
        pressed.add(selector);
        button.click();
        return;
      }
      watch.disconnect();
    };
    const watch = new MutationObserver(press);
    watch.observe(document.body, { childList: true, subtree: true });
    press();
    const stop = setTimeout(() => watch.disconnect(), 8_000);
    return () => { clearTimeout(stop); watch.disconnect(); };
  }, []);
}

function DesktopScreen() {
  const board = useBoard();
  useOpenCard();
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas text-primary" data-proto-screen="desktop">
      <KanbanBoard
        project={PROJECT}
        groups={[]}
        manual={[]}
        files={board.files}
        flows={[]}
        pipelines={board.pipelines}
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
  const board = useBoard();
  const noop = () => undefined;
  return (
    <div className="relative flex min-h-0 min-w-0 max-w-[100dvw] flex-1 flex-col overflow-hidden bg-canvas text-primary" data-proto-screen="phone">
      <MobileKanban
        project={PROJECT}
        groups={[]}
        manual={[]}
        files={board.files}
        flows={[]}
        pipelines={board.pipelines}
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
  0: L("Today: every live stage moves, Sol turns once in 14\u00a0s, Astra breathes", "Як зараз: рухається кожен живий етап, Sol обертається раз на 14\u00a0с, Astra дихає"),
  A: L("Only working agents turn: ordinary\u00a04\u00a0s · fast\u00a02\u00a0s · ultra\u00a01\u00a0s", "Обертаються лише агенти в роботі: звичайна\u00a04\u00a0с · fast\u00a02\u00a0с · ultra\u00a01\u00a0с"),
  B: L("Only working agents turn: ordinary\u00a04\u00a0s · fast\u00a02\u00a0s · ultra\u00a00.5\u00a0s", "Обертаються лише агенти в роботі: звичайна\u00a04\u00a0с · fast\u00a02\u00a0с · ultra\u00a00,5\u00a0с"),
};

function Frame({ children }: { children: ReactNode }) {
  const number = useMemo(() => (VARIANT === "0" ? L("Today", "Зараз") : L(`Variant ${VARIANT}`, `Варіант ${VARIANT}`)), []);
  return (
    <div className={`flex ${PHONE ? "min-h-dvh" : "h-dvh"} min-h-0 flex-col`} data-proto-variant={VARIANT}>
      {/* The variant's name and timing, printed on every frame; the product draws no such band. */}
      <header data-proto-header="" className="flex min-h-6 items-center gap-2 border-b border-border bg-sunken px-3 py-1.5 text-primary">
        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-label font-bold text-accent">{number}</span>
        <span className="min-w-0 flex-1 text-label [overflow-wrap:anywhere]" data-proto-variant-name="">{VARIANT_NAMES[VARIANT]}</span>
      </header>
      {children}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Frame>{PHONE ? <PhoneScreen /> : <DesktopScreen />}</Frame>);
