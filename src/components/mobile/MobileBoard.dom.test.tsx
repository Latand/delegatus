import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations } from "@/lib/board/mutations";
import { translate, type Locale, type TFunction } from "@/lib/i18n";
import { laneMovedAt } from "@/lib/pipelines/laneMovement";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

/*
 * The board on the phone (mobile v2 lane 2, README §8 row 2; since #2072
 * slice 4 the desktop's status columns), mounted as the project leaf it
 * really is. happy-dom does no layout, so what this guards is the contract
 * behind the frames the capture harness measures in Chromium:
 *
 *   - with no conversation on top of the stack the leaf is the BOARD: the seat
 *     card above the column tabs, and what no task owns in Inbox, what needs
 *     the operator first;
 *   - the board carries NO Host section — host detail is one tap away, in the
 *     host sheet behind ⋯ › Host details, and nowhere else;
 *   - the bar's badge counts what Inbox pins, conversations and pipelines;
 *   - opening a row stamps the card seen (#1244) and pushes the conversation
 *     over the board, so ‹ returns to the column it left;
 *   - what a board row can have done to it (#1671) is on a long-press, since
 *     the column pager owns the sideways swipe (phone-kanban §3.8).
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "live" as const, resyncedAt: null, store: emptyStore(), structuredHostsEnabled: false, lastEventAt: null };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => inertRuntime,
  useRuntime: () => inertRuntime,
  useRuntimeSelector: (selector: (state: typeof inertRuntime) => unknown) => selector(inertRuntime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileSheet } = await import("@/components/mobile/MobileSheet");
const { getMobileNav, resetMobileNavForTests, topScreen } = await import("@/components/mobile/mobileNav");
const { receipts } = await import("@/components/mobile/MobileReceipt");
const { resetOrchestratorSeatCacheForTests } = await import("@/components/orchestrator/useOrchestratorSeat");
const { buildMobileBoard, needsDecisionPipelineRows } = await import("@/components/mobile/mobileBoardModel");
const { launchAge, statePhrase } = await import("@/components/mobile/MobileBoard");
const { resetPhoneKanbanPlaces } = await import("@/components/mobile/phoneKanbanPlace");
const { pendingPipelineActs } = await import("@/components/mobile/MobilePipelineScreen");
const { humanizeDuration } = await import("@/components/turnDuration");
const { formatResetClock } = await import("@/components/rateLimit");
type MobileShellHost = NonNullable<React.ComponentProps<typeof ProjectDashboard>["mobileShell"]>;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
let mutations: Array<Record<string, unknown>> = [];
const emptyPrefs = () => ({
  manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [],
  expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false, seenAt: {},
});
const boardState = () => ({
  schemaVersion: 1, revision: boardRevision, updatedAt: new Date(0).toISOString(),
  pathAliases: {}, explicitManual: [], prefs: { ...emptyPrefs(), ...boardPrefs },
});
const jsonResponse = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestLog.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/attention/dismissals" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      dismissals.push(body);
      return jsonResponse({ ok: true, dismissed: [], alreadyClear: [], at: new Date().toISOString(), by: { kind: "operator", surface: "phone" }, undo: body.undo === true });
    }
    if (url.startsWith("/api/pipelines/") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      pipelinePatches.push({ url, body });
      return jsonResponse({ ok: true, pipeline: { ...decisionPipeline, dismissedAt: body.action === "dismiss" ? new Date().toISOString() : null } });
    }
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          patch?: Record<string, unknown>;
          mutations?: Array<Record<string, unknown>>;
        };
        /* A server that refuses any batch holding a close (#1671's rollback). */
        if (boardRejectsClose && (body.mutations ?? []).some((mutation) => mutation.kind === "close")) {
          return { ok: false, status: 400, json: async () => ({ error: "INVALID_REQUEST" }), text: async () => "" };
        }
        for (const mutation of body.mutations ?? []) mutations.push(mutation);
        /* The server's own reducer, so an accepted close is a close. */
        if (body.mutations?.length) boardPrefs = { ...applyBoardMutations(boardState() as never, body.mutations as never).prefs };
        if (body.patch) boardPrefs = { ...boardPrefs, ...body.patch };
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    /* No orchestrator seat in this project by default: the board's seat slot
       invites one and no row is filtered out of the sections. A test that needs
       the footer seats one first. */
    if (url.startsWith("/api/orchestrator/seat")) {
      seatReads += 1;
      return jsonResponse({ seat: seatAnswer, pending: null, exists: true });
    }
    if (url.startsWith("/api/limits")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
/** The project's seat, as `/api/orchestrator/seat` answers it; null by default. */
let seatAnswer: Record<string, unknown> | null = null;
/** How many times this phone has asked for it. */
let seatReads = 0;
/** Every request this phone made, as `METHOD url`. */
const requestLog: string[] = [];
const pipelinePatches: Array<{ url: string; body: Record<string, unknown> }> = [];
/** Every POST to `/api/attention/dismissals` (docs/design/needs-attention.md §5). */
const dismissals: Array<Record<string, unknown>> = [];
let boardRejectsClose = false;

const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "atlas";
const NOW = Math.floor(Date.now() / 1000);

const file = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
  root: "claude-projects", name: over.path.split("/").pop(), project: PROJECT,
  title: "A conversation", engine: "claude", kind: "session", fmt: "claude", parent: null,
  mtime: NOW - 120, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
  pendingQuestion: null, waitingInput: null, conversationId: `conversation_${over.path}`,
  ...over,
} as unknown as FileEntry);

const asking = file({
  path: "/repo/ask.jsonl",
  title: "Implement the export endpoint",
  activity: "live", proc: "running", pid: 4_402,
  lastTurn: { startedAt: (NOW - 600) * 1_000, endedAt: null },
  pendingQuestion: {
    kind: "question", toolUseId: "toolu-export", transcriptPath: "/repo/ask.jsonl", pid: 4_402, paneTarget: null,
    askedAt: new Date((NOW - 540) * 1_000).toISOString(),
    questions: [{ question: "Which format?", header: "Format", multiSelect: false, options: [] }],
  },
} as unknown as Partial<FileEntry> & { path: string });

const running = file({
  path: "/repo/run.jsonl",
  title: "Rebuild the board status projection",
  activity: "live", proc: "running", pid: 4_401, mtime: NOW - 30,
  lastTurn: { startedAt: (NOW - 760) * 1_000, endedAt: null },
  plan: { steps: [], done: 2, total: 5, current: "Add the held precedence", updatedAt: null },
} as unknown as Partial<FileEntry> & { path: string });

const finished = file({ path: "/repo/done.jsonl", title: "Tail: pipeline archive TTL", activity: "recent", mtime: NOW - 900 });

/* A conversation stopped at its account's wall, with both halves of what
   the row must say: which account, and when the window reopens. */
const RESET_AT = NOW + 1_800;
const limited = file({
  path: "/repo/limit.jsonl", title: "Draft the release notes", activity: "idle", mtime: NOW - 240,
  rateLimit: { source: "account", accountId: "Main", window: "session", resetAt: RESET_AT },
} as unknown as Partial<FileEntry> & { path: string });

/* A parentless background process: host data, never a board row. */
const backgroundTask = file({
  path: "/repo/next-dev.log", name: "next-dev.log", title: "next dev · port 8899", cmdDesc: "next dev · port 8899",
  engine: "shell", kind: "task", fmt: "text", activity: "live", proc: "running", pid: 41_822, model: null,
} as unknown as Partial<FileEntry> & { path: string });

const decisionPipeline = {
  id: "pipeline_atlas_p2", task: "Fast conversation switching", taskIds: [], project: PROJECT,
  repoDir: "/repo", worktreeDir: "/repo-p2", branch: "lane/p2", baseBranch: "main", baseRef: "main",
  /* Every stage and attempt carries the role it runs under, as the engine
     records it: the task projection the columns read relies on it. */
  lastPassedCommit: "", stages: [
    { id: "implement", kind: "run", effectiveRole: { roleId: "builder", access: "read-write", promptScaffold: null } },
    { id: "review", kind: "review-loop", effectiveRole: { roleId: "reviewer", access: "read-only", promptScaffold: null } },
  ],
  runs: [{ stageId: "review", attempts: [{ n: 3, state: "failed", effectiveRole: { roleId: "reviewer", access: "read-only", promptScaffold: null }, verdict: { status: "fail", findings: ["one", "two"] }, completedAt: new Date((NOW - 3_600) * 1_000).toISOString() }] }],
  cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
  state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
  createdAt: new Date((NOW - 7_200) * 1_000).toISOString(), closedAt: null,
} as unknown as Pipeline;

const runningPipeline = { ...decisionPipeline, id: "pipeline_atlas_p1", task: "Mobile redesign", state: "running", runs: [] } as unknown as Pipeline;

let sheetOpens: string[] = [];
let opened: string[] = [];
const host = (attentionCount: number): MobileShellHost => ({
  attentionCount,
  arrival: null,
  renderSheet: (name, close) => {
    sheetOpens.push(name);
    return (
      <MobileSheet name={name} title={name} onClose={close}>
        <div data-testid={`${name}-sheet-stub`} />
      </MobileSheet>
    );
  },
});

const dashboardProps = (over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}) => ({
  files: [asking, running, finished], flows: [], pipelines: [], workflows: [], tasks: [],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 12,
  projectCwd: "/repo",
  onArchive: () => {}, onUnarchive: () => {},
  onOpenSearch: () => {},
  onOpenCatalogFile: (entry: FileEntry) => { opened.push(entry.path); },
  mobileShell: host(1),
  ...over,
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  sheetOpens = [];
  opened = [];
  mutations = [];
  boardRevision = 1;
  boardPrefs = {};
  dom.document.body.replaceChildren();
  dom.document.body.style.overflow = "";
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  resetPhoneKanbanPlaces();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  resetMobileNavForTests();
  receipts.dismiss();
  seatAnswer = null;
  seatReads = 0;
  requestLog.length = 0;
  pipelinePatches.length = 0;
  dismissals.length = 0;
  boardRejectsClose = false;
  pendingPipelineActs.cancel();
  /* The seat read is cached per project for the whole module (#1149), so a
     test that seats one has to start from an unanswered cache. */
  resetOrchestratorSeatCacheForTests();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); await settle(); });

function mount(over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(over)} />));
  roots.push(root);
  return container as unknown as HTMLElement;
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
const all = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };
const board = (root: HTMLElement) => q(root, "[data-phone-kanban]");
/** A row of the columns by the conversation it opens. */
const rowFor = (root: HTMLElement, path: string) => q(root, `[data-phone-card-agent="${path}"]`);
const rowPaths = (root: HTMLElement) => all(root, "[data-phone-card-agent]").map((el) => el.getAttribute("data-phone-card-agent"));
const inbox = (root: HTMLElement) => click(q(root, "[data-phone-kanban-tab=inbox]"));

test("with no conversation focused the phone leaf is the board: the seat card above the tabs, and what needs the operator first", async () => {
  const root = mount({ pipelines: [decisionPipeline, runningPipeline] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  /* The focus view is not mounted: one primary surface at a time. */
  expect(q(root, '[data-testid="mobile-chat-shell"]')).toBeNull();
  /* The seat card leads, above the column tabs. */
  const seat = q(root, '[data-testid="mobile-orchestrator-slot"]')!;
  const tabs = q(root, "[data-phone-kanban-tabs]")!;
  expect(seat).not.toBeNull();
  expect(seat.compareDocumentPosition(tabs as unknown as Node) & 4).toBe(4);
  expect(all(root, "[role=tab]").map((tab) => tab.getAttribute("data-phone-kanban-tab"))).toEqual(["inbox", "assigned", "blocked", "done"]);
  /* A first visit opens on Assigned; this project has no task, so it says so
     and points at Inbox, where its work is. */
  expect(board(root)!.getAttribute("data-phone-kanban-active")).toBe("assigned");
  expect(q(root, "[data-phone-kanban-empty=assigned] [data-phone-kanban-nearest]")!.getAttribute("data-phone-kanban-nearest")).toBe("inbox");

  /* Inbox: what needs the operator first — the question, then the lane parked
     on a decision — then the rest of what no task owns. */
  const cards = all(root, '[data-phone-kanban-column="inbox"] [data-phone-card]');
  expect(cards[0]!.getAttribute("data-phone-card-agent")).toBe(asking.path);
  expect(cards[0]!.textContent).toContain("Implement the export endpoint");
  expect(q(cards[0]!, "[data-phone-card-badge]")!.textContent).toBe(translate("en", "mobile2.board.badgeQuestion"));
  expect(cards[0]!.textContent).toContain("Which format?");
  const lane = cards[1]!;
  expect(lane.getAttribute("data-phone-card-kind")).toBe("pipeline");
  expect(lane.textContent).toContain("Fast conversation switching");
  /* The pipeline card (#2072 slice 3): the badge in the desktop's state word,
     the stage chain by the names the stage list gives, and the reason. */
  /* It names its reason and the stage it stopped on (docs/design/needs-attention.md §4). */
  expect(lane.querySelector(".pstate-chip")?.textContent).toBe(translate("en", "needs.laneDecisionStage", { stage: "review" }));
  expect([...lane.querySelectorAll(".pb-pill .pb-name")].map((node) => node.textContent)).toEqual(["Implement", "Review"]);
  expect(lane.querySelector("[data-pipeline-reason]")?.textContent).toBe(
    `${translate("en", "pipelineBlock.reason.failed", { stage: "Review" })} · ${translate("en", "pipelineVerdict.findings", { count: 2 })} · 1h`,
  );
  /* Both of them carry the edge; nothing after them needs the operator. */
  expect(cards.slice(0, 2).map((card) => card.getAttribute("data-needs"))).toEqual(["1", "1"]);
  expect(cards.slice(2).some((card) => card.getAttribute("data-needs") === "1")).toBe(false);
  expect(q(root, "[data-phone-kanban-tab=inbox] [data-phone-tab-needs]")!.textContent).toBe("2");
  /* The working conversation and the finished one are rows no task owns. */
  expect(q(root, "[data-phone-kanban-unlinked]")).not.toBeNull();
  expect(rowFor(root, running.path)).not.toBeNull();
  expect(rowFor(root, finished.path)).not.toBeNull();
  /* The old sections are gone: no Recent, no counts of the scan window. */
  expect(q(root, "[data-mobile2-section]")).toBeNull();
  expect(q(root, '[data-mobile2-row="catalog"]')).toBeNull();
});

test("the board has no Host section: background processes are rows in the host sheet behind ⋯", async () => {
  const root = mount({ files: [asking, running, finished, backgroundTask] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(board(root)!.textContent).not.toContain("next dev · port 8899");
  expect(rowPaths(root)).not.toContain(backgroundTask.path);
  /* Nor a docked strip above the board, which is what the phone used to show. */
  expect(q(root, "[data-mobile2-host-tasks]")).toBeNull();

  click(q(root, '[data-mobile2-open="menu"]'));
  await settle();
  click(q(root, '[data-mobile2-open="host"]'));
  await settle();
  const sheet = q(root, '[data-mobile2-sheet="host"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.textContent).toContain("next dev · port 8899");
  expect(sheet.textContent).toContain(translate("en", "mobile2.host.pid", { pid: 41_822 }));
});

test("what Inbox pins is what the bar's badge counts: the conversations queued and the pipelines waiting on a decision", async () => {
  const root = mount({ pipelines: [decisionPipeline, runningPipeline], mobileShell: host(2) });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  const pinned = all(root, '[data-phone-kanban-column="inbox"] [data-phone-card][data-needs="1"]');
  expect(pinned).toHaveLength(2);
  /* The count is not this leaf's arithmetic: the badge, the queue sheet and
     its «Next ›» read ONE list, scoped to the project behind the badge, and
     the Viewer composes it from the same pure answer that orders these pins
     (`Viewer.switching.dom.test.tsx` proves the scoping over two projects).
     What this asserts is that the answer under the pins and the number over
     them are the same number. */
  const model = buildMobileBoard({
    files: [asking, running, finished],
    pipelines: [decisionPipeline, runningPipeline],
    project: PROJECT,
    now: NOW,
  });
  expect(model.attentionCount).toBe(pinned.length);
  expect(needsDecisionPipelineRows([decisionPipeline, runningPipeline], PROJECT, NOW)).toHaveLength(1);
  expect(q(root, "[data-phone-kanban-tab=inbox] [data-phone-tab-needs]")!.textContent).toBe(String(model.attentionCount));
  const badge = q(root, "[data-mobile2-attention-count]")!;
  expect(badge).not.toBeNull();
  expect(badge.getAttribute("data-mobile2-attention-count")).toBe(String(model.attentionCount));
  expect(badge.getAttribute("aria-label")).toBe(translate("en", "mobile2.bar.attention", { count: model.attentionCount }));
});

test("opening a board row stamps the card seen (#1244) and pushes the conversation over the board", async () => {
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(mutations.filter((mutation) => mutation.kind === "mark-seen")).toEqual([]);

  inbox(root);
  const row = rowFor(root, finished.path)!;
  expect(row).not.toBeNull();
  click(row);
  await settle();

  /* The open gesture: the durable acknowledgement, the conversation screen on
     top of the board, and that conversation under it. */
  const seen = mutations.filter((mutation) => mutation.kind === "mark-seen");
  expect(seen).toHaveLength(1);
  expect(String(seen[0]!.id)).toContain("conversation_/repo/done.jsonl");
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: finished.path });
  expect(await waitFor(() => board(root) === null)).toBe(true);
  /* The conversation screen names itself in the BAR's title cell (mobile v2
     lane 3): the pane it opens carries no header of its own. */
  expect(q(root, '[data-testid="mobile-focused-pane"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-title-text]")?.textContent).toContain(finished.title);
  /* The row places its node itself and does NOT go through the catalog
     resolver. That resolver lands by resetting the shell to the board
     (`nav.home()`, which predates the conversation screen), so routing a row
     through it collapsed the screen this very gesture had just pushed and
     re-pushed it from an effect — the conversation mounted twice with a frame
     of board between. Nothing on this list needs what the resolver adds: a
     board row is a file the scan already carries, never a beyond-cap pin. */
  expect(opened).toEqual([]);

  /* ‹ pops back to the column the operator came from, and stays there. (What
     the pop replays is the Viewer's own focus entry, so the replay itself is
     driven — and its red proved — in `Viewer.switching.dom.test.tsx`.) */
  click(q(root, "[data-mobile2-back]"));
  await settle();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "board" });
  expect(board(root)!.getAttribute("data-phone-kanban-active")).toBe("inbox");

  /* Backing out is not a lock: the same row opens again. */
  click(rowFor(root, finished.path));
  await settle();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: finished.path });
});

test("the board's footer lands the operator in the orchestrator's conversation, and invites one when there is none", async () => {
  /* README §4.1 and §7 Q2: one 44 px target, one tap to the orchestrator. It
     never sends from the board — the reply is written in the conversation. */
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  /* Over a vacancy the slot is the invitation's other half (lane 6): it says
     what the board is missing instead of offering to talk to nothing. */
  expect(await waitFor(() => q(root, "[data-mobile2-board-dock]")?.textContent?.includes(translate("en", "mobile2.seat.createDock")) === true)).toBe(true);
  const empty = q(root, "[data-mobile2-board-dock]")!;
  expect(empty).not.toBeNull();
  expect(empty.textContent).toContain(translate("en", "mobile2.seat.createDock"));

  seatAnswer = {
    project: PROJECT, seatEpoch: 1, conversationId: "conversation_atlas_orchestrator", path: running.path,
    mandate: "Run the atlas board.", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-atlas-1", mode: "existing", launchId: null, error: null },
  };
  resetOrchestratorSeatCacheForTests();
  const seated = mount();
  /* The slot is there either way now, so what is waited for is the seat read
     landing — the footer changing from the invitation to the conversation. */
  expect(await waitFor(() => q(seated, "[data-mobile2-board-dock]")?.textContent?.includes(translate("en", "mobile2.board.tellOrchestrator")) === true)).toBe(true);
  const dock = q(seated, "[data-mobile2-board-dock]")!;
  expect(dock.getAttribute("aria-label")).toBe(translate("en", "mobile2.board.tellOrchestratorLabel"));
  expect(dock.className).toContain("min-h-11");
  /* The seat is the card above the columns, never a row inside them. */
  expect(rowPaths(seated)).not.toContain(running.path);

  click(dock);
  await settle();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: running.path });
  expect(q(seated, '[data-testid="mobile-focused-pane"]')).not.toBeNull();
  expect(q(seated, "[data-mobile2-title-text]")?.textContent).toContain(running.title);
  /* Same open as a row's, and the same reason it is not the resolver's. */
  expect(opened).toEqual([]);
});

test("a launch's age is one unit: context, never the clock the operator acts on (#1487)", () => {
  expect(launchAge(2 * 3600 + 25 * 60)).toBe("2h");
  expect(launchAge(25 * 60 + 40)).toBe("25m");
  expect(launchAge(40)).toBe("40s");
});

test("each phrase carries its age, and the held plurals read right at 1 and at n, in both locales (#1487)", () => {
  const bits = (key: Parameters<typeof statePhrase>[1]["key"], over: Partial<Parameters<typeof statePhrase>[1]> = {}): Parameters<typeof statePhrase>[1] =>
    ({ key, section: "recent", dot: "neutral", edge: null, badge: null, seconds: 900, held: 0, resetAt: null, account: null, ...over });
  const tOf = (locale: Locale): TFunction => ((key: string, vars?: Record<string, unknown>) => translate(locale, key as never, vars as never)) as unknown as TFunction;
  for (const locale of ["en", "uk"] as const) {
    const t = tOf(locale);
    const age = humanizeDuration(900);
    expect(statePhrase(t, bits("killed"), NOW)).toBe(translate(locale, "mobile2.board.killedAge", { age }));
    expect(statePhrase(t, bits("stalled"), NOW)).toBe(translate(locale, "mobile2.board.stalled", { age }));
    expect(statePhrase(t, bits("waiting"), NOW)).toBe(translate(locale, "mobile2.board.waiting", { age }));
    expect(statePhrase(t, bits("returned"), NOW)).toBe(translate(locale, "mobile2.board.returned", { age }));
    expect(statePhrase(t, bits("done"), NOW)).toBe(translate(locale, "mobile2.board.done", { age }));
    for (const key of ["killed", "stalled", "waiting", "returned", "done"] as const) expect(statePhrase(t, bits(key), NOW)).toContain(age);
  }
  expect(statePhrase(tOf("en"), bits("killed"), NOW)).toBe("killed · 15m");
  expect(statePhrase(tOf("en"), bits("held", { held: 1 }), NOW)).toBe("held · 1 message queued");
  expect(statePhrase(tOf("en"), bits("held", { held: 5 }), NOW)).toBe("held · 5 messages queued");
  expect(statePhrase(tOf("uk"), bits("held", { held: 1 }), NOW)).toBe("утримано · 1 повідомлення в черзі");
  expect(statePhrase(tOf("uk"), bits("held", { held: 3 }), NOW)).toBe("утримано · 3 повідомлення в черзі");
  expect(statePhrase(tOf("uk"), bits("held", { held: 5 }), NOW)).toBe("утримано · 5 повідомлень у черзі");
});

test("a row at its account's limit says which account and when the window reopens", async () => {
  /* README §4.1: the state phrase is what the operator is waiting on, and for
     a wall that is the clock — «Main resets 16:40». The read carries both
     halves; a row that only said «at the account limit» made the operator open
     the conversation to find out when to come back. */
  const root = mount({ files: [asking, running, finished, limited] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  const row = rowFor(root, limited.path)!;
  expect(row).not.toBeNull();
  /* A wall lifts on its own clock and asks nothing of the operator
     (docs/design/needs-attention.md §3, reason 4): no pin, no edge, no badge,
     and the row still says which account and when. */
  expect(row.getAttribute("data-needs")).toBeNull();
  expect(row.getAttribute("data-edge")).toBeNull();
  expect(q(row, "[data-phone-card-badge]")).toBeNull();
  expect(q(row, "[data-phone-card-state]")!.className).toContain("text-warning");
  expect(q(row, "[data-phone-card-meta]")!.textContent).toContain(translate("en", "mobile2.board.limitAccountResets", {
    account: "Main", time: formatResetClock(RESET_AT, NOW),
  }));
});

test("the phone reads the seat ONCE: the board keeps it out of the list and the card renders from the same answer", async () => {
  /* Both readers need the same fact — the board, to keep the seat out of the
     sections; the card, to show its state — and the read is a 6 s poll, so a
     second instance for the same key doubled every phone's seat traffic to
     answer one question. */
  seatAnswer = {
    project: PROJECT, seatEpoch: 1, conversationId: "conversation_atlas_orchestrator", path: running.path,
    mandate: "Run the atlas board.", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-atlas-1", mode: "existing", launchId: null, error: null },
  };
  resetOrchestratorSeatCacheForTests();
  seatReads = 0;
  const root = mount();
  /* The dock is in the slot either way now, so the seat read landing is what
     is waited for: the footer says «Tell the orchestrator…» only once it has. */
  expect(await waitFor(() => q(root, "[data-mobile2-board-dock]")?.textContent?.includes(translate("en", "mobile2.board.tellOrchestrator")) === true)).toBe(true);

  /* The board has the answer: the seat's conversation is the card, not a row. */
  expect(rowPaths(root)).not.toContain(running.path);
  /* And so does the card: it is seated — the invitation is gone — from the
     same answer, without a read of its own. */
  const card = q(root, '[data-testid="mobile-orchestrator-slot"] [data-mobile2-seat-card]')!;
  expect(card.getAttribute("data-mobile2-seat-state")).toBe("live");
  expect(card.getAttribute("data-mobile2-seat-shape")).toBe("seat");
  expect(card.getAttribute("data-mobile2-seat-tap")).toBe("conversation");
  expect(seatReads).toBe(1);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * #1671: what a row can have done to it, on a long-press                      *
 * ────────────────────────────────────────────────────────────────────────── */

/* A finger on a board card: touch pointers, the way the phone sends them. */
const finger = (target: Element, type: string, x: number, y: number) => flushSync(() => {
  target.dispatchEvent(new dom.PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: "touch", isPrimary: true,
  }) as unknown as Event);
});
const hold = async (card: HTMLElement) => {
  finger(card, "pointerdown", 200, 30);
  await new Promise((r) => setTimeout(r, 520));
  finger(card, "pointerup", 200, 30);
  await settle();
};
const page = () => dom.document.body as unknown as HTMLElement;
const receiptNow = () => q(page(), "[data-mobile2-receipt]");
const sheetActions = () => all(page(), "[data-phone-card-sheet] [data-phone-card-action]").map((el) => el.getAttribute("data-phone-card-action"));
const laneCard = (root: HTMLElement) => q(root, '[data-phone-card-kind="pipeline"][data-needs="1"]');

test("a row no task owns holds to Close card: the card leaves on the tap, nothing stops the agent, and Reopen brings it back", async () => {
  const root = mount();
  expect(await waitFor(() => board(root) !== null && rowFor(root, running.path) !== null)).toBe(true);
  inbox(root);
  await settle();
  await hold(rowFor(root, running.path)!);
  expect(getMobileNav().getState().sheet).toBe("card");
  expect(sheetActions()).toEqual(["close"]);
  expect(q(page(), '[data-phone-card-action="close"]')!.textContent).toContain(translate("en", "mobile2.board.closeCardHint"));
  /* The held press did not open the conversation. */
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "board" });

  const before = requestLog.length;
  click(q(page(), '[data-phone-card-action="close"]'));
  /* Gone on the tap, before any answer. */
  expect(await waitFor(() => rowFor(root, running.path) === null)).toBe(true);
  expect(receiptNow()!.textContent).toContain(translate("en", "mobile2.chat.closed", { title: running.title }));
  expect(await waitFor(() => mutations.some((mutation) => mutation.kind === "close" && mutation.path === running.path))).toBe(true);
  /* The board is the only thing written: no process control, no transcript. */
  expect(requestLog.slice(before).filter((entry) => !entry.startsWith("GET ")).every((entry) => entry.startsWith("PATCH /api/board"))).toBe(true);
  await settle();
  expect(rowFor(root, running.path)).toBeNull();
  expect(receiptNow()!.textContent).not.toContain(translate("en", "mobile2.board.closeNotSaved", { title: running.title }));

  click(q(receiptNow()!, '[data-mobile2-receipt-undo="reopen"]'));
  expect(await waitFor(() => rowFor(root, running.path) !== null)).toBe(true);
  expect(mutations.some((mutation) => mutation.kind === "restore" && mutation.path === running.path)).toBe(true);
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "board" });
});

test("a close the server refuses brings the row back and says the close was not saved", async () => {
  boardRejectsClose = true;
  const root = mount();
  expect(await waitFor(() => board(root) !== null && rowFor(root, finished.path) !== null)).toBe(true);
  inbox(root);
  await settle();
  await hold(rowFor(root, finished.path)!);
  click(q(page(), '[data-phone-card-action="close"]'));
  expect(await waitFor(() => rowFor(root, finished.path) === null)).toBe(true);
  expect(await waitFor(() => rowFor(root, finished.path) !== null)).toBe(true);
  expect(await waitFor(() => receiptNow()?.textContent?.includes(translate("en", "mobile2.board.closeNotSaved", { title: finished.title })) === true)).toBe(true);
  expect(mutations.some((mutation) => mutation.kind === "close")).toBe(false);
});

test("a lane parked on a decision holds to Dismiss and Close lane: Dismiss clears it through the dismissal route, Close lane waits out its receipt", async () => {
  const root = mount({ pipelines: [decisionPipeline] });
  expect(await waitFor(() => board(root) !== null && laneCard(root) !== null)).toBe(true);
  inbox(root);
  await settle();
  await hold(laneCard(root)!);
  expect(sheetActions()).toEqual(["dismiss", "closeLane"]);
  expect(page().textContent).toContain(translate("en", "needs.dismissRowHint"));
  expect(page().textContent).toContain(translate("en", "mobile2.board.closeLaneHint"));
  expect(q(page(), "[data-phone-card-sheet]")!.textContent).not.toMatch(/\b(Mute|Delete)\b/);
  /* The held press did not open the pipeline under it. */
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "board" });

  /* docs/design/needs-attention.md §5: the one dismissal every surface sends,
     attributed to the operator on the phone, and its Undo. */
  click(q(page(), '[data-phone-card-action="dismiss"]'));
  expect(getMobileNav().getState().sheet).toBeNull();
  expect(await waitFor(() => dismissals.length === 1)).toBe(true);
  /* It names the lane as the card drew it, so a lane that parked again
     before the tap landed is not cleared. */
  expect(dismissals[0]).toEqual({ target: { kind: "subjects", subjects: [{ kind: "pipeline", pipelineId: decisionPipeline.id, laneMovedAt: laneMovedAt(decisionPipeline) }] }, undo: false, surface: "phone" });
  expect(receiptNow()!.textContent).toContain(translate("en", "needs.dismissedReceipt", { title: decisionPipeline.task }));
  click(q(receiptNow()!, '[data-mobile2-receipt-undo="undo"]'));
  expect(await waitFor(() => dismissals.length === 2)).toBe(true);
  expect(dismissals[1]).toMatchObject({ undo: true, surface: "phone" });
  expect(pipelinePatches).toHaveLength(0);

  /* Close lane: the card goes on the tap, and nothing is sent inside the window. */
  expect(await waitFor(() => laneCard(root) !== null)).toBe(true);
  await hold(laneCard(root)!);
  click(q(page(), '[data-phone-card-action="closeLane"]'));
  expect(await waitFor(() => q(root, '[data-phone-card-kind="pipeline"]') === null)).toBe(true);
  expect(receiptNow()!.textContent).toContain(translate("en", "mobile2.pipeline.archived"));
  await settle();
  expect(pipelinePatches).toHaveLength(0);
  click(q(receiptNow()!, '[data-mobile2-receipt-undo="restore"]'));
  expect(await waitFor(() => laneCard(root) !== null)).toBe(true);
  await settle();
  expect(pipelinePatches).toHaveLength(0);

  /* Letting the window close sends the engine's own close. */
  await hold(laneCard(root)!);
  click(q(page(), '[data-phone-card-action="closeLane"]'));
  flushSync(() => pendingPipelineActs.flush());
  expect(await waitFor(() => pipelinePatches.length === 1)).toBe(true);
  expect(pipelinePatches[0]!.body).toEqual({ action: "close" });
});

test("a finger that moves is the pager or the column scrolling: it opens no sheet and no card", async () => {
  const root = mount({ pipelines: [decisionPipeline] });
  expect(await waitFor(() => board(root) !== null && laneCard(root) !== null)).toBe(true);
  inbox(root);
  await settle();
  const card = laneCard(root)!;
  finger(card, "pointerdown", 200, 30);
  finger(card, "pointermove", 204, 60);
  await new Promise((r) => setTimeout(r, 520));
  finger(card, "pointerup", 120, 140);
  await settle();
  expect(getMobileNav().getState().sheet).toBeNull();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "board" });
});
