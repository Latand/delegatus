import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import { translate } from "@/lib/i18n";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * #2098 end to end on the phone: the real Viewer on the Overview, its file
 * poll, its bar and the board under it. The Overview is the phone kanban a
 * project draws, over every project: the same tabs, the same cards (each
 * naming its project by its display name, never by its key), the same card
 * sheet. A card opens what a project's card opens, as a SCREEN over the
 * Overview: the task screen, or the conversation full screen; nothing on the
 * phone opens a conversation inside a card. ‹ comes back to the Overview on
 * the column it left.
 *
 * Four invented projects: three with names, one whose key is an opaque hash
 * and whose name nobody knows, so its card says no project at all rather
 * than the key.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const matchMedia = (query: string) => ({
  matches: String(query) === MOBILE_LAYOUT_QUERY || String(query).includes("pointer: coarse"),
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
const { receipts } = await import("./mobile/MobileReceipt");
const { getMobileNav } = await import("./mobile/mobileNav");
const { resetPhoneKanbanPlaces } = await import("./mobile/phoneKanbanPlace");
const { resetOrchestratorSeatCacheForTests } = await import("./orchestrator/useOrchestratorSeat");

const NOW = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();
const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);

/* Canonical keys the way a repository resolves: opaque hashes nobody reads. */
const LEDGER = "repo-aaaa000011112222";
const ATLAS = "repo-bbbb000011112222";
const MESH = "repo-cccc000011112222";
const NAMELESS = "repo-dddd000011112222";
const NAMES: Record<string, string> = { [LEDGER]: "acme-ledger", [ATLAS]: "dune-atlas", [MESH]: "river-mesh" };

const workingTurn = { startedAt: (NOW - 120) * 1000, endedAt: null };
function conversation(path: string, project: string, title: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    root: "claude-projects", name: path.split("/").pop(), path, project, title, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 30, size: 2_048, activity: "live", proc: "running", pid: null, model: "opus",
    pendingQuestion: null, waitingInput: null, conversationId: `conversation_${path.replace(/\W/g, "_")}`,
    lastTurn: workingTurn, lastAgentWorkAt: (NOW - 30) * 1000,
    ...extra,
  } as unknown as FileEntry;
}
const REVISION = ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-");
function task(id: string, project: string, status: TaskStatus, text: string, path: string | null, extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id, project, text, status, placement: "unplaced", revision: REVISION,
    assignments: path ? [{ path, conversationId: null, panePid: null, state: "delivered", error: null, at: iso(3_600) }] : [],
    createdAt: iso(7_200), updatedAt: iso(3_600),
    ...extra,
  } as BoardTask;
}

const LEDGER_BUILDER = "/sessions/ledger-builder.jsonl";
const ATLAS_REVIEWER = "/sessions/atlas-reviewer.jsonl";
const MESH_PLANNER = "/sessions/mesh-planner.jsonl";
const MESH_LOOSE = "/sessions/mesh-loose.jsonl";
const NAMELESS_WORKER = "/sessions/nameless-worker.jsonl";

const FILES: FileEntry[] = [
  conversation(LEDGER_BUILDER, LEDGER, "Builder of the ledger export"),
  conversation(ATLAS_REVIEWER, ATLAS, "Reviewer of the atlas legend"),
  conversation(MESH_PLANNER, MESH, "Planner of the mesh migration", {
    activity: "idle", proc: null, lastTurn: { startedAt: (NOW - 900) * 1000, endedAt: (NOW - 600) * 1000 },
    pendingQuestion: { kind: "question", toolUseId: "tool-mesh", transcriptPath: MESH_PLANNER, pid: 1, paneTarget: null, askedAt: iso(540), questions: [{ question: "Which schema stays?", header: "Schema", multiSelect: false, options: [] }] },
  } as Partial<FileEntry>),
  conversation(MESH_LOOSE, MESH, "Sweep the stale mesh caches"),
  conversation(NAMELESS_WORKER, NAMELESS, "Worker with no project name"),
];
const TASKS: BoardTask[] = [
  task("t-ledger", LEDGER, "assigned", "Reconcile the ledger export", LEDGER_BUILDER),
  task("t-atlas", ATLAS, "inbox", "Redraw the atlas legend", ATLAS_REVIEWER),
  task("t-mesh", MESH, "blocked", "Unblock the mesh migration", MESH_PLANNER),
  task("t-nameless", NAMELESS, "assigned", "Keep the nameless worker going", NAMELESS_WORKER),
  /* An empty task taken off the board: ⋯ › Hidden tasks is where it is. */
  task("t-off", ATLAS, "inbox", "An empty atlas task nobody started", null, { board: "hidden" } as Partial<BoardTask>),
];

const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});
const boards = new Map<string, BoardProjectStateV1>();
const taskPatches: Array<{ url: string; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/files")) {
      return Response.json({
        files: FILES,
        projectCatalog: [LEDGER, ATLAS, MESH, NAMELESS].map((project) => ({ project, conversations: 2, smt: NOW - 30 })),
        projectDisplayNames: NAMES,
        flows: [], pipelines: [], workflows: [], tasks: TASKS, systemHealth: { tmux: { status: "healthy" } },
      });
    }
    if (url.startsWith("/api/board")) {
      /* One board per project, written the way the server writes it: a write
         answered with an unchanged revision would read as never landing, and
         the store would send it again for good. */
      const body = method === "GET" ? null : JSON.parse(String(init?.body)) as { project?: string; mutations?: BoardMutationV1[] };
      const key = body?.project ?? new URL(url, "http://localhost").searchParams.get("project") ?? "";
      const current = boards.get(key) ?? emptyBoard();
      if (body) {
        const reduced = applyBoardMutations(current, body.mutations ?? []);
        const next = { ...reduced, schemaVersion: 1, revision: current.revision + 1, pathAliases: reduced.pathAliases ?? {} } as BoardProjectStateV1;
        boards.set(key, next);
        return Response.json({ ok: true, applied: true, board: next });
      }
      return Response.json({ ok: true, board: current });
    }
    if (url.startsWith("/api/orchestrator/seat")) {
      if (url.includes("all=")) return Response.json({ all: { conversationIds: [], paths: [], previous: { conversationIds: [], paths: [] } } });
      return Response.json({ seat: null, pending: null, exists: true });
    }
    if (url.startsWith("/api/tasks/") && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      taskPatches.push({ url, body });
      const id = decodeURIComponent(url.slice("/api/tasks/".length));
      return Response.json({ task: { ...TASKS.find((row) => row.id === id), ...body } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  resetFilesClientCacheForTests();
  resetPhoneKanbanPlaces();
  resetOrchestratorSeatCacheForTests();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  dom.history.replaceState(null, "", "/");
  dom.document.body.replaceChildren();
  taskPatches.length = 0;
  boards.clear();
  receipts.dismiss();
  getMobileNav().home();
  stubFetch();
});

afterEach(() => {
  if (mounted) {
    const root = mounted;
    mounted = null;
    act(() => root.unmount());
  }
  receipts.dismiss();
  globalThis.fetch = originalFetch;
  dom.document.body.replaceChildren();
});

async function mountOverview(): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  await until(() => Boolean(host.querySelector("[data-phone-kanban] [data-phone-card]")));
  return host as unknown as HTMLElement;
}

async function until(check: () => boolean, maxMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > maxMs) throw new Error(`not reached within ${maxMs} ms`);
    await act(async () => { await Bun.sleep(15); });
  }
}

async function tap(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("nothing to tap");
  await act(async () => { (element as HTMLElement).click(); });
}

/** ‹ in the bar is the platform back; the popstate it causes is dispatched
    here, with the entry the traversal lands on, as a browser would. */
async function back(host: HTMLElement): Promise<void> {
  await tap(host.querySelector("[data-mobile2-back]"));
  await act(async () => {
    window.dispatchEvent(new dom.PopStateEvent("popstate", { state: dom.history.state }) as unknown as Event);
    await Bun.sleep(15);
  });
}

const column = (host: HTMLElement, status: TaskStatus) => host.querySelector(`[data-phone-kanban-column="${status}"]`) as HTMLElement | null;
/* Scoped to the element it is given: happy-dom does not match a descendant
   selector whose ancestor sits outside that element. */
const cardTitled = (within: HTMLElement, title: string) =>
  [...within.querySelectorAll("[data-phone-card]")].find((card) => card.textContent?.includes(title)) as HTMLElement | undefined;
/** The full-screen conversation on top of the stack, for this transcript. */
const conversationScreen = (host: HTMLElement, path: string) => {
  const stack = getMobileNav().getState().stack;
  const top = stack[stack.length - 1];
  return top?.kind === "chat" && top.id === path ? host.querySelector('[data-mobile2-screen="chat"]') : null;
};
const conversationId = (path: string) => `conversation_${path.replace(/\W/g, "_")}`;
/** Anything that would draw a conversation inside a card: the desktop board
    and its readers, or a feed (`LogFeed`) inside a card. The phone draws a
    feed only on a conversation screen. */
const FEED = "[data-feed-state], [data-feed-key]";
const inlineConversation = (host: HTMLElement) =>
  host.querySelector("[data-kanban-reader], [data-reader-slot], [data-kanban-board]")
  ?? [...host.querySelectorAll("[data-phone-card]")].find((card) => card.querySelector(`${FEED}, [data-mobile2-conversation]`));

test("on the phone the Overview is the phone kanban over every project, each card naming its project", async () => {
  const host = await mountOverview();

  /* The phone kanban, and nothing of the desktop board squeezed to 390 px:
     no board, no «Find a task», no «Hidden N» chip. */
  expect(host.querySelector("[data-phone-kanban]")).not.toBeNull();
  expect(host.querySelector("[data-kanban-board]")).toBeNull();
  expect(host.querySelector("[data-kanban-search]")).toBeNull();
  expect(host.querySelector("[data-hidden-pill]")).toBeNull();
  expect([...host.querySelectorAll("[data-phone-kanban-tab]")].map((tab) => tab.getAttribute("data-phone-kanban-tab"))).toEqual(["inbox", "assigned", "blocked", "done"]);

  /* Cards from four projects, in the desktop's columns. */
  expect(cardTitled(column(host, "assigned")!, "Reconcile the ledger export")).toBeTruthy();
  expect(cardTitled(column(host, "assigned")!, "Keep the nameless worker going")).toBeTruthy();
  expect(cardTitled(column(host, "inbox")!, "Redraw the atlas legend")).toBeTruthy();
  expect(cardTitled(column(host, "blocked")!, "Unblock the mesh migration")).toBeTruthy();
  /* The work no task owns is Inbox's «Not on a task». */
  expect(column(host, "inbox")!.querySelector("[data-phone-kanban-unlinked]")).not.toBeNull();
  expect(cardTitled(column(host, "inbox")!, "Sweep the stale mesh caches")?.getAttribute("data-phone-card-kind")).toBe("conversation");

  /* Each card says whose it is, by the name the rail shows. A project with no
     readable name says nothing: a key is never shown. */
  const projectOf = (title: string) => cardTitled(host, title)?.querySelector("[data-phone-card-project]")?.textContent ?? null;
  expect(projectOf("Reconcile the ledger export")).toBe("acme-ledger");
  expect(projectOf("Redraw the atlas legend")).toBe("dune-atlas");
  expect(projectOf("Unblock the mesh migration")).toBe("river-mesh");
  expect(projectOf("Sweep the stale mesh caches")).toBe("river-mesh");
  expect(projectOf("Keep the nameless worker going")).toBeNull();
  expect(host.querySelector("[data-phone-kanban]")!.textContent).not.toContain("repo-");

  /* The tabs count what the Overview draws, and carry the marks: the mesh
     question needs the operator in Blocked, two agents work in Assigned. */
  const tab = (status: TaskStatus) => host.querySelector(`[data-phone-kanban-tab="${status}"]`)!;
  expect(tab("assigned").querySelector("[data-phone-tab-count]")?.textContent).toBe("2");
  expect(tab("assigned").querySelector("[data-phone-tab-working]")?.textContent).toBe("2");
  expect(tab("blocked").querySelector("[data-phone-tab-needs]")?.textContent).toBe("1");
  /* The bar says the Overview is narrowed to live work, once. */
  expect(host.querySelector("[data-mobile2-title-meta]")?.textContent).toBe(en("mobile2.overview.workingNow"));

  /* Done holds no live work here: it says so for itself, points where the
     work is, and offers nothing that needs one project to write into. */
  await tap(host.querySelector('[data-phone-kanban-tab="done"]'));
  const empty = column(host, "done")!.querySelector("[data-phone-kanban-empty]")!;
  expect(empty.textContent).toContain(en("mobile2.overview.emptyColumn", { column: en("kanban.status.done") }));
  expect(empty.textContent).toContain(en("overview.noneWorkingHint"));
  expect(empty.querySelector("[data-phone-kanban-empty-action]")).toBeNull();
  expect(empty.querySelector("[data-phone-kanban-nearest]")?.getAttribute("data-phone-kanban-nearest")).toBe("blocked");
});

test("a card opens the task screen over the Overview, and ‹ comes back to the same column", async () => {
  const host = await mountOverview();
  await tap(host.querySelector('[data-phone-kanban-tab="blocked"]'));
  expect(host.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active")).toBe("blocked");

  await tap(cardTitled(host, "Unblock the mesh migration"));
  await until(() => Boolean(host.querySelector('[data-mobile2-screen="task"][data-mobile2-task="t-mesh"]')));
  /* The task's own screen, drawn by its project's dashboard: nothing of the
     Overview's board under it, and the conversation that asks is one of its
     agents, a row that opens it (never a feed on this screen). */
  expect(host.querySelector("[data-phone-kanban]")).toBeNull();
  expect(host.textContent).toContain("Unblock the mesh migration");
  expect(inlineConversation(host)).toBeFalsy();

  await back(host);
  await until(() => Boolean(host.querySelector("[data-phone-kanban]")));
  expect(host.querySelector("[data-mobile2-task]")).toBeNull();
  expect(host.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active")).toBe("blocked");
});

test("a conversation opens full screen, never inside a card: a row no task owns, and a card's Open first agent", async () => {
  const host = await mountOverview();
  await tap(host.querySelector('[data-phone-kanban-tab="inbox"]'));

  /* A row no task owns opens its conversation as a screen over the Overview. */
  await tap(cardTitled(host, "Sweep the stale mesh caches"));
  await until(() => Boolean(conversationScreen(host, MESH_LOOSE)));
  expect(conversationScreen(host, MESH_LOOSE)?.getAttribute("data-mobile2-conversation")).toBe(conversationId(MESH_LOOSE));
  /* Its feed is the screen's, full width: the one place a phone draws one. */
  await until(() => Boolean(conversationScreen(host, MESH_LOOSE)?.querySelector(FEED)));
  expect(host.querySelector("[data-phone-kanban]")).toBeNull();
  expect(inlineConversation(host)).toBeFalsy();
  /* The conversation's link rides the entry, and the Overview stays under it. */
  expect(dom.location.hash).toContain("#c=");
  await back(host);
  await until(() => Boolean(host.querySelector("[data-phone-kanban]")));
  expect(host.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active")).toBe("inbox");
  expect(inlineConversation(host)).toBeFalsy();

  /* The card sheet a long-press opens: «Open first agent» is the same screen. */
  const card = cardTitled(host, "Redraw the atlas legend")!;
  await act(async () => {
    card.parentElement!.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  const sheet = dom.document.querySelector("[data-phone-card-sheet]") as unknown as HTMLElement;
  expect(sheet).not.toBeNull();
  /* The same card sheet a project's card has: the moves, Hide, Open first agent. */
  expect(sheet.querySelector('[data-phone-card-action="move-assigned"]')).not.toBeNull();
  expect(sheet.querySelector('[data-phone-card-action="hide"]')).not.toBeNull();
  await tap(sheet.querySelector('[data-phone-card-action="open-agent"]'));
  await until(() => Boolean(conversationScreen(host, ATLAS_REVIEWER)));
  expect(conversationScreen(host, ATLAS_REVIEWER)?.getAttribute("data-mobile2-conversation")).toBe(conversationId(ATLAS_REVIEWER));
  expect(inlineConversation(host)).toBeFalsy();
});

test("the Needs-you sheet over the Overview opens its conversation full screen over the Overview", async () => {
  const host = await mountOverview();
  await until(() => host.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") === "1");

  await tap(host.querySelector('[data-mobile2-open="attention"]'));
  const row = dom.document.querySelector("[data-attention-row]") as unknown as HTMLElement;
  expect(row).not.toBeNull();
  await tap(row);
  await until(() => Boolean(conversationScreen(host, MESH_PLANNER)));
  expect(conversationScreen(host, MESH_PLANNER)?.getAttribute("data-mobile2-conversation")).toBe(conversationId(MESH_PLANNER));
  expect(inlineConversation(host)).toBeFalsy();

  /* ‹ lands on the Overview, not on the conversation's project board. */
  await back(host);
  await until(() => Boolean(host.querySelector("[data-phone-kanban]")));
  expect(host.querySelector('[data-testid="overview-search"]')).not.toBeNull();
});

test("⋯ lists the hidden tasks of every project, and Show brings one back", async () => {
  const host = await mountOverview();
  await tap(host.querySelector('[data-mobile2-open="menu"]'));
  const row = dom.document.querySelector('[data-mobile2-open="hidden"]') as unknown as HTMLElement;
  expect(row).not.toBeNull();
  expect(row.textContent).toContain(en("kanban.hiddenTitle"));
  expect(row.textContent).toContain("1");

  await tap(row);
  const sheet = dom.document.querySelector("[data-phone-hidden-sheet]") as unknown as HTMLElement;
  expect(sheet?.getAttribute("data-phone-hidden-sheet")).toBe("1");
  const hidden = sheet.querySelector('[data-phone-hidden-row="t-off"]') as HTMLElement;
  expect(hidden.textContent).toContain("An empty atlas task nobody started");
  expect(hidden.textContent).toContain("dune-atlas");

  await tap(hidden.querySelector("[data-phone-hidden-show]"));
  await until(() => taskPatches.length > 0);
  expect(taskPatches[0]).toEqual({ url: "/api/tasks/t-off", body: { board: "shown" } });
});


test("a screen the Overview cannot place sends the stack home, and the next card still opens its task", async () => {
  const host = await mountOverview();
  /* A task that is gone, reached again through the history. */
  await act(async () => { getMobileNav().push({ kind: "task", id: "t-deleted" }); });
  await until(() => getMobileNav().getState().stack.length === 1);
  expect(host.querySelector("[data-phone-kanban]")).not.toBeNull();

  await tap(cardTitled(host, "Reconcile the ledger export"));
  await until(() => Boolean(host.querySelector('[data-mobile2-screen="task"][data-mobile2-task="t-ledger"]')));
});
