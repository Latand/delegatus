import { resetPendingOpensForTest } from "@/hooks/useBoardState";
import { resetMobileNavForTests } from "./mobileNav";
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * Issue #613 — the phone header must fit a 390px viewport. happy-dom does no
 * layout, so this guards the *structural* contract the geometry depends on
 * (issue1671Evidence.browser.test.tsx measures the pixels in Chromium; the
 * #613 driver was deleted in #1761):
 *
 *   - the row carries only fixed 44px targets plus ONE elastic cell, the
 *     project name, which truncates;
 *   - the attention badge keeps its own width — it is an action, not filler;
 *   - the 94px scheme/list segmented pair no longer rides the row: both faces
 *     live in the «⋯» menu as radio options and still switch the board.
 *
 * The shell now keeps three fixed controls: attention, search, and the menu.
 * Projects open from the elastic title; creation and hidden tasks live in the
 * menu. Test the current shell with every optional bar control present.
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
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { KeepAwakeProvider } = await import("@/components/KeepAwakeControl");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
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
  PointerEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  /* A tiny in-memory board API: the view switch writes through /api/board, and
     the store needs a real `{ board }` envelope back to fold the write in. */
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/operator/worker-limit")) return { ok: false, status: 503, json: async () => ({}) };
    if (url === "/api/keys") return jsonResponse({ keys: [] });
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          patch?: Record<string, unknown>;
          mutations?: Array<{ kind: string; viewMode?: "scheme" | "list" | null }>;
        };
        for (const mutation of body.mutations ?? []) {
          if (mutation.kind === "set-presentation" && mutation.viewMode !== undefined) boardPrefs.viewMode = mutation.viewMode;
        }
        if (body.patch) boardPrefs = { ...boardPrefs, ...body.patch };
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    return jsonResponse({});
  }) as unknown as typeof fetch,
};

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
const emptyPrefs = () => ({
  manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [],
  expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false,
});
const boardState = () => ({
  schemaVersion: 1, revision: boardRevision, updatedAt: new Date(0).toISOString(),
  pathAliases: {}, explicitManual: [], prefs: { ...emptyPrefs(), ...boardPrefs },
});
const jsonResponse = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});
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
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "live-log-viewer-next-mobile";

const conversation = {
  path: "/repo/worktrees/mobile-header/0f1e2d3c.jsonl",
  root: "claude-projects", name: "0f1e2d3c.jsonl", project: PROJECT,
  title: "Builder · keep the conversation header inside a 390px viewport (#613)",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 9_000, size: 4_096,
  activity: "live", proc: null, pid: null, model: "claude-opus-4-8", effort: "high", ctx: 62,
  renamable: true, conversationId: "conversation_613mobile", pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

const task = {
  id: "t-613", project: PROJECT, status: "inbox", text: "Keep the header inside 390px",
  placement: "pinned", pos: { x: 720, y: 140 }, assignments: [],
  createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
} as unknown as BoardTask;

const ATTENTION_LABEL = translate("en", "attention.badge", { count: 3 });

const dashboardProps = () => ({
  files: [conversation], flows: [], pipelines: [], workflows: [], tasks: [task],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 1,
  projectCwd: "/repo", onArchive: () => {}, onUnarchive: () => {},
  onMenu: () => {},
  onOpenSearch: () => { searchOpens += 1; },
  mobileShell: { attentionCount: 3, arrival: null, renderSheet: () => null },
  attention: (
    <button type="button" className="inline-flex min-h-11 items-center px-3.5" aria-label={ATTENTION_LABEL}>3</button>
  ),
});

let roots: Root[] = [];
let searchOpens = 0;
beforeEach(() => {
  roots = [];
  searchOpens = 0;
  boardRevision = 1;
  boardPrefs = {};
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  resetMobileNavForTests();
  resetPendingOpensForTest();
  /* A closed card in the device-local log: the header no longer offers undo for it (#1801). */
  dom.localStorage.setItem(
    `llvBoardHistory:${PROJECT}`,
    JSON.stringify({ entries: [{ kind: "close", path: "/repo/closed.jsonl", title: "Closed card" }], cursor: 1 }),
  );
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

function mount(wrap: (dashboard: React.ReactNode) => React.ReactNode = (dashboard) => dashboard): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<>{wrap(<ProjectDashboard {...dashboardProps()} />)}</>));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const header = (host: HTMLElement) => host;
const label = (el: Element) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";

const shelfReady = (host: HTMLElement) => host.querySelector("[data-phone-kanban]") !== null;

test("the phone board mounts the shell: one bar, the title cell as the switcher, three 44 px targets, and no five-target header", async () => {
  const root = mount();
  expect(await waitFor(() => shelfReady(root))).toBe(true);
  expect(root.querySelector( '[data-testid="mobile-project-header"]')).toBeNull();
  expect(root.querySelector( '[data-mobile2-screen="board"]')).not.toBeNull();
  const bar = root.querySelector( "[data-mobile2-bar]")!;
  const title = root.querySelector( "[data-mobile2-title]")!;
  expect(title.textContent).toContain(PROJECT);
  expect(title.getAttribute("data-mobile2-open")).toBe("projects");
  expect(title.className).toContain("flex-1");
  expect(title.className).toContain("min-w-0");
  expect(title.className).not.toContain("shrink-0");
  expect(title.querySelector(".truncate")).not.toBeNull();
  const targets = Array.from(bar.querySelectorAll("button")).filter((el) => el !== (title as unknown as Element));
  expect(targets.map(label)).toEqual([
    translate("en", "mobile2.bar.attention", { count: 3 }),
    translate("en", "mobile2.bar.search"),
    translate("en", "mobile2.bar.more"),
  ]);
  for (const target of targets) {
    expect(`${target.className} `).toMatch(/(^|\s)h-11(\s|$)/);
    expect(target.className).toContain("shrink-0");
    expect(target.className).toContain(target.getAttribute("data-mobile2-open") === "attention" ? "w-[52px]" : "w-11");
  }
  /* The search target is wired to the shell's palette, not decoration. */
  const search = root.querySelector( '[data-testid="dash-search"]')!;
  expect(search.className).toContain("w-11");
  flushSync(() => (search as HTMLElement).click());
  expect(searchOpens).toBe(1);
  /* The old header's controls are gone from the row: no hamburger, no shelf
     trigger, no create menu, no scheme/list pair. */
  const labels = targets.map(label);
  for (const key of ["dash.openProjects", "dash.hiddenShelf", "dash.createMenu", "dash.viewScheme", "dash.viewList"] as const) {
    expect(labels).not.toContain(translate("en", key));
  }
});

test("both board faces stay one tap away inside the menu, announced as radio rows, and still switch the board", async () => {
  const root = mount();
  expect(await waitFor(() => shelfReady(root))).toBe(true);
  await openMore(root);
  const options = Array.from(root.querySelectorAll('[role="menuitemradio"]'));
  const rowLabel = (el: Element) => el.querySelector(".truncate")?.textContent ?? "";
  expect(options.map(rowLabel)).toEqual([translate("en", "mobile2.menu.board"), translate("en", "mobile2.menu.catalog")]);
  expect(options[0]!.getAttribute("aria-checked")).toBe("true");
  expect(options[1]!.getAttribute("aria-checked")).toBe("false");
  flushSync(() => (options[1] as HTMLElement).click());
  await settle();
  expect(root.querySelector( '[data-mobile2-sheet="menu"]')).toBeNull();
  expect(await waitFor(() => !shelfReady(root))).toBe(true);
  await openMore(root);
  const reopened = Array.from(root.querySelectorAll('[role="menuitemradio"]'));
  expect(reopened[1]!.getAttribute("aria-checked")).toBe("true");
});

test("Undo and Redo are not «⋯» items, even with a close in the device-local log (#1801; kanban undo is #1856)", async () => {
  const host = mount();
  expect(await waitFor(() => shelfReady(host))).toBe(true);
  const more = Array.from(header(host).querySelectorAll("button")).find(
    (el) => el.getAttribute("data-mobile2-open") === "menu",
  ) as unknown as HTMLButtonElement;
  flushSync(() => more.click());
  await settle();
  const items = Array.from(header(host).querySelectorAll("[data-mobile2-menu-row]")).map(label);
  expect(items.length).toBeGreaterThan(0);
  expect(items.some((entry) => /^(Undo|Redo)/.test(entry))).toBe(false);
});

/*
 * Issue #712 — «Keep screen awake» is the first control added after the 390px
 * budget was fixed, so it takes the route that comment prescribes: it folds into
 * the «⋯» menu and costs the row zero width. These cases prove it is reachable
 * there, that it holds a real sentinel, and that it never rides the row.
 */

interface HeaderSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

function wakeLockScene() {
  const scene = {
    requests: 0,
    granted: [] as HeaderSentinel[],
    environment: {
      request: () => {
        scene.requests += 1;
        const listeners = new Set<() => void>();
        const sentinel: HeaderSentinel = {
          released: false,
          async release() {
            if (sentinel.released) return;
            sentinel.released = true;
            for (const listener of [...listeners]) listener();
          },
          addEventListener: (_type, listener) => void listeners.add(listener),
          removeEventListener: (_type, listener) => void listeners.delete(listener),
        };
        scene.granted.push(sentinel);
        return Promise.resolve(sentinel);
      },
      secureContext: true,
      isVisible: () => true,
      storage: dom.localStorage as unknown as Pick<Storage, "getItem" | "setItem">,
    },
    factory: () => scene.environment,
  };
  return scene;
}

const openMore = async (host: HTMLElement) => {
  const more = Array.from(header(host).querySelectorAll("button")).find(
    (el) => el.getAttribute("data-mobile2-open") === "menu",
  ) as unknown as HTMLButtonElement;
  flushSync(() => more.click());
  await settle();
};

test("«Keep screen awake» is on the «⋯» menu's Settings page and holds a real sentinel (#712)", async () => {
  const scene = wakeLockScene();
  const host = mount((dashboard) => <KeepAwakeProvider environment={scene.factory}>{dashboard}</KeepAwakeProvider>);
  expect(await waitFor(() => shelfReady(host))).toBe(true);

  /* Closed, it costs the 390px row nothing — that is the whole point of the fold. */
  expect(header(host).querySelector('[data-testid="keep-awake-row"]')).toBeNull();

  await openMore(host);
  /* The header menu's mix (docs/design/header-menu.md): the device rows live on Settings. */
  flushSync(() => (header(host).querySelector('[data-mobile2-menu-row="settings"]') as unknown as HTMLButtonElement).click());
  await settle();
  const row = header(host).querySelector('[data-testid="keep-awake-row"]') as unknown as HTMLElement;
  expect(row).not.toBeNull();
  expect(row.textContent).toContain(translate("en", "keepAwake.label"));
  expect(row.getAttribute("data-wake-lock-status")).toBe("off");

  const control = row.querySelector('[role="switch"]') as unknown as HTMLButtonElement;
  expect(control.className).toMatch(/(^|\s)h-11(\s|$)/);
  expect(control.className).toMatch(/(^|\s)w-11(\s|$)/);
  expect(control.getAttribute("aria-checked")).toBe("false");

  flushSync(() => control.click());
  await settle();
  const active = header(host).querySelector('[data-testid="keep-awake-row"]') as unknown as HTMLElement;
  expect(active.getAttribute("data-wake-lock-status")).toBe("active");
  expect(scene.requests).toBe(1);
  expect(scene.granted.filter((sentinel) => !sentinel.released)).toHaveLength(1);
  /* Device-local: the intent is in this device's storage, nowhere on the wire. */
  expect(dom.localStorage.getItem("llvKeepAwake")).toBe("1");
});

test("the wake-lock row takes no target in the three-control shell bar (#712)", async () => {
  const scene = wakeLockScene();
  const host = mount((dashboard) => <KeepAwakeProvider environment={scene.factory}>{dashboard}</KeepAwakeProvider>);
  expect(await waitFor(() => shelfReady(host))).toBe(true);

  /* With the menu closed the shell keeps its three budgeted targets —
     the wake-lock switch is not among them, and nothing
     asked the platform for a lock just because the header rendered. */
  const labels = Array.from(host.querySelectorAll("[data-mobile2-bar] button")).map(label);
  expect(labels).not.toContain(translate("en", "keepAwake.enableAria"));
  expect(labels).not.toContain(translate("en", "keepAwake.disableAria"));
  expect(host.querySelector('[data-mobile2-bar] [role="switch"]')).toBeNull();
  expect(scene.requests).toBe(0);
});

test("speech and reports are included in the title width budget", async () => {
  const { titleCellWidth, TITLE_MIN_PX } = await import("./MobileShell");
  expect(titleCellWidth(390, { back: true, attention: false, search: false, menu: true, actions: 2 })).toBe(198);
  expect(titleCellWidth(390, { back: true, attention: true, search: false, menu: true, actions: 1 })).toBeGreaterThanOrEqual(TITLE_MIN_PX);
});
