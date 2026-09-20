/**
 * The seat's own tasks stay out of the Tasks panel on EITHER desktop face (#1841).
 *
 * A seat launch mints a task to keep the seat's notes in, and section 2 of the
 * design says that task draws nothing: no band, no row in the Tasks panel and
 * no share of `Tasks N`. The panel and its count live above the two desktop
 * faces, so they cannot be answered by the board's own read of the seat — on
 * the Conversations face the board is not mounted at all. This file mounts the
 * dashboard on both faces and asserts the same answer from each.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({ items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {} }),
}));
const { resetSelectionSessionsForTest } = await import("@/hooks/useBoardState");
const { resetOrchestratorSeatCacheForTests, SEAT_POLL_MS } = await import("@/components/orchestrator/useOrchestratorSeat");
const { OrchestratorDock } = await import("@/components/orchestrator/OrchestratorDock");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

const SEAT_CONVERSATION = "conversation_seat_live";
const RETIRED_CONVERSATION = "conversation_seat_retired";
const SEAT_PATH = "/seats/live.jsonl";
/* Another project's seat, which the panel's «all» scope lists tasks from. */
const NEIGHBOUR_PROJECT = "seat-tasks-neighbour";
const NEIGHBOUR_CONVERSATION = "conversation_seat_neighbour";

let projectCounter = 0;
let PROJECT = "seat-tasks-0";
let boards: Record<string, BoardProjectStateV1> = {};
let seatReads = 0;

const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  /* The panel is open from the first frame, which is how the operator left it. */
  prefs: { manual: ["/alpha"], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: true },
});

const seatBody = () => ({
  seat: {
    project: PROJECT, seatEpoch: 4, conversationId: SEAT_CONVERSATION, path: SEAT_PATH, engine: "claude",
    mandate: "own the board", promptVersion: 1, predecessorConversationId: RETIRED_CONVERSATION,
    state: "active", intent: { clientRequestId: "req-1841", mode: "existing", launchId: null, error: null },
    designatedAt: "2026-09-19T03:00:00.000Z", activatedAt: "2026-09-19T03:10:00.000Z",
  },
  pending: null,
  lastFailure: null,
  exists: true,
  viewerMcpRegistered: true,
  previous: [{ conversationId: RETIRED_CONVERSATION, path: "/seats/retired.jsonl", title: "Manager seat, release week", engine: "claude", heldFrom: "2026-09-18T14:02:00.000Z", heldTo: "2026-09-19T03:10:00.000Z", taskId: "task-seat-retired", hasNotes: true }],
  currentTask: { taskId: "task-seat-live", title: "Manager seat, this week", hasNotes: true },
  /* The same read carries every project's seat conversations. */
  all: {
    conversationIds: [SEAT_CONVERSATION, NEIGHBOUR_CONVERSATION],
    paths: [SEAT_PATH],
    previous: { conversationIds: [RETIRED_CONVERSATION], paths: ["/seats/retired.jsonl"] },
  },
});

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  WheelEvent: dom.WheelEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (query: string) => ({
    matches: false, media: String(query), onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    /* The seat status read itself, not the incumbent route below it
       (`/api/orchestrator/seat/status`), which is somebody else's poll. */
    if (url.startsWith("/api/orchestrator/seat?")) {
      seatReads += 1;
      return { ok: true, status: 200, json: async () => seatBody(), text: async () => "" };
    }
    if (url.startsWith("/api/board")) {
      if (method === "GET") {
        const project = new URL(url, "http://x").searchParams.get("project")!;
        return { ok: true, status: 200, json: async () => ({ ok: true, board: boards[project] ?? emptyBoard() }), text: async () => "" };
      }
      const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
      const current = boards[body.project] ?? emptyBoard();
      const reduced = applyBoardMutations(current, body.mutations ?? []);
      const next = { ...reduced, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date(0).toISOString(), pathAliases: reduced.pathAliases ?? {} };
      boards[body.project] = next;
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: true, board: next }), text: async () => "" };
    }
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  (dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
});
afterAll(async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  projectCounter += 1;
  PROJECT = `seat-tasks-${projectCounter}`;
  boards = { [PROJECT]: emptyBoard() };
  seatReads = 0;
  resetSelectionSessionsForTest();
  resetOrchestratorSeatCacheForTests();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
});

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};
const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return predicate();
};

const file = (path: string, title: string, conversationId: string | null): FileEntry => ({
  path, root: "claude-projects", name: `${title}.jsonl`, project: PROJECT, title,
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1,
  activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  ...(conversationId ? { conversationId } : {}),
} as FileEntry);

const task = (id: string, text: string, conversationId: string | null, path: string | null): BoardTask => ({
  id, project: PROJECT, status: "assigned", text, placement: "unplaced",
  assignments: conversationId || path
    ? [{ path, conversationId, panePid: null, state: "linked", error: null, at: "2026-09-19T03:10:00.000Z" }]
    : [],
  createdAt: "2026-09-19T03:00:00.000Z", updatedAt: "2026-09-19T03:10:00.000Z",
} as BoardTask);

/* One product task the operator owns, and the two tasks the seat launches
   minted: the live seat's and the retired seat's. */
const TASKS = (): BoardTask[] => [
  task("task-product", "Ship the wide columns", "conversation_worker", "/alpha"),
  task("task-seat-live", "Manager seat, this week", SEAT_CONVERSATION, SEAT_PATH),
  task("task-seat-retired", "Manager seat, release week", RETIRED_CONVERSATION, "/seats/retired.jsonl"),
  /* The neighbouring project's own work, and its seat's task. */
  { ...task("task-neighbour-product", "Ship the neighbour's columns", "conversation_neighbour_worker", "/beta"), project: NEIGHBOUR_PROJECT },
  { ...task("task-seat-neighbour", "Neighbour seat, launch week", NEIGHBOUR_CONVERSATION, "/seats/neighbour.jsonl"), project: NEIGHBOUR_PROJECT },
];

function mount(withDock = false): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() =>
    root.render(
      <>
        {/* The dock is a SIBLING of the dashboard, as `Viewer` renders it: open
            on every desktop face but the board's, beside the same project. */}
        {withDock ? (
          <OrchestratorDock
            project={PROJECT}
            projectName="Atlas"
            projectCwd="/repos/atlas"
            files={[file("/alpha", "Alpha", "conversation_worker"), file(SEAT_PATH, "Manager seat", SEAT_CONVERSATION)]}
            onClose={() => {}}
          />
        ) : null}
        <ProjectDashboard
          files={[file("/alpha", "Alpha", "conversation_worker")]}
          flows={[]}
          pipelines={[]}
          workflows={[]}
          tasks={TASKS()}
          project={PROJECT}
          projectCwd="/repos/atlas"
          loaded
          openNonce={0}
          archived={false}
          catalogKnown
          catalogConversationCount={1}
          onArchive={() => {}}
          onUnarchive={() => {}}
        />
      </>,
    ),
  );
  roots.push(root);
  return host as unknown as HTMLElement;
}

const panelRows = (host: HTMLElement) =>
  [...host.querySelectorAll("[data-task-panel] [data-task-board-toggle]")].map((node) => node.getAttribute("data-task-board-toggle"));
const taskCount = (host: HTMLElement) => host.querySelector("[data-task-panel-toggle]")?.textContent?.trim() ?? "";

test("the Tasks panel and its count leave the seat's tasks out on the Board and on Conversations (#1841)", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  expect(await waitFor(() => panelRows(host).length > 0)).toBe(true);
  await settle();

  /* The Board face: one product row, and the count says one. */
  expect(panelRows(host)).toEqual(["task-product"]);
  expect(taskCount(host)).toContain("1");

  /* Conversations: the board unmounts, and the same two answers hold — this is
     where the seat tasks used to come back, because the read went with the
     board. */
  const listTab = host.querySelector('button[data-view-tab="list"]') as HTMLButtonElement;
  flushSync(() => listTab.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") === null)).toBe(true);
  await settle();
  expect(host.querySelector("[data-task-panel]")).not.toBeNull();
  expect(panelRows(host)).toEqual(["task-product"]);
  expect(taskCount(host)).toContain("1");
  /* And the seat's rows are not merely reordered out of view. */
  expect(host.querySelector("[data-task-panel]")?.textContent).not.toContain("Manager seat");
});

test("a dashboard that opens on Conversations reads the seat itself, once (#1841)", async () => {
  /* The operator left this project on the Conversations face, so the board —
     which used to be the page's only seat reader — never mounts at all. */
  boards = { [PROJECT]: { ...emptyBoard(), prefs: { ...emptyBoard().prefs, viewMode: "list" } } };
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-desktop-conversations-scroll]") !== null)).toBe(true);
  expect(await waitFor(() => panelRows(host).length > 0)).toBe(true);
  await settle();
  expect(host.querySelector("[data-kanban-board]")).toBeNull();
  expect(panelRows(host)).toEqual(["task-product"]);
  expect(taskCount(host)).toContain("1");
  /* One reader, so one request: on the Board face the board is handed this
     same answer instead of polling the route for the same project and cwd. */
  expect(seatReads).toBe(1);
});

/* The dock is open on the Conversations face — the shape the operator actually
   leaves the desktop in — and its panel reads the same project's seat as the
   dashboard above the faces. Two readers of one document are still one request:
   the poll belongs to the project and cwd, not to the mount. */
test("the dock open beside the Conversations face adds no second seat request (#1841)", async () => {
  boards = { [PROJECT]: { ...emptyBoard(), prefs: { ...emptyBoard().prefs, viewMode: "list" } } };
  const host = mount(true);
  expect(await waitFor(() => host.querySelector("[data-desktop-conversations-scroll]") !== null)).toBe(true);
  expect(await waitFor(() => panelRows(host).length > 0)).toBe(true);
  await settle();
  expect(host.querySelector("[data-kanban-board]")).toBeNull();

  /* The dock paints the live seat, from the answer the dashboard's read
     published to it rather than from one of its own. */
  const dock = host.querySelector("[data-orchestrator-dock]");
  expect(dock).not.toBeNull();
  expect(await waitFor(() => dock!.querySelector('[data-orchestrator-state="live"]') !== null)).toBe(true);
  expect(seatReads).toBe(1);

  /* And one per interval from there on, not one per reader. */
  expect(await waitFor(() => seatReads > 1, SEAT_POLL_MS + 3_000)).toBe(true);
  expect(seatReads).toBe(2);
  expect(dock!.querySelector('[data-orchestrator-state="live"]')).not.toBeNull();
/* One poll interval of real waiting: the count over TIME is the claim. */
}, SEAT_POLL_MS + 12_000);

/* The panel's «all» scope lists every project's tasks, and a seat of ANOTHER
   project is no more a task than this project's is (#1841). */
test("the Tasks panel's all scope leaves every project's seat tasks out (#1841)", async () => {
  const host = mount();
  expect(await waitFor(() => panelRows(host).length > 0)).toBe(true);
  await settle();
  expect(panelRows(host)).toEqual(["task-product"]);

  const scopes = [...host.querySelectorAll("[data-task-panel] button[aria-pressed]")] as HTMLButtonElement[];
  expect(scopes).toHaveLength(2);
  flushSync(() => scopes[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  await settle();

  /* Both projects' product tasks, neither project's seat task. */
  expect(panelRows(host)?.slice().sort()).toEqual(["task-neighbour-product", "task-product"]);
  const panel = host.querySelector("[data-task-panel]")?.textContent ?? "";
  expect(panel).toContain("Ship the neighbour's columns");
  expect(panel).not.toContain("Neighbour seat");
  expect(panel).not.toContain("Manager seat");
});
