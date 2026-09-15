/**
 * The #771 publication contract, driven through the real ProjectDashboard: the
 * canonical selection is one set that survives a view switch, and every view
 * publishes it: the desktop Board (the kanban, #1695), Conversations, and the
 * phone.
 *
 * The desktop Board has no select mode yet, so the set is made through the
 * selection store's own seam (`seedSelectionSessionForTest`) instead of the
 * scheme's hover checks, which left with the scheme.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

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
const { viewBus } = await import("@/hooks/viewPresenceBus");
const { resetSelectionSessionsForTest, seedSelectionSessionForTest } = await import("@/hooks/useBoardState");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

/* Switchable surface: the same selection has to be published by the desktop
   board and by the phone's focus view, so the tests flip this between mounts. */
let mobile = false;
const matchMediaFor = (query: string) => ({
  matches: mobile && String(query) === MOBILE_LAYOUT_QUERY,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

/* In-memory board API over the real mutation reducer: the view-mode switch below
   is a genuine PATCH, so the mode really changes the way it does in the app. */
/* A distinct project per test: the board store keeps a module-level session cache
   of the last confirmed board per project, so reusing one name would let a
   durable close in one case prime the next case's first frame. */
let projectCounter = 0;
let PROJECT = "selection-contract-0";
let boards: Record<string, BoardProjectStateV1> = {};
let tmuxCalls: Array<Record<string, unknown>> = [];
const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});

/* An operator who already has both conversations on their board, so the scheme
   opens with two real cards (and therefore two hover checks) to select. */
const seededBoard = (): BoardProjectStateV1 => ({
  ...emptyBoard(),
  revision: 1,
  explicitManual: ["/alpha", "/beta"],
  prefs: { ...emptyBoard().prefs, manual: ["/alpha", "/beta"] },
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
  matchMedia: matchMediaFor,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/tmux") {
      tmuxCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
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
  /* useIsMobile asks `window.matchMedia`, and `window` here is the happy-dom
     instance — overriding the global alone would leave its real implementation
     answering from happy-dom's own (desktop) viewport. */
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = matchMediaFor;
});
afterAll(async () => {
  /* Let React finish any scheduled work before the DOM globals go away. */
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
  mobile = false;
  projectCounter += 1;
  PROJECT = `selection-contract-${projectCounter}`;
  boards = { [PROJECT]: seededBoard() };
  tmuxCalls = [];
  resetSelectionSessionsForTest();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
});

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

function file(path: string, title: string, mtime: number): FileEntry {
  return {
    path, root: "claude-projects", name: `${title}.jsonl`, project: PROJECT, title,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime, size: 1,
    activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  };
}
/* Built per call, because each test runs under its own project key. */
const alphaOf = () => file("/alpha", "Alpha", 2);
const betaOf = () => file("/beta", "Beta", 1);
const alpha = { path: "/alpha" };
const beta = { path: "/beta" };

function mount(files: FileEntry[] = [alphaOf(), betaOf()], manual?: string[], expanded: string[] = []): HTMLElement {
  if (manual || expanded.length) {
    const seed = seededBoard();
    const nextManual = manual ?? seed.prefs.manual;
    boards = {
      [PROJECT]: {
        ...seed,
        explicitManual: nextManual,
        prefs: { ...seed.prefs, manual: nextManual, expanded },
      },
    };
  }
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() =>
    root.render(
      <ProjectDashboard
        files={files}
        flows={[]}
        pipelines={[]}
        workflows={[]}
        tasks={[]}
        project={PROJECT}
        loaded
        openNonce={0}
        archived={false}
        catalogKnown
        catalogConversationCount={files.length}
        onArchive={() => {}}
        onUnarchive={() => {}}
      />,
    ),
  );
  roots.push(root);
  return host as unknown as HTMLElement;
}

const slice = () => viewBus.getSlice();
const select = (...paths: string[]) => flushSync(() => seedSelectionSessionForTest(PROJECT, paths));
const boardShown = (host: HTMLElement) => host.querySelector("[data-kanban-board]") !== null;
/** Conversations' own order for these rows: freshest first by mtime. */
const listOrder = [alpha.path, beta.path];

/** The view tab an operator actually clicks. */
function clickViewTab(host: HTMLElement, view: "kanban" | "list") {
  const tab = host.querySelector(`button[data-view-tab="${view}"]`) as HTMLButtonElement | null;
  expect(tab).toBeTruthy();
  flushSync(() => tab!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
}

/** Re-render the same dashboard root with a different scan. */
function rescan(files: FileEntry[]) {
  const root = roots[roots.length - 1]!;
  flushSync(() =>
    root.render(
      <ProjectDashboard
        files={files}
        flows={[]}
        pipelines={[]}
        workflows={[]}
        tasks={[]}
        project={PROJECT}
        loaded
        openNonce={0}
        archived={false}
        catalogKnown
        catalogConversationCount={files.length}
        onArchive={() => {}}
        onUnarchive={() => {}}
      />,
    ),
  );
}

test("a selection published on the Board is still published after switching to Conversations, and survives the round trip", async () => {
  const host = mount();
  expect(await waitFor(() => boardShown(host))).toBe(true);
  await settle();
  select("/beta");
  await settle();
  expect(slice().mode).toBe("scheme");
  expect(slice().selectedPaths).toEqual(["/beta"]);

  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();
  expect(boardShown(host)).toBe(false);
  expect(slice().selectedPaths).toEqual(["/beta"]);
  expect(slice().visiblePaths).toEqual(listOrder);

  clickViewTab(host, "kanban");
  expect(await waitFor(() => boardShown(host) && slice().mode === "scheme")).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);
});

test("a selected board conversation that Conversations has no row for is still published", async () => {
  /* Conversations lists root conversations, so a selected child appears in no row; it is published anyway. */
  const leaf = { ...file("/alpha-child", "Child", 3), parent: "/alpha" };
  const host = mount([alphaOf(), leaf], ["/alpha", leaf.path]);
  expect(await waitFor(() => boardShown(host))).toBe(true);
  await settle();
  select(leaf.path);
  await settle();
  expect(slice().selectedPaths).toEqual([leaf.path]);

  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();
  expect(slice().visiblePaths).not.toContain(leaf.path);
  expect(slice().selectedPaths).toEqual([leaf.path]);
});

test("Conversations publishes a multi-conversation selection in its own row order", async () => {
  const host = mount();
  expect(await waitFor(() => boardShown(host))).toBe(true);
  await settle();
  select("/beta", "/alpha");
  await settle();
  expect([...slice().selectedPaths].sort()).toEqual(["/alpha", "/beta"]);

  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(listOrder);
});

test("the phone's focus mode publishes the selection the desktop Board held", async () => {
  const desktop = mount();
  expect(await waitFor(() => boardShown(desktop))).toBe(true);
  await settle();
  select("/beta");
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);

  /* The desktop board goes away: the operator picked up their phone. */
  flushSync(() => roots.pop()!.unmount());
  await settle();

  mobile = true;
  const phone = mount();
  expect(await waitFor(() => slice().mode === "mobile-focus")).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);

  const row = phone.querySelector('[data-mobile2-row="conversation"]') as unknown as HTMLElement | null;
  expect(row).not.toBeNull();
  flushSync(() => row!.click());
  await settle();
  expect(await waitFor(() => slice().focusedPath !== null)).toBe(true);
  expect(slice().mode).toBe("mobile-focus");
  expect(slice().visiblePaths).toEqual([slice().focusedPath!]);
  expect(slice().selectedPaths).toEqual(["/beta"]);
});

test("the phone publishes a member its own board order does not place", async () => {
  /* /beta's window is closed: it is off the board layout while its conversation stays in the scan. */
  boards = { [PROJECT]: { ...seededBoard(), explicitManual: ["/alpha"], prefs: { ...seededBoard().prefs, manual: ["/alpha"], hidden: ["/beta"] } } };
  mobile = true;
  mount();
  expect(await waitFor(() => slice().mode === "mobile-focus")).toBe(true);
  await settle();
  select("/beta");
  await settle();
  expect(slice().visiblePaths).not.toContain("/beta");
  expect(slice().selectedPaths).toEqual(["/beta"]);
});

test("a conversation that disappears from the scan is dropped from the SET, not just from this view's order", async () => {
  const host = mount();
  expect(await waitFor(() => boardShown(host))).toBe(true);
  await settle();
  select("/beta", "/alpha");
  await settle();
  expect([...slice().selectedPaths].sort()).toEqual(["/alpha", "/beta"]);

  rescan([alphaOf()]);
  expect(await waitFor(() => slice().selectedPaths.length === 1)).toBe(true);
  expect(slice().selectedPaths).toEqual(["/alpha"]);

  /* The conversation comes back. If it was only omitted rather than pruned, it would resurrect as selected. */
  rescan([alphaOf(), betaOf()]);
  await settle();
  expect(slice().selectedPaths).toEqual(["/alpha"]);
});

test("a selected conversation the board does not place stays in the set — pruning is not per-view", async () => {
  /* /beta is off the board layout (a durable close) while its conversation stays in the scan and in Conversations. */
  boards = { [PROJECT]: { ...seededBoard(), explicitManual: ["/alpha"], prefs: { ...seededBoard().prefs, manual: ["/alpha"], hidden: ["/beta"] } } };
  const host = mount();
  expect(await waitFor(() => boardShown(host))).toBe(true);
  await settle();
  select("/beta");
  await settle();

  rescan([alphaOf(), betaOf()]);
  await settle();
  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);
});

test("an empty scan never prunes the selection", async () => {
  const host = mount();
  expect(await waitFor(() => boardShown(host))).toBe(true);
  await settle();
  select("/beta");
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);

  /* A failed poll reads as zero entries; it must not wipe the operator's selection. */
  rescan([]);
  await settle();
  rescan([alphaOf(), betaOf()]);
  expect(await waitFor(() => slice().selectedPaths.length === 1)).toBe(true);
  expect(slice().selectedPaths).toEqual(["/beta"]);
});
