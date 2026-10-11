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

const READ_FAILURES = ["503", "network rejection", "malformed JSON"] as const;
async function failedRead(failure: typeof READ_FAILURES[number]) {
  if (failure === "network rejection") throw new TypeError("network unavailable");
  return new globalThis.Response(failure === "503" ? "unavailable" : "{broken", { status: failure === "503" ? 503 : 200 });
}

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
    pending: () => container.querySelector("#probe")?.getAttribute("data-message-pending"),
    render: async (path: string, nextItems = items, nextProbe = probe) => {
      await act(async () => root.render(<Probe path={path} items={nextItems} probe={nextProbe} />));
    },
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

for (const failure of READ_FAILURES) {
  test(`a failed provenance read retries after ${failure} and resolves the mounted native id`, async () => {
    setMessageProvenanceRetryScheduleForTests([10, 10]);
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1
      ? failedRead(failure)
      : globalThis.Response.json({ messages: { [ENGINE_MESSAGE_ID]: { origin: "operator" } } })) as unknown as typeof fetch;
    const probe = await mount([deliveredEntry], deliveredEntry.item);
    try {
      expect(probe.text()).toBe("unresolved");
      expect(probe.pending()).toBe("true");
      await act(async () => { await sleep(80); });
      expect(probe.text()).toBe("operator");
      expect(probe.pending()).toBe("false");
      expect(calls).toBe(2);
      await act(async () => { await sleep(40); });
      expect(calls).toBe(2);
    } finally { await probe.unmount(); }
  });

  test(`persistent ${failure} stops at the bounded schedule without inventing evidence`, async () => {
    setMessageProvenanceRetryScheduleForTests([10, 10]);
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return failedRead(failure); }) as unknown as typeof fetch;
    const probe = await mount([deliveredEntry], deliveredEntry.item);
    try {
      await act(async () => { await sleep(80); });
      expect(calls).toBe(3);
      expect(probe.text()).toBe("unresolved");
      expect(probe.pending()).toBe("false");
      await act(async () => { await sleep(40); });
      expect(calls).toBe(3);
    } finally { await probe.unmount(); }
  });

  test(`a later revalidation recovers after ${failure}`, async () => {
    setMessageProvenanceRetryScheduleForTests([10, 10]);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return globalThis.Response.json({ messages: {} });
      if (calls === 2) return failedRead(failure);
      return globalThis.Response.json({ messages: { [ENGINE_MESSAGE_ID]: { origin: "operator" } } });
    }) as unknown as typeof fetch;
    const probe = await mount([deliveredEntry], deliveredEntry.item);
    try {
      await act(async () => { await sleep(80); });
      expect(calls).toBe(3);
      expect(probe.text()).toBe("operator");
    } finally { await probe.unmount(); }
  });
}

test("a failed read followed by a different native id never attributes this row", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10]);
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1
    ? failedRead("503")
    : globalThis.Response.json({ messages: { "other-native-id": { origin: "operator" } } })) as unknown as typeof fetch;
  const probe = await mount([deliveredEntry], deliveredEntry.item);
  try {
    await act(async () => { await sleep(80); });
    expect(calls).toBe(3);
    expect(probe.text()).toBe("unresolved");
  } finally { await probe.unmount(); }
});

for (const origin of ["operator", "agent"] as const) {
  test(`a failed read adopts ${origin} evidence resolved by another mounted reader`, async () => {
    setMessageProvenanceRetryScheduleForTests([10, 10]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls === 1) { await gate; return failedRead("503"); }
      return globalThis.Response.json({ messages: { [ENGINE_MESSAGE_ID]: { origin } } });
    }) as unknown as typeof fetch;
    const first = await mount([deliveredEntry], deliveredEntry.item);
    let second: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      expect(first.text()).toBe("unresolved");
      second = await mount([deliveredEntry], deliveredEntry.item);
      expect(second.text()).toBe(origin);
      await act(async () => { release(); });
      expect(first.text()).toBe(origin);
      expect(first.pending()).toBe("false");
      await act(async () => { await sleep(50); });
      expect(calls).toBe(2);
    } finally {
      release();
      await first.unmount();
      await second?.unmount();
    }
  });

  test(`cached ${origin} evidence survives failed revalidation of another row`, async () => {
    setMessageProvenanceRetryScheduleForTests([10, 10]);
    const other: FeedEntry = { ...deliveredEntry, key: "other-row", item: { ...deliveredEntry.item, deliveredMessage: { engineMessageId: "unresolved-native-id" } } as Item };
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1
      ? globalThis.Response.json({ messages: { [ENGINE_MESSAGE_ID]: { origin } } })
      : failedRead("503")) as unknown as typeof fetch;
    const probe = await mount([deliveredEntry, other], deliveredEntry.item);
    try {
      expect(probe.text()).toBe(origin);
      await act(async () => { await sleep(80); });
      expect(calls).toBe(3);
      expect(probe.text()).toBe(origin);
      await probe.render(TRANSCRIPT_PATH, [deliveredEntry]);
      expect(probe.text()).toBe(origin);
      expect(calls).toBe(3);
    } finally { await probe.unmount(); }
  });
}

test("unmount cancels the retry scheduled after a failure", async () => {
  setMessageProvenanceRetryScheduleForTests([50, 50]);
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return failedRead("503"); }) as unknown as typeof fetch;
  const probe = await mount([deliveredEntry], deliveredEntry.item);
  expect(calls).toBe(1);
  await probe.unmount();
  await act(async () => { await sleep(150); });
  expect(calls).toBe(1);
});

test("a conversation change cancels the failed path's scheduled retry", async () => {
  setMessageProvenanceRetryScheduleForTests([50, 50]);
  const reads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").searchParams.get("path")!;
    reads.push(path);
    return path === TRANSCRIPT_PATH ? failedRead("503")
      : globalThis.Response.json({ messages: { [ENGINE_MESSAGE_ID]: { origin: "agent" } } });
  }) as unknown as typeof fetch;
  const probe = await mount([deliveredEntry], deliveredEntry.item);
  try {
    await probe.render("/sessions/next-provenance.jsonl");
    await act(async () => { await sleep(150); });
    expect(reads).toEqual([TRANSCRIPT_PATH, "/sessions/next-provenance.jsonl"]);
    expect(probe.text()).toBe("agent");
  } finally { await probe.unmount(); }
});

for (const cleanup of ["unmount", "conversation change"] as const) {
  test(`an in-flight answer after ${cleanup} cannot seed stale provenance on reopen`, async () => {
    setMessageProvenanceRetryScheduleForTests([]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls !== 1) return globalThis.Response.json({ messages: {} });
      return { ok: true, json: async () => { await gate; return { messages: { [ENGINE_MESSAGE_ID]: { origin: "operator" } } }; } };
    }) as unknown as typeof fetch;
    const probe = await mount([deliveredEntry], deliveredEntry.item);
    let reopened: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      if (cleanup === "unmount") await probe.unmount();
      else await probe.render("/sessions/next-provenance.jsonl");
      await act(async () => { release(); });
      if (cleanup === "unmount") reopened = await mount([deliveredEntry], deliveredEntry.item);
      else await probe.render(TRANSCRIPT_PATH);
      expect((reopened ?? probe).text()).toBe("unresolved");
      expect(calls).toBe(cleanup === "unmount" ? 2 : 3);
    } finally {
      release();
      if (cleanup === "conversation change") await probe.unmount();
      await reopened?.unmount();
    }
  });
}

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

test("a failed legacy read retries only while the row can still race its receipt", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10]);
  for (const fresh of [true, false]) {
    resetMessageProvenanceCacheForTests();
    const timestamp = fresh ? new Date().toISOString() : "2026-01-01T00:00:00.000Z";
    const row: FeedEntry = { anchorKey: null, key: "legacy-failed-read", item: { kind: "user", ts: timestamp, text: TEXT } };
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1 ? failedRead("503") : globalThis.Response.json({
      occurrences: [{ origin: "agent", textDigest: messageTextDigest(TEXT), deliveredAt: timestamp }],
    })) as unknown as typeof fetch;
    const probe = await mount([row], row.item);
    try {
      await act(async () => { await sleep(80); });
      expect(calls).toBe(fresh ? 2 : 1);
      expect(probe.text()).toBe(fresh ? "agent" : "unresolved");
    } finally { await probe.unmount(); }
  }
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
