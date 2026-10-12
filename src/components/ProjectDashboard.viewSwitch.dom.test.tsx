/**
 * The desktop has one view, the Board, which is the kanban (#1695).
 *
 * The Board | Conversations switch (#1614) left the header: the operator never
 * leaves the board, and the list the switch led to opens under the header's
 * recent-agents icon instead. A view saved for the project before that (the
 * list, the scheme face) still opens on the Board and is not rewritten, since
 * the phone reads the same preference. happy-dom lays nothing out and cannot
 * hit-test, so this file asserts those structural facts.
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
const { resetSelectionSessionsForTest } = await import("@/hooks/useBoardState");
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

function click(element: Element | null) {
  expect(element).toBeTruthy();
  flushSync(() => element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
}

const TOP_LEFT_CORNER = "[class*='absolute'][class*='left-3'][class*='top-3']";

test("the desktop shows the Board and no view switch: nothing in its bar leaves it", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  expect(host.querySelector("[data-project-view-tabs], button[data-view-tab]")).toBeNull();
  expect(host.querySelector('[data-bar-group="view"]')).toBeNull();
  expect(host.querySelector("[data-scheme-band], [data-scheme-ui]")).toBeNull();
  expect(Array.from(host.querySelectorAll(TOP_LEFT_CORNER))).toHaveLength(0);
});

test("the recent agents open under the header's icon, over the Board, and nothing is saved for it", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  const before = JSON.stringify(boards[PROJECT]!.prefs);

  const toggle = host.querySelector("header.bar [data-bar-recent-toggle]") as HTMLElement;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Recent agents");
  expect(toggle.getAttribute("title")).toBe("Recent agents");
  expect(host.querySelector("[data-desktop-conversations-scroll]")).toBeNull();
  click(toggle);
  await settle();
  /* The list is the project's every conversation, in a dialog under the icon; the Board stays where it was. */
  const list = host.querySelector("[data-bar-recent-list]") as HTMLElement;
  expect(list.getAttribute("role")).toBe("dialog");
  expect(list.querySelector("[data-desktop-conversations-scroll]")).not.toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[data-kanban-board]")).not.toBeNull();
  expect(JSON.stringify(boards[PROJECT]!.prefs)).toBe(before);

  click(toggle);
  await settle();
  expect(host.querySelector("[data-bar-recent-list]")).toBeNull();
  expect(host.querySelector("[data-kanban-board]")).not.toBeNull();
});

test("a board stored on the scheme face before the kanban became the desktop board opens on the Board", async () => {
  boards = { [PROJECT]: { ...seededBoard(), prefs: { ...seededBoard().prefs, viewMode: "scheme", desktopBoard: "scheme" } } };
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(host.querySelector("[data-scheme-band], [data-scheme-ui]")).toBeNull();
  /* Nothing stored is rewritten to get there. */
  expect(boards[PROJECT]!.prefs).toMatchObject({ viewMode: "scheme", desktopBoard: "scheme" });
});

/* #2166 §3.4: a project created a moment ago (from the rail, or the setup
   guide) has nothing in it and no view anyone chose. It opens on its Board,
   where its orchestrator's draft sits above the columns. A view the operator did choose still wins. */
test("a desktop project nobody chose a view for opens on its Board, even with nothing in it yet", async () => {
  const host = mount([]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(host.querySelector("[data-desktop-conversations-scroll]")).toBeNull();
  /* Nothing is written to get there: no view is stored for the project. */
  expect(boards[PROJECT]?.prefs.viewMode ?? null).toBeNull();
});

/* The operator's decision (2026-10-12): the board is always the view. A list preference saved
   while the desktop had two views no longer takes the desktop off its Board, and stays as it
   was stored, because the phone reads the same preference for its own two views. */
test("a project saved on Conversations opens on its Board on the desktop, and the saved view is left alone", async () => {
  boards = { [PROJECT]: { ...emptyBoard(), revision: 1, prefs: { ...emptyBoard().prefs, viewMode: "list" } } };
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(host.querySelector("[data-desktop-conversations-scroll]")).toBeNull();
  expect(boards[PROJECT]!.prefs.viewMode).toBe("list");
});
