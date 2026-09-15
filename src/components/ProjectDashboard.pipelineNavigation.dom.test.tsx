import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * A pipeline link in an MCP call card (#1695, review of #1712): on the desktop
 * Board it reveals and focuses the card that holds the pipeline, in this project
 * or after switching to the pipeline's own. The scheme's builder it used to open
 * is gone. The real ProjectDashboard is mounted over invented records; the board
 * route is a scripted fetch.
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

const PROJECT = "pipeline-links-project";
const OTHER = "pipeline-links-other-project";
const iso = new Date().toISOString();
const builder = {
  path: "/repo/sessions/pipeline-builder.jsonl", name: "pipeline-builder.jsonl", title: "Builder of the index rebuild", project: OTHER,
  root: "claude-projects", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: Math.floor(Date.now() / 1000) - 60, size: 1,
  activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, conversationId: "conversation_pipeline_builder",
} as unknown as FileEntry;
const builderRole = { roleId: "builder", engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null };
const pipelineFor = (id: string, project: string, taskId: string) => ({
  id, task: "Rebuild the search index", taskIds: [taskId], project, state: "running", repoDir: "/repo", worktreeDir: "/repo/worktree", branch: "b", baseBranch: "main",
  stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build it.", next: null, onFail: null, effectiveRole: builderRole }],
  runs: [{ stageId: "build", attempts: [{
    n: 1, state: "running", effectiveRole: builderRole, launchId: null, conversationId: builder.conversationId, sessionId: null, agentPath: builder.path, paneId: null, flowId: null,
    startedAt: iso, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
  }] }],
  cursor: { stageId: "build", state: "running", input: null, activatedBy: null }, createdAt: iso,
}) as unknown as Pipeline;
const taskFor = (id: string, project: string, text: string) => ({
  id, project, status: "assigned", text, placement: "unplaced", assignments: [], createdAt: iso, updatedAt: iso,
}) as unknown as BoardTask;

const here = pipelineFor("pipeline-here", PROJECT, "task-here");
const there = pipelineFor("pipeline-there", OTHER, "task-there");
const tasks = [taskFor("task-here", PROJECT, "Rebuild the search index here"), taskFor("task-other", PROJECT, "Another task on this board"), taskFor("task-there", OTHER, "Rebuild the search index there")];

const dashboardProps = (project: string) => ({
  files: project === OTHER ? [builder] : [{ ...builder, project: PROJECT }], flows: [], pipelines: [here, there], workflows: [], tasks,
  project, loaded: true, openNonce: 0, archived: false, catalogKnown: true, catalogConversationCount: 1,
  projectCwd: "/repo", onArchive: () => {}, onUnarchive: () => {}, onOpenSearch: () => {},
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

function mount(project: string) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(project)} />));
  roots.push(root);
  return { host: host as unknown as HTMLElement, switchTo: (next: string) => flushSync(() => root.render(<ProjectDashboard {...dashboardProps(next)} />)) };
}

const focusedCard = () => (dom.document.activeElement as unknown as HTMLElement | null)?.closest?.("[data-kanban-card]")?.getAttribute("data-kanban-card") ?? null;
const navigate = (id: string) => dom.dispatchEvent(new dom.CustomEvent("llv:mcp-navigate", { detail: { kind: "pipeline", id } }));

test("a pipeline link on this project's Board focuses the card that holds the pipeline", async () => {
  const { host } = mount(PROJECT);
  expect(await waitFor(() => host.querySelector('[data-kanban-card="task:task-here"]') !== null)).toBe(true);
  (host.querySelector('[data-kanban-card="task:task-other"]') as HTMLElement | null)?.focus();
  expect(focusedCard()).not.toBe("task:task-here");
  navigate(here.id);
  expect(await waitFor(() => focusedCard() === "task:task-here")).toBe(true);
  expect(presentationWrites).toEqual([]);
});

test("a pipeline link to another project switches to it, then focuses the card that holds the pipeline there", async () => {
  const { host, switchTo } = mount(PROJECT);
  expect(await waitFor(() => host.querySelector('[data-kanban-card="task:task-here"]') !== null)).toBe(true);
  navigate(there.id);
  expect(dom.location.hash).toBe(`#p=${encodeURIComponent(OTHER)}`);
  expect(dom.sessionStorage.getItem("llvPipelineFocus")).toBe(there.id);
  /* The Viewer answers the hash by showing the pipeline's project. */
  switchTo(OTHER);
  expect(await waitFor(() => focusedCard() === "task:task-there")).toBe(true);
  expect(dom.sessionStorage.getItem("llvPipelineFocus")).toBeNull();
});
