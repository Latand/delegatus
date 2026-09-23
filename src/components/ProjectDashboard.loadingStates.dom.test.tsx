/**
 * A project while it loads, while it shows a restored answer, and while the
 * server is being reconnected (#2071).
 *
 * The header first. *
 * A cold start has no `/api/files` answer yet, so the live display name is
 * missing, and the header used to fall back to the canonical key: the phone
 * bar read `repo-<hash>` until the catalog landed. It now names the project
 * from the name this browser remembered, draws a placeholder bar when there is
 * none, and says "Unnamed project" once a certified answer carries no name.
 * The key never reaches the header, on either form factor.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";

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
const { PERSISTED_BOARDS_KEY, resetPendingOpensForTest } = await import("@/hooks/useBoardState");
const { ServerReachProvider } = await import("@/hooks/serverReach");
const { viewBus } = await import("@/hooks/viewPresenceBus");
const { resetProjectNameCacheForTest, PROJECT_NAMES_STORAGE_KEY } = await import("@/lib/client/projectNameCache");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");

/* An invented opaque key, the shape `src/lib/projects/identity.ts` mints. */
const KEY = "repo-0123456789abcdef0123456789abcdef";
const RAW_KEY = /(?:repo|dir)-[0-9a-f]{8,}/;

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
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
/* No read ever answers: the project stays loading, or cached, for the test.
   Every request is recorded, so a write made on a snapshot would show. */
const pending = new Promise<Response>(() => {});
let requests: Array<{ url: string; method: string }> = [];
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaFor,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
    return pending;
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
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = matchMediaFor;
});
afterAll(async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  setLocale("en");
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  requests = [];
  mobile = false;
  dom.localStorage.clear();
  resetProjectNameCacheForTest();
  resetPendingOpensForTest();
  setLocale("en");
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
});

type Reach = React.ComponentProps<typeof ServerReachProvider>["value"];
function mount({ loaded, cached = false, files = [], catalogFailures = 0, reach = { kind: "ok", lastGoodAt: null } }: { loaded: boolean; cached?: boolean; files?: FileEntry[]; catalogFailures?: number; reach?: Reach }): { host: HTMLElement; rerender: (next: { loaded: boolean; cached?: boolean }) => void } {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  const render = (state: { loaded: boolean; cached?: boolean }) => flushSync(() => root.render(
    <ServerReachProvider value={reach}>
    <ProjectDashboard
      files={files}
      flows={[]}
      pipelines={[]}
      workflows={[]}
      tasks={[]}
      project={KEY}
      loaded={state.loaded}
      cached={state.cached}
      catalogFailures={catalogFailures}
      openNonce={0}
      archived={false}
      catalogKnown={false}
      catalogConversationCount={0}
      onArchive={() => {}}
      onUnarchive={() => {}}
      onToggleOrchestratorPanel={() => {}}
    />
    </ServerReachProvider>,
  ));
  render({ loaded, cached });
  return { host: host as unknown as HTMLElement, rerender: render };
}

/** The header's title: the phone bar's title cell, or the desktop bar's h1. */
function title(host: HTMLElement): HTMLElement {
  const node = mobile ? host.querySelector<HTMLElement>("[data-mobile2-title]") : host.querySelector<HTMLElement>("h1");
  expect(node, "the header has a title").not.toBeNull();
  return node!;
}
function header(host: HTMLElement): HTMLElement {
  return (mobile ? host.querySelector<HTMLElement>("[data-mobile2-bar]") : host.querySelector<HTMLElement>("h1")?.closest<HTMLElement>("[data-project-bar]") ?? host.querySelector<HTMLElement>("h1")?.parentElement)!;
}

for (const phone of [true, false]) {
  const surface = phone ? "phone" : "desktop";

  test(`${surface}: while loading, the header names the project from the remembered name`, () => {
    mobile = phone;
    dom.localStorage.setItem(PROJECT_NAMES_STORAGE_KEY, JSON.stringify({ [KEY]: "atlas" }));
    const { host } = mount({ loaded: false });
    expect(title(host).textContent).toContain("atlas");
    expect(header(host).textContent ?? "").not.toMatch(RAW_KEY);
    expect(host.textContent ?? "").not.toMatch(RAW_KEY);
  });

  test(`${surface}: while loading with no remembered name, the title is a placeholder bar, never the key`, () => {
    mobile = phone;
    const { host } = mount({ loaded: false });
    expect(title(host).querySelector("[data-title-skeleton]")).not.toBeNull();
    expect(header(host).textContent ?? "").not.toMatch(RAW_KEY);
    expect(host.textContent ?? "").not.toMatch(RAW_KEY);
  });

  test(`${surface}: a certified answer with no name says Unnamed project, in en and uk`, () => {
    mobile = phone;
    const { host } = mount({ loaded: true });
    expect(title(host).textContent).toContain(en["dash.projectUnnamed"]);
    expect(title(host).querySelector("[data-title-skeleton]")).toBeNull();
    expect(host.textContent ?? "").not.toMatch(RAW_KEY);
    flushSync(() => setLocale("uk"));
    expect(title(host).textContent).toContain(translate("uk", "dash.projectUnnamed"));
    expect(host.textContent ?? "").not.toMatch(RAW_KEY);
  });
}

test("desktop: loading never borrows the idle 'nothing is running' line", () => {
  const { host } = mount({ loaded: false });
  const status = host.querySelector('[data-bar-group="status"]');
  expect(status?.textContent).toBe(en["common.loadingCap"]);
  expect(host.textContent).not.toContain(en["common.nothingRunning"]);
});

/* ── Cached first ───────────────────────────────────────────────────────── */

function conversation(path: string, title: string): FileEntry {
  return {
    path, root: "claude-projects", name: `${title}.jsonl`, project: KEY, title,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity: "live", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  };
}
const ALPHA = conversation("/sessions/alpha.jsonl", "Run the atlas board.");
/** The board this browser confirmed in an earlier document. */
function persistBoard(): void {
  dom.localStorage.setItem(PERSISTED_BOARDS_KEY, JSON.stringify([[KEY, {
    schemaVersion: 1, revision: 2, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [ALPHA.path],
    prefs: { manual: [ALPHA.path], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
  }]]));
  dom.localStorage.setItem(PROJECT_NAMES_STORAGE_KEY, JSON.stringify({ [KEY]: "atlas" }));
}

for (const phone of [true, false]) {
  const surface = phone ? "phone" : "desktop";
  test(`${surface}: a restored answer paints the board at once, says it is updating, and acts on nothing until certified`, () => {
    mobile = phone;
    persistBoard();
    const reports = spyOn(viewBus, "reportCards");
    try {
      const { host, rerender } = mount({ loaded: false, cached: true, files: [ALPHA] });
      /* The board's content, not its skeleton. (The seat's own panel may
         still be reading its seat, which is its own placeholder.) */
      expect(host.querySelector('[data-kanban-skeleton], [data-skeleton="rows-board"]') === null).toBe(true);
      if (phone) expect(host.querySelector('[data-mobile2-row="conversation"]')).not.toBeNull();
      else expect(host.querySelector("[data-kanban-board]")).not.toBeNull();
      expect(host.textContent).toContain(en["dash.updating"]);
      expect(title(host).textContent).toContain("atlas");
      /* Nothing that acts on data ran on the snapshot. */
      expect(reports).not.toHaveBeenCalled();
      expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
      rerender({ loaded: true, cached: false });
      expect(reports).toHaveBeenCalled();
      expect(host.textContent).not.toContain(en["dash.updating"]);
    } finally {
      reports.mockRestore();
    }
  });
}

/* ── Reconnecting ───────────────────────────────────────────────────────── */

test("desktop: a reconnect in progress is a quiet note in the bar, never an alert", () => {
  persistBoard();
  const { host } = mount({ loaded: true, files: [ALPHA], catalogFailures: 2, reach: { kind: "reconnecting", lastGoodAt: Date.UTC(2100, 0, 2, 14, 2) } });
  const note = host.querySelector('[data-bar-reach="reconnecting"]');
  expect(note).not.toBeNull();
  expect(note!.textContent).toMatch(/^reconnecting · showing \d\d:\d\d$/);
  expect(host.querySelector('.bar [role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain(en["kanban.filesFailed"]);
});

test("desktop: a minute of failures is the red alert again", () => {
  persistBoard();
  const { host } = mount({ loaded: true, files: [ALPHA], catalogFailures: 7, reach: { kind: "offline", lastGoodAt: null } });
  const alert = host.querySelector('.bar [role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).toBe(en["kanban.filesFailed"]);
});
