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
  }) as unknown as typeof fetch;
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


test("unchanged seat polls render nothing; changed notes and failures still publish", async () => {
  let renders = 0;
  let fail = false;
  let title = "Seat notes";
  const refs = { conversationIds: ["seat-a"], paths: ["/sessions/seat-a.jsonl"], previous: { conversationIds: [], paths: [] } };
  globalThis.fetch = (async () => {
    if (fail) throw new Error("poll failed");
    return new Response(JSON.stringify({ seat: null, pending: null, exists: true,
      currentTask: { taskId: "seat-task", title, hasNotes: true }, all: refs }));
  }) as unknown as typeof fetch;
  function CountedProbe() {
    // Test instrumentation counts renders, including abandoned ones.
    // eslint-disable-next-line react-hooks/globals
    renders += 1;
    // Fail before a render loop can exhaust the host's memory.
    if (renders > 30) throw new Error("seat render loop");
    const seat = useOrchestratorSeat("project-a");
    useSeatConversations(true);
    return <span>{seat.status?.currentTask?.title}:{String(seat.failed)}</span>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<CountedProbe />));
  await Bun.sleep(30);
  const initial = renders;
  await Bun.sleep(SEAT_POLL_MS + 100);
  expect(renders).toBe(initial);
  title = "Updated notes";
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(30);
  expect(host.textContent).toBe("Updated notes:false");
  expect(renders).toBeGreaterThan(initial);
  fail = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(30);
  expect(host.textContent).toBe("Updated notes:true");
  const failedRenders = renders;
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(30);
  expect(renders).toBe(failedRenders);
  fail = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(30);
  expect(host.textContent).toBe("Updated notes:false");
  refs.paths.push("/sessions/seat-b.jsonl");
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(30);
  expect(renders).toBeGreaterThan(failedRenders);
}, 10_000);


test("enabling a reader adopts the cached seat references even when the poll is unchanged", async () => {
  const refs = { conversationIds: ["seat-a"], paths: ["/sessions/seat-a.jsonl"], previous: { conversationIds: [], paths: [] } };
  globalThis.fetch = (async () => new Response(JSON.stringify({ all: refs }))) as unknown as typeof fetch;
  function Reader({ enabled, label }: { enabled: boolean; label: string }) {
    const refs = useSeatConversations(enabled);
    return <span data-reader={label}>{refs?.paths.join("|") ?? "unread"}</span>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (enabled: boolean) => flushSync(() => root!.render(<>
    <Reader enabled label="first" />
    <Reader enabled={enabled} label="later" />
  </>));
  render(false);
  await Bun.sleep(30);
  expect(host.querySelector('[data-reader="later"]')?.textContent).toBe("unread");
  render(true);
  await Bun.sleep(30);
  expect(host.querySelector('[data-reader="later"]')?.textContent).toBe("/sessions/seat-a.jsonl");
});
