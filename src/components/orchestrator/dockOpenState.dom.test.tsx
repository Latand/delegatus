import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/* The desktop always opens the kanban board (#1695), whose seat owns the
 * orchestrator. Historical per-project dock preferences survive project
 * switches without mounting another composer beside that seat. */

installActEnv();

const dom = new Window({ url: "http://localhost/" });
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
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

/* Desktop: the dock is a desktop surface. */
const matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
Object.assign(globalThis, { matchMedia });
Object.assign(dom, { matchMedia });

/* The board children call `animate`; happy-dom has no Web Animations, and
   `useFlip` subscribes to the returned animation's `finish` event. */
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(),
  cancel() {},
  finish() {},
  addEventListener() {},
  removeEventListener() {},
});

const { setRuntimeUiEnabledForTests } = await import("@/hooks/runtimeBus");

const { Viewer } = await import("../Viewer");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { resetPendingOpensForTest } = await import("@/hooks/useBoardState");
const { OPEN_KEY } = await import("./OrchestratorDock");

const PROJECT = "atlas";
const OTHER = "borealis";
const openKey = (project: string) => `${OPEN_KEY}:${project}`;
const originalFetch = globalThis.fetch;

/* The dock is what a project shows off its Board: the Board seats the
   orchestrator above its columns instead (#1695 K3). A desktop project nobody
   chose a view for opens on its Board (#2166 §3.4), so these cases serve a
   board whose saved view is the conversation list, the way an operator who
   picked it has one. */
let boards: Record<string, BoardProjectStateV1> = {};
const savedBoard = (viewMode: "list"): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode, taskPanelOpen: false },
});

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/files")) {
      return new Response(JSON.stringify({
        files: [],
        projectCatalog: [{ project: PROJECT, conversations: 0 }, { project: OTHER, conversations: 0 }],
      }));
    }
    if (url.startsWith("/api/orchestrator/seat")) {
      return new Response(JSON.stringify({ seat: null, pending: null, exists: true }));
    }
    if (url.startsWith("/api/board")) {
      /* A real in-memory board: the Viewer writes to it as it opens a project,
         and a write answered with anything but its result is retried forever. */
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        const project = new URL(url, "http://localhost").searchParams.get("project") ?? "";
        return Response.json({ ok: true, board: boards[project] ??= savedBoard("list") });
      }
      const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
      const current = boards[body.project] ??= savedBoard("list");
      const next = { ...applyBoardMutations(current, body.mutations ?? []), revision: current.revision + 1 };
      boards[body.project] = next;
      return Response.json({ ok: true, applied: true, board: next });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  setRuntimeUiEnabledForTests(false);
  resetFilesClientCacheForTests();
  resetPendingOpensForTest();
  boards = {};
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  dom.location.hash = "";
  dom.document.body.replaceChildren();
  stubFetch();
});

afterEach(() => {
  if (mounted) {
    const root = mounted;
    mounted = null;
    act(() => root.unmount());
  }
  setRuntimeUiEnabledForTests(null);
  globalThis.fetch = originalFetch;
  dom.document.body.replaceChildren();
});

async function mountViewer(): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  await act(async () => { await Bun.sleep(60); });
  return host as unknown as HTMLElement;
}

/** Present or not, as a boolean: a failing `toBeNull()` on a happy-dom element
    prints the whole node graph, which is megabytes of noise around one bit. */
const hasDock = (host: HTMLElement) => host.querySelector("[data-orchestrator-dock]") !== null;
const seatedOn = (host: HTMLElement) =>
  host.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel") ?? null;

/** Selecting a project the way the rail does — through the hash, which is also
    what a reload of a project URL replays. Explicit, because a test that
    inherits the previous one's hash is a test of the Overview. */
async function goTo(project: string): Promise<void> {
  await act(async () => {
    dom.location.hash = `#p=${encodeURIComponent(project)}`;
    dom.dispatchEvent(new dom.Event("hashchange"));
  });
  await act(async () => { await Bun.sleep(20); });
}

test("legacy open docks leave one board seat per project across switches", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(OPEN_KEY, "1");
  const host = await mountViewer();
  for (const project of [PROJECT, OTHER, PROJECT]) {
    await goTo(project);
    expect(hasDock(host)).toBe(false);
    expect(host.querySelectorAll("[data-orchestrator-panel]")).toHaveLength(1);
    expect(seatedOn(host)).toBe(project);
    expect(dom.localStorage.getItem(openKey(project))).toBeNull();
  }
  expect(dom.localStorage.getItem(OPEN_KEY)).toBe("1");
});

test("the board preserves a project's closed dock preference and the global seed", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(OPEN_KEY, "1");
  dom.localStorage.setItem(openKey(PROJECT), "0");
  const host = await mountViewer();
  for (const project of [PROJECT, OTHER, PROJECT]) {
    await goTo(project);
    expect(hasDock(host)).toBe(false);
    expect(seatedOn(host)).toBe(project);
    expect(host.querySelectorAll("[data-orchestrator-panel]")).toHaveLength(1);
  }
  expect(dom.localStorage.getItem(openKey(PROJECT))).toBe("0");
  expect(dom.localStorage.getItem(openKey(OTHER))).toBeNull();
  expect(dom.localStorage.getItem(OPEN_KEY)).toBe("1");
});
