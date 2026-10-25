import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/**
 * The conversation feed's follow scroll, and the pills it no longer has.
 *
 * The orchestrator dock and the board's conversation pane are the same shell:
 * both compose `LogFeed` over `TmuxComposer`. Reply-draft pills used to sit
 * under the latest turn and pin above the composer (#1202); every ask now goes
 * through a decision form, so neither place renders a pill and nothing reads
 * drafts. The rest asserts how follow holds and releases.
 */

const dom = new HappyWindow({ width: 1280, height: 800 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
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
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }
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
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IntersectionObserver: undefined,
});

const CONVERSATION_ID = "conversation_seat_1202";
const AT = (second: number) => `2026-08-26T10:00:${String(second).padStart(2, "0")}.000Z`;

/* One ask from the manager, as the tail reads it: the operator's request and
   the question that once carried reply drafts under it. */
const TRANSCRIPT = [
  { type: "user", uuid: "uuid-ask", timestamp: AT(0), message: { role: "user", content: [{ type: "text", text: "How does the merge look?" }] } },
  { type: "assistant", uuid: "uuid-answer", timestamp: AT(1), message: { role: "assistant", content: [{ type: "text", text: "Both reviews passed. Merge now, or hold for the deploy window?" }] } },
].map((line) => JSON.stringify(line));

/* Every URL the pane reaches for. Each is absent here: a 404 is what each of
   those readers already handles (no delivery evidence, no tmux targets, no
   speech backends), so nothing else renders. */
const requested: string[] = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  requested.push(String(input));
  return { ok: false, status: 404, json: async () => ({}) } as Response;
}) as typeof fetch;

const tailState = { lines: TRANSCRIPT };
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
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: tailState.lines,
    linesStart: 0,
    size: tailState.lines.length,
    loading: false,
    error: null,
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
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("./LogFeed");

const roots = new Set<Root>();
beforeEach(() => {
  setLocale("en");
  dom.sessionStorage.clear();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  tailState.lines = TRANSCRIPT;
});
afterAll(() => {
  globalThis.fetch = previousFetch;
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

const file = {
  path: "/fixtures/claude/projects/-repo/seat-1202.jsonl",
  root: "claude-projects",
  name: "seat-1202.jsonl",
  project: "repo",
  title: "Manager",
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
  conversationId: CONVERSATION_ID,
} as FileEntry;

function conversationFile(suffix: string): FileEntry {
  return {
    ...file,
    path: `/fixtures/claude/projects/-repo/seat-${suffix}.jsonl`,
    name: `seat-${suffix}.jsonl`,
    conversationId: `conversation_seat_${suffix.replaceAll("-", "_")}`,
  };
}

function feedElement(
  follow: boolean,
  setFollow: (value: boolean) => void,
  feedFile: FileEntry,
): ReactElement {
  return (
    <LogFeed
      file={feedFile}
      showSvc={false}
      lineFilter=""
      onStatus={() => undefined}
      paused
      follow={follow}
      setFollow={setFollow}
      compact
    />
  );
}

function transcriptWithUpdates(idPrefix: string, textPrefix: string, count: number): string[] {
  return [
    ...TRANSCRIPT,
    ...Array.from({ length: count }, (_, index) => JSON.stringify({
      type: "assistant",
      uuid: `uuid-${idPrefix}-${index}`,
      timestamp: AT(3 + index),
      message: { role: "assistant", content: [{ type: "text", text: `${textPrefix} ${index + 1}.` }] },
    })),
  ];
}

function render(
  follow: boolean,
  setFollow: (value: boolean) => void = () => undefined,
  feedFile: FileEntry = file,
): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => {
    root.render(feedElement(follow, setFollow, feedFile));
  });
  return host as unknown as HTMLElement;
}

function setScrollerGeometry(element: HTMLElement, height: number, viewport: number, initialTop: number) {
  let scrollHeight = height;
  let top = initialTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => viewport },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(Number(value), scrollHeight - viewport));
      },
    },
  });
  return {
    setHeight: (value: number) => { scrollHeight = value; },
    setTop: (value: number) => { element.scrollTop = value; },
  };
}

function touchEvent(type: "touchstart" | "touchmove" | "touchend", clientY?: number): Event {
  const event = new dom.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: clientY === undefined ? [] : [{ clientX: 20, clientY }],
  });
  return event as unknown as Event;
}

function pointerEvent(type: "pointerdown" | "pointerup", clientX: number): Event {
  return new dom.PointerEvent(type, {
    bubbles: true,
    button: 0,
    clientX,
    clientY: 100,
    pointerType: "mouse",
  }) as unknown as Event;
}

function setScrollerPointerGeometry(element: HTMLElement, contentWidth: number, totalWidth: number): void {
  Object.defineProperties(element, {
    clientLeft: { configurable: true, value: 0 },
    clientWidth: { configurable: true, value: contentWidth },
  });
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: totalWidth,
    bottom: element.clientHeight,
    width: totalWidth,
    height: element.clientHeight,
    toJSON: () => ({}),
  });
}

async function settle(host: HTMLElement, selector: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !host.querySelector(selector)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test.each([true, false])("no reply-draft pill renders under the latest turn or above the composer (follow %p), and nothing reads drafts", async (follow) => {
  requested.length = 0;
  const host = render(follow);
  await settle(host, "[data-feed-key]");
  const rows = [...host.querySelectorAll("[data-feed-key]")];
  expect(rows.map((row) => row.textContent).join("\n")).toContain("Merge now, or hold for the deploy window?");
  /* A few more turns of the event loop, where the pills' read used to land. */
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(host.querySelectorAll("[data-reply-suggestions], [data-reply-suggestion]")).toHaveLength(0);
  expect(host.textContent).not.toContain("Yes, publish report ");
  expect(host.querySelector('[aria-label="Suggested replies — tap one to put it in the composer"]')).toBeNull();
  expect(requested.filter((url) => url.includes("/api/log/suggestions"))).toEqual([]);
});

test("an upward wheel survives a concurrent glue and releases the scroll magnet on the first gesture", () => {
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    const followChanges: boolean[] = [];
    const host = render(true, (value) => followChanges.push(value));
    const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
    const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -20 }) as unknown as Event);
      geometry.setHeight(1_100);
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
      geometry.setTop(880);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    expect(scroller.scrollTop).toBe(880);
    expect(followChanges).toEqual([false]);
  } finally {
    Date.now = originalNow;
  }
});

test("a burst of tail records cannot move the viewport down during an upward wheel gesture", () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("wheel-burst");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const root = [...roots].at(-1)!;
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);
  const viewportPositions = [scroller.scrollTop];

  try {
    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }) as unknown as Event);
    });

    for (let record = 1; record <= 3; record += 1) {
      tailState.lines = transcriptWithUpdates("wheel-burst", "Burst update", record);
      geometry.setHeight(1_000 + record * 100);
      flushSync(() => {
        root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
      });
      viewportPositions.push(scroller.scrollTop);
    }

    expect(viewportPositions).toEqual([800, 800, 800, 800]);
    expect(followChanges).toEqual([false]);
  } finally {
    tailState.lines = TRANSCRIPT;
  }
});

test("a burst of tail records cannot move the viewport down during an upward touch gesture", () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("touch-burst");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const root = [...roots].at(-1)!;
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);
  const viewportPositions = [scroller.scrollTop];

  try {
    flushSync(() => {
      scroller.dispatchEvent(touchEvent("touchstart", 400));
      scroller.dispatchEvent(touchEvent("touchmove", 460));
    });

    for (let record = 1; record <= 3; record += 1) {
      tailState.lines = transcriptWithUpdates("touch-burst", "Touch burst update", record);
      geometry.setHeight(1_000 + record * 100);
      flushSync(() => {
        root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
      });
      viewportPositions.push(scroller.scrollTop);
    }

    expect(viewportPositions).toEqual([800, 800, 800, 800]);
    expect(followChanges).toEqual([false]);
  } finally {
    tailState.lines = TRANSCRIPT;
  }
});

test("follow stays disarmed across further arrivals and resizes until the operator reaches bottom", () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("durable-release");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const root = [...roots].at(-1)!;
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

  try {
    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
      geometry.setTop(600);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    const releasedPositions: number[] = [];
    for (let record = 1; record <= 3; record += 1) {
      tailState.lines = transcriptWithUpdates("durable-release", "Durable update", record);
      geometry.setHeight(1_000 + record * 100);
      flushSync(() => {
        root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
        for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      });
      releasedPositions.push(scroller.scrollTop);
    }

    expect(releasedPositions).toEqual([600, 600, 600]);
    expect(followChanges).toEqual([false]);

    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 500 }) as unknown as Event);
      geometry.setTop(1_100);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });
    expect(followChanges).toEqual([false, true]);

    tailState.lines = [
      ...tailState.lines,
      JSON.stringify({
        type: "assistant",
        uuid: "uuid-after-bottom-return",
        timestamp: AT(6),
        message: { role: "assistant", content: [{ type: "text", text: "Following again." }] },
      }),
    ];
    geometry.setHeight(1_400);
    flushSync(() => {
      root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
    });
    expect(scroller.scrollTop).toBe(1_200);
  } finally {
    tailState.lines = TRANSCRIPT;
  }
});

test("a pointer-driven scrollbar return to bottom re-arms follow without authorizing content clicks", () => {
  const followChanges: boolean[] = [];
  const host = render(true, (value) => followChanges.push(value), conversationFile("scrollbar-return"));
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);
  setScrollerPointerGeometry(scroller, 300, 320);

  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  expect(followChanges).toEqual([false]);

  flushSync(() => {
    scroller.dispatchEvent(pointerEvent("pointerdown", 100));
    geometry.setTop(800);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    scroller.dispatchEvent(pointerEvent("pointerup", 100));
  });
  expect(followChanges).toEqual([false]);

  flushSync(() => {
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    scroller.dispatchEvent(pointerEvent("pointerdown", 310));
    geometry.setTop(700);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  expect(followChanges).toEqual([false]);

  flushSync(() => {
    geometry.setTop(800);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    scroller.dispatchEvent(pointerEvent("pointerup", 310));
  });
  expect(followChanges).toEqual([false, true]);
});

test("an ended scrollbar gesture cannot authorize a later uncaused bottom-reaching scroll", () => {
  const followChanges: boolean[] = [];
  const host = render(true, (value) => followChanges.push(value), conversationFile("programmatic-bottom"));
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);
  setScrollerPointerGeometry(scroller, 300, 320);

  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  expect(followChanges).toEqual([false]);

  flushSync(() => {
    scroller.dispatchEvent(pointerEvent("pointerdown", 310));
    geometry.setTop(700);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    scroller.dispatchEvent(pointerEvent("pointerup", 310));
  });
  expect(followChanges).toEqual([false]);

  flushSync(() => {
    geometry.setTop(800);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  expect(followChanges).toEqual([false]);
});

test("the jump-to-latest control clears the durable disarm and restores live-tail follow", async () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("jump-latest");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_200, 200, 1_000);

  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  await settle(host, 'button[aria-label="Back to the live tail"]');

  const jump = host.querySelector('button[aria-label="Back to the live tail"]') as HTMLButtonElement;
  expect(jump).toBeTruthy();
  expect(followChanges).toEqual([false]);

  flushSync(() => { jump.click(); });

  expect(scroller.scrollTop).toBe(1_000);
  expect(followChanges).toEqual([false, true]);
  expect(host.querySelector('button[aria-label="Back to the live tail"]')).toBeNull();
  expect(host.querySelector("[data-live-tail-pill]")).toBeTruthy();
});

test("growth before an upward wheel survives resize glue and stays released through the next append", () => {
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    const followChanges: boolean[] = [];
    const feedFile = {
      ...file,
      path: "/fixtures/claude/projects/-repo/seat-growth-before-input.jsonl",
      name: "seat-growth-before-input.jsonl",
      conversationId: "conversation_seat_growth_before_input",
    };
    const host = render(true, (value) => followChanges.push(value), feedFile);
    const root = [...roots].at(-1)!;
    const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
    const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

    flushSync(() => {
      geometry.setHeight(1_100);
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }) as unknown as Event);
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
      geometry.setTop(780);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    expect(scroller.scrollTop).toBe(780);
    expect(followChanges).toEqual([false]);

    tailState.lines = [
      ...TRANSCRIPT,
      JSON.stringify({
        type: "assistant",
        uuid: "uuid-after-release",
        timestamp: AT(3),
        message: { role: "assistant", content: [{ type: "text", text: "A later update arrived." }] },
      }),
    ];
    geometry.setHeight(1_200);
    flushSync(() => {
      root.render(
        <LogFeed
          file={feedFile}
          showSvc={false}
          lineFilter=""
          onStatus={() => undefined}
          paused
          follow={false}
          setFollow={(value) => followChanges.push(value)}
          compact
        />,
      );
    });

    expect(scroller.scrollTop).toBe(780);
    expect(followChanges).toEqual([false]);
  } finally {
    tailState.lines = TRANSCRIPT;
    Date.now = originalNow;
  }
});

test("a wheel that cannot move the feed does not tag a later settling scroll as user initiated", () => {
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    const followChanges: boolean[] = [];
    const host = render(
      true,
      (value) => followChanges.push(value),
      {
        ...file,
        path: "/fixtures/claude/projects/-repo/seat-settling.jsonl",
        name: "seat-settling.jsonl",
        conversationId: "conversation_seat_settling",
      },
    );
    const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
    const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }) as unknown as Event);
      geometry.setTop(600);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    expect(scroller.scrollTop).toBe(800);
    expect(followChanges).toEqual([]);
  } finally {
    Date.now = originalNow;
  }
});
