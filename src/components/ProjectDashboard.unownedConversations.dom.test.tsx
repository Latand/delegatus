import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { Flow } from "@/lib/flows/types";
import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * Conversations no Board card holds (#1695, review of #1712): a review flow's
 * reviewer round, a collapsed worker, an engine's own subagent. The scheme drew
 * them; the Board lists them in Conversations, and every door that names one of
 * them (a catalog row, a search, a `#c=`/`#f=` link, an attention jump) must
 * still put its transcript and composer in front of the operator, with no
 * Scheme and no preference written. The real ProjectDashboard is mounted over
 * invented files; the board route is a scripted fetch.
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
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
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

const PROJECT = "unowned-conversations-project";
const now = Math.floor(Date.now() / 1000);
const base = {
  root: "codex-sessions", project: PROJECT, engine: "codex", kind: "session", fmt: "codex", size: 4_096,
  proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
};
const implementer = {
  ...base, path: "/repo/sessions/implementer.jsonl", name: "implementer.jsonl", title: "Implementer of the export presets",
  parent: null, mtime: now - 30, activity: "live", proc: "running", conversationId: "conversation_unowned_implementer",
} as unknown as FileEntry;
const reviewer = {
  ...base, path: "/repo/sessions/reviewer.jsonl", name: "reviewer.jsonl", title: "Reviewer round of the export presets",
  parent: null, mtime: now - 20, activity: "live", proc: "running", conversationId: "conversation_unowned_reviewer",
  durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation_unowned_implementer", reviewsConversationId: "conversation_unowned_implementer", memberships: [] },
} as unknown as FileEntry;
const worker = {
  ...base, path: "/repo/sessions/worker.jsonl", name: "worker.jsonl", title: "Worker that finished its lane",
  parent: implementer.path, mtime: now - 5 * 3_600, activity: "idle", proc: "killed", handoff: true, conversationId: "conversation_unowned_worker",
  authoritativeTurn: { state: "terminal", source: "lifecycle", terminalAt: new Date((now - 5 * 3_600) * 1000).toISOString() },
  durableLineage: { kind: "spawn", role: "builder", parentConversationId: "conversation_unowned_implementer", reviewsConversationId: null, memberships: [] },
} as unknown as FileEntry;
const engineChild = {
  ...base, path: "/repo/sessions/engine-child.jsonl", name: "engine-child.jsonl", title: "Explorer the engine spawned",
  parent: implementer.path, mtime: now - 3 * 3_600, activity: "idle", spawnOrigin: "engine", conversationId: "conversation_unowned_engine_child",
} as unknown as FileEntry;
const flow = {
  id: "flow-unowned", implementerPath: implementer.path, state: "reviewing", project: PROJECT,
  rounds: [{ n: 1, reviewerPath: reviewer.path, reviewerConversationId: reviewer.conversationId }],
} as unknown as Flow;

type Landing = { path: string; nonce: number; catalog?: boolean } | null;
const dashboardProps = (focusRequest: Landing) => ({
  files: [implementer, reviewer, worker, engineChild], flows: [flow], pipelines: [], workflows: [], tasks: [],
  project: PROJECT, loaded: true, openNonce: 0, archived: false, catalogKnown: true, catalogConversationCount: 4,
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
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

function mount(focusRequest: Landing = null) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(focusRequest)} />));
  roots.push(root);
  return {
    host: host as unknown as HTMLElement,
    rerender: (next: Landing) => flushSync(() => root.render(<ProjectDashboard {...dashboardProps(next)} />)),
  };
}

/* Where each lands: a reviewer round stays in its deck and opens in the window; the dashboard's jump places a
   collapsed worker or an engine's subagent on its spawner's card, and its reader opens there. */
const TARGETS = [["an active flow's reviewer round", reviewer, "window"], ["a collapsed worker", worker, "card"], ["an engine's own subagent", engineChild, "card"]] as const;
const boardShown = (host: HTMLElement) => host.querySelector("[data-kanban-board]") !== null;
/** No card draws it: no tile, and no reader inside a card. */
const onNoCard = (host: HTMLElement, file: FileEntry) =>
  host.querySelector(`[data-kanban-card] [data-member="${file.path}"]`) === null
  && host.querySelector(`[data-kanban-card] [data-link-path="${file.path}"]`) === null;
/** Its reader on the Board, with the transcript and the composer: the window or a card, or null. */
const holdsPath = (element: Element, file: FileEntry) => element.matches(`[data-link-path="${file.path}"]`) || element.querySelector(`[data-link-path="${file.path}"]`) !== null;
const readerOf = (host: HTMLElement, file: FileEntry): "window" | "card" | null => {
  const reader = Array.from(host.querySelectorAll("[data-kanban-reader]"))
    .find((element) => holdsPath(element, file) && element.querySelector("textarea"));
  if (!reader) return null;
  return reader.closest(".reader-full") ? "window" : reader.closest("[data-kanban-card]") ? "card" : null;
};
const boardReady = (host: HTMLElement) => boardShown(host) && host.querySelector(`[data-member="${implementer.path}"]`) !== null;

for (const [label, file, where] of TARGETS) {
  test(`${label}: on no card, and a catalog landing opens its transcript and composer on the Board, with nothing written`, async () => {
    const { host, rerender } = mount();
    expect(await waitFor(() => boardReady(host))).toBe(true);
    expect(onNoCard(host, file)).toBe(true);

    rerender({ path: file.path, nonce: 1, catalog: true });
    expect(await waitFor(() => readerOf(host, file) === where)).toBe(true);
    expect(boardShown(host)).toBe(true);
    expect(presentationWrites).toEqual([]);

    /* Closing it closes the reader, and the Board stays. */
    const reader = Array.from(host.querySelectorAll("[data-kanban-reader]")).find((element) => holdsPath(element, file))!;
    flushSync(() => (reader.querySelector("[data-reader-close]") as HTMLButtonElement).click());
    expect(await waitFor(() => readerOf(host, file) === null)).toBe(true);
    expect(boardShown(host)).toBe(true);
  });

  test(`${label}: an attention jump opens the same reader`, async () => {
    const { host, rerender } = mount();
    expect(await waitFor(() => boardReady(host))).toBe(true);
    rerender({ path: file.path, nonce: 1, catalog: false });
    expect(await waitFor(() => readerOf(host, file) === where)).toBe(true);
    expect(presentationWrites).toEqual([]);
  });

  test(`${label}: a focus handoff resolves it though no card holds it, opens its reader in the window, and its Return closes it`, async () => {
    const { host } = mount();
    expect(await waitFor(() => boardReady(host) && focusHandoffBus.board()?.project === PROJECT)).toBe(true);
    expect(onNoCard(host, file)).toBe(true);
    const board = focusHandoffBus.board()!;
    const rect = board.index.rectFor(file.path);
    expect(rect).not.toBeNull();
    let moved = false;
    flushSync(() => { moved = board.moveTo({ rect: rect!, zoom: "inspect", anchorKeys: [file.path], intent: "open", path: file.path, requestId: `handoff-${file.name}` }); });
    expect(moved).toBe(true);
    expect(await waitFor(() => readerOf(host, file) === "window")).toBe(true);
    focusHandoffBus.board()!.returnFromHandoff?.(`handoff-${file.name}`);
    expect(await waitFor(() => readerOf(host, file) === null && host.querySelector(".reader-full") === null)).toBe(true);
  });
}

test("under a standing landing, a card's link to Conversations opens Conversations", async () => {
  const { host, rerender } = mount();
  expect(await waitFor(() => boardReady(host))).toBe(true);
  /* A search lands on the implementer, and the landing stands. */
  rerender({ path: implementer.path, nonce: 1, catalog: true });
  expect(await waitFor(() => host.querySelector(`[data-kanban-card].has-reader [data-link-path="${implementer.path}"]`) !== null)).toBe(true);
  const link = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-kanban-card] .refs .ref"))
    .find((button) => (button.textContent ?? "").includes("Conversations"));
  expect(link).toBeDefined();
  flushSync(() => link!.click());
  expect(await waitFor(() => !boardShown(host) && host.textContent!.includes(translate("en", "list.title")))).toBe(true);
  expect(presentationWrites).toEqual([]);
});
