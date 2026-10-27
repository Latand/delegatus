import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * Mobile v2 lane 5 (#1439) — the two rows this lane takes off the bottom of the
 * phone's transcript (README §3.4, §6).
 *
 * The operator's screenshot stacked, above the keyboard: a live-tail pill, a
 * «working… 1m 31s» status row, and a model/effort row. The pill and the status
 * row are LogFeed's, and both are gone on the phone: following is the feed's
 * default and needs no pill, and the state phrase with its clock lives in the
 * conversation bar's meta line while Stop is the composer's send slot. Neither
 * was ever in the old `chatBudget` sum, which is why that budget stayed green
 * while the screen filled with chrome.
 *
 * What must NOT go with them is the «back to live» control: it only exists once
 * the operator has scrolled away from the tail, and without it a phone has no
 * way back. The desktop keeps all three.
 */

const dom = new HappyWindow({ width: 390, height: 844 });
let mobile = true;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

const resizeCallbacks = new Set<ResizeObserverCallback>();
class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
  observe() {}
  unobserve() {}
  disconnect() { resizeCallbacks.delete(this.callback); }
}

Object.assign(globalThis, {
  ResizeObserver: TestResizeObserver,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  WheelEvent: dom.WheelEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IntersectionObserver: undefined,
});

const AT = (second: number) => `2026-09-02T10:00:${String(second).padStart(2, "0")}.000Z`;
const TRANSCRIPT = [
  { type: "user", uuid: "uuid-ask", timestamp: AT(0), message: { role: "user", content: [{ type: "text", text: "Rebuild the board status projection." }] } },
  { type: "assistant", uuid: "uuid-answer", timestamp: AT(1), message: { role: "assistant", content: [{ type: "text", text: "The projection derives held from the delivery outbox." }] } },
].map((line) => JSON.stringify(line));

const previousFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as unknown as typeof fetch;

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: true, connection: "live" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
/* The tail as the feed reads it; a first read is `loading` with no lines yet. */
let tail: { lines: string[]; loading: boolean; error: string | null } = { lines: TRANSCRIPT, loading: false, error: null };
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: tail.lines,
    linesStart: 0,
    size: tail.lines.length,
    loading: tail.loading,
    error: tail.error,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));
mock.module("@/hooks/useToolActivityCues", () => ({ ...actualToolCues, useToolActivityCues: () => undefined }));

const { JUMP_FADE_PX, LogFeed } = await import("./LogFeed");

const roots = new Set<Root>();
beforeEach(() => {
  setLocale("en");
  mobile = true;
  tail = { lines: TRANSCRIPT, loading: false, error: null };
  dom.sessionStorage.clear();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});
afterAll(() => {
  globalThis.fetch = previousFetch;
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

/** A live conversation with an open turn: the state that renders both rows. */
const file = {
  path: "/fixtures/claude/projects/-repo/lane5-chrome.jsonl",
  root: "claude-projects",
  name: "lane5-chrome.jsonl",
  project: "repo",
  title: "Rebuild the board status projection",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: Date.parse(AT(2)) / 1000,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation_lane5_chrome",
  lastTurn: { startedAt: Date.parse(AT(0)), endedAt: null },
} as FileEntry;

function render(feedFile: FileEntry = file): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  roots.add(root);
  flushSync(() => root.render(
    <LogFeed file={feedFile} showSvc={false} lineFilter="" onStatus={() => undefined} paused follow setFollow={() => undefined} compact />,
  ));
  return host as unknown as HTMLElement;
}

test("the phone transcript ends with the feed: no live-tail pill, no turn status row", () => {
  const host = render();
  expect(host.querySelector("[data-live-tail-pill]")).toBeNull();
  expect(host.querySelector("[data-turn-status]")).toBeNull();
});

test("the desktop keeps both — the removal is the phone's, not a regression for everyone", () => {
  mobile = false;
  const host = render();
  expect(host.querySelector("[data-live-tail-pill]")).toBeTruthy();
  expect(host.querySelector('[data-turn-status="running"]')).toBeTruthy();
});

/** A scroller the feed's magnet logic can actually read (happy-dom reports 0
    for every box), so releasing the magnet is a real gesture here. */
function setScrollerGeometry(element: HTMLElement, height: number, viewport: number, initialTop: number) {
  let top = initialTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => viewport },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(Number(value), height - viewport)); },
    },
  });
  return { setTop: (value: number) => { element.scrollTop = value; } };
}

test("«back to live» survives on the phone: it is the only way back once the tail is left", async () => {
  const host = render();
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_200, 200, 1_000);
  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !host.querySelector('button[aria-label="Back to the live tail"]')) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(host.querySelector('button[aria-label="Back to the live tail"]')).toBeTruthy();
  /* And leaving the tail still does not bring the removed rows back. */
  expect(host.querySelector("[data-live-tail-pill]")).toBeNull();
  expect(host.querySelector("[data-turn-status]")).toBeNull();
});

/** Its own conversation, so no scroll position another test left behind is
    restored into it. */
const conversation = (name: string): FileEntry => ({
  ...file,
  path: `/fixtures/claude/projects/-repo/${name}.jsonl`,
  name: `${name}.jsonl`,
  conversationId: `conversation_${name.replaceAll("-", "_")}`,
});

/*
 * #2072 defect D: the «down» control sat over the feed, centred at its bottom
 * edge, over a line of text. It then took its own 44 px row below the feed.
 * The operator's decision of 2026-10-11 (round 1) floats it again, at the
 * transcript's bottom right, so it costs the transcript no row: while it
 * shows, the feed's last 44 px band fades out under it, so the pill lies on
 * the faded edge and covers no line the reader is reading.
 */
async function releaseTail(host: HTMLElement): Promise<{ scroller: HTMLElement; jump: HTMLButtonElement }> {
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_200, 200, 1_000);
  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !host.querySelector('button[aria-label="Back to the live tail"]')) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { scroller, jump: host.querySelector('button[aria-label="Back to the live tail"]') as HTMLButtonElement };
}

for (const surface of ["phone", "desktop"] as const) {
  test(`${surface}: the jump control floats at the feed's bottom right, over a faded edge, and takes no row`, async () => {
    mobile = surface === "phone";
    const host = render(conversation(`jump-strip-${surface}`));
    expect(host.querySelector("[data-feed-jump-strip]")).toBeNull();
    const { scroller, jump } = await releaseTail(host);
    expect(jump).toBeTruthy();
    const strip = jump.closest("[data-feed-jump-strip]") as HTMLElement | null;
    expect(strip).toBeTruthy();
    /* Inside the box that overlays the scroller, pinned to its bottom right:
       nothing after the scroller in flow, so its viewport is as tall as before. */
    expect(scroller.parentElement!.contains(strip)).toBe(true);
    expect(strip!.className.split(/\s+/)).toEqual(expect.arrayContaining(["absolute", "bottom-0", "right-2"]));
    expect(scroller.nextElementSibling?.matches("[data-feed-jump-strip]") ?? false).toBe(false);
    /* The edge under it fades out, as tall as its 44 px target. */
    expect(scroller.hasAttribute("data-feed-faded")).toBe(true);
    expect(scroller.style.maskImage).toContain(`calc(100% - ${JUMP_FADE_PX}px)`);
    expect(JUMP_FADE_PX).toBe(44);
    /* A 44 px target around the 32 px pill, which still says where it goes. */
    expect(jump.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-11", "min-w-11", "pointer-events-auto"]));
    expect(jump.querySelector("[data-feed-jump-pill]")?.className.split(/\s+/)).toContain("h-8");
    expect(jump.textContent).toContain("down");

    flushSync(() => { jump.click(); });
    expect(host.querySelector("[data-feed-jump-strip]")).toBeNull();
    expect(scroller.hasAttribute("data-feed-faded")).toBe(false);
  });
}

test("uk: the strip keeps the existing words", async () => {
  setLocale("uk");
  const host = render(conversation("jump-strip-uk"));
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_200, 200, 1_000);
  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !host.querySelector("[data-feed-jump-strip] button")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const jump = host.querySelector("[data-feed-jump-strip] button");
  expect(jump?.getAttribute("aria-label")).toBe("Повернутись до живого хвоста");
  expect(jump?.textContent).toContain("вниз");
});

/* Board task d5e2680a: the phone's chat screen is drawn while a first read
   loads, so what the read settles on is marked once, for the stylesheet to
   fade it in where it rests instead of swapping it in for the skeleton. A
   tail read before paints at once and is never marked. */
describe("a first read's arrival", () => {
  function mount() {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const root = createRoot(host as unknown as Element);
    roots.add(root);
    const show = (feedFile: FileEntry) => flushSync(() => root.render(
      <LogFeed file={feedFile} showSvc={false} lineFilter="" onStatus={() => undefined} paused follow setFollow={() => undefined} compact />,
    ));
    const content = () => host.querySelector("[data-feed-state]") as unknown as HTMLElement;
    return { show, content };
  }

  test("the transcript a skeleton waited for is marked as arrived; the skeleton never is", () => {
    const { show, content } = mount();
    tail = { lines: [], loading: true, error: null };
    show(file);
    expect(content().dataset.feedState).toBe("loading");
    expect(content().querySelector('[data-skeleton="feed"]')).toBeTruthy();
    expect(content().hasAttribute("data-feed-arrived")).toBe(false);
    tail = { lines: TRANSCRIPT, loading: false, error: null };
    show(file);
    expect(content().dataset.feedState).toBe("items");
    expect(content().querySelector('[data-skeleton="feed"]')).toBeNull();
    expect(content().hasAttribute("data-feed-arrived")).toBe(true);
  });

  test("a read that fails after the skeleton is marked too", () => {
    const { show, content } = mount();
    tail = { lines: [], loading: true, error: null };
    show(file);
    tail = { lines: [], loading: false, error: "read failed" };
    show(file);
    expect(content().dataset.feedState).toBe("error");
    expect(content().hasAttribute("data-feed-arrived")).toBe(true);
  });

  test("a reply card waits for the arrival and fades in with the rows; later rows are not marked", () => {
    const { show, content } = mount();
    const waiting = { ...file, waitingInput: { since: Date.parse(AT(0)), screenTail: "Proceed? (y/n)", target: "lane5:0.0", menu: null } } as FileEntry;
    tail = { lines: [], loading: true, error: null };
    show(waiting);
    expect(content().querySelector("#question")).toBeNull();
    tail = { lines: TRANSCRIPT, loading: false, error: null };
    show(waiting);
    expect(content().hasAttribute("data-feed-arrived")).toBe(true);
    const card = content().querySelector("#question");
    expect(card).toBeTruthy();
    expect(card!.hasAttribute("data-feed-enter")).toBe(true);
    const rows = [...content().querySelectorAll(":scope > [data-feed-key]")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.hasAttribute("data-feed-enter"))).toBe(true);
    const later = JSON.stringify({ type: "assistant", uuid: "uuid-later", timestamp: AT(3), message: { role: "assistant", content: [{ type: "text", text: "A later reply after the arrival." }] } });
    tail = { lines: [...TRANSCRIPT, later], loading: false, error: null };
    show(waiting);
    const added = [...content().querySelectorAll(":scope > [data-feed-key]")].filter((row) => !rows.includes(row));
    expect(added.length).toBe(1);
    expect(added[0]!.hasAttribute("data-feed-enter")).toBe(false);
  });

  test("a tail read before paints at once, unmarked", () => {
    const { show, content } = mount();
    show(file);
    expect(content().dataset.feedState).toBe("items");
    expect(content().hasAttribute("data-feed-arrived")).toBe(false);
  });

  test("switching to another conversation and back does not mark either again", () => {
    const { show, content } = mount();
    tail = { lines: [], loading: true, error: null };
    show(file);
    tail = { lines: TRANSCRIPT, loading: false, error: null };
    show(file);
    expect(content().hasAttribute("data-feed-arrived")).toBe(true);
    show(conversation("arrival-other"));
    expect(content().hasAttribute("data-feed-arrived")).toBe(false);
    show(file);
    expect(content().hasAttribute("data-feed-arrived")).toBe(false);
  });
});
