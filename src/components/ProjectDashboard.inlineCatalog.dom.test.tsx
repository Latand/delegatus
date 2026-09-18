import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { clearRetainedConversationPages } from "@/hooks/useConversationCatalog";
import { translate } from "@/lib/i18n";
import { emptyStore } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";

/* Real Home and catalog hook. Fetch is fully intercepted; deferred responses
   exercise the same cursor and navigation seams used by the browser fixture. */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "live" as const, resyncedAt: null, store: emptyStore(), structuredHostsEnabled: false, lastEventAt: null };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => inertRuntime,
  useRuntime: () => inertRuntime,
  useRuntimeSelector: (selector: (state: typeof inertRuntime) => unknown) => selector(inertRuntime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));


const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileSheet } = await import("@/components/mobile/MobileSheet");
const { getMobileNav, topScreen } = await import("@/components/mobile/mobileNav");
const { receipts } = await import("@/components/mobile/MobileReceipt");
const { resetOrchestratorIncumbentCacheForTests } = await import("@/components/orchestrator/useOrchestratorIncumbent");
const { resetOrchestratorSeatCacheForTests } = await import("@/components/orchestrator/useOrchestratorSeat");
type MobileShellHost = NonNullable<React.ComponentProps<typeof ProjectDashboard>["mobileShell"]>;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
let mutations: Array<Record<string, unknown>> = [];
const emptyPrefs = () => ({
  manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [],
  expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false, seenAt: {},
});
const boardState = () => ({
  schemaVersion: 1, revision: boardRevision, updatedAt: new Date(0).toISOString(),
  pathAliases: {}, explicitManual: [], prefs: { ...emptyPrefs(), ...boardPrefs },
});
const jsonResponse = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class {
    callback: () => void;
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { this.callback = () => callback([{ isIntersecting: true }]); }
    observe(target: HTMLElement) { if (target.hasAttribute("data-catalog-sentinel")) observers.add(this.callback); }
    unobserve() {}
    disconnect() { observers.delete(this.callback); }
    takeRecords() { return []; }
  },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          patch?: Record<string, unknown>;
          mutations?: Array<Record<string, unknown>>;
        };
        for (const mutation of body.mutations ?? []) mutations.push(mutation);
        if (body.patch) boardPrefs = { ...boardPrefs, ...body.patch };
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/conversations")) { catalogRequests.push(url); return catalogReply(new URL(url, "http://localhost")); }
    /* No orchestrator seat in this project by default: the board's seat slot
       invites one and no row is filtered out of the sections. A test that needs
       the footer seats one first. */
    if (url.startsWith("/api/orchestrator/seat/status")) {
      incumbentReads += 1;
      return jsonResponse(incumbentAnswer);
    }
    if (url.startsWith("/api/orchestrator/seat")) {
      seatReads += 1;
      if (seatFailure) return { ok: false, status: 503, json: async () => ({}) };
      return jsonResponse({ seat: seatAnswer, pending: null, exists: true });
    }
    if (url.startsWith("/api/limits")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
/** The project's seat, as `/api/orchestrator/seat` answers it; null by default. */
let seatAnswer: Record<string, unknown> | null = null;
/** How many times this phone has asked for it. */
let seatReads = 0;
let incumbentReads = 0;
let incumbentAnswer: Record<string, unknown> | null = null;

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
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const PROJECT = "atlas";
const NOW = Math.floor(Date.now() / 1000);

const file = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
  root: "claude-projects", name: over.path.split("/").pop(), project: PROJECT,
  title: "A conversation", engine: "claude", kind: "session", fmt: "claude", parent: null,
  mtime: NOW - 120, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
  pendingQuestion: null, waitingInput: null, conversationId: `conversation_${over.path}`,
  ...over,
} as unknown as FileEntry);

const asking = file({
  path: "/repo/ask.jsonl",
  title: "Implement the export endpoint",
  activity: "live", proc: "running", pid: 4_402,
  lastTurn: { startedAt: (NOW - 600) * 1_000, endedAt: null },
  pendingQuestion: {
    kind: "question", toolUseId: "toolu-export", transcriptPath: "/repo/ask.jsonl", pid: 4_402, paneTarget: null,
    askedAt: new Date((NOW - 540) * 1_000).toISOString(),
    questions: [{ question: "Which format?", header: "Format", multiSelect: false, options: [] }],
  },
} as unknown as Partial<FileEntry> & { path: string });

const running = file({
  path: "/repo/run.jsonl",
  title: "Rebuild the board status projection",
  activity: "live", proc: "running", pid: 4_401, mtime: NOW - 30,
  lastTurn: { startedAt: (NOW - 760) * 1_000, endedAt: null },
  plan: { steps: [], done: 2, total: 5, current: "Add the held precedence", updatedAt: null },
} as unknown as Partial<FileEntry> & { path: string });

const finished = file({ path: "/repo/done.jsonl", title: "Tail: pipeline archive TTL", activity: "recent", mtime: NOW - 900 });

let sheetOpens: string[] = [];
let opened: string[] = [];
const host = (attentionCount: number): MobileShellHost => ({
  attentionCount,
  arrival: null,
  renderSheet: (name, close) => {
    sheetOpens.push(name);
    return (
      <MobileSheet name={name} title={name} onClose={close}>
        <div data-testid={`${name}-sheet-stub`} />
      </MobileSheet>
    );
  },
});

const dashboardProps = (over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}) => ({
  files: [asking, running, finished], flows: [], pipelines: [], workflows: [], tasks: [],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 12,
  projectCwd: "/repo",
  onArchive: () => {}, onUnarchive: () => {},
  onOpenSearch: () => {},
  onOpenCatalogFile: (entry: FileEntry) => { opened.push(entry.path); },
  mobileShell: host(1),
  ...over,
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  /* Scoped catalog pages are retained across mounts (#1614), so without this
     one case's loaded pages would be the next case's first paint — and the
     request counts below would count the previous test's work. */
  clearRetainedConversationPages();
  catalogRequests.length = 0;
  observers.clear();
  seatFailure = false;
  catalogReply = defaultCatalogReply;
  sheetOpens = [];
  opened = [];
  mutations = [];
  boardRevision = 1;
  boardPrefs = {};
  dom.document.body.replaceChildren();
  dom.document.body.style.overflow = "";
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  getMobileNav().home();
  receipts.dismiss();
  seatAnswer = null;
  seatReads = 0;
  incumbentReads = 0;
  incumbentAnswer = null;
  resetOrchestratorIncumbentCacheForTests();
  /* The seat read is cached per project for the whole module (#1149), so a
     test that seats one has to start from an unanswered cache. */
  resetOrchestratorSeatCacheForTests();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); await settle(); });

function mount(over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(over)} />));
  roots.push(root);
  return container as unknown as HTMLElement;
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
const all = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };
const board = (root: HTMLElement) => q(root, "[data-mobile2-board]");

const observers = new Set<() => void>();
let seatFailure = false;
const catalogRequests: string[] = [];
const catalogItems = Array.from({ length: 45 }, (_, i) => file({ path: `/repo/history-${i}.jsonl`, title: `History ${i}` }));

const defaultCatalogReply = (url: URL) => {
  const offset = Number(url.searchParams.get("cursor") ?? 0);
  return jsonResponse({ items: catalogItems.slice(offset, offset + 20), nextCursor: offset + 20 < 45 ? String(offset + 20) : null, total: 4232 });
};
let catalogReply: (url: URL) => unknown = defaultCatalogReply;
const intersect = () => flushSync(() => { for (const callback of [...observers]) callback(); });
/* Recent rows the feed itself carries past the board's first three (#1671). */
const feedRows = (count: number) => Array.from({ length: count }, (_, i) => file({ path: `/repo/feed-${i}.jsonl`, title: `Feed ${i}`, mtime: NOW - 1_000 - i }));
/* Every row of the Recent list, in order: the three first and all that «All
   conversations» appended under them. */
const anchors = (root: HTMLElement) => all(root, "[data-catalog-path]").map((el) => el.dataset.catalogPath!);

test("All conversations appends the feed's own Recent rows first with no request, then project pages of twenty in the same rows", async () => {
  const feed = feedRows(4);
  const root = mount({ files: [asking, running, finished, ...feed] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(anchors(root)).toEqual([finished.path, feed[0]!.path, feed[1]!.path]);
  const hash = dom.location.hash;

  click(q(root, '[data-mobile2-row="catalog"]'));
  /* The rest of the feed's rows, from memory. */
  expect(anchors(root)).toEqual([finished.path, ...feed.map((row) => row.path)]);
  await settle();
  expect(catalogRequests).toHaveLength(0);
  expect(q(root, '[data-mobile2-row="catalog"]')!.textContent).toContain(translate("en", "mobile2.board.showFewer"));
  /* One list: no search field, no refresh button, no hint line. */
  expect(q(root, 'input[type="search"]')).toBeNull();
  expect(root.textContent).not.toContain(translate("en", "mobile.catalog.refresh"));
  expect(root.textContent).not.toContain(translate("en", "mobile.catalog.hint"));

  /* The end of those rows coming into view reads the project's own catalog. */
  intersect();
  expect(await waitFor(() => anchors(root).length === 5 + 20)).toBe(true);
  expect(catalogRequests).toHaveLength(1);
  const request = new URL(catalogRequests[0]!, "http://localhost");
  expect(request.searchParams.get("limit")).toBe("20");
  expect(request.searchParams.get("project")).toBe(PROJECT);
  expect(request.searchParams.has("q")).toBe(false);
  expect(q(root, '[data-mobile2-row="catalog"]')!.textContent).toContain("4232");
  expect(board(root)).not.toBeNull();
  expect(dom.location.hash).toBe(hash);

  /* Every appended row is the board's own conversation row, swipe and all. */
  const stored = q(root, `[data-catalog-path="${catalogItems[0]!.path}"]`)!;
  const fromFeed = q(root, `[data-catalog-path="${feed[3]!.path}"]`)!;
  for (const row of [stored, fromFeed]) {
    expect(row.getAttribute("data-mobile2-row")).toBe("conversation");
    expect(row.closest("[data-mobile2-swipe-row]")).not.toBeNull();
    expect(row.className).toContain("bg-quiet");
  }
  /* A stored row past the scan opens through the resolver that pins it. */
  click(stored);
  expect(opened).toEqual([catalogItems[0]!.path]);
});

test("a page never repeats a row: what the board lists, a closed card and an entry two pages share appear once", async () => {
  const feed = feedRows(4);
  const closed = "/repo/closed.jsonl";
  /* The board store keeps each project's settled board across mounts, so the
     closed card is served at a revision no earlier case reached. */
  boardRevision = 1_000;
  boardPrefs = { hidden: [closed] };
  const page = (items: FileEntry[], nextCursor: string | null) => jsonResponse({ items, nextCursor, total: 60 });
  const history = (i: number) => catalogItems[i]!;
  catalogReply = (url) => {
    const cursor = url.searchParams.get("cursor");
    if (!cursor) return page([finished, running, feed[3]!, file({ path: closed, title: "Closed card" }), history(0), history(1)], "p2");
    if (cursor === "p2") return page([history(1), history(2), asking], "p3");
    return page([history(3)], null);
  };
  const root = mount({ files: [asking, running, finished, ...feed] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  click(q(root, '[data-mobile2-row="catalog"]'));
  intersect();
  expect(await waitFor(() => anchors(root).includes(history(1).path))).toBe(true);
  await settle(); intersect();
  expect(await waitFor(() => anchors(root).includes(history(2).path))).toBe(true);
  await settle(); intersect();
  expect(await waitFor(() => anchors(root).includes(history(3).path))).toBe(true);
  expect(anchors(root)).toEqual([finished.path, ...feed.map((row) => row.path), history(0).path, history(1).path, history(2).path, history(3).path]);
  const paths = all(root, "[data-mobile2-path]").map((el) => el.getAttribute("data-mobile2-path"));
  expect(paths.filter((path) => path === running.path)).toHaveLength(1);
  expect(paths.filter((path) => path === asking.path)).toHaveLength(1);
  expect(paths).not.toContain(closed);
  expect(catalogRequests).toHaveLength(3);
});

test("existing manager with null seat path resolves by durable identity in the footer", async () => {
  seatAnswer = { project: PROJECT, seatEpoch: 1, conversationId: running.conversationId, path: null,
    mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-atlas-null", mode: "existing", launchId: null, error: null } };
  const root = mount();
  expect(await waitFor(() => seatReads > 0 && q(root, '[data-mobile2-board-dock]') !== null)).toBe(true);
  await settle();
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.board.tellOrchestrator"));
  click(q(root, '[data-mobile2-board-dock]'));
  expect(await waitFor(() => topScreen(getMobileNav().getState()).kind === "chat")).toBe(true);
});


test("pages append once across polls, Show fewer collapses to three, reopening needs no request, and the last page ends the list", async () => {
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  click(q(root, '[data-mobile2-row="catalog"]'));
  intersect();
  expect(await waitFor(() => anchors(root).length === 1 + 20)).toBe(true);
  await settle();
  intersect(); intersect();
  expect(await waitFor(() => anchors(root).length === 1 + 40)).toBe(true);
  expect(catalogRequests).toHaveLength(2);
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps({ files: [asking, { ...running, mtime: NOW + 90 }, finished] })} />));
  await settle(); expect(catalogRequests).toHaveLength(2);
  /* Feed order, then the catalog's own order; a poll re-sorts nothing. */
  expect(anchors(root)).toEqual([finished.path, ...catalogItems.slice(0, 40).map((row) => row.path)]);
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(anchors(root)).toEqual([finished.path]);
  expect(q(root, '[data-mobile2-row="catalog"]')!.textContent).toContain(translate("en", "mobile2.board.allConversations"));
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(anchors(root)).toHaveLength(41);
  expect(catalogRequests).toHaveLength(2);
  await settle(); intersect();
  expect(await waitFor(() => anchors(root).length === 46)).toBe(true);
  expect(await waitFor(() => root.textContent!.includes(translate("en", "mobile.catalog.end")))).toBe(true);
  intersect(); await settle(); expect(catalogRequests).toHaveLength(3);
  expect(new Set(anchors(root)).size).toBe(46);
});

test("each project keeps its own expansion and pages, and the list never searches", async () => {
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  click(q(root, '[data-mobile2-row="catalog"]'));
  intersect();
  expect(await waitFor(() => anchors(root).length === 21)).toBe(true);
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps({ project: "beta", files: [file({ path: "/repo/beta.jsonl", project: "beta" })] })} />));
  await settle();
  expect(anchors(root)).toEqual(["/repo/beta.jsonl"]);
  expect(q(root, '[data-mobile2-row="catalog"]')!.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps()} />));
  expect(await waitFor(() => anchors(root).length === 21)).toBe(true);
  expect(catalogRequests).toHaveLength(1);
  expect(catalogRequests.every((url) => !new URL(url, "http://localhost").searchParams.has("q"))).toBe(true);
});

test("failed seat read and an unresolved designation never offer Create", async () => {
  seatFailure = true;
  const root = mount();
  expect(await waitFor(() => seatReads > 0)).toBe(true); await settle();
  const dock = q(root, '[data-mobile2-board-dock]')!;
  expect(dock.textContent).not.toContain(translate("en", "mobile2.seat.createDock"));
  click(dock); expect(getMobileNav().getState().sheet).toBe("seat");
  getMobileNav().closeSheet();
  seatFailure = false;
  seatAnswer = { project: PROJECT, seatEpoch: 1, conversationId: "conversation_unhydrated", path: null,
    mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-unhydrated", mode: "existing", launchId: null, error: null } };
  resetOrchestratorSeatCacheForTests();
  const second = mount();
  expect(await waitFor(() => q(second, '[data-mobile2-board-dock]') !== null)).toBe(true); await settle();
  expect(q(second, '[data-mobile2-board-dock]')!.textContent).not.toContain(translate("en", "mobile2.seat.createDock"));
  click(q(second, '[data-mobile2-board-dock]')); expect(getMobileNav().getState().sheet).toBe("seat");
});

test("a failed vacancy poll disables creation on both Home surfaces until revalidated", async () => {
  const root = mount();
  expect(await waitFor(() => q(root, '[data-mobile2-seat-invitation]') !== null)).toBe(true);
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.seat.createDock"));
  seatFailure = true;
  const reads = seatReads;
  expect(await waitFor(() => seatReads > reads, 8000)).toBe(true);
  await settle();
  expect(q(root, '[data-mobile2-seat-invitation]')).toBeNull();
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).not.toContain(translate("en", "mobile2.seat.createDock"));
  click(q(root, '[data-mobile2-seat-open]'));
  expect(getMobileNav().getState().sheet).toBe("seat");
  flushSync(() => getMobileNav().closeSheet());
  click(q(root, '[data-mobile2-board-dock]'));
  expect(getMobileNav().getState().sheet).toBe("seat");
  flushSync(() => getMobileNav().closeSheet());
  seatFailure = false;
  expect(await waitFor(() => q(root, '[data-mobile2-seat-invitation]') !== null, 8000)).toBe(true);
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.seat.createDock"));
}, 20000);

test("a failed poll preserves the known null-path incumbent on both Home surfaces", async () => {
  seatAnswer = { project: PROJECT, seatEpoch: 1, conversationId: running.conversationId, path: null,
    mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-known-incumbent", mode: "existing", launchId: null, error: null } };
  const root = mount();
  expect(await waitFor(() => q(root, '[data-mobile2-seat-tap="conversation"]') !== null)).toBe(true);
  seatFailure = true;
  const reads = seatReads;
  expect(await waitFor(() => seatReads > reads, 8000)).toBe(true);
  await settle();
  expect(q(root, '[data-mobile2-seat-tap="conversation"]')).not.toBeNull();
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.board.tellOrchestrator"));
  expect(q(root, '[data-mobile2-seat-invitation]')).toBeNull();
}, 12000);

test("a failed append keeps the rows and retries the same cursor; an expired snapshot keeps them and reloads from the start", async () => {
  let respond: ((value: unknown) => void) | undefined;
  let failNext = true;
  catalogReply = (url) => {
    const cursor = url.searchParams.get("cursor");
    if (cursor === "20" && failNext) { failNext = false; return { ok: false, status: 503, json: async () => ({}) }; }
    if (cursor === "40") return new Promise((resolve) => { respond = resolve; });
    return defaultCatalogReply(url);
  };
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  click(q(root, '[data-mobile2-row="catalog"]'));
  intersect();
  expect(await waitFor(() => anchors(root).length === 21)).toBe(true);
  await settle(); intersect();
  expect(await waitFor(() => q(root, '[data-mobile2-catalog-retry="retry"]') !== null)).toBe(true);
  expect(root.textContent).toContain(translate("en", "list.failed"));
  expect(anchors(root)).toHaveLength(21);
  /* The sentinel stays quiet while the failure stands; its own row retries. */
  intersect(); await settle(); expect(catalogRequests).toHaveLength(2);
  const retry = q(root, '[data-mobile2-catalog-retry="retry"]')!;
  expect(retry.className).toContain("min-h-11");
  click(retry);
  expect(await waitFor(() => anchors(root).length === 41)).toBe(true);
  expect(new URL(catalogRequests[2]!, "http://localhost").searchParams.get("cursor")).toBe("20");

  await settle(); intersect();
  expect(await waitFor(() => respond !== undefined)).toBe(true);
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps({ files: [asking, { ...running, title: "Updated title" }, finished] })} />));
  expect(anchors(root)).toHaveLength(41);
  respond!({ ok: false, status: 409, json: async () => ({}) });
  expect(await waitFor(() => root.textContent!.includes(translate("en", "mobile.catalog.expired")))).toBe(true);
  intersect(); await settle(); expect(catalogRequests).toHaveLength(4);
  expect(anchors(root)).toHaveLength(41);
  catalogReply = () => ({ ok: false, status: 503, json: async () => ({}) });
  click(q(root, '[data-mobile2-catalog-retry="reload"]'));
  expect(await waitFor(() => catalogRequests.length === 5)).toBe(true); await settle();
  expect(new URL(catalogRequests[4]!, "http://localhost").searchParams.has("cursor")).toBe(false);
  expect(anchors(root)).toHaveLength(41);
  catalogReply = () => jsonResponse({ items: [catalogItems[44]], total: 1, nextCursor: null });
  click(q(root, '[data-mobile2-catalog-retry="reload"]'));
  expect(await waitFor(() => anchors(root).length === 2)).toBe(true);
  expect(anchors(root)[1]).toBe(catalogItems[44]!.path);
});


test("Home card and footer share the incumbent-resolved transcript with a scanner-native file ID", async () => {
  seatAnswer = { project: PROJECT, seatEpoch: 1, conversationId: "conversation_manager", path: null,
    mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-manager", mode: "existing", launchId: null, error: null } };
  incumbentAnswer = { project: PROJECT, designated: true, conversationId: "conversation_manager",
    transcriptPath: running.path, liveness: { lifecycle: "running", hostState: "alive" } };
  const root = mount();
  expect(await waitFor(() => q(root, '[data-mobile2-seat-open]') !== null)).toBe(true);
  await settle();
  expect(incumbentReads).toBe(0);
  click(q(root, '[data-mobile2-seat-open]'));
  expect(await waitFor(() => q(root, '[data-mobile2-seat-controls]') !== null)).toBe(true);
  const readsAfterResolution = incumbentReads;
  expect(readsAfterResolution).toBeGreaterThan(0);
  flushSync(() => getMobileNav().closeSheet());
  await settle();
  click(q(root, '[data-mobile2-board-dock]'));
  expect(await waitFor(() => topScreen(getMobileNav().getState()).kind === "chat")).toBe(true);
  expect(topScreen(getMobileNav().getState())).toMatchObject({ kind: "chat", id: running.path });
  flushSync(() => getMobileNav().home());
  expect(await waitFor(() => q(root, '[data-mobile2-seat-open]') !== null)).toBe(true);
  click(q(root, '[data-mobile2-seat-open]'));
  expect(await waitFor(() => topScreen(getMobileNav().getState()).kind === "chat")).toBe(true);
  expect(topScreen(getMobileNav().getState())).toMatchObject({ kind: "chat", id: running.path });
  expect(incumbentReads).toBe(readsAfterResolution);
});

for (const mismatch of ["project", "conversation"] as const) {
  test(`Home rejects an incumbent response for a different ${mismatch} on card and footer`, async () => {
    seatAnswer = { project: PROJECT, seatEpoch: 2, conversationId: "conversation_manager", path: null,
      mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
      intent: { clientRequestId: "seat-manager", mode: "existing", launchId: null, error: null } };
    incumbentAnswer = { project: mismatch === "project" ? "other-project" : PROJECT,
      designated: true, conversationId: mismatch === "conversation" ? "conversation_previous" : "conversation_manager",
      transcriptPath: running.path, liveness: { lifecycle: "running", hostState: "alive" } };
    const root = mount();
    expect(await waitFor(() => q(root, '[data-mobile2-seat-open]') !== null)).toBe(true);
    click(q(root, '[data-mobile2-seat-open]'));
    expect(await waitFor(() => incumbentReads > 0)).toBe(true);
    await settle();
    flushSync(() => getMobileNav().closeSheet());
    await settle();
    for (const selector of ['[data-mobile2-board-dock]', '[data-mobile2-seat-open]']) {
      click(q(root, selector));
      await settle();
      expect(topScreen(getMobileNav().getState()).kind).not.toBe("chat");
      expect(getMobileNav().getState().sheet).toBe("seat");
      expect(root.textContent).not.toContain(translate("en", "mobile2.seat.createDock"));
      flushSync(() => getMobileNav().closeSheet());
      await settle();
    }
  });
}
