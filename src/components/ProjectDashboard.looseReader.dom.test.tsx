import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * The reader of a conversation no card holds (#1695, round 2 of the review of
 * #1712) takes the whole window. It belongs to the project it was opened in and
 * to the moment it was opened for:
 *   - a switch to another project whose files the Viewer already holds keeps
 *     the Board mounted, and the reader must not stay over that project, nor
 *     come back when the operator returns;
 *   - an attention jump, a `#c=` landing, a focus handoff or a pipeline link to
 *     something a card holds leaves the window first, so the target is not
 *     covered, and a handoff does not report arrival while the window is up.
 * The real ProjectDashboard is mounted over invented records; a project switch
 * is the dashboard rendered with the other project's loaded files, as the
 * Viewer renders it; the board route is a scripted fetch.
 */

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
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 4, known: true, loading: false, error: false, expired: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { focusHandoffBus } = await import("@/components/attention/focusHandoffBus");

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

let boardRevision = 1;
let presentationWrites: unknown[] = [];
const boardState = () => ({
  schemaVersion: 1, revision: boardRevision, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [],
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.MouseEvent,
  MutationObserver: dom.MutationObserver,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { mutations?: Array<{ kind: string }> };
        presentationWrites.push(...(body.mutations ?? []).filter((mutation) => mutation.kind === "set-presentation"));
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    /* Every transcript is empty: a reader's feed settles on its empty state. */
    if (url.startsWith("/api/logs")) {
      const { reqs } = JSON.parse(String(init?.body ?? "{}")) as { reqs?: Array<{ id: string }> };
      return jsonResponse({ chunks: Object.fromEntries((reqs ?? []).map((req) => [req.id, { data: "", start: 0, offset: 0, size: 0 }])) });
    }
    if (url.startsWith("/api/log")) return jsonResponse({ data: "", start: 0, offset: 0, size: 0 });
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
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
  (dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({ cancel() {}, addEventListener() {} });
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "loose-reader-project";
const OTHER = "loose-reader-other-project";
const now = Math.floor(Date.now() / 1000);
const iso = new Date().toISOString();
const session = (project: string, id: string, title: string, over: Record<string, unknown> = {}) => ({
  root: "codex-sessions", project, engine: "codex", kind: "session", fmt: "codex", size: 4_096, proc: null, pid: null, model: null,
  pendingQuestion: null, waitingInput: null, path: `/repo/sessions/${id}.jsonl`, name: `${id}.jsonl`, title, parent: null,
  mtime: now - 60, activity: "idle", conversationId: `conversation_loose_${id}`, ...over,
}) as unknown as FileEntry;

const implementer = session(PROJECT, "implementer", "Implementer of the export presets", { mtime: now - 30, activity: "live", proc: "running" });
const reviewer = session(PROJECT, "reviewer", "Reviewer round two of the export presets", {
  mtime: now - 20,
  durableLineage: { kind: "review", role: "reviewer", parentConversationId: implementer.conversationId, reviewsConversationId: implementer.conversationId, memberships: [] },
});
const earlierReviewer = session(PROJECT, "earlier-reviewer", "Reviewer round one of the export presets", {
  mtime: now - 40,
  durableLineage: { kind: "review", role: "reviewer", parentConversationId: implementer.conversationId, reviewsConversationId: implementer.conversationId, memberships: [] },
});
const builderHere = session(PROJECT, "builder-here", "Builder of the index rebuild here");
const otherImplementer = session(OTHER, "other-implementer", "Implementer on the other project", { mtime: now - 25 });
const builderThere = session(OTHER, "builder-there", "Builder of the index rebuild there");

const flow = {
  id: "flow-loose", implementerPath: implementer.path, state: "reviewing", project: PROJECT,
  rounds: [
    { n: 1, reviewerPath: earlierReviewer.path, reviewerConversationId: earlierReviewer.conversationId },
    { n: 2, reviewerPath: reviewer.path, reviewerConversationId: reviewer.conversationId },
  ],
} as unknown as Flow;

const builderRole = { roleId: "builder", engine: "codex", model: "gpt", effort: "high", access: "read-write", promptScaffold: null };
const pipelineFor = (id: string, project: string, taskId: string, file: FileEntry) => ({
  id, task: "Rebuild the search index", taskIds: [taskId], project, state: "running", repoDir: "/repo", worktreeDir: "/repo/worktree", branch: "b", baseBranch: "main",
  stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build it.", next: null, onFail: null, effectiveRole: builderRole }],
  runs: [{ stageId: "build", attempts: [{
    n: 1, state: "running", effectiveRole: builderRole, launchId: null, conversationId: file.conversationId, sessionId: null, agentPath: file.path, paneId: null, flowId: null,
    startedAt: iso, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
  }] }],
  cursor: { stageId: "build", state: "running", input: null, activatedBy: null }, createdAt: iso,
}) as unknown as Pipeline;
const taskFor = (id: string, project: string, text: string) => ({
  id, project, status: "assigned", text, placement: "unplaced", assignments: [], createdAt: iso, updatedAt: iso,
}) as unknown as BoardTask;
const here = pipelineFor("pipeline-loose-here", PROJECT, "task-here", builderHere);
const there = pipelineFor("pipeline-loose-there", OTHER, "task-there", builderThere);
const tasks = [taskFor("task-here", PROJECT, "Rebuild the search index here"), taskFor("task-there", OTHER, "Rebuild the search index there")];

type Landing = { path: string; nonce: number; catalog?: boolean } | null;
const dashboardProps = (project: string, focusRequest: Landing) => ({
  files: project === PROJECT ? [implementer, reviewer, earlierReviewer, builderHere] : [otherImplementer, builderThere],
  flows: project === PROJECT ? [flow] : [], pipelines: [here, there], workflows: [], tasks,
  project, loaded: true, openNonce: 0, archived: false, catalogKnown: true, catalogConversationCount: 4,
  projectCwd: "/repo", onArchive: () => {}, onUnarchive: () => {}, focusRequest, onOpenSearch: () => {},
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  boardRevision = 1;
  presentationWrites = [];
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "";
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

function mount() {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(PROJECT, null)} />));
  roots.push(root);
  let nonce = 0;
  return {
    host: host as unknown as HTMLElement,
    root,
    /* The Viewer's landing on a path: an attention jump (`catalog: false`) or a resolved `#c=` link (`catalog: true`). */
    land: (file: FileEntry, catalog = false) => flushSync(() => root.render(<ProjectDashboard {...dashboardProps(file.project, { path: file.path, nonce: ++nonce, catalog })} />)),
    switchTo: (project: string) => flushSync(() => root.render(<ProjectDashboard {...dashboardProps(project, null)} />)),
    /* As a browser switch renders: committed by the scheduler, with effects after the commit. */
    switchLater: (project: string) => root.render(<ProjectDashboard {...dashboardProps(project, null)} />),
  };
}

const holdsPath = (element: Element, file: FileEntry) => element.matches(`[data-link-path="${file.path}"]`) || element.querySelector(`[data-link-path="${file.path}"]`) !== null;
/** Its reader with the transcript and the composer: in the window, in a card, or none. */
const readerOf = (host: HTMLElement, file: FileEntry): "window" | "card" | null => {
  const reader = Array.from(host.querySelectorAll("[data-kanban-reader]"))
    .find((element) => holdsPath(element, file) && element.querySelector("textarea"));
  if (!reader) return null;
  return reader.closest(".reader-full") ? "window" : reader.closest("[data-kanban-card]") ? "card" : null;
};
const windowUp = () => dom.document.querySelector(".reader-full") !== null;
const cardOf = (host: HTMLElement, id: string) => host.querySelector(`[data-kanban-card="${id}"]`);
const focusedCard = () => (dom.document.activeElement as unknown as HTMLElement | null)?.closest?.("[data-kanban-card]")?.getAttribute("data-kanban-card") ?? null;
const navigate = (id: string) => dom.dispatchEvent(new dom.CustomEvent("llv:mcp-navigate", { detail: { kind: "pipeline", id } }));
const readyOn = (host: HTMLElement, project: string) => project === PROJECT
  ? host.querySelector(`[data-member="${implementer.path}"]`) !== null && cardOf(host, "task:task-here") !== null
  : host.querySelector(`[data-member="${otherImplementer.path}"]`) !== null && cardOf(host, "task:task-there") !== null;

/** The reviewer's round, open in the window on this project's Board. The other project was shown in this tab
    first, so a switch to it finds its board already loaded and keeps the Board mounted, as the Viewer does. */
async function openReviewer() {
  const board = mount();
  expect(await waitFor(() => readyOn(board.host, PROJECT))).toBe(true);
  board.switchTo(OTHER);
  expect(await waitFor(() => readyOn(board.host, OTHER))).toBe(true);
  board.switchTo(PROJECT);
  expect(await waitFor(() => readyOn(board.host, PROJECT))).toBe(true);
  expect(board.host.querySelector(`[data-kanban-card] [data-member="${reviewer.path}"]`)).toBeNull();
  board.land(reviewer);
  expect(await waitFor(() => readerOf(board.host, reviewer) === "window")).toBe(true);
  return board;
}

test("a switch to a project the Board is already showing files for leaves the reader behind, and it is not back on return", async () => {
  const { host, switchTo, switchLater } = await openReviewer();
  /* A stale commit would still draw the window over the other project's cards: watch every mutation. */
  let staleOverOther = false;
  const observer = new dom.MutationObserver(() => {
    if (readyOn(host, OTHER) && windowUp()) staleOverOther = true;
  });
  observer.observe(dom.document.body, { childList: true, subtree: true });
  switchLater(OTHER);
  expect(await waitFor(() => readyOn(host, OTHER))).toBe(true);
  await settle();
  observer.disconnect();
  expect(staleOverOther).toBe(false);
  expect(windowUp()).toBe(false);
  expect(readerOf(host, reviewer)).toBeNull();

  switchTo(PROJECT);
  expect(await waitFor(() => readyOn(host, PROJECT))).toBe(true);
  await settle();
  expect(windowUp()).toBe(false);
  expect(readerOf(host, reviewer)).toBeNull();
  expect(presentationWrites).toEqual([]);
});

test("an attention jump to a conversation a card holds leaves the window and opens it in its card", async () => {
  const { host, land } = await openReviewer();
  land(implementer);
  expect(await waitFor(() => readerOf(host, implementer) === "card")).toBe(true);
  expect(windowUp()).toBe(false);
  expect(readerOf(host, reviewer)).toBeNull();
  expect(presentationWrites).toEqual([]);
});

test("a `#c=` landing on a conversation a card holds leaves the window and opens it in its card", async () => {
  const { host, land } = await openReviewer();
  land(implementer, true);
  expect(await waitFor(() => readerOf(host, implementer) === "card")).toBe(true);
  expect(windowUp()).toBe(false);
  expect(presentationWrites).toEqual([]);
});

test("another conversation no card holds takes the window from the first", async () => {
  const { host, land } = await openReviewer();
  land(earlierReviewer);
  expect(await waitFor(() => readerOf(host, earlierReviewer) === "window")).toBe(true);
  expect(readerOf(host, reviewer)).toBeNull();
  expect(dom.document.querySelectorAll(".reader-full").length).toBe(1);
});

for (const intent of ["show", "open"] as const) {
  test(`a focus handoff \`${intent}\` to a card leaves the window, and does not report arrival while the window is up`, async () => {
    const { host } = await openReviewer();
    /* Laid out: every box is the window, so only what covers the target decides arrival. */
    const prototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect(): unknown };
    const measured = prototype.getBoundingClientRect;
    prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, toJSON() {} });
    try {
      const board = focusHandoffBus.board()!;
      expect(board.project).toBe(PROJECT);
      const rect = board.index.rectFor(implementer.path);
      expect(rect).not.toBeNull();
      const destination = { rect: rect!, zoom: "inspect" as const, anchorKeys: [implementer.path], intent, path: implementer.path, requestId: `loose-${intent}` };
      /* Under the window, the implementer's card is not where the operator is. */
      expect(board.arrival!(destination)).toBeNull();

      let moved = false;
      flushSync(() => { moved = board.moveTo(destination); });
      expect(moved).toBe(true);
      expect(await waitFor(() => !windowUp())).toBe(true);
      expect(readerOf(host, reviewer)).toBeNull();
      if (intent === "open") expect(await waitFor(() => readerOf(host, implementer) === "card")).toBe(true);
      /* Arrived once nothing covers it. This harness streams no transcript, so an opened reader's feed never
         settles here and its card is what is on screen. */
      expect(await waitFor(() => focusHandoffBus.board()!.arrival!(destination) === "visible")).toBe(true);
    } finally {
      prototype.getBoundingClientRect = measured;
    }
    expect(presentationWrites).toEqual([]);
  });
}

test("a pipeline link on this project leaves the window and focuses the card that holds the pipeline", async () => {
  const { host } = await openReviewer();
  navigate(here.id);
  expect(await waitFor(() => focusedCard() === "task:task-here")).toBe(true);
  expect(windowUp()).toBe(false);
  expect(readerOf(host, reviewer)).toBeNull();
  expect(presentationWrites).toEqual([]);
});

test("a pipeline link to another project switches to it with no window, and focuses the card that holds the pipeline there", async () => {
  const { host, switchTo } = await openReviewer();
  navigate(there.id);
  expect(dom.location.hash).toBe(`#p=${encodeURIComponent(OTHER)}`);
  switchTo(OTHER);
  expect(await waitFor(() => focusedCard() === "task:task-there")).toBe(true);
  expect(windowUp()).toBe(false);
  expect(readerOf(host, reviewer)).toBeNull();
});
