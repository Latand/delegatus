/**
 * Issue #1758: nothing full-width is drawn for a parentless background task.
 *
 * Two live background processes whose owning conversation is not on the board
 * used to become stub groups, which the dashboard docked above the board as
 * full-width strips titled «Background task <id>» — every one of them pushing
 * the whole board further down for something the operator cannot act on.
 *
 * happy-dom lays nothing out, so "the same board origin" is asserted
 * STRUCTURALLY: everything drawn before the board, walked out from the board
 * element through its own ancestor chain, must be identical with and without
 * the two processes. The third case proves that probe can go red — a strip put
 * back above the board by hand has to change the reading.
 *
 * A background task that belongs to a conversation on the board is the
 * model's side of the same issue and stays under its column
 * (`projectModel.test.ts`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
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
const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

/* The desktop is the surface this issue is about; the media query never matches. */
const matchMediaFor = (query: string) => ({
  matches: false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

/* A distinct project per mount: the board store keeps a module-level session
   cache of the last confirmed board per project, so two cases sharing a name
   would let the first one's arrangement prime the second one's first frame. */
let projectCounter = 0;
let PROJECT = "dock-0";
let boards: Record<string, BoardProjectStateV1> = {};
const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
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
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = matchMediaFor;
  /* Asserted rather than assumed: a matching mobile query would render the
     phone, where this dock never existed, and every case would pass blind. */
  expect(dom.matchMedia(MOBILE_LAYOUT_QUERY).matches).toBe(false);
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
  PROJECT = `dock-${projectCounter}`;
  boards = {};
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

const conversation = (): FileEntry => ({
  path: "/alpha.jsonl", root: "claude-projects", name: "alpha.jsonl", project: PROJECT, title: "Alpha",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1,
  activity: "live", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
});

/* A live background process with no owning conversation: exactly what the
   scanner produces for `<slug>/<sid>/tasks/<tid>.output` whose session
   transcript this board does not carry. */
const backgroundTask = (id: string): FileEntry => ({
  path: `/tasks/${id}.output`, root: "claude-tasks", name: `${id}.output`, project: PROJECT,
  title: `Background task ${id}`, engine: "shell", kind: "background", fmt: "plain", parent: null,
  mtime: 3, size: 1, activity: "live", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
});

function mount(files: FileEntry[]): HTMLElement {
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

/* The project key appears in the board's header text and differs between the
   two mounts by construction (see `beforeEach`), so it is scrubbed before the
   readings are compared. Everything else about an element above the board —
   its tag, its classes and its words — is part of the comparison. */
const describeElement = (element: Element, project: string): string => {
  const text = (element.textContent ?? "").split(project).join("<project>").slice(0, 60);
  return `${element.tagName.toLowerCase()}[${element.getAttribute("class") ?? ""}]:${text}`;
};

/**
 * Everything the board's own origin sits below: walking out from the board
 * element to the dashboard root, every earlier sibling at every level, in
 * paint order. A full-width strip docked above the board lands in this list,
 * whichever of the board's ancestors it was inserted before.
 *
 * A missing board is a failure, never an empty reading: an empty list would
 * compare equal to another empty one and every assertion below would hold
 * while measuring nothing.
 */
function boardOrigin(host: HTMLElement, project = PROJECT): string[] {
  const board = host.querySelector("[data-kanban-board]");
  if (!board) throw new Error("no [data-kanban-board] — this test measures what is not there");
  const above: string[] = [];
  for (let node: Element | null = board; node && node !== host; node = node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      above.unshift(describeElement(sibling, project));
    }
  }
  return above;
}

async function mountedOrigin(files: FileEntry[]): Promise<{ host: HTMLElement; origin: string[] }> {
  const project = PROJECT;
  const host = mount(files);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  return { host, origin: boardOrigin(host, project) };
}

test("two live parentless background tasks draw no strip and leave the board origin where it was", async () => {
  const withTasks = await mountedOrigin([conversation(), backgroundTask("aaaa1111"), backgroundTask("bbbb2222")]);

  /* Nothing above the board names them, and the board itself draws neither of
     them — no strip, full-width or otherwise. They keep their rows in the
     quiet strips and the switchboard BELOW the board, which is what «reachable
     from the sidebar or the file list» means here, and which costs the board
     no space. */
  expect(withTasks.origin.join("\n")).not.toContain("Background task");
  const board = withTasks.host.querySelector("[data-kanban-board]")!;
  expect(board.textContent ?? "").not.toContain("Background task");
  /* Not a vacuous reading: the dashboard did receive them. */
  expect(withTasks.host.textContent ?? "").toContain("Background task aaaa1111");

  /* The origin itself: identical to a board that never had them. */
  PROJECT = `${PROJECT}-clean`;
  const without = await mountedOrigin([conversation()]);
  expect(withTasks.origin).toEqual(without.origin);
});

test("the origin probe sees a strip put back above the board", async () => {
  const { host, origin } = await mountedOrigin([conversation()]);
  const board = host.querySelector("[data-kanban-board]")!;
  const strip = dom.document.createElement("div");
  strip.setAttribute("class", "shrink-0 border-b border-border bg-sunken");
  strip.textContent = "Background task aaaa1111";
  board.parentElement!.parentElement!.insertBefore(strip as unknown as Element, board.parentElement as unknown as Element);

  const docked = boardOrigin(host);

  expect(docked).not.toEqual(origin);
  expect(docked.join("\n")).toContain("Background task");
});
