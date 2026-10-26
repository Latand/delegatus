import { afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import type { ReaderPlacement } from "./KanbanReaders";
import { READER_READY_LIMIT_MS, useReaderReady } from "./agentWindowGeometry";

installActEnv();
const dom = new Window();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
});
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  frames.clear();
  document.body.replaceChildren();
});
async function frame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

function feedIn(width: number) {
  const container = document.createElement("div");
  const feed = document.createElement("div");
  feed.dataset.logFeedScroller = "";
  container.append(feed);
  document.body.append(container);
  const box = { height: 400 };
  Object.defineProperties(feed, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => box.height },
    scrollHeight: { get: () => 1600 },
  });
  const placement = { containerOf: () => container } as unknown as ReaderPlacement;
  return { feed, box, placement };
}

async function open(placement: ReaderPlacement, onReady: () => void) {
  function Open() {
    useReaderReady(placement, "conversation", onReady);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Open />));
}

for (const width of [390, 1280]) {
  test(`a first read is shown once its height and scrollTop have settled together at ${width}px`, async () => {
    const { feed, box, placement } = feedIn(width);
    feed.dataset.feedState = "loading";
    const revealed: Array<{ height: number; top: number }> = [];
    await open(placement, () => revealed.push({ height: feed.clientHeight, top: feed.scrollTop }));
    await frame();
    await frame();
    await frame();
    expect(revealed).toEqual([]);
    feed.dataset.feedState = "items"; // Ready before the feed has followed its tail.
    await frame();
    box.height = 480;
    await frame();
    await frame();
    expect(revealed).toEqual([]);
    feed.scrollTop = 1120; // Follow/restore can settle a frame after layout.
    await frame();
    await frame();
    expect(revealed).toEqual([]);
    await frame();
    expect(revealed).toEqual([{ height: 480, top: 1120 }]);
    await frame();
    await frame();
    expect(revealed).toHaveLength(1);
    expect(frames.size).toBe(0);
  });
}

test("a reader that is already ready is shown in the same commit, with no frame between", async () => {
  const { feed, placement } = feedIn(1280);
  feed.dataset.feedState = "items";
  feed.scrollTop = 1200;
  let reveals = 0;
  await open(placement, () => { reveals++; });
  expect(reveals).toBe(1);
  expect(frames.size).toBe(0);
});

test("a reader that never settles is shown at the readiness limit", async () => {
  const { feed, placement } = feedIn(1280);
  feed.dataset.feedState = "loading";
  let reveals = 0;
  const now = performance.now();
  const clock = spyOn(performance, "now").mockReturnValue(now);
  try {
    await open(placement, () => { reveals++; });
    await frame();
    expect(reveals).toBe(0);
    clock.mockReturnValue(now + READER_READY_LIMIT_MS);
    await frame();
    expect(reveals).toBe(1);
    expect(frames.size).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test("closing a pending conversation cancels its reveal", async () => {
  const placement = { containerOf: () => null } as unknown as ReaderPlacement;
  let reveals = 0;
  function Open() {
    useReaderReady(placement, "conversation", () => { reveals++; });
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Open />));
  await act(async () => root!.render(null));
  await frame();
  expect(reveals).toBe(0);
  expect(frames.size).toBe(0);
});
