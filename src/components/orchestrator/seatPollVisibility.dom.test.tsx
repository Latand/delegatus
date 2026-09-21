import { afterEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

/* #1994: a hidden phone tab re-read every seat every six seconds. The seat
   polls skip their ticks while hidden and read once when the tab returns. */

const dom = new HappyWindow();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
});
let visibility: "visible" | "hidden" = "visible";
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });

const { SEAT_POLL_MS, resetOrchestratorSeatCacheForTests, useOrchestratorSeat, useSeatConversations } = await import("./useOrchestratorSeat");

const realFetch = globalThis.fetch;
let reads: string[] = [];
let root: Root | null = null;

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  resetOrchestratorSeatCacheForTests();
  globalThis.fetch = realFetch;
  visibility = "visible";
  document.body.replaceChildren();
});

function Probe() {
  useOrchestratorSeat("project-a");
  useSeatConversations(true);
  return null;
}

test("seat polls are silent while hidden and read once on return", async () => {
  reads = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    reads.push(String(input));
    return new Response(JSON.stringify({ seat: null, pending: null, exists: true, all: [] }));
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Probe />));
  await Bun.sleep(20);
  const initial = reads.length;
  expect(initial).toBe(2);

  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(SEAT_POLL_MS * 2 + 200);
  expect(reads.length).toBe(initial);

  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(20);
  expect(reads.length).toBe(initial + 2);
}, 20_000);
