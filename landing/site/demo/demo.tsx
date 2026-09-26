import { createRoot } from "react-dom/client";

import { Viewer } from "@/components/Viewer";
import { reportCardRefs } from "@/lib/bridge/reportCardRefs";
import { setLocale, translate, type MessageKey } from "@/lib/i18n";
import { SNIPPET_MATCH_CLOSE, SNIPPET_MATCH_OPEN } from "@/lib/search/snippet";

import { buildWorld, LAST_STEP, PROJECT, type Lang, type World } from "./world";
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
 *   ← { type: "dlg:state", step, lang, playing }  after every change
 *   ← { type: "dlg:lang", lang }   the visitor switched language inside the product
 * The visitor's own send in the orchestrator's composer starts the script.
 */

const params = new URLSearchParams(location.search);
const LANG: Lang = params.get("lang") === "uk" ? "uk" : "en";
const PHONE = params.get("phone") === "1";
const START = Math.max(0, Math.min(LAST_STEP, Number(params.get("step") ?? 0) || 0));

/* How long each step waits after the one before it, once the visitor sent. */
const STEP_DELAY_MS = [0, 0, 2600, 5200, 5200, 4600];
/* The composer keeps its copy of a delivered message until the transcript
   moves this far past the delivery (OUTBOX_MTIME_GRACE_MS, 2 s), so the
   orchestrator's answer is always dated at least this long after the send. */
const ANSWER_AFTER_SEND_S = 2.5;

/* Every frame on the page shares one origin, so what one frame left in
   storage — a conversation it opened, a message it sent — would otherwise
   open in the next frame too. Each frame starts from the world alone. */
for (const key of Object.keys(localStorage)) {
  if (key.startsWith("llvOutbox") || key.startsWith("llv:kanban-readers:")) localStorage.removeItem(key);
}

const boot = Math.floor(Date.now() / 1000);
/* When each step arrived, in seconds to the millisecond. A page opened on a
   later step dates the earlier ones a little apart. */
const stepSeconds: number[] = [];
for (let s = 1; s <= START; s += 1) stepSeconds[s] = boot - (START - s + 1) * 40;
let step = START;
let world: World = buildWorld(step, LANG, boot, stepSeconds);
let playing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let filesRevision = 1;

function post(message: Record<string, unknown>) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}
function announce() {
  document.documentElement.dataset.demoStep = String(step);
  post({ type: "dlg:state", step, lang: LANG, playing });
}

function advance(to: number) {
  if (to <= step) return;
  for (let s = step + 1; s <= to; s += 1) {
    stepSeconds[s] = Date.now() / 1000 - (to - s);
    if (s === 2 && stepSeconds[1] !== undefined) stepSeconds[2] = Math.max(stepSeconds[2], stepSeconds[1] + ANSWER_AFTER_SEND_S);
  }
  step = to;
  world = buildWorld(step, LANG, boot, stepSeconds);
  filesRevision += 1;
  for (const stream of runtimeStreams) stream.filesChanged();
  if (step >= LAST_STEP) playing = false;
  announce();
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
      accounts: [accountRow("main", L("Main", "Основний"), "Max", 42, 140, 31), accountRow("work", L("Work", "Робочий"), "Max", 18, 200, 12), accountRow("side", L("Side", "Запасний"), "Pro", 71, 95, 64)],
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
   revision whenever the script moves, which is how a running Delegatus tells
   the board to read again; the log stream says it cannot connect, so the
   feeds poll /api/logs below. */
type Listener = (event: { data: string }) => void;
const runtimeStreams = new Set<DemoEventSource>();
let streamSeq = 1000;
class DemoEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private beat: ReturnType<typeof setInterval> | null = null;
  constructor(url: string | URL) {
    const target = String(url);
    if (target.startsWith("/api/runtime/stream")) {
      runtimeStreams.add(this);
      setTimeout(() => this.onopen?.(new Event("open")), 0);
      this.beat = setInterval(() => this.emit("heartbeat", ""), 10_000);
    } else if (target.startsWith("/api/logs/stream")) {
      setTimeout(() => this.onerror?.(new Event("error")), 0);
    }
  }
  emit(name: string, data: string) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data });
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
    if (sent.conversationId === world.seat.conversationId && step === 0) {
      advance(1);
      /* The transcript records the request at the very moment it was delivered. */
      at = Math.round(stepSeconds[1]! * 1000);
      play();
      settleSendControl();
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
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const settings = { project: PROJECT, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null };
    return json({
      project: PROJECT, changed: false, at: new Date().toISOString(), actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      settings, defaults: settings, defaultWakeIntervalMinutes: 60, monitorPromptLength: 0, cardText: null,
      effective: { enabled: true, wakeIntervalMinutes: 60, reason: null, monitorPrompt: null, until: null, isDefault: true, configured: false, lapsed: false, updatedAt: null },
      policy: { checkIntervalMinutes: 5, staleAfterMinutes: 15, retryGuardWakes: 2 },
      state: { lastCheckAt: ago(3), lastWakeAt: ago(41), lastWakeReasons: ["interval"], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
      stateError: null, lastRun: { at: ago(3), verdict: "quiet", reasons: [], delivery: null, detail: "nothing owed" }, lastDelivery: { at: ago(41), outcome: "landed" },
    });
  }
  if (path === "/api/tts/backend") return json({ error: "no speech in the demo" }, 503);
  if (path === "/api/accounts/copilot") return json({ active: null, accounts: [] });
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
function press(find: () => HTMLElement | null | undefined, tries = 40): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = (left: number) => {
      const element = find();
      if (element) {
        element.click();
        resolve(true);
      } else if (left > 0) setTimeout(() => attempt(left - 1), 100);
      else resolve(false);
    };
    attempt(tries);
  });
}
function waitFor<T>(find: () => T | null | undefined, tries = 40): Promise<T | null> {
  return new Promise((resolve) => {
    const attempt = (left: number) => {
      const found = find();
      if (found || left <= 0) resolve(found ?? null);
      else setTimeout(() => attempt(left - 1), 100);
    };
    attempt(tries);
  });
}
const byLabel = (text: string) => document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(text)}"]`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function closeOverlays() {
  (document.activeElement instanceof HTMLElement ? document.activeElement : document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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

/** Presses the product's own controls to reach a view, the way a visitor would. */
async function showView(view: string) {
  closeOverlays();
  if (PHONE) {
    const screens: Record<string, string> = {
      /* The orchestrator is its chat until the answer is in, then its report log. */
      board: `#p=${PROJECT}`, orchestrator: step <= 2 ? `#c=${encodeURIComponent(world.seat.conversationId!)}` : "#reports",
      reports: "#reports", accounts: "#accounts", pipelines: "#pipelines",
      pipeline: `#pipeline=${step >= 2 ? "p-refunds" : "p-retries"}`, decision: "#pipeline=p-retries",
      conversation: `#c=${encodeURIComponent(`conversation_${step >= 2 ? "refunds-builder" : "webhook-retries"}`)}`,
    };
    location.hash = screens[view] ?? `#p=${PROJECT}`;
    if (view === "overview") {
      await press(() => byLabel(label("mobile2.bar.switchProject")));
      await press(() => document.querySelector<HTMLElement>("[data-mobile2-project]"));
    }
    if (view === "search") {
      await press(() => document.querySelector<HTMLElement>('[data-mobile2-open="search"]'));
      await typeSearch(false);
    }
    return;
  }
  /* The rail's visibility is kept in storage every frame on the page shares,
     so each view sets it: the accounts and the overview live in it. */
  const wantRail = view === "accounts" || view === "overview";
  if (wantRail && byLabel(label("rail.show"))) await press(() => byLabel(label("rail.show")), 5);
  if (!wantRail && view !== "orchestrator" && view !== "board" && byLabel(label("rail.hide"))) await press(() => byLabel(label("rail.hide")), 5);
  if (view === "overview") {
    await press(() => document.querySelector<HTMLElement>(`nav[aria-label="${CSS.escape(label("rail.projects"))}"] button`));
    return;
  }
  if (view === "orchestrator" || view === "board") {
    /* The hero's two faces: the orchestrator docked on top with its report
       log, or docked at the side of the board. Both without the project rail. */
    goBoard();
    if (byLabel(label("rail.hide"))) await press(() => byLabel(label("rail.hide")), 5);
    if (byLabel(label("orchPanel.seatExpand"))) await press(() => byLabel(label("orchPanel.seatExpand")), 5);
    const want = view === "board" ? "side" : "top";
    await waitFor(() => document.querySelector<HTMLElement>("[data-seat-placement]"), 20);
    const toggle = document.querySelector<HTMLElement>("[data-seat-placement]");
    if (toggle && toggle.dataset.seatPlacement !== want) toggle.click();
    return;
  }
  goBoard();
  if (byLabel(label("orchPanel.seatCollapse"))) await press(() => byLabel(label("orchPanel.seatCollapse")), 5);
  if (view === "fold") return;
  if (view === "pipeline" || view === "decision") {
    const card = view === "decision" || step < 2 ? "t-retries" : "t-refunds";
    await pause(250);
    await press(() => document.querySelector<HTMLElement>(`.card[data-id="task:${card}"] [data-open-stages]`));
    return;
  }
  if (view === "conversation") {
    location.hash = `#c=${encodeURIComponent(`conversation_${step >= 3 ? "refunds-builder" : "webhook-retries"}`)}`;
    await press(() => byLabel(label("kanban.readerFull")));
    /* Unfold the builder's tool calls, so the edit reads as a diff and the test run shows its output. */
    for (let round = 0; round < 3; round += 1) {
      await pause(400);
      for (const details of document.querySelectorAll<HTMLDetailsElement>("details:not([open])")) {
        if (details.querySelector("[data-tool-row]")) details.open = true;
      }
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
    await pause(150);
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    await typeSearch(true);
  }
}

/** Types the search the demo shows into the search field that just opened:
    on the desktop the message-search dialog's own field, never the board's
    task filter behind it. */
async function typeSearch(inDialog: boolean) {
  const field = await waitFor(() => {
    const dialogField = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (dialogField || inDialog) return dialogField;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement) return active;
    return document.querySelector<HTMLInputElement>('input[type="search"]');
  }, 30);
  if (!field) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, L("webhook", "вебхук"));
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

window.addEventListener("message", (event) => {
  const data = event.data as { type?: string; step?: number; view?: string } | null;
  if (!data || typeof data.type !== "string") return;
  if (data.type === "dlg:step" && typeof data.step === "number") jump(Math.max(0, Math.min(LAST_STEP, data.step)));
  if (data.type === "dlg:play") play();
  if (data.type === "dlg:view" && typeof data.view === "string") showView(data.view);
});

/* The request waits in the orchestrator's composer until the visitor sends
   it: every composer that appears while nothing was sent yet gets it once. */
const prefilled = new WeakSet<HTMLTextAreaElement>();
function prefill() {
  if (step !== 0) return;
  for (const field of document.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    if (prefilled.has(field) || field.value) continue;
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

/* A frame is a small window, so a pipeline's stages and a conversation opened
   full take all of it: nothing half-covered shows around their edges. Hints
   stay quiet after the send (above), and at phone scale a message's faint
   copy control reads as a stray mark in the margin, so the phone leaves it out. */
const frameFill = document.createElement("style");
frameFill.textContent = `
html[data-demo-quiet-hints] [role="tooltip"] { display: none; }
[data-demo-docked] { position: fixed !important; margin: 0 !important; inset: 0 0 0 var(--demo-rail-right) !important; width: auto !important; max-width: none !important; max-height: none !important; translate: none !important; transform: none !important; border-radius: 0 !important; }
html[data-demo-phone] [aria-label="${label("feed.copyMd")}"] { display: none; }
.kb .gsheet-scrim, .kb .reader-full { padding: 0; }
.kb .gsheet, .kb .reader-full .reader.conv { border-radius: 0; }`;
document.head.appendChild(frameFill);

setLocale(LANG);
localStorage.setItem("llvProject", PROJECT);
if (!location.hash) location.hash = `#p=${PROJECT}`;
Object.assign(window, { demo: { jump, play, get step() { return step; }, showView } });
createRoot(document.getElementById("root")!).render(<Viewer />);
announce();
const INITIAL_VIEW = params.get("view");
/* The page swaps a frame in once it has drawn its view. */
void waitFor(() => document.querySelector("[data-seat-placement], [data-mobile2-board-dock], [data-kanban-board]"), 80)
  .then(() => (INITIAL_VIEW ? showView(INITIAL_VIEW) : undefined))
  .then(() => pause(INITIAL_VIEW === "search" || INITIAL_VIEW === "conversation" ? 900 : 500))
  .then(() => post({ type: "dlg:viewed", view: INITIAL_VIEW }));
if (PHONE) document.documentElement.dataset.demoPhone = "1";
