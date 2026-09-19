import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

/*
 * Putting the WHOLE project sidebar away (issue #1819).
 *
 * The operator's ask is literal: while a stream is watching, no project name,
 * count, limit or account name may be on screen at all. So the assertions are
 * about the rail being gone from the document — unmounted, not hidden — and
 * about the one small control that brings it back.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/* Desktop: the rail is a desktop surface; the phone reaches it through a drawer. */
const matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
Object.assign(globalThis, { matchMedia });
Object.assign(dom, { matchMedia });

(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(),
  cancel() {},
  finish() {},
  addEventListener() {},
  removeEventListener() {},
});

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
const { RAIL_HIDDEN_STORAGE_KEY } = await import("./ProjectRail");
const { translate } = await import("@/lib/i18n");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");

const PROJECT = "atlas";
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/files")) {
      return new Response(JSON.stringify({
        files: [],
        projectCatalog: [{ project: PROJECT, conversations: 0 }],
      }));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  resetFilesClientCacheForTests();
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

const railIn = (host: HTMLElement) => host.querySelector("aside:not([data-orchestrator-dock])");
const hideIn = (host: HTMLElement) => host.querySelector("[data-rail-hide]") as HTMLButtonElement | null;
const restoreIn = (host: HTMLElement) => host.querySelector("[data-rail-restore]") as HTMLButtonElement | null;

test("the hide control leaves no rail content on screen, and the restore control brings it back", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  const host = await mountViewer();

  expect(railIn(host)).not.toBeNull();
  expect(host.textContent ?? "").toContain(translate("en", "rail.title"));
  expect(restoreIn(host)).toBeNull();

  await act(async () => { hideIn(host)!.click(); });

  /* Unmounted, not hidden: no rail subtree is left in the document to poll, and
     nothing of the rail's copy — its title, its filter, its project list — is
     readable. (The board's own header still names the project the operator has
     open; that is the board, not the rail.) */
  expect(railIn(host)).toBeNull();
  const hidden = host.textContent ?? "";
  expect(hidden).not.toContain(translate("en", "rail.title"));
  expect(hidden).not.toContain(translate("en", "rail.overview"));
  expect(hidden).not.toContain(translate("en", "rail.filter"));
  expect(dom.localStorage.getItem(RAIL_HIDDEN_STORAGE_KEY)).toBe("hidden");

  /* The restore control is the only thing left, and it names its shortcut. */
  const restore = restoreIn(host)!;
  expect(restore).not.toBeNull();
  expect(restore.getAttribute("title")).toBe(translate("en", "rail.show"));
  expect(restore.getAttribute("title")).toContain("B");

  await act(async () => { restore.click(); });
  expect(railIn(host)).not.toBeNull();
  expect(host.textContent ?? "").toContain(translate("en", "rail.title"));
  expect(restoreIn(host)).toBeNull();
  expect(dom.localStorage.getItem(RAIL_HIDDEN_STORAGE_KEY)).toBe("shown");
});

test("the choice is remembered for this browser across a remount", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  const host = await mountViewer();
  await act(async () => { hideIn(host)!.click(); });
  expect(railIn(host)).toBeNull();

  act(() => mounted!.unmount());
  mounted = null;
  dom.document.body.replaceChildren();

  const again = await mountViewer();
  expect(railIn(again)).toBeNull();
  expect(restoreIn(again)).not.toBeNull();
  expect(again.textContent ?? "").not.toContain(translate("en", "rail.title"));
});

test("a corrupt stored value means shown", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(RAIL_HIDDEN_STORAGE_KEY, "{not-json");
  const host = await mountViewer();
  expect(railIn(host)).not.toBeNull();
});

test("the B key toggles the whole rail, and stays quiet inside a field", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  const host = await mountViewer();

  const press = async (target: EventTarget) => {
    await act(async () => {
      target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "b", bubbles: true }) as unknown as Event);
    });
  };

  /* A field owns its own keystrokes: the filter input must still accept a «b». */
  const filter = host.querySelector("input") as HTMLInputElement;
  await press(filter);
  expect(railIn(host)).not.toBeNull();

  await press(dom.document.body as unknown as EventTarget);
  expect(railIn(host)).toBeNull();

  await press(dom.document.body as unknown as EventTarget);
  expect(railIn(host)).not.toBeNull();
});
