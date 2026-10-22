import "./frameSession";

import { createRoot } from "react-dom/client";

import { predictedRules } from "@/components/roleMemory/LearnedRules";
import { Viewer } from "@/components/Viewer";
import { reportCardRefs } from "@/lib/bridge/reportCardRefs";
import { setLocale, translate, type MessageKey } from "@/lib/i18n";
import { navigateToFragment } from "@/lib/navigation/fragmentNavigation";
import { SNIPPET_MATCH_CLOSE, SNIPPET_MATCH_OPEN } from "@/lib/search/snippet";

import {
  askedLine, buildAutonomy, buildLessons, buildLimitsHistory, buildProfile, buildRoleMemory, buildTaskSpend, buildWorld, curatorPasses,
  LAST_STEP, PROJECT, RULE_IDS, saidLine, type Lang, type World,
} from "./world";
import TASK_ICONS from "./taskIcons.json";

/*
 * The landing page's live demo: the real Delegatus Viewer, bundled for the
 * browser, with every request it makes answered here from the invented
 * harbor-api world in ./world.ts. Nothing leaves the page.
 *
 * The landing embeds this page in an iframe and drives it by message:
 *   → { type: "dlg:step", step }   jump to a step (a backward jump reloads)
 *   → { type: "dlg:play" }         run the rest of the script from here
 *   → { type: "dlg:view", view }   press the product's own control for a view
 * `autonomy=1` in the query turns the orchestrator's full autonomy on for this
 * frame alone (./world.ts).
 *   ← { type: "dlg:state", step, lang, playing }  after every change
 *   ← { type: "dlg:lang", lang }   the visitor switched language inside the product
 * The visitor's own send of the prepared request in the orchestrator's
 * composer starts the script. Anything else the visitor sends is theirs: it
 * shows in the chat as they wrote it, and the agent answers that it runs a
 * script here.
 */

const params = new URLSearchParams(location.search);
const LANG: Lang = params.get("lang") === "uk" ? "uk" : "en";
const PHONE = params.get("phone") === "1";
const AUTONOMY = params.get("autonomy") === "1";
const START = Math.max(0, Math.min(LAST_STEP, Number(params.get("step") ?? 0) || 0));

/* How long each step waits after the one before it, once the visitor sent. */
const FIRST_REPLY_MS = 650;
const STEP_DELAY_MS = [0, 0, FIRST_REPLY_MS, 5200, 5200, 4600];
/* The composer keeps its copy of a delivered message until the transcript
   moves this far past the delivery (OUTBOX_MTIME_GRACE_MS, 2 s), so the
   orchestrator's answer is always dated at least this long after the send. */
const ANSWER_AFTER_SEND_S = 2.5;

/* What the visitor sent beyond the script, kept for the life of the frame and
   written into each world the script builds, in time order. */
interface Aside { path: string; model: string; sentMs: number; text: string; reply: string | null }
const asides: Aside[] = [];

const boot = Math.floor(Date.now() / 1000);
/* When each step arrived, in seconds to the millisecond. A page opened on a
   later step dates the earlier ones a little apart. */
const stepSeconds: number[] = [];
for (let s = 1; s <= START; s += 1) stepSeconds[s] = boot - (START - s + 1) * 40;
let step = START;
let world: World = buildWorld(step, LANG, boot, stepSeconds, AUTONOMY);
let playing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let filesRevision = 1;

function post(message: Record<string, unknown>) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}

function announce() {
  document.documentElement.dataset.demoStep = String(step);
  post({ type: "dlg:state", step, lang: LANG, playing, nextInMs: playing ? STEP_DELAY_MS[step + 1] ?? 0 : 0 });
}

function advance(to: number) {
  if (to <= step) return;
  for (let s = step + 1; s <= to; s += 1) {
    stepSeconds[s] = Date.now() / 1000 - (to - s);
    if (s === 2 && stepSeconds[1] !== undefined) stepSeconds[2] = Math.max(stepSeconds[2], stepSeconds[1] + ANSWER_AFTER_SEND_S);
  }
  step = to;
  refresh();
  if (step >= LAST_STEP) playing = false;
  announce();
}

function withAsides(built: World): World {
  for (const file of built.files) {
    const own = asides.filter((aside) => aside.path === file.path);
    if (!own.length) continue;
    const lines = (built.transcripts.get(file.path) ?? "").split("\n").filter(Boolean);
    const stamp = (raw: string) => Date.parse((JSON.parse(raw) as { timestamp: string }).timestamp);
    const insert = (atMs: number, raw: string) => {
      const before = lines.findIndex((existing) => stamp(existing) > atMs);
      lines.splice(before < 0 ? lines.length : before, 0, raw);
    };
    let latestMs = 0;
    for (const aside of own) {
      insert(aside.sentMs, askedLine(new Date(aside.sentMs).toISOString(), aside.text));
      latestMs = Math.max(latestMs, aside.sentMs);
      if (aside.reply === null) continue;
      const repliedMs = aside.sentMs + ANSWER_AFTER_SEND_S * 1000;
      insert(repliedMs, saidLine(new Date(repliedMs).toISOString(), aside.reply, aside.model));
      latestMs = Math.max(latestMs, repliedMs);
    }
    const body = `${lines.join("\n")}\n`;
    built.transcripts.set(file.path, body);
    const entry = file as unknown as { size: number; mtime: number };
    entry.size = new TextEncoder().encode(body).length;
    entry.mtime = Math.max(entry.mtime, Math.floor(latestMs / 1000));
  }
  return built;
}
function refresh() {
  world = withAsides(buildWorld(step, LANG, boot, stepSeconds, AUTONOMY));
  filesRevision += 1;
  for (const stream of runtimeStreams) stream.filesChanged();
  for (const stream of logStreams) stream.logsChanged();
  // The invented world is already complete; wake the board immediately.
  window.dispatchEvent(new Event("llv:files-changed"));
}
/** Takes a message the script has no part for: it lands as sent, and its agent answers in its own voice. */
function offScript(conversationId: unknown, text: string, atMs: number) {
  const file = world.files.find((entry) => entry.conversationId === conversationId);
  if (!file) return;
  const toSeat = conversationId === world.seat.conversationId;
  const aside: Aside = { path: file.path, model: file.model ?? "claude-opus-5-5", sentMs: atMs, text, reply: null };
  asides.push(aside);
  refresh();
  setTimeout(() => {
    aside.reply = toSeat && step === 0
      ? L("This demo plays a script, so I can't run that one. Send the request waiting in the composer and I'll show you the rest.",
        "Це демо грає за сценарієм, тож цього я не виконаю. Надішли запит, що чекає в полі вводу, і я покажу решту.")
      : L("This demo plays a script, so I can't act on that here. Install Delegatus and I will.",
        "Це демо грає за сценарієм, тож тут я цього не виконаю. Встанови Delegatus, і виконаю.");
    refresh();
    if (toSeat && step === 0) setTimeout(() => prefill(true), 400);
  }, FIRST_REPLY_MS);
}

function play() {
  if (timer) clearTimeout(timer);
  playing = step < LAST_STEP;
  announce();
  const next = () => {
    if (step >= LAST_STEP) return;
    timer = setTimeout(() => {
      advance(step + 1);
      next();
    }, STEP_DELAY_MS[step + 1] ?? 4000);
  };
  next();
}

function jump(to: number) {
  if (to < step) {
    const url = new URL(location.href);
    url.searchParams.set("step", String(to));
    location.replace(url);
    return;
  }
  if (timer) clearTimeout(timer);
  playing = false;
  advance(to);
  announce();
}

/* ── the answers ──────────────────────────────────────────────────────── */

/* The learned rules as this frame keeps them: a visitor's ×, Undo, Return or
   Undo pass changes this copy, and every later read answers it. */
let rules = buildRoleMemory(LANG, boot);
/* The window's pass history is a 128 px box that scrolls. On a phone two passes and their buttons
   overflow it, so the phone lists the latest pass alone and none sits half under the box's edge. */
if (PHONE && rules.curation) rules = { ...rules, curation: { ...rules.curation, passes: rules.curation.passes.slice(0, 1) } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);
const resetIn = (minutes: number) => now() + minutes * 60;
const L = (en: string, uk: string) => (LANG === "uk" ? uk : en);

function accountRow(id: string, label: string, plan: string, used: number, resetsInMinutes: number, weekly: number) {
  return {
    id, label, kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null,
    auth: { state: "authenticated", plan },
    limits: { state: "fresh", checkedAt: new Date().toISOString(), session: { usedPercent: used, resetsAt: resetIn(resetsInMinutes), windowMinutes: 300 }, weekly: { usedPercent: weekly, resetsAt: resetIn(3 * 24 * 60), windowMinutes: 10_080 } },
  };
}
function accounts() {
  return {
    claude: {
      active: "main",
      accounts: [accountRow("main", L("Main", "Основний"), "Max", 42, 140, 31), accountRow("work", L("Work", "Робочий"), "Max", 18, 200, 12), accountRow("side", L("Side", "Запасний"), "Pro", 71, 95, 64), accountRow("team", L("Team", "Командний"), "Team", 54, 60, 47)],
      mutationLocked: false, migration: null, autoBalance: null,
    },
    codex: {
      active: "main",
      accounts: [accountRow("main", L("Main", "Основний"), "Pro", 35, 170, 22), accountRow("spare", L("Spare", "Запасний"), "Plus", 8, 230, 5)],
      mutationLocked: false, migration: null, autoBalance: null,
    },
    copilot: { active: "", accounts: [], migration: null, autoBalance: null },
  };
}

function runtimeSnapshot() {
  return {
    schemaVersion: 1, snapshotSeq: filesRevision, retentionFloorSeq: 0, structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ready" }, filesRevision,
    sessions: world.files.filter((file) => file.project === PROJECT).map((file) => {
      const busy = (file as unknown as { activity?: string }).activity === "live";
      return {
        conversationId: file.conversationId, sessionKey: { engine: file.engine, sessionId: `${file.name}-session` }, hostKind: file.engine === "codex" ? "codex-app-server" : "claude-broker", host: "hosted",
        turn: busy ? "running" : "idle", provenance: "structured", revision: filesRevision, attentionIds: [], recentReceipts: [], accountId: "main",
        parentConversationId: null, flowId: null, workflowId: null, cwd: `/work/${PROJECT}`, artifactPath: file.path,
        capabilities: { steer: true, structuredAttention: true, imageInput: { supported: true } }, activeTurnId: busy ? `turn-${file.name}` : null, pendingReconfigure: null,
      };
    }),
    attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
  };
}

let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: "scheme", desktopBoard: "kanban", taskPanelOpen: false },
};

/* The Viewer's streams. The runtime stream opens and carries a files
   revision whenever the script moves. Transcript chunks arrive on the log
   stream immediately, rather than simulating an outage and a 1.2 s poll. */
type Listener = (event: { data: string }) => void;
const runtimeStreams = new Set<DemoEventSource>();
const logStreams = new Set<DemoEventSource>();
let streamSeq = 1000;
class DemoEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private beat: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Array<{ id: string; path: string; offset: number }> = [];
  constructor(url: string | URL) {
    const target = String(url);
    if (target.startsWith("/api/runtime/stream")) {
      runtimeStreams.add(this);
      setTimeout(() => this.onopen?.(new Event("open")), 0);
      this.beat = setInterval(() => this.emit("heartbeat", ""), 10_000);
    } else if (target.startsWith("/api/logs/stream")) {
      this.subscriptions = JSON.parse(new URL(target, location.origin).searchParams.get("subs") ?? "[]");
      logStreams.add(this);
      setTimeout(() => { if (logStreams.has(this)) this.logsChanged(); }, 0);
    }
  }
  emit(name: string, data: string) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data });
  }
  logsChanged() {
    for (const sub of this.subscriptions) {
      const bytes = new TextEncoder().encode(world.transcripts.get(sub.path) ?? "");
      const start = Math.min(sub.offset, bytes.length);
      this.emit("chunk", JSON.stringify({ id: sub.id, chunk: {
        data: new TextDecoder().decode(bytes.slice(start)), start, offset: bytes.length, size: bytes.length,
      } }));
      sub.offset = bytes.length;
    }
  }
  filesChanged() {
    streamSeq += 1;
    this.onmessage?.({ data: JSON.stringify({ schemaVersion: 1, seq: streamSeq, eventId: `demo-${streamSeq}`, scope: { kind: "system", id: "files" }, kind: "files.revision", payload: { filesRevision } }) });
  }
  addEventListener(name: string, listener: Listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: Listener) {
    this.listeners.get(name)?.delete(listener);
  }
  close() {
    runtimeStreams.delete(this);
    logStreams.delete(this);
    if (this.beat) clearInterval(this.beat);
  }
}
Object.assign(window, { EventSource: DemoEventSource });

const unanswered = new Set<string>();

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.origin);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const path = url.pathname;
  const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

  if (path === "/api/files") {
    const projects = [...new Set(world.files.map((file) => file.project))];
    return json({
      files: world.files,
      projectCatalog: projects.map((project) => {
        const own = world.files.filter((file) => file.project === project);
        return { project, conversations: own.length, smt: Math.max(...own.map((file) => file.mtime)) };
      }),
      projectCwds: Object.fromEntries(projects.map((project) => [project, `/work/${project}`])),
      flows: [], pipelines: world.pipelines, tasks: world.tasks, workflows: [], systemHealth: { tmux: { status: "healthy" } },
    });
  }
  if (path === "/api/task-icons") {
    const names = (url.searchParams.get("names") ?? "").split(",").filter(Boolean);
    return json({ icons: Object.fromEntries(names.filter((name) => name in TASK_ICONS).map((name) => [name, (TASK_ICONS as Record<string, unknown>)[name]])) });
  }
  if (path === "/api/tasks" && method === "GET") return json({ tasks: world.tasks });
  if (path === "/api/board") {
    if (method === "PATCH") {
      const { applyBoardMutations } = await import("@/lib/board/mutations");
      const reduced = applyBoardMutations(board as never, (body().mutations ?? []) as never);
      board = { ...(reduced as unknown as typeof board), schemaVersion: 1, revision: board.revision + 1, pathAliases: (reduced as { pathAliases?: object }).pathAliases ?? {} };
      return json({ ok: true, applied: true, board });
    }
    return json({ ok: true, board });
  }
  if (path === "/api/logs" && method === "POST") {
    const { reqs } = body() as { reqs: Array<{ id: string; path: string; offset: number }> };
    return json({ chunks: Object.fromEntries(reqs.map((req) => {
      const data = world.transcripts.get(req.path) ?? "";
      const bytes = new TextEncoder().encode(data);
      const from = Math.min(Math.max(req.offset, 0), bytes.length);
      return [req.id, { data: new TextDecoder().decode(bytes.slice(from)), start: from, offset: bytes.length, size: bytes.length }];
    })) });
  }
  if (path === "/api/log") return json({ data: "", start: 0, offset: 0, size: 0 });
  if (path === "/api/conversations") return json({ items: world.files, total: world.files.length, nextCursor: null });
  if (path === "/api/orchestrator/seat") {
    if (url.searchParams.get("scope") === "all") return json({ all: { conversationIds: [world.seat.conversationId], paths: [world.seat.path], previous: { conversationIds: [], paths: [] } } });
    return json({
      seat: {
        project: PROJECT, seatEpoch: 1, conversationId: world.seat.conversationId, path: world.seat.path, mandate: L("Keep harbor-api moving.", "Веди harbor-api далі."),
        promptVersion: null, predecessorConversationId: null, state: "active",
        intent: { clientRequestId: "seat-harbor", mode: "spawn", launchId: null, error: null }, designatedAt: new Date((boot - 6 * 3600) * 1000).toISOString(), activatedAt: new Date((boot - 6 * 3600) * 1000).toISOString(),
      },
      pending: null, exists: true, viewerMcpRegistered: true, previous: [],
    });
  }
  if (path === "/api/orchestrator/reports") {
    const known = new Map<string, "task" | "pipeline">([...world.tasks.map((task) => [task.id, "task"] as const), ...world.pipelines.map((lane) => [lane.id, "pipeline"] as const)]);
    const entries = [...world.reports].reverse().map((entry) => ({ ...entry, cards: reportCardRefs(entry.body, known) }));
    const revision = `demo:${entries[0]?.seq ?? 0}`;
    const base = { ok: true, project: PROJECT, bridgeReports: true, github: null, revision };
    if (url.searchParams.get("since") === revision && !url.searchParams.get("before")) return json({ ...base, unchanged: true, entries: [], nextBefore: null });
    return json({ ...base, entries, nextBefore: null });
  }
  if (path === "/api/projects/settings") {
    return json({
      ok: true, project: PROJECT,
      mergeOnReview: { enabled: false, changedAt: null, changedBy: null },
      bridgeReports: { enabled: true, changedAt: null, changedBy: null },
      reportTelegram: null, reportDestination: null, postableChats: 0, reportFallbackName: null, reportNameSuggestion: "Harbor", github: null,
    });
  }
  if (path === "/api/runtime/snapshot") return json(runtimeSnapshot());
  if (path === "/api/runtime/send" && method === "POST") {
    const sent = body();
    let at = Date.now();
    const text = typeof sent.text === "string" ? sent.text : "";
    const same = (left: string, right: string) => left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
    if (sent.conversationId === world.seat.conversationId && step === 0 && same(text, world.request)) {
      advance(1);
      /* The transcript records the request at the very moment it was delivered. */
      at = Math.round(stepSeconds[1]! * 1000);
      play();
      settleSendControl();
    } else if (text.trim()) {
      offScript(sent.conversationId, text, at);
    }
    return json({ receipt: {
      operationId: `operation-demo-${at}`, idempotencyKey: sent.idempotencyKey, conversationId: sent.conversationId, kind: "send", status: "delivered",
      text: sent.text, at: new Date(at).toISOString(), revision: 1,
    } });
  }
  if (path === "/api/runtime/send") return json({ outcome: "not-executed" });
  if (path.startsWith("/api/pipelines/") && method === "GET") {
    const id = decodeURIComponent(path.split("/")[3] ?? "");
    const lane = world.pipelines.find((entry) => entry.id === id);
    return lane ? json({ ok: true, pipeline: lane, stageDigests: {} }) : json({ error: "pipeline not found" }, 404);
  }
  if (path.startsWith("/api/pipelines/")) return json({ error: L("This is a demo: nothing runs here.", "Це демо: тут нічого не запускається.") }, 409);
  if (path === "/api/accounts" && method === "GET") return json(accounts());
  if (path === "/api/account-project-bindings") return json({ project: PROJECT, projectName: PROJECT, bindings: [], engines: {} });
  if (path === "/api/limits") {
    return json({
      claude: { session: { usedPercent: 42, resetsAt: resetIn(140), windowMinutes: 300 }, weekly: { usedPercent: 31, resetsAt: resetIn(4320), windowMinutes: 10_080 }, plan: "max", capturedAt: now() },
      codex: { session: { usedPercent: 35, resetsAt: resetIn(170), windowMinutes: 300 }, weekly: { usedPercent: 22, resetsAt: resetIn(4320), windowMinutes: 10_080 }, plan: "pro", capturedAt: now() },
      claudeAccountId: "main", codexAccountId: "main",
      provenance: { claude: { source: "live", reason: null, staleSince: null }, codex: { source: "live", reason: null, staleSince: null } },
      staleSince: null,
    });
  }
  if (path.startsWith("/api/resources")) {
    return json({ system: { ramTotal: 32 * 1024 ** 3, ramAvailable: 14 * 1024 ** 3, swapTotal: 8 * 1024 ** 3, swapUsed: 0, capturedAt: new Date().toISOString() }, sessions: [] });
  }
  if (path === "/api/attention") return json({ ok: true, records: null, notices: [], rootId: "root-demo", offer: null, live: [], expired: [] });
  if (path === "/api/view/presence") return json({ ok: true });
  if (path === "/api/operator/settings") {
    if (method === "PUT") {
      const chosen = body().locale;
      if ((chosen === "en" || chosen === "uk") && chosen !== LANG) post({ type: "dlg:lang", lang: chosen });
      return json({ ok: true });
    }
    return json({ locale: { value: LANG, source: "chosen" }, timeZone: null });
  }
  if (path === "/api/onboarding") {
    return json({ marker: { schemaVersion: 1, completedAt: new Date((boot - 86_400) * 1000).toISOString(), dismissedAt: null, reason: null, steps: { engines: "done", project: "done" }, lastHealth: null, walk: "done" }, seatTickCheckMinutes: 10 });
  }
  if (path === "/api/monitor/seat-tick/settings") {
    if (method !== "GET") return json({ error: L("This is a demo: nothing runs here.", "Це демо: тут нічого не запускається.") }, 409);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const defaults = { project: PROJECT, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null };
    const episode = AUTONOMY ? buildAutonomy(LANG, boot, stepSeconds[LAST_STEP] ?? boot) : null;
    const settings = { ...defaults, ...(episode ? { autonomy: episode, updatedAt: episode.updatedAt, setBy: episode.setBy } : {}) };
    const [lastPass] = curatorPasses(boot);
    return json({
      project: PROJECT, changed: false, at: new Date().toISOString(), actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      settings, defaults, defaultWakeIntervalMinutes: 60, monitorPromptLength: 0, cardText: null,
      effective: { enabled: true, wakeIntervalMinutes: 60, reason: null, monitorPrompt: null, until: null, isDefault: true, configured: false, lapsed: false, updatedAt: null },
      policy: { checkIntervalMinutes: 5, staleAfterMinutes: 15, retryGuardWakes: 2 },
      state: { lastCheckAt: ago(3), lastWakeAt: ago(41), lastWakeReasons: ["interval"], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
      stateError: null, lastRun: null, lastDelivery: { at: ago(41), outcome: "landed" },
      autonomy: { active: episode !== null, until: episode?.until ?? null, startedAt: episode?.startedAt ?? null, episode },
      /* The curator's own block; its last pass is the one the learned rules window lists first. */
      curation: {
        enabled: true, intervalHours: 6, intervalMs: 6 * 3_600_000, defaultIntervalHours: 6, minIntervalHours: 1, maxIntervalHours: 168, updatedAt: null,
        live: null, lastRun: { ...lastPass!, conversationId: null }, nextRunAt: rules.curation?.nextAt ?? null, waitingOn: null, runsError: null,
      },
    });
  }
  /* The agent mapping the tick panel reads for board maintenance, which this world leaves off. */
  if (path === "/api/roles" && method === "GET") return json({ revision: "demo", roles: [], launchChoices: [] });
  if (path === "/api/task-spend") {
    const spend = buildTaskSpend(LANG);
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => id in spend);
    return json({ generatedAt: now(), tasks: Object.fromEntries(ids.map((id) => [id, spend[id]])) });
  }
  if (path === "/api/limits/history") return json(buildLimitsHistory(now()));
  if (path === "/api/role-memory/lessons") return json({ lessons: url.searchParams.get("project") === PROJECT ? buildLessons(step, LANG) : [] });
  if (path === "/api/role-memory/profile") {
    const profile = JSON.stringify(buildProfile(LANG, boot, rules));
    if (method === "POST") return new Response(`${profile}\n`, { headers: { "content-type": "application/x-ndjson" } });
    return new Response(profile, { headers: { "content-type": "application/json" } });
  }
  if (path === "/api/role-memory") {
    if (method === "POST") {
      const { action, ruleId } = body() as { action?: string; ruleId?: string };
      if (action === "revert-pass") {
        rules = { ...rules, curation: rules.curation && { ...rules.curation, passes: rules.curation.passes.map((pass) => (pass.id === ruleId ? { ...pass, revertedAt: new Date().toISOString() } : pass)) } };
      } else if ((action === "delete" || action === "restore" || action === "revert") && typeof ruleId === "string") {
        rules = predictedRules(rules, action, ruleId);
      }
      return json(rules);
    }
    return json(url.searchParams.get("project") === PROJECT ? rules : { project: url.searchParams.get("project"), enabled: true, scopes: [] });
  }
  if (path === "/api/tts/backend") return json({ error: "no speech in the demo" }, 503);
  if (path === "/api/transcribe/token") return json({ error: "no speech in the demo" }, 503);
  /* Settings the product reads on the way, each in its off state: nothing here sends telemetry, calls a voice model,
     classifies messages, shares a project or writes memory on the side. */
  if (path === "/api/telemetry") return json({ enabled: false, locked: false, noticeDismissed: true });
  if (path === "/api/memory/settings") return json({ enabled: false, capUsd: 5, spentUsd: 0 });
  if (path === "/api/asks-you") return json({ enabled: false, keySource: null, keyPath: "", month: new Date().toISOString().slice(0, 7), spentUsd: 0, capUsd: 5, calls: 0, capped: 0 });
  if (path === "/api/voice-companion/settings") {
    return json({ enabled: false, callMemory: true, backend: "api", monthlyCapUsd: 20, keySource: "missing", keyEnvironment: "OPENAI_API_KEY", month: new Date().toISOString().slice(0, 7), usageUsd: 0, reservedUsd: 0, incomplete: false, uncertainSession: false });
  }
  if (path === "/api/links/shared") return json({ shared: { v: 1, all: false, projects: [] }, known: [] });
  if (path === "/api/links/agents") return json({ agents: [], lanes: [], self: null, hosts: {} });
  if (path === "/api/telegram") return json({ telegram: { phase: "disconnected", login: null, identity: null, credentialRef: null, lastHealthCheckAt: null, error: null, credentialsConfigured: false } });
  /* Nothing finished waits for an acknowledgement, no task has pictures, and the transcripts carry no delivery records. */
  if (path === "/api/attention/done") return json({ ok: true, items: [], revision: 1 });
  if (path === "/api/task-album") return json({ tasks: {} });
  if (path === "/api/log/provenance") return json({ messages: {}, occurrences: [], submissions: {} });
  /* The orchestrator's parallel helper: never busy here, and it starts nothing. */
  if (path === "/api/orchestrator/ghost") {
    if (method !== "GET") return json({ ok: false, error: L("This is a demo: nothing runs here.", "Це демо: тут нічого не запускається.") }, 409);
    if (url.searchParams.has("askId")) return json({ lines: [], missing: true });
    return json({ conversationId: world.seat.conversationId, busy: false });
  }
  if (path === "/api/accounts/copilot") return json({ active: null, accounts: [] });
  if (path === "/api/external-relay/conversations") return json({ relays: [], chats: [], answers: [], retentionDays: 30 });
  if (path === "/api/search/transcripts") return json(search(url.searchParams.get("q") ?? "", url.searchParams.get("speaker")));
  if (path === "/api/tmux/targets") return json({ targets: {} });
  if (path === "/api/staging") return json({ staging: false });
  if (path === "/api/orchestrator/seat/status") {
    return json({
      project: PROJECT, designated: true, conversationId: world.seat.conversationId, predecessorConversationId: null,
      engine: "claude", model: "claude-opus-5-5", effort: "high", accountId: "main", cwd: `/work/${PROJECT}`, transcriptPath: world.seat.path,
      liveness: { lifecycle: "running", hostState: "alive", silentForMs: 1_000 },
      context: { tokens: 61_400, limit: 1_000_000, percent: 6, estimated: false, basis: "" },
      transcriptFacts: null,
      rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
    });
  }
  if (path === "/api/spawn" && method === "GET") return json({ dirs: [`/work/${PROJECT}`], cwd: null });
  if (!unanswered.has(`${method} ${path}`)) {
    unanswered.add(`${method} ${path}`);
    (window as unknown as { demoUnanswered?: string[] }).demoUnanswered = [...unanswered];
  }
  return json({}, 404);
}) as typeof fetch;

/** Message search over the demo's own transcripts, as the index answers it. */
function search(query: string, speaker: string | null) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items: unknown[] = [];
  for (const file of world.files) {
    const lines = (world.transcripts.get(file.path) ?? "").split("\n").filter(Boolean);
    let byteOffset = 0;
    lines.forEach((raw, index) => {
      const record = JSON.parse(raw) as { type?: string; timestamp?: string; message?: { content?: unknown } };
      const content = record.message?.content;
      const body = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join(" ") : "";
      const who = record.type === "user" ? "user" : "assistant";
      const lower = body.toLowerCase();
      if (body && terms.length && terms.every((term) => lower.includes(term)) && (!speaker || speaker === who)) {
        const first = lower.indexOf(terms[0]!);
        const from = Math.max(0, first - 60);
        let snippet = (from > 0 ? "…" : "") + body.slice(from, first + 120).replace(/\*\*/g, "") + (first + 120 < body.length ? "…" : "");
        for (const term of terms) snippet = snippet.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (hit) => `${SNIPPET_MATCH_OPEN}${hit}${SNIPPET_MATCH_CLOSE}`);
        items.push({ snippet, speaker: who, duplicateCount: 1, timestamp: record.timestamp ? Math.floor(Date.parse(record.timestamp) / 1000) : null, transcriptPath: file.path, byteOffset, lineNumber: index + 1, project: file.project, engine: file.engine, title: file.title });
      }
      byteOffset += new TextEncoder().encode(raw).length + 1;
    });
  }
  items.sort((a, b) => ((b as { timestamp: number }).timestamp ?? 0) - ((a as { timestamp: number }).timestamp ?? 0));
  return { items, nextCursor: null, total: items.length, stats: { conversationsIndexed: world.files.length, messagesIndexed: 214, fieldsSearched: ["message.body"], tokenizer: "unicode61" } };
}

/* ── the landing's controls ───────────────────────────────────────────── */

const label = (key: MessageKey, params?: Record<string, string | number>) => translate(LANG, key, params);

/** Clicks the first element `find` returns, waiting for it to render. */
async function press(find: () => HTMLElement | null | undefined, tries = 40): Promise<void> {
  (await waitFor(find, tries)).click();
}
function waitFor<T>(find: () => T | null | undefined, tries = 40): Promise<T> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const found = find();
      if (found) resolve(found);
      else if (left <= 0) reject(new Error("Demo view did not become ready"));
      else setTimeout(() => attempt(left - 1), 100);
    };
    attempt(tries);
  });
}
const byLabel = (text: string) => document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(text)}"]`);
async function closeOverlays() {
  /* A task's spend popover closes on a press outside it, not on Escape. */
  if (document.querySelector("[data-spend-pop]")) document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const searchWasOpen = !!document.querySelector("[data-search-input]");
  (document.activeElement instanceof HTMLElement ? document.activeElement : document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  // Let React unmount Search before reopening it. A close and open in one
  // batch preserves the failed query, so typing it again cannot retry fetch.
  if (searchWasOpen) await waitFor(() => !document.querySelector("[data-search-input]"));
  // The accounts flyout answers Escape only from inside itself, so the
  // Escape above leaves it docked over the next view; press its own close.
  const accountsDialog = () => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${CSS.escape(label("accounts.titleFor", { engine: "Claude" }))}"]`);
  const accountsClose = accountsDialog()?.querySelector<HTMLElement>(`button[aria-label="${CSS.escape(label("accounts.close"))}"]`);
  if (accountsClose) {
    accountsClose.click();
    await waitFor(() => !accountsDialog());
    /* Closing hands focus back to the rail row that opened the flyout; the
       next view starts without that ring. */
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    (document.activeElement as HTMLElement | null)?.blur();
  }
}
/** The send control's hint stays up while the pointer or focus rests on it;
    once the request is on its way, the chat is what the visitor reads. Hints
    stay quiet from the send until the pointer really moves. */
let lastPointer: { x: number; y: number } | null = null;
window.addEventListener("pointermove", (event) => {
  if (lastPointer && document.documentElement.dataset.demoQuietHints && Math.hypot(event.clientX - lastPointer.x, event.clientY - lastPointer.y) > 6) {
    delete document.documentElement.dataset.demoQuietHints;
  }
  if (!document.documentElement.dataset.demoQuietHints || !lastPointer) lastPointer = { x: event.clientX, y: event.clientY };
}, { passive: true });
function settleSendControl() {
  document.documentElement.dataset.demoQuietHints = "1";
  setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 0);
}
function goBoard() {
  if (location.hash !== `#p=${PROJECT}`) location.hash = `#p=${PROJECT}`;
}
/** The first of the matches a visitor can see. */
const shown = (selector: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((element) => element.getClientRects().length > 0) ?? null;
/** The nearest box that scrolls `target`, or null. */
function scroller(target: Element): HTMLElement | null {
  for (let box = target.parentElement; box; box = box.parentElement) {
    const overflow = getComputedStyle(box).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && box.scrollHeight > box.clientHeight) return box;
  }
  return null;
}
/** Every line of text drawn in `box`, and every control with no text of its own (a switch, a field), as viewport rectangles. */
function textLines(box: HTMLElement): DOMRect[] {
  const range = document.createRange();
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const lines: DOMRect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    lines.push(...range.getClientRects());
  }
  for (const control of box.querySelectorAll<HTMLElement>('select, input, textarea, [role="switch"]')) {
    if (control.getClientRects().length) lines.push(control.getBoundingClientRect());
  }
  return lines;
}
/** The first line of text in `box` that `edge` (a viewport y) runs through. */
const lineAcross = (box: HTMLElement, edge: number) => textLines(box).find((line) => line.top < edge - 0.5 && line.bottom > edge + 0.5) ?? null;
/** Nudges a scrolled box until no line of text is cut by its top or bottom edge, as a still picture needs. */
function wholeLines(box: HTMLElement, gap = 6) {
  for (let pass = 0; pass < 4; pass += 1) {
    const frame = box.getBoundingClientRect();
    const top = frame.top + box.clientTop;
    const bottom = top + box.clientHeight;
    const above = lineAcross(box, top);
    if (above) {
      box.scrollTop -= top - above.top + gap;
      continue;
    }
    const below = lineAcross(box, bottom);
    if (!below) return;
    /* Only the empty space above the first line shown may go: a nudge never hides a line at the top. */
    const first = Math.min(...textLines(box).filter((line) => line.bottom > top).map((line) => line.top));
    const nudge = below.bottom - bottom + gap;
    if (first - nudge < top) return;
    box.scrollTop += nudge;
  }
}
/** Where a box that starts at its top and must keep its first line can stand on whole lines: the middle of the first run of scroll positions that cut no line at either edge, or the top when there is none. */
function wholeFromTop(box: HTMLElement) {
  const frame = box.getBoundingClientRect();
  const top = frame.top + box.clientTop;
  const bottom = top + box.clientHeight;
  box.scrollTop = 0;
  /* The room above the first line is all a scroll may take. */
  const reach = Math.min(...textLines(box).map((line) => line.top)) - top + 0.5;
  const whole = () => !lineAcross(box, top) && !lineAcross(box, bottom);
  let first = -1;
  let last = -1;
  for (let at = 0; at <= reach && at <= box.scrollHeight - box.clientHeight; at += 1) {
    box.scrollTop = at;
    if (whole()) {
      if (first < 0) first = at;
      last = at;
    } else if (first >= 0) break;
  }
  box.scrollTop = first < 0 ? 0 : Math.floor((first + last) / 2);
}
/** Scrolls the nearest box that scrolls `target` until it sits at that box's top, on whole lines; the page outside stays put. */
function scrollToTop(target: Element, gap = 8) {
  const box = scroller(target);
  if (!box) return;
  box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - gap;
  wholeLines(box);
}

/** Scrolls the box that scrolls `target` until `target` is its first line. A target near the end of the content has no scroll left to give, so the box is padded below until it has. A line the top edge still cuts is scrolled away. */
function headToTop(target: Element, gap = 4) {
  const box = scroller(target);
  if (!box) return;
  const toGo = () => target.getBoundingClientRect().top - (box.getBoundingClientRect().top + box.clientTop) - gap;
  box.scrollTop += toGo();
  const short = toGo();
  if (short > 0.5) {
    box.style.paddingBottom = `${parseFloat(getComputedStyle(box).paddingBottom) + Math.ceil(short)}px`;
    box.scrollTop += toGo();
  }
  const top = box.getBoundingClientRect().top + box.clientTop;
  for (let pass = 0; pass < 4; pass += 1) {
    const cut = lineAcross(box, top);
    if (!cut) return;
    box.scrollTop += cut.bottom - top + 1;
  }
}
/** A sheet that shows part of a long panel ends between two rows, and its top edge falls between two lines of the page behind it: its top edge comes down by the least that makes both so. */
function fitSheet(box: HTMLElement, gap = 6) {
  let sheet = box.parentElement;
  while (sheet && getComputedStyle(sheet).maxHeight === "none") sheet = sheet.parentElement;
  if (!sheet) return;
  const top = box.getBoundingClientRect().top + box.clientTop;
  const bottom = top + box.clientHeight;
  const edge = sheet.getBoundingClientRect();
  const behind = pageLines(sheet).filter((line) => line.right > edge.left && line.left < edge.right);
  /* The sheet's content moves down with its top edge while its bottom edge stays: what the bottom edge meets now is the row at `bottom - cut`. */
  const whole = (cut: number) =>
    !lineAcross(box, bottom - cut) && !lineAcross(box, bottom - cut - gap) &&
    !behind.some((line) => line.top < edge.top + cut - 0.5 && line.bottom > edge.top + cut + 0.5);
  for (let cut = 0; cut <= 160 && bottom - cut > top + 80; cut += 1) {
    if (!whole(cut)) continue;
    if (cut > 0) sheet.style.maxHeight = `${Math.floor(edge.height - cut)}px`;
    return;
  }
}

/** The lines of text on the page outside `overlay` that a viewer sees, each as the part of it that its own scrolling boxes and the window leave showing. */
function pageLines(overlay: Element): DOMRect[] {
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const lines: DOMRect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!node.textContent?.trim() || !element || overlay.contains(element) || element.closest("script, style")) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let box: Element | null = element; box && box !== document.documentElement; box = box.parentElement) {
      const own = getComputedStyle(box);
      const x = own.overflowX !== "visible";
      const y = own.overflowY !== "visible";
      if (!x && !y) continue;
      const rect = box.getBoundingClientRect();
      clip = {
        left: x ? Math.max(clip.left, rect.left) : clip.left, right: x ? Math.min(clip.right, rect.right) : clip.right,
        top: y ? Math.max(clip.top, rect.top) : clip.top, bottom: y ? Math.min(clip.bottom, rect.bottom) : clip.bottom,
      };
    }
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      const shown = new DOMRect(Math.max(line.left, clip.left), Math.max(line.top, clip.top), 0, 0);
      shown.width = Math.min(line.right, clip.right) - shown.x;
      shown.height = Math.min(line.bottom, clip.bottom) - shown.y;
      if (shown.width > 0.5 && shown.height > 0.5) lines.push(shown);
    }
  }
  return lines;
}
/** Moves `overlay` by its own `translate` (no layout moves with it) the shortest way that leaves no line of text half under it: every line it touches is under it whole or not at all, and it stays inside the window. */
function keepClear(overlay: HTMLElement, reachX: number, reachY: number, margin = 8) {
  overlay.style.translate = "0px 0px";
  const at = overlay.getBoundingClientRect();
  const lines = pageLines(overlay);
  const half = (dx: number, dy: number) => {
    let count = 0;
    for (const line of lines) {
      const width = Math.min(line.right, at.right + dx) - Math.max(line.left, at.left + dx);
      const height = Math.min(line.bottom, at.bottom + dy) - Math.max(line.top, at.top + dy);
      if (width > 0.5 && height > 0.5 && width * height < 0.97 * line.width * line.height) count += 1;
    }
    return count;
  };
  let best: { dx: number; dy: number; count: number } | null = null;
  for (let dy = -reachY; dy <= reachY; dy += 2) {
    for (let dx = -reachX; dx <= reachX; dx += 2) {
      const left = at.left + dx;
      const top = at.top + dy;
      if (left < margin || top < margin || left + at.width > window.innerWidth - margin || top + at.height > window.innerHeight - margin) continue;
      const count = half(dx, dy);
      const nearer = !best || Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy);
      if (!best || count < best.count || (count === best.count && nearer)) best = { dx, dy, count };
    }
  }
  if (best) overlay.style.translate = `${best.dx}px ${best.dy}px`;
}
/** How far the page shrinks this frame, and so how much the product's own overlays are drawn larger to stay readable at the size the visitor sees. */
function setFrameZoom() {
  let scale = 1;
  try { scale = (window.frameElement?.getBoundingClientRect().width ?? window.innerWidth) / window.innerWidth; } catch { /* a frame the page does not own draws unscaled */ }
  document.documentElement.style.setProperty("--demo-zoom", Math.min(1.8, Math.max(1, 0.98 / (scale || 1))).toFixed(3));
}

/* ── the seat tick, the learned rules and the limits, by their own controls ── */

/** The board scrolled to put the In progress column first: with the orchestrator beside it, the frame's edge then falls in the gap after that column, so no card is cut by it. */
function showInProgress() {
  const column = document.querySelector<HTMLElement>('.column[data-status="assigned"]');
  const board = column?.closest<HTMLElement>(".board");
  if (!column || !board) return;
  board.scrollTo({ left: board.scrollLeft + column.getBoundingClientRect().left - board.getBoundingClientRect().left - 8, behavior: "instant" });
}
/** The seat tick's panel: the popover from the switch in the seat's head, or on the phone the tick's sheet from the seat sheet. */
async function openSeatTick(): Promise<HTMLElement> {
  if (PHONE) {
    /* The seat's ⚙: the row itself opens the chat once the seat has loaded. */
    await press(() => shown("[data-mobile2-seat-controls]"));
    await press(() => shown('[data-mobile2-open="tick"]'));
    return waitFor(() => document.querySelector<HTMLElement>('[data-testid="mobile-seat-tick-sheet"]')?.querySelector<HTMLElement>("[data-seat-tick-autonomy-summary]")
      ? document.querySelector<HTMLElement>('[data-testid="mobile-seat-tick-sheet"]') : null);
  }
  const open = () => document.querySelector<HTMLElement>("[data-seat-tick-popover]");
  const ready = () => (open()?.querySelector("[data-seat-tick-autonomy-summary]") ? open() : null);
  /* A seat that was just docked again replaces its head, and a press on the head it replaced opens nothing: press again. */
  for (let attempt = 0; attempt < 3 && !open(); attempt += 1) {
    await press(() => shown(`[role="slider"][aria-label="${CSS.escape(label("seatTick.switch.aria"))}"]`));
    await waitFor(open, 10).catch(() => null);
  }
  return waitFor(ready);
}
/** The panel at its top, ending on a whole line. On a desktop it takes the orchestrator's whole column, so no word of the chat stands beside it; on the phone the sheet ends between two rows. */
function settleAutonomy(panel: HTMLElement) {
  const box = scroller(panel.querySelector("[data-seat-tick-autonomy-summary]")!);
  if (PHONE) {
    if (box) {
      box.scrollTop = 0;
      fitSheet(box);
    }
    return;
  }
  coverChat(panel);
  if (box) wholeLines(box);
}
/** The popover from the tick switch is a narrow card over the left of the chat; here it spans the chat's column, and slides to where no line of the chat is half under it. */
function coverChat(panel: HTMLElement) {
  const chat = document.querySelector<HTMLElement>("[data-orchestrator-panel]");
  if (!chat) return;
  const column = chat.getBoundingClientRect();
  panel.style.setProperty("--demo-cover-left", `${column.left}px`);
  panel.style.setProperty("--demo-cover-width", `${column.width}px`);
  panel.dataset.demoCover = "";
  keepClear(panel, 0, 48);
}
/** Its decision log: Details opened and standing at the top of the panel, so the view opens on a heading. */
async function showDecisions(panel: HTMLElement) {
  const details = await waitFor(() => panel.querySelector<HTMLDetailsElement>("details[data-seat-tick-details]"));
  details.open = true;
  await waitFor(() => panel.querySelector("[data-seat-tick-autonomy-log]"));
  if (!PHONE) coverChat(panel);
  headToTop(details.querySelector("summary")!, 6);
  if (PHONE) fitSheet(scroller(details)!);
}
/** The learned rules window from the board's ⋯ (on the phone, the menu's project rules), on All rules with one role chosen. */
async function openRules(role: string, expand: string | null): Promise<HTMLElement> {
  if (PHONE) {
    await press(() => shown('[data-mobile2-open="menu"]'));
    await press(() => shown('[data-mobile2-menu-row="rules"]'));
    await press(() => shown("[data-learned-rules-open]"));
  } else {
    await press(() => shown("[data-bar-more]"));
    await press(() => shown("[data-bar-more-menu] [data-learned-rules-open]"));
  }
  const rulesWindow = await waitFor(() => document.querySelector<HTMLElement>("[data-rules-window]"));
  await press(() => [...rulesWindow.querySelectorAll<HTMLElement>("nav button")].find((button) => button.textContent === label("memoryProfile.allRules")));
  await press(() => rulesWindow.querySelector<HTMLElement>(`[data-rules-role="${role}"]`));
  if (expand) await press(() => rulesWindow.querySelector<HTMLElement>(`[data-learned-rule="${expand}"] button[aria-expanded]`));
  /* The window's close control took the focus when it opened; a picture needs no ring on it. */
  (document.activeElement as HTMLElement | null)?.blur();
  return rulesWindow;
}

/** Presses the product's own controls to reach a view, the way a visitor would. */
async function navigateView(view: string) {
  await closeOverlays();
  if (!PHONE) {
    // Leaving full-screen mode only docks the reader. Close that local pane
    // too, so the next view has the same clean board as a fresh frame.
    const readers = [...document.querySelectorAll<HTMLButtonElement>("[data-reader-close]")];
    for (const reader of readers) reader.click();
    if (readers.length) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (PHONE) {
    const screens: Record<string, string> = {
      /* The orchestrator is its chat until the answer is in, then its report log. */
      board: `#p=${PROJECT}`, orchestrator: step <= 2 ? `#c=${encodeURIComponent(world.seat.conversationId!)}` : "#reports",
      reports: "#reports", accounts: "#accounts", pipelines: "#pipelines",
      pipeline: `#pipeline=${step >= 2 ? "p-refunds" : "p-retries"}`, decision: "#pipeline=p-retries",
      conversation: `#c=${encodeURIComponent(`conversation_${step >= 2 ? "refunds-builder" : "webhook-retries"}`)}`,
    };
    if (view === "task") screens.task = "#task=t-refunds";
    const hash = screens[view] ?? `#p=${PROJECT}`;
    // Project navigation cancels unresolved conversation intent in the Viewer.
    // Wait for its destination before opening a sheet or releasing this queue:
    // assigning a hash alone leaves the previous resolver free to close Search.
    navigateToFragment(hash);
    const screen = hash.startsWith("#c=") ? "chat" : hash.startsWith("#pipeline=") ? "pipeline" : hash.startsWith("#task=") ? "task"
      : hash === "#reports" ? "reports" : hash === "#accounts" ? "accounts"
      : hash === "#pipelines" ? "pipelines" : "board";
    await waitFor(() => location.hash === hash && document.querySelector(`[data-mobile2-screen="${screen}"]`));
    if (view === "overview") {
      await press(() => byLabel(label("mobile2.bar.switchProject")));
      await press(() => document.querySelector<HTMLElement>("[data-mobile2-project]"));
    }
    if (view === "search") {
      await press(() => document.querySelector<HTMLElement>('[data-mobile2-open="search"]'));
      await typeSearch();
    }
    if (view === "autonomy") settleAutonomy(await openSeatTick());
    if (view === "decisions") await showDecisions(await openSeatTick());
    if (view === "rules") {
      const rulesWindow = await openRules("orchestrator", RULE_IDS.O1);
      const box = scroller(rulesWindow.querySelector(`[data-learned-rule="${RULE_IDS.O1}"]`)!);
      if (box) {
        /* The opened rule grows over a few frames; the lines are judged once the window has stopped growing. */
        for (let frames = 0, still = 0, height = -1; still < 3 && frames < 60; frames += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          still = box.scrollHeight === height ? still + 1 : 0;
          height = box.scrollHeight;
        }
        wholeFromTop(box);
      }
    }
    if (view === "curator") {
      const rulesWindow = await openRules("builder", null);
      rulesWindow.querySelector<HTMLDetailsElement>("details[data-curation-history]")!.open = true;
      await press(() => rulesWindow.querySelector<HTMLElement>('[data-rules-history="project"][aria-expanded="false"]'));
      headToTop(rulesWindow.querySelector('[data-rules-section="project"]')!, 6);
    }
    /* The phone has no limit history; its frame shows the cards instead. */
    if (view === "spend" || view === "history") {
      await press(() => shown('[data-phone-kanban-tab="assigned"]'));
      await waitFor(() => shown('[data-spend="t-refunds"] .scale'));
    }
    if (view === "task") scrollToTop(await waitFor(() => document.querySelector("[data-phone-task-spend]")));
    return;
  }
  /* The rail's visibility is kept in the frame's storage and outlives a view,
     so each view sets it: the accounts and the overview live in it. */
  const wantRail = view === "accounts" || view === "overview" || view === "history";
  if (wantRail && byLabel(label("rail.show"))) await press(() => byLabel(label("rail.show")), 5);
  if (!wantRail && view !== "orchestrator" && view !== "board" && byLabel(label("rail.hide"))) await press(() => byLabel(label("rail.hide")), 5);
  if (view === "overview") {
    await press(() => document.querySelector<HTMLElement>(`nav[aria-label="${CSS.escape(label("rail.projects"))}"] button`));
    return;
  }
  if (view === "orchestrator" || view === "board" || view === "autonomy" || view === "decisions") {
    /* The hero's two faces: the orchestrator docked on top with its report
       log, or docked at the side of the board. Both without the project rail. */
    goBoard();
    if (byLabel(label("rail.hide"))) await press(() => byLabel(label("rail.hide")), 5);
    if (byLabel(label("orchPanel.seatExpand"))) await press(() => byLabel(label("orchPanel.seatExpand")), 5);
    const want = view === "orchestrator" ? "top" : "side";
    await waitFor(() => document.querySelector<HTMLElement>("[data-seat-placement]"), 20);
    const toggle = document.querySelector<HTMLElement>("[data-seat-placement]");
    if (toggle && toggle.dataset.seatPlacement !== want) {
      toggle.click();
      await waitFor(() => document.querySelector<HTMLElement>("[data-seat-placement]")?.dataset.seatPlacement === want, 20).catch(() => null);
    }
    if (view === "autonomy" || view === "decisions") showInProgress();
    if (view === "autonomy") settleAutonomy(await openSeatTick());
    if (view === "decisions") await showDecisions(await openSeatTick());
    return;
  }
  if (view !== "conversation") {
    goBoard();
    if (byLabel(label("orchPanel.seatCollapse"))) await press(() => byLabel(label("orchPanel.seatCollapse")), 5);
  }
  if (view === "fold") return;
  if (view === "rules") {
    await openRules("orchestrator", RULE_IDS.O1);
    return;
  }
  if (view === "curator") {
    /* The builder's rule the curator rewrote from two, the passes with their undo, and what it archived. */
    const rulesWindow = await openRules("builder", RULE_IDS.B1);
    rulesWindow.querySelector<HTMLDetailsElement>("details[data-curation-history]")!.open = true;
    await press(() => rulesWindow.querySelector<HTMLElement>('[data-rules-history="project"][aria-expanded="false"]'));
    return;
  }
  if (view === "spend") {
    await waitFor(() => document.querySelector('[data-spend="t-refunds"] .scale'));
    return;
  }
  if (view === "task") {
    if (!document.querySelector('[data-spend-pop="t-refunds"]')) await press(() => document.querySelector<HTMLElement>('[data-spend="t-refunds"][role="button"]'));
    const lines = await waitFor(() => document.querySelector<HTMLElement>('[data-spend-pop="t-refunds"]'));
    /* The bubble is placed a frame after it mounts; it then slides to where it covers whole lines or none. */
    const bubble = lines.closest<HTMLElement>('[role="tooltip"]');
    if (bubble) {
      await waitFor(() => bubble.style.visibility !== "hidden" && bubble.style.left !== "-9999px");
      keepClear(bubble, 300, 300);
    }
    return;
  }
  if (view === "history") {
    const name = label("burndown.openAria", { engine: "Claude" });
    await press(() => byLabel(name));
    const chart = await waitFor(() => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${CSS.escape(name)}"]`));
    await waitFor(() => chart.querySelector("svg path"));
    const rail = document.querySelector<HTMLElement>(`nav[aria-label="${CSS.escape(label("rail.projects"))}"]`);
    if (rail) {
      document.documentElement.style.setProperty("--demo-rail-right", `${Math.round(rail.getBoundingClientRect().right)}px`);
      chart.dataset.demoChart = "";
    }
    /* The chart's own close control took the focus when it opened; a picture needs no ring on it. */
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  if (view === "pipeline" || view === "decision") {
    const card = view === "decision" || step < 2 ? "t-retries" : "t-refunds";
    /* A card is closed by default (#2800): its lane row, and the Stages opener in it, show once it is open. */
    document.querySelector<HTMLElement>(`.card[data-id="task:${card}"] .icon-btn.fold[aria-expanded="false"]`)?.click();
    await press(() => document.querySelector<HTMLElement>(`.card[data-id="task:${card}"] [data-open-stages]`));
    return;
  }
  if (view === "conversation") {
    location.hash = `#c=${encodeURIComponent(`conversation_${step >= 3 ? "refunds-builder" : "webhook-retries"}`)}`;
    /* The link opens the conversation in the agent window. */
    await waitFor(() => document.querySelector("[data-agent-window] [data-kanban-reader]"));
    /* Unfold the builder's tool calls, so the edit reads as a diff and the test run shows its output. */
    await waitFor(() => document.querySelector("[data-tool-row]"));
    for (const details of document.querySelectorAll<HTMLDetailsElement>("details:not([open])")) {
      if (details.querySelector("[data-tool-row]")) details.open = true;
    }
    return;
  }
  if (view === "accounts") {
    await press(() => byLabel(label("accounts.triggerAria", { engine: "Claude" })));
    /* The accounts popover floats over the middle of the board and would cut
       its cards mid-word; here it takes the board's whole place beside the
       rail, whose limits it details. */
    const panel = await waitFor(() => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${CSS.escape(label("accounts.titleFor", { engine: "Claude" }))}"]`), 20);
    const rail = document.querySelector<HTMLElement>(`nav[aria-label="${CSS.escape(label("rail.projects"))}"]`);
    if (panel && rail) {
      document.documentElement.style.setProperty("--demo-rail-right", `${Math.round(rail.getBoundingClientRect().right)}px`);
      panel.dataset.demoDocked = "";
    }
    return;
  }
  if (view === "search") {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    await typeSearch();
  }
}

// Serialize navigation and discard superseded queued tabs. Acknowledgement
// follows rendering; no fixed 500/900 ms "ready" delay or iframe reboot.
let viewVersion = 0;
let viewQueue = Promise.resolve();
function showView(view: string) {
  const version = ++viewVersion;
  viewQueue = viewQueue.then(async () => {
    try {
      await viewerReady();
      if (version !== viewVersion) return;
      await navigateView(view);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      // Recheck after paint: a transient search field is not a rendered result.
      if (view === "search" && !searchReady()) throw new Error("Search was replaced before rendering");
      if (version === viewVersion) post({ type: "dlg:viewed", view });
    } catch (error) {
      if (version === viewVersion) post({ type: "dlg:view-error", view, reason: error instanceof Error ? error.message : "Navigation failed" });
    }
  });
  return viewQueue;
}

/** The real search dialog owns query state, loading and speaker scope. */
function searchReady() {
  const field = document.querySelector<HTMLInputElement>("[data-search-input]");
  const dialog = field?.closest('[role="dialog"]');
  const query = L("webhook", "вебхук");
  return field?.value === query && !!dialog &&
    !dialog.querySelector("[data-search-loading], [data-search-updating], [data-search-stale], [data-search-error]") &&
    dialog.querySelectorAll("[data-search-result]").length > 0;
}
/** Use the message-search field on both layouts, never a background filter. */
async function typeSearch() {
  const field = await waitFor(() => document.querySelector<HTMLInputElement>("[data-search-input]"), 30);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, L("webhook", "вебхук"));
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(searchReady, 30);
}

window.addEventListener("message", (event) => {
  const data = event.data as { type?: string; step?: number; view?: string } | null;
  if (!data || typeof data.type !== "string") return;
  if (data.type === "dlg:step" && typeof data.step === "number") jump(Math.max(0, Math.min(LAST_STEP, data.step)));
  if (data.type === "dlg:play") play();
  if (data.type === "dlg:view" && typeof data.view === "string") showView(data.view);
});

/* The request waits in the orchestrator's composer until the visitor sends
   it: every composer that appears while nothing was sent yet gets it once,
   over whatever it restored, and an empty one gets it again once the
   orchestrator has answered something else the visitor sent. */
const prefilled = new WeakSet<HTMLTextAreaElement>();
function prefill(again = false) {
  if (step !== 0) return;
  for (const field of document.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    if (again ? field.value : prefilled.has(field)) continue;
    prefilled.add(field);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, world.request);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
const prefillTimer = setInterval(() => (step === 0 ? prefill() : clearInterval(prefillTimer)), 300);

/* Until then, the control that sends it breathes. */
const coach = document.createElement("style");
coach.textContent = `
html[data-demo-step="0"] [aria-label="${label("composer.sendToAgent")}"],
html[data-demo-step="0"] [data-mobile2-board-dock] { animation: demo-coach 1.8s ease-out infinite; }
@keyframes demo-coach { 0% { box-shadow: 0 0 0 0 rgb(143 136 255 / 0.7); } 70%, 100% { box-shadow: 0 0 0 12px rgb(143 136 255 / 0); } }
@media (prefers-reduced-motion: reduce) { html[data-demo-step="0"] [aria-label="${label("composer.sendToAgent")}"], html[data-demo-step="0"] [data-mobile2-board-dock] { animation: none; box-shadow: 0 0 0 3px rgb(143 136 255 / 0.6); } }`;
document.head.appendChild(coach);

/* A frame is a small window, so a pipeline's stages and the agent window take
   all of it: nothing half-covered shows around their edges. Hints
   stay quiet after the send (above), and at phone scale a message's faint
   copy control reads as a stray mark in the margin, so the phone leaves it out. */
const frameFill = document.createElement("style");
frameFill.textContent = `
html[data-demo-quiet-hints] [role="tooltip"] { display: none; }
[data-demo-docked] .overflow-y-auto { max-height: none !important; }
[data-demo-docked] { position: fixed !important; margin: 0 !important; inset: 0 0 0 var(--demo-rail-right) !important; width: auto !important; max-width: none !important; max-height: none !important; translate: none !important; transform: none !important; border-radius: 0 !important; }
html[data-demo-phone] [aria-label="${label("feed.copyMd")}"] { display: none; }
/* The tick popover over the orchestrator spans the chat's column (coverChat). */
[data-seat-tick-popover][data-demo-cover] { left: var(--demo-cover-left) !important; width: var(--demo-cover-width) !important; max-width: none !important; }
/* A page that shrinks a frame to 0.6 would draw a task's spend lines at 6 px: they are drawn as much larger as the frame is smaller (setFrameZoom). */
[data-spend-pop] { zoom: var(--demo-zoom, 1); }
.spend-pop, .spend-pop:has(.meter) { max-width: calc(320px * var(--demo-zoom, 1)); }
/* The burndown takes the board's place beside the rail, as the accounts do, so no card is half under it. */
[data-demo-chart] {
  position: fixed !important; zoom: var(--demo-zoom, 1); top: 0 !important; right: 0 !important; bottom: 0 !important;
  left: calc(var(--demo-rail-right, 0px) / var(--demo-zoom, 1)) !important; width: auto !important; max-width: none !important;
  margin: 0 !important; translate: none !important; transform: none !important; border-radius: 0 !important;
}
[data-demo-chart] svg[role="img"] { height: 280px; }
.kb .gsheet-scrim { padding: 0; }
.kb .gsheet { border-radius: 0; }
html .kb .agent-window { top: 0; left: 0; width: 100vw; height: 100vh; border-radius: 0; box-shadow: none; }
/* The agent window is the whole frame, and a builder's amber ribbon ring
   round the whole frame reads as an error. Its reader wears the product's
   plain reader border and names its role the quiet way the Stages sheet does. */
:root[data-role-frame="ribbon"] .kb .agent-window .reader.conv[data-role-host]:not([data-role="orchestrator"]) {
  border: 1px solid color-mix(in srgb, var(--color-accent) 40%, var(--border-default)); background: var(--surface-card); padding: 8px var(--inset-conversation) 10px;
}
:root[data-role-frame="ribbon"] .kb .agent-window .reader.conv[data-role-host]:not([data-role="orchestrator"])::after { display: none; }
:root[data-role-frame="ribbon"] .kb .agent-window .reader.conv:not([data-role="orchestrator"]) .role-mark {
  height: auto; margin-left: 0; padding: 0; gap: 7px; color: var(--role-ink); letter-spacing: 0.06em; background: none; clip-path: none;
}
:root[data-role-frame="ribbon"] .kb .agent-window .reader.conv:not([data-role="orchestrator"]) .role-mark-emblem {
  width: 22px; height: 22px; border-radius: 6px; color: #fff; background: var(--role-fill); box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 18%, transparent);
}
/* A frame is a still picture as often as a window: a transcript scrolled to
   its tail cuts a line at its top edge, so the top of every transcript fades
   in instead of ending on half a line. */
[data-log-feed-scroller] { -webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 6px, #000 34px); mask-image: linear-gradient(to bottom, transparent 0, transparent 6px, #000 34px); }
/* A frame holds a few short transcripts, so every row stays laid out. Under
   content-visibility: auto the rows of a scaled frame stayed skipped (a 44 px
   placeholder, no text) after the page scrolled away and back. */
.feed-cv { content-visibility: visible; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; } }`;
document.head.appendChild(frameFill);

setFrameZoom();
window.addEventListener("resize", setFrameZoom);
try { window.parent.addEventListener("resize", setFrameZoom); } catch { /* a page that is not ours */ }
setLocale(LANG);
localStorage.setItem("llvProject", PROJECT);
if (!location.hash) location.hash = `#p=${PROJECT}`;
Object.assign(window, { demo: { jump, play, get step() { return step; }, showView } });
createRoot(document.getElementById("root")!).render(<Viewer />);
announce();
const INITIAL_VIEW = params.get("view");
/* The page swaps a frame in once it has drawn its view. */
const viewerReady = () => waitFor(() => document.querySelector("[data-seat-placement], [data-mobile2-screen], [data-kanban-board]"), 80);
void viewerReady().then(() => {
  // A tab selected during boot owns navigation, including before first paint.
  if (viewVersion === 0) return showView(INITIAL_VIEW ?? (PHONE ? "orchestrator" : "board"));
}).catch(() => post({ type: "dlg:view-error", view: INITIAL_VIEW ?? (PHONE ? "orchestrator" : "board") }));
if (PHONE) document.documentElement.dataset.demoPhone = "1";
