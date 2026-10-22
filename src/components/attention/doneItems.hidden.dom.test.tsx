import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { CueRequest } from "@/lib/audio/cues";
import type { DoneItemV1 } from "@/lib/done/types";
import { installActEnv } from "@/test-helpers/actEnv";

/*
 * The «Готово» feed in a hidden tab (docs/design/sound-redesign.md §4.3, §8):
 * S5 and the deploy and limit faults read it, so a hidden desktop tab keeps
 * reading it at its 30 s cadence and the sound reaches the operator working
 * elsewhere; a hidden phone reads nothing (#1994).
 */

const dom = new HappyWindow({ url: "http://127.0.0.1:8899/" });
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement });

const played: CueRequest[] = [];
const actualApp = await import("@/lib/audio/app");
mock.module("@/lib/audio/app", () => ({ ...actualApp, playCue: (request: CueRequest) => { played.push(request); return "played"; } }));
afterAll(() => {
  mock.module("@/lib/audio/app", () => actualApp);
});

const { useDoneItems, useDoneItemsLoaded, resetDoneItemsForTests } = await import("./doneItems");
const { useWorkCues } = await import("@/hooks/useWorkCues");

const realFetch = globalThis.fetch;
let reads = 0;
let served: DoneItemV1[] = [];
let ticks: Array<() => void> = [];
let visibility: "visible" | "hidden" = "visible";
let phone = false;
let root: Root | null = null;

function Probe() {
  const items = useDoneItems();
  const loaded = useDoneItemsLoaded();
  useWorkCues([], [], items, "repo-widgets", true, loaded);
  return null;
}

beforeEach(() => {
  reads = 0;
  served = [];
  ticks = [];
  played.length = 0;
  visibility = "visible";
  phone = false;
  resetDoneItemsForTests();
  Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
  (dom as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = (query) => ({
    matches: phone ? query === "(pointer: coarse)" : query === "(any-pointer: fine)",
  });
  spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void) => {
    ticks.push(handler);
    return ticks.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  globalThis.fetch = (async () => {
    reads += 1;
    return new Response(JSON.stringify({ items: served }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  root = null;
  globalThis.fetch = realFetch;
  mock.restore();
});

const settle = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
const tick = () => act(async () => { ticks[0](); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });

function mount() {
  root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
  act(() => { root!.render(<Probe />); });
}

function deployItem(at: number): DoneItemV1 {
  return { key: "deploy:rel-1", kind: "deploy", at: new Date(at).toISOString(), refs: { phase: "succeeded" } } as unknown as DoneItemV1;
}

test("a hidden desktop tab reads the done feed again at the 30 s tick", async () => {
  mount();
  await settle();
  expect(reads).toBe(1);
  visibility = "hidden";
  expect(ticks).toHaveLength(1);
  await tick();
  expect(reads).toBe(2);
});

test("a fresh deploy that arrives on a hidden read sounds as released", async () => {
  mount();
  await settle();
  expect(played).toEqual([]);
  visibility = "hidden";
  served = [deployItem(Date.now())];
  await tick();
  await settle();
  expect(played.map((request) => [request.cue, request.eventId])).toEqual([["released", "done:deploy:rel-1"]]);
});

test("a hidden phone reads nothing at the tick", async () => {
  phone = true;
  mount();
  await settle();
  expect(reads).toBe(1);
  visibility = "hidden";
  await tick();
  expect(reads).toBe(1);
});

test("a visible tab keeps its tick", async () => {
  mount();
  await settle();
  await tick();
  expect(reads).toBe(2);
});
