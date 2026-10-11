import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { DeliveryProgressStore, setDeliveryProgressStoreForTests } from "@/lib/runtime/deliveryProgress";
import { GET } from "@/app/api/runtime/delivery-progress/route";
import { resetDeliveryProgressPollerForTests, useDeliveryProgress } from "./useDeliveryProgress";

const dom = new Window({ url: "http://localhost/" });
installActEnv();
const saved = { window: globalThis.window, document: globalThis.document };
Object.assign(globalThis, { window: dom, document: dom.document });
afterAll(async () => {
  Object.assign(globalThis, saved);
  await dom.happyDOM.abort();
});

test("65 subscriptions across consumers read every stall and retain other batches after unsubscribe or a failed read", async () => {
  const ids = Array.from({ length: 65 }, (_, n) => `poll-operation-${n}`);
  const store = new DeliveryProgressStore(null);
  ids.forEach((id, n) => {
    store.note(id, `conversation_poll_${n < 64 ? "a" : "b"}`, { waitReason: "checking", detail: "reading the host state" });
    store.stalled(id);
  });
  setDeliveryProgressStoreForTests(store);
  const batches: string[][] = [];
  let refuseFirstBatch = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), "http://localhost");
    const batch = url.searchParams.getAll("operationId");
    batches.push(batch);
    if (refuseFirstBatch && batch.includes(ids[0]!)) return new Response(null, { status: 503 });
    return GET(new Request(url));
  }) as typeof fetch;
  function Reading({ operations, name }: { operations: string[]; name: string }) {
    const reading = useDeliveryProgress(operations, true);
    return <output data-reader={name}>{operations.map(id => reading.records.get(id)?.stalledSince ? id : "missing").join(",")}</output>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<><Reading name="receipts" operations={ids.slice(0, 64)} /><Reading name="message" operations={ids.slice(64)} /></>);
      await Bun.sleep(100);
    });
    expect(new Set(batches.flat()).size).toBe(65);
    expect(batches.every(batch => batch.length <= 64)).toBe(true);
    expect(container.querySelector('[data-reader="message"]')?.textContent).toBe(ids[64]!);
    expect(container.querySelector('[data-reader="receipts"]')?.textContent).not.toContain("missing");
    refuseFirstBatch = true;
    await act(async () => { await Bun.sleep(3_100); });
    expect(container.querySelector('[data-reader="receipts"]')?.textContent).not.toContain("missing");
    expect(container.querySelector('[data-reader="message"]')?.textContent).toBe(ids[64]!);
    await act(async () => { root.render(<Reading name="message" operations={ids.slice(64)} />); await Bun.sleep(100); });
    expect(container.textContent).toBe(ids[64]!);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    setDeliveryProgressStoreForTests(null);
    store.close();
    container.remove();
  }
}, 10_000);

test("an answered batch publishes its stall while another batch stays pending through poll aborts", async () => {
  const ids = Array.from({ length: 65 }, (_, n) => `pending-poll-operation-${n}`);
  const store = new DeliveryProgressStore(null);
  for (const id of ids) {
    store.note(id, "conversation_pending_poll", { waitReason: "checking", detail: "reading the host state" });
    store.stalled(id);
  }
  setDeliveryProgressStoreForTests(store);
  resetDeliveryProgressPollerForTests(new Map(ids.slice(0, 64).map(id => [id, store.get(id)!])));
  let abortedBatches = 0;
  let answeredBatches = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.searchParams.getAll("operationId").includes(ids[0]!)) {
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => {
          abortedBatches++;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }
    answeredBatches++;
    return GET(new Request(url));
  }) as typeof fetch;
  function Reading({ operations, name }: { operations: string[]; name: string }) {
    const reading = useDeliveryProgress(operations, true);
    return <output data-reader={name}>{operations.map(id => reading.records.get(id)?.stalledSince ? id : "missing").join(",")}</output>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<><Reading key="receipts" name="receipts" operations={ids.slice(0, 64)} /><Reading key="message" name="message" operations={ids.slice(64)} /></>);
      await Bun.sleep(100);
    });
    expect(answeredBatches).toBeGreaterThan(0);
    expect(container.querySelector('[data-reader="message"]')?.textContent).toBe(ids[64]!);
    expect(container.querySelector('[data-reader="receipts"]')?.textContent).not.toContain("missing");
    await act(async () => { await Bun.sleep(3_100); });
    expect(abortedBatches).toBeGreaterThan(0);
    expect(answeredBatches).toBeGreaterThan(1);
    expect(container.querySelector('[data-reader="message"]')?.textContent).toBe(ids[64]!);
    expect(container.querySelector('[data-reader="receipts"]')?.textContent).not.toContain("missing");
    await act(async () => { root.render(<Reading key="message" name="message" operations={ids.slice(64)} />); });
    expect(container.textContent).toBe(ids[64]!);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    resetDeliveryProgressPollerForTests();
    setDeliveryProgressStoreForTests(null);
    store.close();
    container.remove();
  }
}, 10_000);
