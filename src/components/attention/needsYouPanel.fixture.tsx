/*
 * The page the needs-you panel is rendered on (docs/design/needs-you-options.md,
 * option B): the real Viewer over an invented three-project board with every
 * needs-you reason and several roles, answered by an in-page fetch double. The
 * dismissal route is answered the way the server records it, so a row
 * dismissed on the panel, a question ticked in the report log, and Undo, all
 * survive the next poll here as they do in production. All data is invented.
 *
 *   ?lang=uk|en           the interface language (uk by default)
 *   &open=1               the panel open (it docks when the board has room)
 *   &placement=overlay    the panel floating over the board
 *   &seat=beside          the orchestrator seat open beside the board
 *   &overview=1           the Overview instead of the delegatus board
 */
import { createRoot } from "react-dom/client";

import { Viewer } from "@/components/Viewer";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { DismissalSubjectRequest } from "@/lib/attention/dismissalTypes";
import type { ReportLogEntry, ReportLogPage } from "@/lib/bridge/reportLog";
import { reportCardRefs } from "@/lib/bridge/reportCardRefs";
import type { Pipeline } from "@/lib/pipelines/types";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

const params = new URLSearchParams(location.search);
const OVERVIEW = params.has("overview");
const SEAT_BESIDE = params.get("seat") === "beside";
const LANG = params.get("lang") === "en" ? "en" : "uk";

/* A pinned clock, so every age on every frame reads the same. */
const now = Math.floor(Date.now() / 1000);
/* The driver writes its readings relative to this clock, so two runs commit the same file. */
(window as unknown as { __needsYouFixtureNow?: number }).__needsYouFixtureNow = now;
const iso = (secondsAgo: number) => new Date((now - secondsAgo) * 1_000).toISOString();
const MIN = 60;

const KEYS = { delegatus: "delegatus", shop: "shop-web", bot: "tg-bot" } as const;
const NAMES: Record<string, string> = { [KEYS.delegatus]: "delegatus", [KEYS.shop]: "shop-web", [KEYS.bot]: "tg-bot" };

let seq = 0;
const idOf = (path: string) => `conversation_${(path.split("/").pop() ?? "").replace(".jsonl", "")}`;
const files: FileEntry[] = [];
function conversation(project: string, title: string, over: Record<string, unknown> = {}): string {
  const path = `/repo/${NAMES[project]}-${++seq}.jsonl`;
  files.push({
    path, root: "claude-projects", name: path.split("/").pop(), project, title, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: now - 900, size: 2_048, activity: "idle", proc: null, pid: null, model: "claude-opus-5-5",
    pendingQuestion: null, waitingInput: null, conversationId: idOf(path), lastAgentWorkAt: (now - 900) * 1_000,
    ...over,
  } as unknown as FileEntry);
  return path;
}
const working = (ago: number) => ({ activity: "live", proc: "running", pid: 5_000 + seq, mtime: now - 20, lastTurn: { startedAt: (now - ago) * 1_000, endedAt: null }, lastAgentWorkAt: (now - 20) * 1_000 });
const role = (roleId: string) => ({ durableLineage: { kind: "spawn", role: roleId, memberships: [] } });

const pipelines: Pipeline[] = [];
const kanbanRole = (roleId: string) => ({ roleId, engine: "claude", access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: null });
interface Stage { id: string; state?: "passed" | "running" | "failed" | "needs_decision"; ago?: number; role?: string }
function lane(project: string, id: string, title: string, taskIds: string[], state: Pipeline["state"], stages: Stage[], over: Record<string, unknown> = {}): Pipeline {
  const runs: unknown[] = [];
  let cursor: unknown = null;
  for (const spec of stages) {
    if (!spec.state) continue;
    const ago = spec.ago ?? 900;
    const agentPath = conversation(project, `${title} · ${spec.id}`, spec.state === "running" ? working(ago) : { mtime: now - ago, lastAgentWorkAt: (now - ago) * 1_000 });
    const failing = spec.state === "failed" || spec.state === "needs_decision";
    runs.push({ stageId: spec.id, attempts: [{
      n: 1, state: spec.state, startedAt: iso(ago + 300), completedAt: spec.state === "running" ? null : iso(ago), agentPath, conversationId: idOf(agentPath),
      activatedBy: null, effectiveRole: kanbanRole(spec.role ?? "builder"),
      verdict: failing ? { status: "fail", findings: ["Ліміт рахує приховані задачі; смуга зникає раніше, ніж заповнюється."] } : spec.state === "passed" ? { status: "pass", findings: [] } : null,
    }] });
    if (spec.state === "running" || spec.state === "needs_decision") cursor = { stageId: spec.id, state: spec.state, input: null, activatedBy: null };
  }
  const pipeline = {
    id, task: title, taskIds, project, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `lane/${id}`, baseBranch: "main", baseRef: "main", lastPassedCommit: "",
    stages: stages.map((spec, index) => ({ id: spec.id, kind: "run", prompt: "", effectiveRole: kanbanRole(spec.role ?? "builder"), next: stages[index + 1]?.id ?? null })),
    runs, cursor, state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(14_400), closedAt: state === "completed" ? iso(1_200) : null,
    ...over,
  } as unknown as Pipeline;
  pipelines.push(pipeline);
  return pipeline;
}

const tasks: Array<Record<string, unknown>> = [];
const assign = (path: string) => ({ path, conversationId: idOf(path), panePid: null, state: "delivered", error: null, at: iso(3_600), engine: "claude" });
const task = (project: string, id: string, status: string, text: string, over: Record<string, unknown> = {}) => {
  tasks.push({ id, project, status, text, placement: "unplaced", board: "shown", assignments: [], createdAt: iso(3 * 86_400), updatedAt: iso(3_600), revision: `r-${id}-1`, ...over });
};

/* ── delegatus (the board on screen): rows 1–4 ─────────────────────────── */
const D = KEYS.delegatus;
/* The seat's open questions in the report log: each is its own row, the
   seat's role on it, and resolving one here or in the log resolves both. */
const seatDelegatus = conversation(D, "Оркестратор", { ...role("orchestrator"), mtime: now - 300 });
const SEAT_ASKS = [
  { id: "report-weekend-digest", at: iso(26 * MIN), seq: 1_202, body: "Слати нічний дайджест і у вихідні?" },
  { id: "report-merge-order", at: iso(9 * MIN), seq: 1_204, body: "Що зливаємо першим: ліміт задач чи перемикання розмов?" },
];
/* Row 1: a builder's structured question. */
const ask = conversation(D, "Чип Чекають: 2–3 варіанти", {
  ...role("builder"), activity: "idle", mtime: now - 4 * MIN, lastAgentWorkAt: (now - 4 * MIN) * 1_000,
  pendingQuestion: { kind: "question", toolUseId: "toolu-ask-1", transcriptPath: "", pid: null, paneTarget: null, askedAt: iso(4 * MIN),
    questions: [{ question: "Злити #2246 зараз чи після ревʼю?", header: "Злиття #2246", multiSelect: false, options: [] }] },
});
/* Row 2, `permission`: a structured host's tool request, answered inline. */
const permission = conversation(D, "Аудит задач дошки", {
  ...role("reviewer"), ...working(900), mtime: now - 11 * MIN,
  pendingPermission: { id: "request-audit-1", tool: "Bash", command: "rm -rf .next", reason: null, reasonType: "safetyCheck", since: iso(11 * MIN) },
});
/* Row 3, `ask` ("Asks you"): an architect whose turn ended asking the
   operator in prose; the line is its own sentence. */
const EXPORT_ASK_GIST = "Лишити окремі пресети для кожного формату чи звести все в одну кнопку «Експорт» з розширеними параметрами?";
const prose = conversation(D, "Експорт звітів у CSV і PDF", {
  ...role("architect"), activity: "idle", mtime: now - 14 * MIN, lastAgentWorkAt: (now - 14 * MIN) * 1_000,
  lastTurn: { startedAt: (now - 22 * MIN) * 1_000, endedAt: (now - 14 * MIN) * 1_000 }, lastAssistantMessageAt: (now - 14 * MIN) * 1_000,
});
const proseFile = files.find((entry) => entry.path === prose)!;
proseFile.operatorAsk = { id: `ask:${proseFile.conversationId}:claude:msg-export-1`, messageAt: (now - 14 * MIN) * 1_000, gist: EXPORT_ASK_GIST };
(window as unknown as { __needsYouFixtureAsk?: { id: string; gist: string } }).__needsYouFixtureAsk = { id: proseFile.operatorAsk.id, gist: EXPORT_ASK_GIST };
task(D, "t-chip", "assigned", "Чип Чекають: 2–3 варіанти", { assignments: [assign(ask)], color: "amber", icon: "bell" });
task(D, "t-export", "assigned", "Експорт звітів у CSV і PDF", { assignments: [assign(prose)], color: "violet", icon: "file-search" });
task(D, "t-audit", "assigned", "Аудит задач дошки", { assignments: [assign(permission)], color: "sky", icon: "list-checks" });
/* Row 4, `lane-decision`. */
lane(D, "lane-limit", "Ліміт видимих задач", ["t-limit"], "needs_decision", [
  { id: "implement", state: "passed", ago: 3_000 }, { id: "review", state: "needs_decision", ago: 32 * MIN, role: "reviewer" },
]);
task(D, "t-limit", "assigned", "Ліміт видимих задач", { color: "violet", icon: "gauge" });
lane(D, "lane-switch", "Швидке перемикання розмов", ["t-switch"], "running", [
  { id: "implement", state: "passed", ago: 2_400 }, { id: "review", state: "running", ago: 420, role: "reviewer" },
]);
task(D, "t-switch", "assigned", "Швидке перемикання розмов", { color: "teal", icon: "zap" });
const voice = conversation(D, "Голосові повідомлення в композері", { ...role("builder"), ...working(1_300) });
task(D, "t-voice", "assigned", "Голосові повідомлення в композері", { assignments: [assign(voice)], color: "lime", icon: "mic" });
lane(D, "lane-favicon", "Favicon з емблемою Delegatus", ["t-favicon"], "completed", [
  { id: "implement", state: "passed", ago: 7_200 }, { id: "review", state: "passed", ago: 5_400, role: "reviewer" },
]);
task(D, "t-favicon", "done", "Favicon з емблемою Delegatus", { icon: "image" });
task(D, "t-tray", "inbox", "Прибрати порожній лоток прихованих", { updatedAt: iso(5 * 3_600) });
task(D, "t-quota", "inbox", "Витрачати квоту до скидання вікна", { updatedAt: iso(2 * 86_400) });
task(D, "t-digest-weekend", "inbox", "Нічний дайджест пропускає вихідні", { updatedAt: iso(86_400) });
task(D, "t-seat", "assigned", "Оркестратор delegatus", { assignments: [assign(seatDelegatus)], icon: "compass" });

/* ── shop-web: rows 5–6 ────────────────────────────────────────────────── */
const S = KEYS.shop;
/* Row 5, `decision`: the orchestrator's open bridge ask. */
const shopAsk = { id: "report-shop-limit", at: iso(60 * MIN), seq: 1_190, body: "Підняти ліміт вкладень до 100 МБ чи лишити 25?" };
const seatShop = conversation(S, "Оркестратор", { ...role("orchestrator"), mtime: now - 3_600, bridgeAsks: [shopAsk], bridgeAsk: shopAsk });
task(S, "t-shop-seat", "assigned", "Оркестратор shop-web", { assignments: [assign(seatShop)] });
/* Row 6, `plan`: an architect's plan approval. */
const plan = conversation(S, "Пошук по каталогу", {
  ...role("architect"), activity: "idle", mtime: now - 18 * MIN,
  pendingQuestion: { kind: "plan", toolUseId: "toolu-plan-1", transcriptPath: "", pid: null, paneTarget: null, askedAt: iso(18 * MIN), questions: [] },
});
task(S, "t-catalog", "assigned", "Пошук по каталогу", { assignments: [assign(plan)] });

/* ── tg-bot: rows 7–8 ──────────────────────────────────────────────────── */
const B = KEYS.bot;
/* Row 7, `lane-review`: the review budget spent on implement. */
lane(B, "lane-digest", "Щоденний дайджест", ["t-digest"], "needs_review", [
  { id: "implement", state: "passed", ago: 2 * 3_600 }, { id: "review", state: "failed", ago: 2 * 3_600 - 60, role: "reviewer" },
], { cursor: { stageId: "implement", state: "reviewing", input: null, activatedBy: null } });
task(B, "t-digest", "assigned", "Щоденний дайджест");
/* Row 8, `delivery`: a message held for 41 minutes, to a verifier. */
const owed = conversation(B, "Перевірка #88 на стейджі", { ...role("verifier"), ...working(3_000), stuckDelivery: { since: iso(41 * MIN), attempts: 2, state: "held" } });
task(B, "t-merge88", "assigned", "Мердж #88", { assignments: [assign(owed)] });

/* ── the report log beside delegatus's seat: two open questions (the two
   needs-you rows above), one the operator already resolved, and the rest of
   the log around them ── */
const seatFile = files.find((entry) => entry.path === seatDelegatus)!;
const REPORTS: Array<Omit<ReportLogEntry, "cards">> = [
  { seq: 1_204, at: iso(9 * MIN), class: "question", body: "Що зливаємо першим: ліміт задач чи перемикання розмов?" },
  { seq: 1_203, at: iso(20 * MIN), class: "review_verdict", body: "Ревʼю, раунд 2 на #2244: APPROVE. Ліміт смуг рахує лише показані задачі; одне P3 лишив як #2247." },
  { seq: 1_202, at: iso(26 * MIN), class: "blocked", body: "Слати нічний дайджест і у вихідні?" },
  { seq: 1_201, at: iso(70 * MIN), class: "question", body: "Лишити вебхук Telegram на старому домені до понеділка?" },
  { seq: 1_200, at: iso(95 * MIN), class: "status", body: "Три лейни працюють: перемикання розмов (ревʼю, раунд 1), голосові (білд), ліміт задач (чекає вашого рішення)." },
];
const resolvedQuestions = new Map<number, string>([[1_201, iso(64 * MIN)]]);
const knownCards = new Map<string, "task" | "pipeline">([...tasks.map((row) => [String(row.id), "task"] as const), ...pipelines.map((row) => [row.id, "pipeline"] as const)]);
function reportPage(): ReportLogPage {
  const open = (seatFile.bridgeAsks ?? []).map((entry) => entry.seq!).filter((seq) => !resolvedQuestions.has(seq));
  return {
    ok: true, project: D, bridgeReports: true, github: "example/delegatus",
    revision: `fixture:${open.join(",")}:${[...resolvedQuestions.keys()].join(",")}`,
    entries: REPORTS.map((entry) => ({ ...entry, cards: reportCardRefs(entry.body, knownCards) })), nextBefore: null,
    /* The Viewer's own line for the architect's ask, by time among the reports. */
    asks: proseFile.attentionDismissal ? [] : [{ id: proseFile.operatorAsk!.id, at: iso(14 * MIN), conversationId: proseFile.conversationId ?? null, path: prose, role: "architect", title: proseFile.title, gist: EXPORT_ASK_GIST }],
    nextAsksBefore: null,
    questions: { open, resolved: [...resolvedQuestions].map(([seq, at]) => ({ seq, at })) },
  };
}
seatFile.bridgeAsks = SEAT_ASKS;
seatFile.bridgeAsk = SEAT_ASKS.at(-1)!;
/* The operator last looked at the log before the two newest entries. */
try { localStorage.setItem(`llvReportLogSeen:${D}`, "1202"); } catch { /* private mode */ }

/* The dismissal route, recorded the way the server records it: a
   conversation's reason on its entry, a lane's instant on the lane, a
   question's resolution in the report log, which takes it off its seat. */
const allAsks = new Map<number, { file: FileEntry; ask: NonNullable<FileEntry["bridgeAsk"]> }>();
for (const entry of files) for (const ask of entry.bridgeAsks ?? []) allAsks.set(ask.seq!, { file: entry, ask });
function dismiss(subjects: DismissalSubjectRequest[], undo: boolean): unknown[] {
  const at = new Date().toISOString();
  const by = { kind: "operator", surface: innerWidth < 768 ? "phone" : "desktop" } as const;
  const done: unknown[] = [];
  for (const subject of subjects) {
    if (subject.kind === "report") {
      const held = allAsks.get(subject.seq);
      if (!held) continue;
      const asks = held.file.bridgeAsks ?? [];
      if (undo) {
        resolvedQuestions.delete(subject.seq);
        if (!asks.some((entry) => entry.seq === subject.seq)) held.file.bridgeAsks = [...asks, held.ask].sort((a, b) => a.seq! - b.seq!);
      } else {
        resolvedQuestions.set(subject.seq, at);
        held.file.bridgeAsks = asks.filter((entry) => entry.seq !== subject.seq);
      }
      held.file.bridgeAsk = held.file.bridgeAsks!.at(-1) ?? null;
      done.push({ kind: "report", seq: subject.seq });
    } else if (subject.kind === "pipeline") {
      const target = pipelines.find((entry) => entry.id === subject.pipelineId);
      if (!target) continue;
      Object.assign(target, undo ? { dismissedAt: null, dismissedBy: null } : { dismissedAt: at, dismissedBy: by });
      done.push({ kind: "pipeline", pipelineId: subject.pipelineId });
    } else {
      const target = files.find((entry) => entry.path === subject.path);
      if (!target) continue;
      if (undo) delete target.attentionDismissal;
      else target.attentionDismissal = { at, by, reasonId: subject.reasonId ?? null };
      done.push({ kind: "conversation", conversationId: target.conversationId });
    }
  }
  return done;
}

let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: "scheme", desktopBoard: "kanban", taskPanelOpen: false },
} as unknown as BoardProjectStateV1;

const seats: Record<string, string> = { [D]: seatDelegatus, [S]: seatShop };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const serverFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/task-icons") return serverFetch(url.pathname + url.search);
  if (url.pathname === "/api/files") {
    return json({
      files, projectCatalog: Object.values(KEYS).map((project) => ({ project, conversations: files.filter((entry) => entry.project === project).length, smt: now - 20 })),
      projectDisplayNames: NAMES, flows: [], pipelines, workflows: [], tasks, workLinks: { pipelines: {}, tasks: {} }, systemHealth: { tmux: { status: "healthy" } },
    });
  }
  if (url.pathname === "/api/tasks" && method === "GET") return json({ tasks });
  if (url.pathname === "/api/board") {
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { mutations?: BoardMutationV1[] };
      const reduced = applyBoardMutations(board, body.mutations ?? []);
      board = { ...reduced, schemaVersion: 1, revision: board.revision + 1, pathAliases: reduced.pathAliases ?? {} } as BoardProjectStateV1;
      return json({ ok: true, applied: true, board });
    }
    return json({ ok: true, board });
  }
  if (url.pathname === "/api/orchestrator/reports") return json(url.searchParams.get("project") === D ? reportPage() : { ...reportPage(), project: url.searchParams.get("project"), entries: [], questions: { open: [], resolved: [] } });
  if (url.pathname === "/api/attention/dismissals" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { target: { kind: "subjects"; subjects: DismissalSubjectRequest[] } | DismissalSubjectRequest; undo?: boolean };
    const subjects = body.target.kind === "subjects" ? body.target.subjects : [body.target];
    const dismissed = dismiss(subjects, body.undo === true);
    return json({ ok: true, dismissed, alreadyClear: [], changed: [], at: new Date().toISOString(), by: { kind: "operator" }, undo: body.undo === true });
  }
  if (url.pathname === "/api/projects/settings") {
    return json({ ok: true, project: url.searchParams.get("project") ?? D, mergeOnReview: { enabled: true, changedAt: iso(86_400), changedBy: "operator" }, bridgeReports: { enabled: true, changedAt: iso(86_400), changedBy: "operator" }, github: "example/delegatus" });
  }
  if (url.pathname === "/api/orchestrator/seat") {
    if (url.searchParams.get("scope") === "all") {
      const all = Object.values(seats);
      return json({ all: { conversationIds: all.map(idOf), paths: all, previous: { conversationIds: [], paths: [] } } });
    }
    const project = url.searchParams.get("project") ?? D;
    const path = seats[project];
    if (!path) return json({ seat: null, pending: null, exists: true });
    return json({
      seat: { project, seatEpoch: 1, conversationId: idOf(path), path, mandate: "Вести дошку.", state: "active", designatedAt: iso(86_400), intent: { clientRequestId: `seat-${project}`, mode: "existing", launchId: null, error: null } },
      pending: null, exists: true,
    });
  }
  if (url.pathname === "/api/conversations") return json({ items: [], total: 0, nextCursor: null });
  if (url.pathname === "/api/runtime/snapshot") return json({ code: RUNTIME_PLANE_ABSENT }, 503);
  if (url.pathname === "/api/attention") return json({ ok: true, rootId: "root-fixture", offer: null, live: [], expired: [], records: null, notices: [] });
  if (url.pathname === "/api/logs" && method === "POST") {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { reqs?: Array<{ id: string }> };
    return json({ chunks: Object.fromEntries((asked.reqs ?? []).map((_, index) => [String(index), { offset: 0, start: 0, size: 0, data: "" }])) });
  }
  if (url.pathname === "/api/accounts") return json({ claude: { active: "main", accounts: [{ id: "main", label: "main", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null }], migration: null, autoBalance: null }, codex: { active: "", accounts: [], migration: null, autoBalance: null } });
  if (url.pathname === "/api/telegram") return json({ telegram: { phase: "disconnected", login: null, identity: null, credentialRef: null, lastHealthCheckAt: null, error: null, credentialsConfigured: true } });
  if (url.pathname === "/api/telegram/bot") return json({ bot: { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] } });
  if (params.has("debug")) console.log("unanswered", method, url.pathname + url.search);
  return json({}, 404);
}) as typeof fetch;

try {
  localStorage.setItem("llv_lang", LANG);
  if (params.has("open")) localStorage.setItem("llvNeedsYouPanel", "open");
  if (params.get("placement") === "overlay") localStorage.setItem("llvNeedsYouPlacement", "overlay");
  localStorage.setItem("llvProject", OVERVIEW ? "__overview__" : D);
  /* The seat folded on top (§4: "seat collapsed"), or open at the side for B's width frame. */
  localStorage.setItem("llv:kanban-seat:v2", JSON.stringify({ height: null, collapsed: { [D]: !SEAT_BESIDE }, placement: SEAT_BESIDE ? "side" : "top", width: null, topWidths: {}, sideWidths: {}, heightV: 2 }));
} catch { /* private mode */ }
if (!OVERVIEW && !location.hash) location.hash = `#p=${D}`;

createRoot(document.getElementById("root")!).render(<Viewer />);
document.body.setAttribute("data-needs-you-fixture-ready", "");
