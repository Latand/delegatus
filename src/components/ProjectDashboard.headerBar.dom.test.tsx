/**
 * The project board's one header bar (#1801, docs/design/board-header.md).
 *
 * Before it, a project showed two stacked bars that told the same facts twice
 * («N branches running» over «N agents working», «N need you» beside the
 * island, «N tasks on the board» beside «Tasks N») and carried two search
 * affordances. These cases hold the bar to: one bar, every fact once, one
 * search, and every action still reachable (in the row, in its one filter or
 * behind its ⋯) except Undo and Redo, which the operator took out of the header
 * (a kanban undo is #1856).
 *
 * The row is the operator's choice of 2026-10-12: the board is the one desktop
 * view, so the Board | Conversations switch is gone and the list it led to
 * opens under the recent-agents icon; the two create buttons are one «+»; the
 * reason chips and the island's funnel are one filter joined to the search;
 * Hidden is a row of ⋯; and the bar gives up, in a fixed order, the fewest
 * things at which the row fits (`useBarFit`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";

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
const { BarIslandProvider } = await import("@/components/ProjectBar");

const dom = new Window({ url: "http://localhost/" });
/* happy-dom lays nothing out: the Board and the other leaves' bar report the width the case sets. */
let barWidth = 2292;
const measureRect = dom.HTMLElement.prototype.getBoundingClientRect;
dom.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const rect = measureRect.call(this);
  return this.classList?.contains("kb") || this.hasAttribute?.("data-project-bar") ? { ...rect, width: barWidth, right: barWidth } as DOMRect : rect;
} as typeof measureRect;
/* The board's bar measures its own content against its box (`useBarFit`). The row here is as wide
   as the case says it needs, less what each step it has taken gives back, so the hook's order and
   its stopping point are the real ones. */
let rowNeeds = 0;
const STEP_GIVES: Record<string, number> = { accounts: 300, labels: 150, chip: 90, tight: 40, find: 80 };
const isBoardBar = (element: HTMLElement) => element.matches?.('header.bar[data-bar="project"]');
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return isBoardBar(this) ? barWidth : 0; } });
Object.defineProperty(dom.HTMLElement.prototype, "scrollWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (!isBoardBar(this)) return 0;
    const taken = (this.getAttribute("data-fit") ?? "").split(" ").filter(Boolean);
    return rowNeeds - taken.reduce((sum, step) => sum + (STEP_GIVES[step] ?? 0), 0);
  },
});
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
let searches = 0;
let boardWrites = 0;
let taskPatches: Array<{ id: string; status: unknown }> = [];
let boardTasks: BoardTask[] = [];
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
    if (String(input) === "/api/links/shared") return Response.json({ shared: { v: 1, all: false, projects: [] }, known: [] });
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
      boardWrites += 1;
      const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
      const current = boards[body.project] ?? emptyBoard();
      const reduced = applyBoardMutations(current, body.mutations ?? []);
      const next = { ...reduced, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date(0).toISOString(), pathAliases: reduced.pathAliases ?? {} };
      boards[body.project] = next;
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: true, board: next }), text: async () => "" };
    }
    if (url.startsWith("/api/tasks/") && method === "PATCH") {
      const id = decodeURIComponent(url.slice("/api/tasks/".length));
      const body = JSON.parse(String(init?.body)) as { status?: unknown };
      taskPatches.push({ id, status: body.status });
      const current = boardTasks.find((task) => task.id === id)!;
      const task = { ...current, ...body, revision: `task-v1:rev-${taskPatches.length + 1}` };
      return { ok: true, status: 200, json: async () => ({ task }), text: async () => "" };
    }
    if (url.startsWith("/api/account-project-bindings")) {
      const body = { project: PROJECT, engines: { claude: { restricted: true, allowed: [{ accountId: "acct-a", label: "Account A" }], carrying: [], outsidePool: [] } } };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
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
/* The Viewer's attention island as the Viewer hands it to the bar. */
let island: ReactNode = null;
beforeEach(() => {
  roots = [];
  island = null;
  rowNeeds = 0;
  mobile = false;
  projectCounter += 1;
  PROJECT = `header-bar-${projectCounter}`;
  barWidth = 2292;
  boards = { [PROJECT]: seededBoard() };
  tmuxCalls = [];
  searches = 0;
  boardWrites = 0;
  taskPatches = [];
  boardTasks = [];
  dom.localStorage.clear();
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
      <BarIslandProvider island={() => island}>
      <ProjectDashboard
        files={files}
        flows={[]}
        pipelines={[]}
        workflows={[]}
        tasks={boardTasks}
        project={PROJECT}
        loaded
        openNonce={0}
        archived={false}
        catalogKnown
        catalogConversationCount={files.length}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onOpenSearch={() => { searches += 1; }}
        onToggleOrchestratorPanel={() => {}}
      />
      </BarIslandProvider>,
    ),
  );
  roots.push(root);
  return host as unknown as HTMLElement;
}


const bar = (host: HTMLElement) => host.querySelector("header.bar, [data-project-bar]") as HTMLElement;
/* What the page SAYS: a textarea's text is a field's value (the orchestrator
   draft's folded mandate, which the seat reads), so it is left out. */
const text = (element: Element | null) => {
  if (!element) return "";
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll("textarea").forEach((field) => field.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ");
};
function click(element: Element | null) {
  expect(element).toBeTruthy();
  flushSync(() => element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
}
const openMore = (host: HTMLElement) => {
  click(bar(host).querySelector("[data-bar-more]"));
  return host.querySelector("[data-bar-more-menu]") as HTMLElement;
};
/* A running conversation, so the old header would have said «1 branch running» over «1 agent working». */
const running = () => ({ ...alphaOf(), activity: "live" as const, proc: "running" as const });

test("the Board has one header bar, and it says each fact once", async () => {
  const host = mount([running(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  expect(host.querySelectorAll("header.bar, [data-project-bar]")).toHaveLength(1);
  /* The project's name is in that bar, once, rather than in a row of its own above it. */
  const names = Array.from(host.querySelectorAll("h1"));
  expect(names).toHaveLength(1);
  expect(bar(host).contains(names[0]!)).toBe(true);
  expect(host.querySelector(".h-10")).toBeNull();
  /* «What is happening» is one count: the working one. */
  expect(bar(host).querySelectorAll("[data-bar-working]")).toHaveLength(1);
  const said = text(host);
  expect(said).not.toMatch(/branch(es)? running/);
  expect(said).not.toMatch(/tasks? on the board/);
  expect(said).not.toMatch(/needs? you/);
});

test("the Board's bar has one search, and the message search moved into ⋯", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const searches_ = () => host.querySelectorAll('input[type="search"], [data-testid="dash-search"]');
  expect(searches_()).toHaveLength(1);
  expect(bar(host).querySelector("[data-kanban-search]")).not.toBeNull();

  const menu = openMore(host);
  const message = menu.querySelector('[data-testid="dash-search"]');
  expect(text(message)).toContain(en["search.open"]);
  click(message);
  expect(searches).toBe(1);
});

test("the bar holds no view switch: the Board is the one desktop view", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  expect(host.querySelector("[data-project-view-tabs], button[data-view-tab]")).toBeNull();
  expect(bar(host).querySelector('[data-bar-group="view"]')).toBeNull();
  /* The groups, in the order the row is read. */
  const groups = Array.from(bar(host).querySelectorAll("[data-bar-group]")).map((element) => element.getAttribute("data-bar-group"));
  expect(groups).toEqual(["where", "status", "find", "create", "trail", "panels", "more"]);
});

test("the recent agents are the panel group's last segment: an icon with its name, and the list under it", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const panels = bar(host).querySelector('[data-bar-group="panels"]') as HTMLElement;
  expect(Array.from(panels.children).map((child) => child.hasAttribute("data-orchestrator-toggle") ? "orchestrator" : child.hasAttribute("data-task-panel-toggle") ? "tasks" : child.hasAttribute("data-bar-recent") ? "recent" : child.tagName)).toEqual(["orchestrator", "tasks", "recent"]);
  const toggle = panels.querySelector("[data-bar-recent-toggle]") as HTMLElement;
  /* A quiet icon: no words in the row, its name in the tooltip and for assistive technology. */
  expect(text(toggle)).toBe("");
  expect(toggle.querySelector("svg")).not.toBeNull();
  expect(toggle.getAttribute("aria-label")).toBe(en["dash.recentAgents"]);
  expect(toggle.getAttribute("title")).toBe(en["dash.recentAgents"]);
  expect(toggle.getAttribute("aria-haspopup")).toBe("dialog");

  click(toggle);
  const list = bar(host).querySelector("[data-bar-recent-list]") as HTMLElement;
  expect(list.getAttribute("aria-label")).toBe(en["dash.recentAgents"]);
  expect(list.querySelector("[data-desktop-conversations-scroll]")).not.toBeNull();
  expect(host.querySelector("[data-kanban-board]")).not.toBeNull();
  /* Escape and the close button both put it away. */
  click(list.querySelector(`button[aria-label="${en["common.close"]}"]`));
  expect(bar(host).querySelector("[data-bar-recent-list]")).toBeNull();
});

test("the reasons and «Needs you» are one filter joined to the search, and the row shows no reason chip", async () => {
  boardTasks = [{
    id: "t1", project: PROJECT, text: "Write the release notes", status: "inbox", placement: "unplaced", assignments: [],
    createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z", revision: "task-v1:rev-1",
  } as unknown as BoardTask];
  let funnel = false;
  const { BarNeedsFilterProvider } = await import("@/components/ProjectBar");
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const draw = () => flushSync(() => root.render(
    <BarNeedsFilterProvider value={{ available: true, active: funnel, toggle: () => { funnel = !funnel; draw(); } }}>
      <ProjectDashboard files={[alphaOf(), betaOf()]} flows={[]} pipelines={[]} workflows={[]} tasks={boardTasks} project={PROJECT} loaded openNonce={0} archived={false} catalogKnown catalogConversationCount={2} onArchive={() => {}} onUnarchive={() => {}} />
    </BarNeedsFilterProvider>,
  ));
  draw();
  roots.push(root);
  const page = host as unknown as HTMLElement;
  expect(await waitFor(() => page.querySelector('.card[data-id="task:t1"]') !== null)).toBe(true);
  await settle();

  expect(page.querySelector(".reason-filter, .reason-filter-row, [data-reason-filters]")).toBeNull();
  const find = bar(page).querySelector('[data-bar-group="find"]') as HTMLElement;
  expect(find.querySelector("[data-kanban-search]")).not.toBeNull();
  const toggle = find.querySelector("[data-bar-filter-toggle]") as HTMLElement;
  expect(toggle.getAttribute("aria-label")).toBe(en["dash.filter"]);
  expect(toggle.getAttribute("title")).toBe(en["dash.filter"]);
  expect(toggle.querySelector("[data-bar-filter-dot]")).toBeNull();

  click(toggle);
  const menu = () => find.querySelector("[data-bar-filter-menu]") as HTMLElement;
  /* «Needs you» first, with its key; then every task and each other reason the board shows, counted. */
  const needs = menu().querySelector("[data-bar-filter-needs]") as HTMLElement;
  expect(text(needs)).toContain(en["kanban.filterReason.needs-you"]);
  expect(text(needs)).toContain("F");
  expect(needs.getAttribute("aria-checked")).toBe("false");
  /* The funnel is the Viewer's filter: the row toggles it, and the icon says the board is narrowed. */
  click(needs);
  expect(funnel).toBe(true);
  expect(menu().querySelector("[data-bar-filter-needs]")!.getAttribute("aria-checked")).toBe("true");
  expect(find.querySelector("[data-bar-filter-dot]")).not.toBeNull();
  expect(find.querySelector("[data-bar-filter-toggle]")!.getAttribute("aria-label")).toBe(en["dash.filterOn"]);
  click(menu().querySelector("[data-bar-filter-needs]"));
  expect(funnel).toBe(false);
  expect(find.querySelector("[data-bar-filter-dot]")).toBeNull();
});

test("the filter lists every other reason with its count; a reason narrows and closes, «All tasks» clears", async () => {
  const { BarFilterMenu } = await import("@/components/ProjectBar");
  let active: string | undefined;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const draw = () => flushSync(() => root.render(
    <BarFilterMenu
      reasons={[{ id: "queued", label: en["kanban.filterReason.queued"], count: 3 }, { id: "no-reason", label: en["kanban.filterReason.no-reason"], count: 1 }]}
      active={active}
      onPick={(id) => { active = id; draw(); }}
      needs={{ label: en["kanban.filterReason.needs-you"], count: 2 }}
    />,
  ));
  draw();
  roots.push(root);
  const find = host as unknown as HTMLElement;
  const menu = () => find.querySelector("[data-bar-filter-menu]") as HTMLElement;

  click(find.querySelector("[data-bar-filter-toggle]"));
  /* With no Viewer behind it the funnel has nothing to narrow, so its row is inert. */
  expect((menu().querySelector("[data-bar-filter-needs]") as HTMLButtonElement).disabled).toBe(true);
  expect(Array.from(menu().querySelectorAll("[data-bar-filter-reason]")).map((row) => [row.getAttribute("data-bar-filter-reason"), text(row)])).toEqual([
    ["", en["dash.filterAll"]],
    ["queued", `${en["kanban.filterReason.queued"]}3`],
    ["no-reason", `${en["kanban.filterReason.no-reason"]}1`],
  ]);
  expect(menu().querySelector('[data-bar-filter-reason=""]')!.getAttribute("aria-checked")).toBe("true");

  click(menu().querySelector('[data-bar-filter-reason="queued"]'));
  expect(active).toBe("queued");
  expect(find.querySelector("[data-bar-filter-menu]")).toBeNull();
  expect(find.querySelector("[data-bar-filter-dot]")).not.toBeNull();
  click(find.querySelector("[data-bar-filter-toggle]"));
  expect(menu().querySelector('[data-bar-filter-reason="queued"]')!.getAttribute("aria-checked")).toBe("true");
  /* The same reason again lets it go; so does «All tasks». */
  click(menu().querySelector('[data-bar-filter-reason=""]'));
  expect(active).toBeUndefined();
  expect(find.querySelector("[data-bar-filter-dot]")).toBeNull();
});

test("with room, every daily control is in the row, labelled where the row has words", async () => {
  const host = mount([alphaOf(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(await waitFor(() => bar(host).querySelector("[data-account-switch-engine]") !== null)).toBe(true);

  const inBar = bar(host);
  expect(inBar.getAttribute("data-fit")).toBe("");
  for (const selector of ["[data-kanban-search]", "[data-bar-filter-toggle]", "[data-bar-create]", "[data-orchestrator-toggle]", "[data-task-panel-toggle]", "[data-bar-recent-toggle]", "[data-bar-more]", "[data-account-switch-engine]"]) {
    expect({ selector, found: inBar.querySelector(selector) !== null }).toEqual({ selector, found: true });
  }
  /* What left the row: the two create buttons, the Hidden pill and the view switch. */
  expect(inBar.querySelector("[data-new-task], [data-new-agent], [data-hidden-pill], [data-view-tab]")).toBeNull();
  /* Orchestrator and Tasks say their names while the row has room. */
  expect(text(inBar.querySelector("[data-orchestrator-toggle] [data-fit-label]"))).toBe(en["orchPanel.title"]);
  expect(text(inBar.querySelector("[data-task-panel-toggle] [data-fit-label]"))).toBe(en["tasks.panelTitle"]);

  const menu = openMore(host);
  const rows = text(menu);
  for (const label of [en["search.open"], en["sound.mute"], en["sound.settings"], en["trash.toArchive"], en["trash.deleteProject"]]) {
    expect({ label, found: rows.includes(label) }).toEqual({ label, found: true });
  }
  /* The account switch stays in the bar while it has room, so ⋯ does not repeat it. */
  expect(menu.querySelector("[data-account-switch-engine]")).toBeNull();
  const account = inBar.querySelector("[data-account-switch-engine] button") as HTMLElement;
  expect(account.getAttribute("data-account-switch-appearance")).toBe("bar");
  /* Sound levels open in place, inside the menu. */
  click(menu.querySelector('[data-testid="sound-settings-trigger"]'));
  expect(menu.querySelector('[data-testid="sound-settings"]')).not.toBeNull();
});

test("a short row gives up the fewest things, in order: the accounts first, then the words of Orchestrator and Tasks", async () => {
  /* 100 px short: the accounts' 300 px are enough, and nothing else is given up. */
  barWidth = 1100;
  rowNeeds = 1200;
  const host = mount([alphaOf(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const inBar = bar(host);
  expect(inBar.getAttribute("data-fit")).toBe("accounts");
  /* One + with both creators, at every width. */
  click(inBar.querySelector("[data-bar-create]"));
  const create = host.querySelector('.menu[role="menu"]') as HTMLElement;
  expect(text(create)).toContain(en["dash.newTask"]);
  expect(text(create)).toContain(en["dash.newConvo"]);

  /* In ⋯ the account switch is one menu row per engine, never a pill. */
  const menu = openMore(host);
  expect(await waitFor(() => menu.querySelector("[data-account-switch-engine]") !== null)).toBe(true);
  const row = menu.querySelector("[data-account-switch-engine] button") as HTMLElement;
  expect(row.getAttribute("data-account-switch-appearance")).toBe("menu");
  /* They are a section of ⋯ that opens in place, its rows mounted while it is closed. */
  expect(row.closest("[data-bar-menu-section]")!.getAttribute("data-bar-menu-section")).toBe("accounts");
  expect(menu.querySelector('[data-bar-menu-head="accounts"]')?.getAttribute("aria-expanded")).toBe("false");
  /* The toggles keep their names for a pointer and for assistive technology at every step. */
  expect(inBar.querySelector("[data-orchestrator-toggle]")!.getAttribute("aria-label")).toBe(en["orchPanel.toggleAria"]);
  expect(inBar.querySelector("[data-orchestrator-toggle]")!.getAttribute("title")).toBe(en["orchPanel.toggleAria"]);
  expect(inBar.querySelector("[data-task-panel-toggle]")!.getAttribute("title")).toBe(en["tasks.panelToggleAria"]);
});

test("each further step is taken only when the one before it was not enough, and the row never wraps", async () => {
  const stepsAt = async (needs: number) => {
    barWidth = 1000;
    rowNeeds = needs;
    const host = mount();
    expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
    await settle();
    const fit = bar(host).getAttribute("data-fit");
    expect(bar(host).hasAttribute("data-bar-wrap")).toBe(false);
    for (const root of roots) flushSync(() => root.unmount());
    roots = [];
    dom.document.body.replaceChildren();
    projectCounter += 1;
    PROJECT = `header-bar-${projectCounter}`;
    boards = { [PROJECT]: seededBoard() };
    resetSelectionSessionsForTest();
    return fit;
  };
  expect(await stepsAt(1000)).toBe("");
  expect(await stepsAt(1300)).toBe("accounts");
  expect(await stepsAt(1301)).toBe("accounts labels");
  expect(await stepsAt(1451)).toBe("accounts labels chip");
  expect(await stepsAt(1541)).toBe("accounts labels chip tight");
  expect(await stepsAt(1581)).toBe("accounts labels chip tight find");
  /* Past the last step the bar keeps them all and stays one row. */
  expect(await stepsAt(2400)).toBe("accounts labels chip tight find");
});

test("Undo and Redo are gone from the header, its ⋯ and Ctrl+Z, even with a close in the log (#1856)", async () => {
  /* A closed card in the device-local log, which used to light the undo row. */
  dom.localStorage.setItem(
    `llvBoardHistory:${PROJECT}`,
    JSON.stringify({ entries: [{ kind: "close", path: "/gamma", title: "Gamma" }], cursor: 1 }),
  );
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const menu = openMore(host);
  expect(host.querySelector("[data-board-undo], [data-board-redo]")).toBeNull();
  expect(text(bar(host))).not.toMatch(/undo|redo/i);
  expect(text(menu)).not.toMatch(/undo|redo/i);

  const writes = boardWrites;
  flushSync(() => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }) as never));
  await settle();
  expect(boardWrites).toBe(writes);
});

test("⋯ draws no rule next to a group with nothing in it", async () => {
  /* A running conversation stands Archive and Delete down, which used to leave a rule under the last row. */
  const host = mount([running(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const menu = openMore(host);
  expect(menu.querySelector('[role="separator"]')).toBeNull();
  /* #2187 §6: the project's merge setting stays when Archive and Delete stand
     down, and its Bridge reports setting (#2146): two sections of ⋯, each a
     page. The section whose rows all stood down draws nothing. */
  const rowsOf = (section: string) => Array.from(menu.querySelector(`[data-bar-menu-body="${section}"]`)?.children ?? []).map((child) =>
    child.hasAttribute("data-merge-on-review") ? "merge" : child.querySelector("[data-share-project-switch]") ? "share" : child.querySelector("[data-bridge-reports-switch]") ? "bridge" : child.querySelector("[data-asks-you-switch]") ? "asks" : child.tagName);
  expect([rowsOf("merging"), rowsOf("seat"), rowsOf("project")]).toEqual([["merge", "share"], ["bridge", "asks"], []]);
  expect(Array.from(menu.querySelectorAll("[data-bar-menu-head]")).map((head) => [head.getAttribute("data-bar-menu-head"), head.getAttribute("data-bar-menu-opens")])).toEqual([["merging", "page"], ["seat", "page"], ["project", "place"]]);
  /* A page replaces the list: its own rows and a back row, nothing else. */
  flushSync(() => (menu.querySelector('[data-bar-menu-head="seat"]') as HTMLElement).click());
  expect(menu.getAttribute("data-bar-menu-view")).toBe("seat");
  expect(menu.querySelector("[data-bar-menu-back]")?.textContent?.trim()).toBe("Orchestrator");
  expect(menu.querySelector('[data-bar-menu-group="sound"]')?.children.length).toBe(0);
  flushSync(() => (menu.querySelector("[data-bar-menu-back]") as HTMLElement).click());
  expect(menu.getAttribute("data-bar-menu-view")).toBe("rest");
});

test("+ is one control: an icon in the control's own colour, never a glyph, opening the two-row menu", async () => {
  /* The hover colour of each control is measured by the board-geometry capture. */
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const controls = Array.from(bar(host).querySelectorAll('[data-bar-group="create"] button')) as HTMLElement[];
  expect(controls).toHaveLength(1);
  const control = controls[0]!;
  expect(control.hasAttribute("data-bar-create")).toBe(true);
  expect(control.querySelector("svg")).not.toBeNull();
  expect(control.querySelector(".plus")).toBeNull();
  expect(text(control)).toBe("");
  expect(control.getAttribute("aria-label")).toBe(en["dash.create"]);
  expect(control.getAttribute("title")).toBe(en["dash.create"]);
  expect(control.getAttribute("aria-haspopup")).toBe("menu");
});

test("the Tasks panel opens under the Board's one bar, so the bar spans it and stays one row", async () => {
  barWidth = 1032;
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  click(bar(host).querySelector("[data-task-panel-toggle]"));
  expect(await waitFor(() => host.querySelector(`aside[aria-label="${en["tasks.panelTitle"]}"]`) !== null)).toBe(true);
  await settle();

  const panel = host.querySelector(`aside[aria-label="${en["tasks.panelTitle"]}"]`) as HTMLElement;
  expect(host.querySelectorAll(`aside[aria-label="${en["tasks.panelTitle"]}"]`)).toHaveLength(1);
  const board = host.querySelector("[data-kanban-board]") as HTMLElement;
  /* The panel is inside the board, below the bar: the bar is the board's first row and the panel
     sits in the row under it, beside the columns. */
  expect(board.contains(panel)).toBe(true);
  expect(board.firstElementChild).toBe(bar(host));
  expect(bar(host).contains(panel)).toBe(false);
  expect(panel.closest(".kb-body")?.previousElementSibling).toBe(bar(host));
  expect(bar(host).querySelector("[data-task-panel-toggle]")!.getAttribute("aria-pressed")).toBe("true");

  /* The toggle in the bar still closes it. */
  click(bar(host).querySelector("[data-task-panel-toggle]"));
  expect(await waitFor(() => host.querySelector(`aside[aria-label="${en["tasks.panelTitle"]}"]`) === null)).toBe(true);
});

test("uk: the row's names and ⋯ read in Ukrainian, and who works is a number with its words in the tooltip", async () => {
  setLocale("uk");
  try {
    const host = mount();
    expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
    await settle();
    /* A dot and a number in the row; the sentence is the tooltip's and the accessible name. */
    expect(text(bar(host).querySelector("[data-bar-working]"))).toBe("0");
    expect(bar(host).querySelector("[data-bar-working]")!.getAttribute("aria-label")).toBe(translate("uk", "kanban.summaryWorking", { count: 0 }));
    expect(bar(host).querySelector('[data-bar-group="status"]')!.getAttribute("title")).toBe(translate("uk", "kanban.summaryWorking", { count: 0 }));
    expect(bar(host).querySelector("[data-bar-recent-toggle]")!.getAttribute("title")).toBe(translate("uk", "dash.recentAgents"));
    expect(bar(host).querySelector("[data-bar-filter-toggle]")!.getAttribute("title")).toBe(translate("uk", "dash.filter"));
    expect(text(bar(host).querySelector("[data-orchestrator-toggle] [data-fit-label]"))).toBe(translate("uk", "orchPanel.title"));
    const menu = openMore(host);
    expect(text(menu)).toContain(translate("uk", "search.open"));
  } finally {
    setLocale("en");
  }
});

test("Hidden is a row of ⋯ with its count, drawn only while something is hidden", async () => {
  const none = mount();
  expect(await waitFor(() => none.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(bar(none).querySelector("[data-hidden-pill]")).toBeNull();
  expect(openMore(none).querySelector("[data-bar-more-hidden]")).toBeNull();
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();

  /* A conversation closed on the board is one hidden thing. */
  projectCounter += 1;
  PROJECT = `header-bar-${projectCounter}`;
  boards = { [PROJECT]: { ...seededBoard(), prefs: { ...seededBoard().prefs, hidden: ["/beta"] } } };
  resetSelectionSessionsForTest();
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(bar(host).querySelector("[data-hidden-pill]")).toBeNull();
  const row = openMore(host).querySelector("[data-bar-more-hidden]") as HTMLElement;
  expect(text(row)).toContain(en["kanban.hidden"]);
  expect(text(row)).toMatch(/[1-9]/);
  expect(row.querySelector("svg")).not.toBeNull();
  /* The row closes ⋯ and opens the tray under it. */
  click(row);
  await settle();
  expect(host.querySelector("[data-bar-more-menu]")).toBeNull();
  expect(await waitFor(() => host.querySelector(".hidden-tray") !== null)).toBe(true);
});

test("the create menu's two rows carry icons, like the ⋯ rows", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  click(bar(host).querySelector("[data-bar-create]"));
  const items = Array.from(host.querySelectorAll('.menu[role="menu"] [role="menuitem"]'));
  expect(items).toHaveLength(2);
  for (const item of items) expect(item.querySelector("svg.ico")).not.toBeNull();
});

test("a project with nothing in it draws the same bar: its two ends, the message search, no board controls", async () => {
  barWidth = 1032;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <BarIslandProvider island={() => <div data-test-island=""><button type="button">waiting</button></div>}>
      <ProjectDashboard files={[]} flows={[]} pipelines={[]} workflows={[]} tasks={[]} project={PROJECT} loaded openNonce={0} archived={false} catalogKnown={false} catalogConversationCount={0} onArchive={() => {}} onUnarchive={() => {}} onOpenSearch={() => { searches += 1; }} onToggleOrchestratorPanel={() => {}} />
    </BarIslandProvider>,
  ));
  roots.push(root);
  const page = host as unknown as HTMLElement;
  expect(await waitFor(() => page.querySelector("[data-project-bar]") !== null)).toBe(true);
  await settle();

  const leaf = page.querySelector("[data-project-bar]") as HTMLElement;
  expect(page.querySelectorAll("header.bar, [data-project-bar]")).toHaveLength(1);
  expect(leaf.querySelector("[data-project-view-tabs], [data-bar-create-reserve], [data-bar-create], [data-bar-recent]")).toBeNull();
  /* Narrow, it is in the two steps its width asks for: the accounts in ⋯, the toggles as icons. */
  expect(leaf.getAttribute("data-fit")).toBe("accounts labels");
  const find = leaf.querySelector('[data-testid="dash-search"]') as HTMLElement;
  expect(text(find).trim()).toBe(en["dash.searchShort"]);
  /* The full wording and its «/» hint stay as the name and the tooltip. */
  expect(find.getAttribute("aria-label")).toBe(en["search.open"]);
  expect(find.getAttribute("title")).toBe(en["search.open"]);
  expect(uk["dash.searchShort"]).toBe("Пошук");
  /* The island is this bar's last item too, in the row. */
  expect(leaf.querySelector("[data-bar-island-slot] [data-test-island]")).not.toBeNull();
  expect(leaf.className).not.toContain("236");
});

test("the attention island is the row's last item, so Tab reaches it right after ⋯", async () => {
  island = (
    <div data-test-island="">
      <button type="button" data-island-first="">waiting</button>
      <button type="button">next</button>
    </div>
  );
  /* The document's tab sequence: what Tab visits, in order (no positive tabindex is used here). */
  const tabbable = () => Array.from(dom.document.querySelectorAll("button, a[href], input, select, textarea, [tabindex]"))
    .map((element) => element as unknown as HTMLElement)
    .filter((element) => element.getAttribute("tabindex") !== "-1" && !element.hasAttribute("disabled") && !element.closest("[inert]"));
  const afterMore = () => {
    const order = tabbable();
    return order[order.indexOf(bar(host).querySelector("[data-bar-more]") as HTMLElement) + 1] ?? null;
  };

  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(host.querySelectorAll("[data-test-island]")).toHaveLength(1);
  expect(afterMore()?.hasAttribute("data-island-first")).toBe(true);
  /* And ahead of the board body, which follows the bar. */
  const order = tabbable();
  const firstInBody = order.find((element) => element.closest(".kb-body"));
  expect(order.indexOf(host.querySelector("[data-island-first]") as HTMLElement)).toBeLessThan(order.indexOf(firstInBody!));
  /* It is in the bar itself, the last thing in it, and the bar keeps no reserve for a box drawn over it. */
  expect(bar(host).lastElementChild?.hasAttribute("data-bar-island-slot")).toBe(true);
  expect(bar(host).querySelector("[data-bar-island-slot] [data-test-island]")).not.toBeNull();
});

test("`/` and `u` keep their meaning on the Viewer's controls the bar brought into the board", async () => {
  island = (
    <div data-test-island="">
      <button type="button" data-island-first="">waiting</button>
    </div>
  );
  boardTasks = [{
    id: "t1", project: PROJECT, text: "Write the release notes", status: "inbox", placement: "unplaced", assignments: [],
    createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z", revision: "task-v1:rev-1",
  } as unknown as BoardTask];
  /* The Viewer's window listener, as far as this case needs it: a `/` that reaches the window
     unclaimed is the Viewer's to answer. */
  let slashesReachingViewer = 0;
  const viewer = (event: KeyboardEvent) => { if (event.key === "/" && !event.defaultPrevented) slashesReachingViewer += 1; };
  dom.addEventListener("keydown", viewer as never);
  try {
    const host = mount();
    expect(await waitFor(() => host.querySelector('.card[data-id="task:t1"]') !== null)).toBe(true);
    await settle();
    const cardSearch = host.querySelector("[data-kanban-search]") as HTMLElement;
    const press = (target: HTMLElement, key: string) => {
      target.focus();
      flushSync(() => target.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as never));
    };

    /* A move leaves an undoable receipt, so a `u` the board wrongly claims has something to undo. */
    const card = host.querySelector('.card[data-id="task:t1"]') as HTMLElement;
    press(card, "]");
    expect(await waitFor(() => taskPatches.length === 1)).toBe(true);
    await settle();

    const more = bar(host).querySelector("[data-bar-more]") as HTMLElement;
    const toggle = bar(host).querySelector("[data-task-panel-toggle]") as HTMLElement;
    const islandButton = host.querySelector("[data-island-first]") as HTMLElement;
    for (const target of [more, toggle, islandButton]) {
      const before = slashesReachingViewer;
      press(target, "/");
      expect(dom.document.activeElement === (cardSearch as never)).toBe(false);
      expect(slashesReachingViewer).toBe(before + 1);
      press(target, "u");
      await settle();
      expect(taskPatches).toHaveLength(1);
    }
    /* A row inside the open ⋯ is the Viewer's too. */
    const row = openMore(host).querySelector('[data-testid="dash-search"]') as HTMLElement;
    const before = slashesReachingViewer;
    press(row, "/");
    expect(slashesReachingViewer).toBe(before + 1);

    /* On the board itself both keys are still the board's. */
    const moved = host.querySelector('.card[data-id="task:t1"]') as HTMLElement;
    press(moved, "/");
    expect(dom.document.activeElement === (host.querySelector("[data-kanban-search]") as never)).toBe(true);
    expect(slashesReachingViewer).toBe(before + 1);
    flushSync(() => dom.document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "u", bubbles: true, cancelable: true }) as never));
    expect(await waitFor(() => taskPatches.length === 2)).toBe(true);
    expect(taskPatches[1]!.status).toBe("inbox");
  } finally {
    dom.removeEventListener("keydown", viewer as never);
  }
});
