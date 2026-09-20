/**
 * One message, one row (send-latency slice 3).
 *
 * The operator's complaint was that a single message they pressed Send on once
 * passed through a pile of visually different renderings — a narrow, dimmed
 * bubble with a status word under it, then a wider one at full strength with a
 * copy control — and that watching it change made the send feel slow. The
 * claim this file pins is the one that answers that: from submit to the
 * transcript's own record, the message keeps ONE rendering. Only its progress
 * affordance comes and goes.
 *
 * So the assertions are about sameness across a receipt sequence: the same DOM
 * node (the row's key never changes), the same bubble classes — the width, the
 * opacity, the padding and the type size all live in them — the same position
 * among the rows, and never a second copy of the message anywhere. The pixels
 * those classes produce are measured in a real browser by
 * `conversationWindow.browser.test.tsx`.
 */
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { installActEnv } from "@/test-helpers/actEnv";
import { type TFunction, translate } from "@/lib/i18n";

const translator = (locale: "en" | "uk"): TFunction => (key, params) => translate(locale, key, params);

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const { ConversationMessageRow, OutboxBubblesView } = await import("@/components/conversation/OutboxBubbles");
const { FeedItem } = await import("@/components/feed/FeedItem");
const {
  enqueueOutbox, outboxReceiptPatch, publishTranscriptEchoes, readOutbox,
  resetOutboxForTests, updateOutbox,
} = await import("@/components/conversation/outbox");

type Entry = Parameters<typeof OutboxBubblesView>[0]["entries"][number];
type ReceiptStatus = Parameters<typeof outboxReceiptPatch>[1];

const CARD = "conversation_one_row";
const TEXT = "Check the release status and tell me what is blocking it.";
const SUBMITTED_AT = 1_772_400_000_000;

function entry(overrides: Partial<Entry> = {}): Entry {
  return { id: "key-one-row", text: TEXT, images: 0, at: SUBMITTED_AT, state: "queued", ...overrides } as Entry;
}

/** Everything about the row that the operator could see change. */
function reading(host: HTMLElement) {
  const row = host.querySelector("[data-message-row]") as HTMLElement | null;
  const bubble = host.querySelector("[data-user-bubble]") as HTMLElement | null;
  return {
    row,
    node: row,
    bubbleClass: bubble?.className ?? null,
    bubbleText: bubble?.textContent ?? null,
    /* Which child of the queue this row is: its conversational position. */
    position: row?.parentElement ? [...row.parentElement.children].indexOf(row) : -1,
    bubbles: host.querySelectorAll("[data-user-bubble]").length,
    phase: row?.getAttribute("data-message-row") ?? null,
  };
}

test("one message keeps one row through every non-failure receipt", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  /* The whole non-failure life of an ordinary send: reserved, admitted behind
     a turn, taken off the park, handed over, arrived. */
  const sequence: ReceiptStatus[] = ["pending", "queued", "delivering", "applying", "delivered"];
  let projected: Partial<Entry> = {};
  const render = async () => {
    await act(async () => root.render(
      <OutboxBubblesView
        entries={[entry(projected)]}
        t={translator("en")}
        nowMs={SUBMITTED_AT + 30_000}
        onCancel={() => {}}
        onRetry={() => {}}
        session={{ host: "hosted", turn: "running" }}
      />,
    ));
    return reading(host);
  };

  const first = await render();
  expect(first.bubbles).toBe(1);
  expect(first.phase).toBe("pending");
  const readings = [first];
  for (const status of sequence) {
    const patch = outboxReceiptPatch(entry(projected), status, {
      operationId: "operation-one-row",
      idempotencyKey: "key-one-row",
      conversationId: CARD,
      kind: "send",
      status,
      at: new Date(SUBMITTED_AT + 10_000).toISOString(),
      admittedAt: new Date(SUBMITTED_AT).toISOString(),
      revision: readings.length + 1,
    } as Parameters<typeof outboxReceiptPatch>[2], SUBMITTED_AT + 30_000);
    if (patch) projected = { ...projected, ...patch };
    readings.push(await render());
  }

  /* The message arrived: the walk really did cover the whole life of a send. */
  expect(readings.at(-1)!.phase).toBe("confirmed");
  for (const step of readings) {
    /* The same DOM node throughout — the row's key never changes, so React
       never replaced it, and nothing about the message was re-created. */
    expect(step.node).toBe(first.node);
    /* The same bubble: width cap, opacity, padding and type size are all in
       these classes, and none of them moved. */
    expect(step.bubbleClass).toBe(first.bubbleClass);
    expect(step.bubbleText).toBe(first.bubbleText);
    expect(step.position).toBe(first.position);
    /* And never a second copy of the message. */
    expect(step.bubbles).toBe(1);
  }
  /* The only visible difference across the whole walk is the progress
     affordance clearing when arrival is proven. */
  expect(readings.filter((step) => step.phase !== "pending").map((step) => step.phase)).toEqual(["confirmed"]);
  await act(async () => root.unmount());
  host.remove();
});

test("the row the outbox paints and the row the transcript paints are the same rendering", async () => {
  /* The phone's 75% → 86% jump lived here: two components drawing the same
     message. There is one renderer now, so the two cannot drift. */
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <OutboxBubblesView entries={[entry({ state: "delivering" })]} t={translator("en")} onCancel={() => {}} onRetry={() => {}} />,
  ));
  const optimistic = reading(host);

  const canonical = document.createElement("div");
  document.body.append(canonical);
  const canonicalRoot = createRoot(canonical);
  await act(async () => canonicalRoot.render(<FeedItem item={{ kind: "user", ts: SUBMITTED_AT, text: TEXT }} />));
  const transcript = canonical.querySelector("[data-user-bubble]") as HTMLElement;

  expect(optimistic.bubbleClass).toBe(transcript.className);
  expect(optimistic.bubbleText).toBe(transcript.textContent);
  await act(async () => { root.unmount(); canonicalRoot.unmount(); });
  host.remove();
  canonical.remove();
});

test("the transcript's own record is adopted into the row, never swapped for it", async () => {
  /* The row is the message, and the message does not end when its record
     arrives: the canonical text is handed to the SAME keyed row, so React
     keeps the node, the body inside it and whatever the reader had opened.
     The feed's own wiring of this is measured in
     `LogFeed.oneMessageOneRow.dom.test.tsx`; what is pinned here is the
     component contract that makes it possible — one component, two sources,
     one node. */
  resetOutboxForTests();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  enqueueOutbox(CARD, { id: "key-echo", text: TEXT, images: 0, at: SUBMITTED_AT });
  updateOutbox(CARD, "key-echo", { state: "delivering" });
  const entryNow = () => readOutbox(CARD).find((candidate) => candidate.id === "key-echo")!;

  const row = (canonical: { text: string } | null) => (
    <ConversationMessageRow
      key="msg:key-echo"
      entry={canonical ? null : entryNow()}
      canonical={canonical}
      t={translator("en")}
      nowMs={SUBMITTED_AT + 6_000}
    />
  );

  await act(async () => root.render(row(null)));
  const before = reading(host);
  expect(before.bubbles).toBe(1);
  expect(before.phase).toBe("pending");
  expect(host.querySelectorAll("[data-outbox-progress]")).toHaveLength(1);

  publishTranscriptEchoes(CARD, [{ id: "row:1:0", text: TEXT }]);
  await act(async () => root.render(row({ text: TEXT })));
  const after = reading(host);
  /* One copy, the same node, the same rendering — and the affordance gone. */
  expect(after.bubbles).toBe(1);
  expect(after.node).toBe(before.node);
  expect(host.querySelector("[data-user-bubble]")).toBe(before.row!.querySelector("[data-user-bubble]"));
  expect(after.bubbleClass).toBe(before.bubbleClass);
  expect(after.bubbleText).toBe(before.bubbleText);
  expect(after.phase).toBe("confirmed");
  expect(host.querySelectorAll("[data-outbox-progress]")).toHaveLength(0);
  await act(async () => root.unmount());
  host.remove();
  resetOutboxForTests();
});
