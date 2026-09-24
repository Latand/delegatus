import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import { PRODUCT_NAME } from "@/lib/brand";
import { translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * The header's «Needs you» counts the lanes parked on the operator (#2129).
 *
 * The real Viewer over one invented corpus: two projects, no conversation
 * waiting on anyone, and one lane in `needs_decision` on the ledger task. The
 * card, its column and the phone's ⚠ badge have always counted that lane; the
 * desktop island read 0 beside them. Both counters now read the one list, so
 * the lane counts 1 on each, a dismissal takes it off both, and the island's
 * «Next ›» and its popover land on the card that holds the lane.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let phone = false;
const dom = new Window({ url: "http://localhost/", width: 1280, height: 800 });
const matchMedia = (query: string) => ({
  matches: phone && (String(query) === MOBILE_LAYOUT_QUERY || String(query).includes("pointer: coarse")),
  media: String(query), onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  history: dom.history,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  PopStateEvent: dom.PopStateEvent,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  matchMedia,
});
Object.assign(dom, { matchMedia });
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(), cancel() {}, finish() {}, addEventListener() {}, removeEventListener() {},
});
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

mock.module("@/hooks/runtimeBus", () => ({
  SNAPSHOT_URL: "/api/runtime/snapshot",
  STREAM_URL: "/api/runtime/stream",
  STREAM_RECONNECTED_EVENT: "llv:stream-reconnected",
  isRuntimeUiEnabled: () => false,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "offline" }),
    subscribe: () => () => {},
    subscribeFilesRevision: () => () => {},
  }),
}));

const { Viewer } = await import("./Viewer");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { resetDismissalOverlayForTests } = await import("./attention/dismissalOverlay");
const { resetMobileNavForTests } = await import("./mobile/mobileNav");
const { resetPhoneKanbanPlaces } = await import("./mobile/phoneKanbanPlace");
const { resetOrchestratorSeatCacheForTests } = await import("./orchestrator/useOrchestratorSeat");

const NOW = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();
const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);

const LEDGER = "repo-aaaa000011112222";
const ATLAS = "repo-bbbb000011112222";
const NAMES: Record<string, string> = { [LEDGER]: "acme-ledger", [ATLAS]: "dune-atlas" };

const workingTurn = { startedAt: (NOW - 120) * 1000, endedAt: null };
function conversation(path: string, project: string, title: string): FileEntry {
  return {
    root: "claude-projects", name: path.split("/").pop(), path, project, title, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 30, size: 2_048, activity: "live", proc: "running", pid: null, model: "opus",
    pendingQuestion: null, waitingInput: null, conversationId: `conversation_${path.replace(/\W/g, "_")}`,
    lastTurn: workingTurn, lastAgentWorkAt: (NOW - 30) * 1000,
  } as unknown as FileEntry;
}
const REVISION = ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-");
function task(id: string, project: string, status: TaskStatus, text: string, path: string): BoardTask {
  return {
    id, project, text, status, placement: "unplaced", revision: REVISION,
    assignments: [{ path, conversationId: null, panePid: null, state: "delivered", error: null, at: iso(3_600) }],
    createdAt: iso(7_200), updatedAt: iso(3_600),
  } as BoardTask;
}

const LEDGER_BUILDER = "/sessions/ledger-builder.jsonl";
const ATLAS_WORKER = "/sessions/atlas-worker.jsonl";
/* Nobody's conversation waits on the operator: only the lane does. */
const FILES: FileEntry[] = [
  conversation(LEDGER_BUILDER, LEDGER, "Builder of the ledger export"),
  conversation(ATLAS_WORKER, ATLAS, "Worker on the atlas legend"),
];
const TASKS: BoardTask[] = [
  task("t-ledger", LEDGER, "assigned", "Reconcile the ledger export", LEDGER_BUILDER),
  task("t-atlas", ATLAS, "assigned", "Redraw the atlas legend", ATLAS_WORKER),
];
const LEDGER_CARD = "task:t-ledger";

const LANE = "lane-ledger-decide";
const role = (roleId: string) => ({ roleId, access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: null });
/** The ledger lane, parked on its build stage; `dismissed` is the Dismiss a
    card already sent for this very decision. */
function lane(dismissed: boolean): Pipeline {
  return {
    id: LANE, task: "Reconcile the ledger export", taskIds: ["t-ledger"], project: LEDGER, repoDir: "/repo", worktreeDir: "/repo-ledger", branch: "lane/ledger",
    baseBranch: "main", baseRef: "main", lastPassedCommit: "",
    stages: [{ id: "implement", kind: "run", effectiveRole: role("builder"), next: "review" }, { id: "review", kind: "run", effectiveRole: role("reviewer"), next: null }],
    runs: [{ stageId: "implement", attempts: [{ n: 1, state: "failed", startedAt: iso(2_400), completedAt: iso(2_000), effectiveRole: role("builder"), activatedBy: null, verdict: { status: "fail", findings: ["The export drops the last row."] } }] }],
    cursor: { stageId: "implement", state: "needs_decision", input: null, activatedBy: null },
    state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(7_200), closedAt: null,
    ...(dismissed ? { dismissedAt: iso(60), dismissedBy: { kind: "operator", surface: "desktop" } } : {}),
  } as unknown as Pipeline;
}

let laneDismissed = false;
const posted: Array<Record<string, unknown>> = [];

const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});
const boards = new Map<string, BoardProjectStateV1>();
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/files")) {
      return Response.json({
        files: FILES,
        projectCatalog: [LEDGER, ATLAS].map((project) => ({ project, conversations: 1, smt: NOW - 30 })),
        projectDisplayNames: NAMES,
        flows: [], pipelines: [lane(laneDismissed)], workflows: [], tasks: TASKS, systemHealth: { tmux: { status: "healthy" } },
      });
    }
    if (url.startsWith("/api/board")) {
      /* One board per project, written the way the server writes it: a write
         answered with an unchanged revision would read as never landing, and
         the store would send it again for good. */
      const body = method === "GET" ? null : JSON.parse(String(init?.body)) as { project?: string; mutations?: BoardMutationV1[] };
      const key = body?.project ?? new URL(url, "http://localhost").searchParams.get("project") ?? "";
      const current = boards.get(key) ?? emptyBoard();
      if (!body) return Response.json({ ok: true, board: current });
      const reduced = applyBoardMutations(current, body.mutations ?? []);
      const next = { ...reduced, schemaVersion: 1, revision: current.revision + 1, pathAliases: reduced.pathAliases ?? {} } as BoardProjectStateV1;
      boards.set(key, next);
      return Response.json({ ok: true, applied: true, board: next });
    }
    if (url.startsWith("/api/orchestrator/seat")) {
      if (url.includes("all=")) return Response.json({ all: { conversationIds: [], paths: [], previous: { conversationIds: [], paths: [] } } });
      return Response.json({ seat: null, pending: null, exists: true });
    }
    /* The dismissal route, answered the way the server answers it. */
    if (url === "/api/attention/dismissals") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { target?: { subjects?: Array<{ kind: string; pipelineId?: string; conversationId?: string }> }; undo?: boolean };
      posted.push(body as Record<string, unknown>);
      const subjects = (body.target?.subjects ?? []).map((subject) => subject.kind === "pipeline"
        ? { kind: "pipeline", pipelineId: subject.pipelineId }
        : { kind: "conversation", conversationId: subject.conversationId });
      return Response.json({ ok: true, dismissed: subjects, alreadyClear: [], changed: [], at: new Date().toISOString(), by: { kind: "operator", surface: "desktop" }, undo: body.undo === true });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(async () => {
  phone = false;
  laneDismissed = false;
  posted.length = 0;
  boards.clear();
  resetFilesClientCacheForTests();
  resetDismissalOverlayForTests();
  resetPhoneKanbanPlaces();
  resetOrchestratorSeatCacheForTests();
  resetMobileNavForTests();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  dom.history.replaceState(null, "", "/");
  /* happy-dom answers a URL reset with a late hashchange: let it land here,
     with no Viewer mounted, rather than move the next test's Viewer to the
     Overview (the cross-project test leaves `#p=` behind). */
  await Bun.sleep(20);
  dom.document.body.replaceChildren();
  stubFetch();
});

afterEach(() => {
  if (mounted) {
    const root = mounted;
    mounted = null;
    act(() => root.unmount());
  }
  resetDismissalOverlayForTests();
  globalThis.fetch = originalFetch;
  dom.document.body.replaceChildren();
});

async function until(check: () => boolean, maxMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > maxMs) throw new Error(`not reached within ${maxMs} ms`);
    await act(async () => { await Bun.sleep(15); });
  }
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("nothing to click");
  await act(async () => { (element as HTMLElement).click(); });
}

/** The real Viewer on `project`'s board, once the board draws its cards. */
async function mountOn(project: string): Promise<HTMLElement> {
  dom.localStorage.setItem("llvProject", project);
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  await until(() => Boolean(host.querySelector(phone ? "[data-phone-kanban] [data-phone-card]" : "[data-kanban-board] .card")));
  return host as unknown as HTMLElement;
}

const island = (host: HTMLElement) => host.querySelector("[data-attention-island]") as HTMLElement | null;
/** The number the desktop island shows: its count button, or its muted zero. */
const islandCount = (host: HTMLElement) => {
  const face = island(host);
  if (!face) return null;
  return face.hasAttribute("data-attention-zero") ? 0 : Number((face.querySelector("[data-attention-count]")?.textContent ?? "").replace(/\D+/g, ""));
};
/** The phone bar's ⚠ count; the badge is not drawn at all at zero. */
const phoneBadge = (host: HTMLElement) => Number(host.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? "0");
const card = (host: HTMLElement, id: string) => host.querySelector(`.card[data-id="${id}"]`) as HTMLElement | null;
/** Whether keyboard focus sits on the card: where «Next ›» and N land. */
const focused = (host: HTMLElement, id: string) => {
  const target = card(host, id);
  return target !== null && (dom.document.activeElement as unknown) === target;
};

test("desktop: a lane parked on a decision counts 1 on the island, in the tab title and in the column", async () => {
  const host = await mountOn(LEDGER);

  expect(islandCount(host)).toBe(1);
  expect(dom.document.title).toBe(`(1) ${PRODUCT_NAME}`);
  /* The same lane the column header and the card already mark. */
  expect(card(host, LEDGER_CARD)?.getAttribute("data-attention")).toBe("needs");
  expect(host.querySelector('.column[data-status="assigned"] .needs.num')?.getAttribute("data-count")).toBe("1");

  /* The popover lists it in the card's own words, and the row opens its card. */
  await click(host.querySelector("[data-attention-count]"));
  const row = host.querySelector(`[data-attention-lane="${LANE}"]`) as HTMLElement | null;
  expect(row).not.toBeNull();
  expect(row!.textContent).toContain("Reconcile the ledger export");
  expect(row!.textContent).toContain("acme-ledger");
  expect(row!.querySelector("[data-attention-decision]")?.textContent).toContain(en("needs.laneDecision"));
  await click(row);
  expect(host.querySelector(`[data-attention-lane="${LANE}"]`)).toBeNull();
  await until(() => focused(host, LEDGER_CARD));
  expect(card(host, LEDGER_CARD)!.classList.contains("flash")).toBe(true);
});

test("desktop: «Next ›» from another project's board switches to the lane's project and lands on its card", async () => {
  const host = await mountOn(ATLAS);
  /* The island is global: the atlas board shows the ledger lane's count. */
  expect(islandCount(host)).toBe(1);

  await click(host.querySelector("[data-attention-next]"));
  await until(() => focused(host, LEDGER_CARD));
  expect(dom.localStorage.getItem("llvProject")).toBe(LEDGER);
  expect(card(host, LEDGER_CARD)!.classList.contains("flash")).toBe(true);
});

test("desktop: «Next ›» on the lane's own board lands on its card", async () => {
  const host = await mountOn(LEDGER);
  expect(focused(host, LEDGER_CARD)).toBe(false);

  await click(host.querySelector("[data-attention-next]"));
  await until(() => focused(host, LEDGER_CARD));
  expect(card(host, LEDGER_CARD)!.classList.contains("flash")).toBe(true);
});

test("desktop: the N key walks the same list and reaches the lane", async () => {
  const host = await mountOn(LEDGER);

  await act(async () => {
    (dom.document.body as unknown as HTMLElement).dispatchEvent(new dom.KeyboardEvent("keydown", { key: "n", bubbles: true }) as unknown as Event);
  });
  await until(() => focused(host, LEDGER_CARD));
});

test("desktop: a lane dismissed on its card leaves the island's count with the column's", async () => {
  const host = await mountOn(LEDGER);
  expect(islandCount(host)).toBe(1);

  await click(host.querySelector(`[data-dismiss="${LEDGER_CARD}"]`));
  await until(() => islandCount(host) === 0);
  expect(posted).toHaveLength(1);
  expect(dom.document.title).toBe(PRODUCT_NAME);
  expect(host.querySelector("[data-attention-next]")).toBeNull();
});

test("desktop: a lane already dismissed for this decision counts 0", async () => {
  laneDismissed = true;
  const host = await mountOn(LEDGER);
  expect(islandCount(host)).toBe(0);
  expect(dom.document.title).toBe(PRODUCT_NAME);
});

test("phone: the ⚠ badge counts the same lane, and 0 once it is dismissed", async () => {
  phone = true;
  const host = await mountOn(LEDGER);
  expect(phoneBadge(host)).toBe(1);
  /* The island is the desktop's; the phone's count lives in the bar. */
  expect(island(host)).toBeNull();

  act(() => mounted!.unmount());
  mounted = null;
  dom.document.body.replaceChildren();
  resetFilesClientCacheForTests();
  resetMobileNavForTests();
  laneDismissed = true;
  const again = await mountOn(LEDGER);
  expect(phoneBadge(again)).toBe(0);
});
