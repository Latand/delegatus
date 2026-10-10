import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { DeliveredMessageOccurrence, DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import type { ProvenanceLookup } from "./messageProvenance";
import type { FeedEntry, Item } from "./parse";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const {
  useDeliveredMessageProvenance,
  resetMessageProvenanceCacheForTests,
  setMessageProvenanceRetryScheduleForTests,
} = await import("./messageProvenance");

/* Assembled from parts so the invented id can never fingerprint as a real
   engine message identifier on the publication gate. */
const ENGINE_MESSAGE_ID = ["99999999", "8888", "4777", "8666", "555555555555"].join("-");
const TRANSCRIPT_PATH = "/sessions/provenance-retry.jsonl";
const TEXT = "please rerun the failing check";

const deliveredEntry: FeedEntry = {
  anchorKey: null,
  key: "row-1",
  item: {
    kind: "sysmsg",
    label: "system",
    text: TEXT,
    deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: "2026-07-31T09:00:01.000Z" },
  },
};

/* The probe renders the resolution itself, so assertions read the DOM the way
   FeedItem would instead of capturing render-time state. */
function Probe({ path, items, probe }: { path: string | null; items: readonly FeedEntry[]; probe: Item }) {
  const lookup: ProvenanceLookup = useDeliveredMessageProvenance(path, items);
  const resolved = lookup.forItem(probe);
  const id = probe.kind === "sysmsg" ? probe.deliveredMessage?.engineMessageId : null;
  return <span id="probe" data-first-read-pending={lookup.messageReadPending(id)} data-message-pending={lookup.messagePending(id)}>{resolved ? resolved.origin : "unresolved"}</span>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetMessageProvenanceCacheForTests();
  setMessageProvenanceRetryScheduleForTests(null);
});

interface Response {
  messages?: Record<string, DeliveredMessageProvenance>;
  occurrences?: DeliveredMessageOccurrence[];
}

function stubFetch(responses: Response[]): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return {
      ok: true,
      json: async () => ({ messages: body.messages ?? {}, occurrences: body.occurrences ?? [] }),
    };
  }) as unknown as typeof fetch;
  return () => calls;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probeText(container: ReturnType<typeof dom.document.createElement>): string | null {
  return container.querySelector("#probe")?.textContent ?? null;
}

async function mount(items: readonly FeedEntry[], probe: Item) {
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<Probe path={TRANSCRIPT_PATH} items={items} probe={probe} />);
  });
  return {
    text: () => probeText(container),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

test("an unresolved delivered id revalidates until the ledger answers, without a remount", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10, 10]);
  /* The transcript row is visible before the ledger records its engine message
     id: the first response is empty, the second resolves the SAME id. */
  const calls = stubFetch([{}, { messages: { [ENGINE_MESSAGE_ID]: { origin: "operator" } } }]);
  const probe = await mount([deliveredEntry], deliveredEntry.item);
  expect(probe.text()).toBe("unresolved");
  await act(async () => {
    await sleep(40);
  });
  expect(probe.text()).toBe("operator");
  const settled = calls();
  expect(settled).toBe(2);
  /* Resolution ends the schedule: no further polling. */
  await act(async () => {
    await sleep(40);
  });
  expect(calls()).toBe(settled);
  await probe.unmount();
});

test("an id with no evidence stops at the bounded schedule instead of polling forever", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10]);
  const calls = stubFetch([{}]);
  const probe = await mount([deliveredEntry], deliveredEntry.item);
  await act(async () => {
    await sleep(80);
  });
  /* Initial fetch plus exactly the two scheduled revalidations. */
  expect(calls()).toBe(3);
  expect(probe.text()).toBe("unresolved");
  await probe.unmount();
});

test("the first empty answer releases ordinary rows while the delayed ledger join still waits", async () => {
  setMessageProvenanceRetryScheduleForTests([10]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const retry = calls > 1;
    if (retry) await gate;
    return { ok: true, json: async () => ({ messages: retry ? { [ENGINE_MESSAGE_ID]: { origin: "operator" } } : {}, occurrences: [] }) };
  }) as unknown as typeof fetch;
  const container = dom.document.createElement("div"), root = createRoot(container as unknown as Element);
  const pending = () => [container.querySelector("#probe")?.getAttribute("data-first-read-pending"), container.querySelector("#probe")?.getAttribute("data-message-pending")];
  try {
    await act(async () => root.render(<Probe path={TRANSCRIPT_PATH} items={[deliveredEntry]} probe={deliveredEntry.item} />));
    expect(pending()).toEqual(["false", "true"]);
    await act(async () => { await sleep(30); });
    expect(calls).toBe(2);
    expect(pending()).toEqual(["false", "true"]);
    await act(async () => { release(); });
    expect(pending()).toEqual(["false", "false"]);
    expect(probeText(container)).toBe("operator");
  } finally { release(); await act(async () => root.unmount()); }
});

test("a first answer is scoped to the native id and the transcript path", async () => {
  setMessageProvenanceRetryScheduleForTests([10_000]);
  let release: () => void = () => {};
  let gate = Promise.resolve();
  globalThis.fetch = (async () => {
    await gate;
    return { ok: true, json: async () => ({ messages: {}, occurrences: [] }) };
  }) as unknown as typeof fetch;
  const container = dom.document.createElement("div"), root = createRoot(container as unknown as Element);
  const pending = () => container.querySelector("#probe")?.getAttribute("data-first-read-pending");
  try {
    await act(async () => root.render(<Probe path={TRANSCRIPT_PATH} items={[deliveredEntry]} probe={deliveredEntry.item} />));
    expect(pending()).toBe("false");
    gate = new Promise<void>((resolve) => { release = resolve; });
    const otherPath = "/sessions/other-provenance.jsonl";
    await act(async () => root.render(<Probe path={otherPath} items={[deliveredEntry]} probe={deliveredEntry.item} />));
    expect(pending()).toBe("true");
    await act(async () => { release(); });
    expect(pending()).toBe("false");
    const otherEntry: FeedEntry = { ...deliveredEntry, key: "later-row", item: { ...deliveredEntry.item, deliveredMessage: { engineMessageId: "later-native-id" } } as Item };
    gate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => root.render(<Probe path={otherPath} items={[otherEntry]} probe={otherEntry.item} />));
    expect(pending()).toBe("true");
    await act(async () => { release(); });
    expect(pending()).toBe("false");
  } finally { release(); await act(async () => root.unmount()); }
});

test("a fresh legacy row revalidates until its receipt settles; a historical one fetches once", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10, 10]);
  /* A legacy paste's row lands before the registry settles the receipt: the
     first response has no occurrence, the second carries the settled one. */
  const now = new Date().toISOString();
  const freshRow: FeedEntry = { anchorKey: null, key: "row-2", item: { kind: "user", ts: now, text: TEXT } };
  const settled: DeliveredMessageOccurrence = {
    textDigest: messageTextDigest(TEXT),
    deliveredAt: now,
    origin: "agent",
    senderRole: "orchestrator",
  };
  const calls = stubFetch([{}, { occurrences: [settled] }]);
  const probe = await mount([freshRow], freshRow.item);
  expect(probe.text()).toBe("unresolved");
  await act(async () => {
    await sleep(40);
  });
  expect(probe.text()).toBe("agent");
  expect(calls()).toBe(2);
  await probe.unmount();

  resetMessageProvenanceCacheForTests();
  const historicalRow: FeedEntry = {
    anchorKey: null,
    key: "row-3",
    item: { kind: "user", ts: "2026-01-01T00:00:00.000Z", text: TEXT },
  };
  const historicalCalls = stubFetch([{}]);
  const historical = await mount([historicalRow], historicalRow.item);
  await act(async () => {
    await sleep(80);
  });
  /* Settled absence: one fetch, no revalidation. */
  expect(historicalCalls()).toBe(1);
  expect(historical.text()).toBe("unresolved");
  await historical.unmount();
});

test("a cached admission join still reads delayed memory for the compact operator turn", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10]);
  const ref = "fixture-memory-turn", dedup = "a".repeat(64), path = "/sessions/memory-offer.jsonl";
  const timestamp = new Date().toISOString(), message = "Update the widget parser";
  let calls = 0, offerReady = false;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, json: async () => ({ messages: {}, occurrences: [{ textDigest: messageTextDigest(message), deliveredAt: timestamp, origin: "operator" }], submissions: { [dedup]: "submission" },
      memoryOffers: offerReady ? { [ref]: ["Widget parser constraint"] } : {} }) };
  }) as unknown as typeof fetch;
  const item: Item = { kind: "user", text: message, ts: timestamp, structuredUserRef: ref };
  const row: FeedEntry = { key: "memory-row", anchorKey: null, item, submissionDedup: dedup };
  function MemoryProbe({ items, pending }: { items: FeedEntry[]; pending: string[] }) {
    const lookup = useDeliveredMessageProvenance(path, items, pending);
    return <span id="memory">{lookup.memoryFor?.(item).join(", ")}</span>;
  }
  const container = dom.document.createElement("div"), root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<MemoryProbe items={[]} pending={["submission"]} />));
    expect(calls).toBe(1);
    await act(async () => root.render(<MemoryProbe items={[row]} pending={[]} />));
    offerReady = true;
    await act(async () => { await sleep(50); });
    expect(container.querySelector("#memory")?.textContent).toBe("Widget parser constraint");
    const settled = calls;
    await act(async () => { await sleep(40); });
    expect(calls).toBe(settled);
  } finally { await act(async () => root.unmount()); }
});
