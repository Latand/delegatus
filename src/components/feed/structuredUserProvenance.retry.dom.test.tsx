import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { structuredUserReference } from "@/lib/runtime/codexStructuredUserText";
import * as metadataAction from "@/lib/selection/structuredUserMetadataAction";
import type { FeedEntry } from "./parse";
import { setStructuredUserRetryScheduleForTests, useStructuredUserProvenance } from "./structuredUserProvenance";

const dom = new Window();
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event });

const ref = (digit: string) => `o.${structuredUserReference(digit.repeat(64), true).slice(2)}.${"a".repeat(16)}`;
const A = ref("a"), B = ref("b"), C = ref("c");
const metadata: Record<string, DeliveredMessageProvenance> = {
  [A]: { origin: "agent", senderRole: "reviewer" },
  [B]: { origin: "operator", selectedContext: { version: 1, state: "selected",
    conversationId: "conversation_retry_fixture", capturedAt: "2026-09-22T00:00:00.000Z", label: "Selected fixture" } },
  [C]: { origin: "agent", senderRole: "builder" },
};
function entries(refs: string[]): FeedEntry[] {
  return refs.map((reference) => ({ key: reference, anchorKey: null,
    item: { kind: "user", text: "identical words", ts: "2026-09-22T00:00:01.000Z", structuredUserRef: reference } }));
}
function Probe({ items }: { items: FeedEntry[] }) {
  const lookup = useStructuredUserProvenance(items);
  return <>{items.map(({ item, key }) => {
    const resolved = lookup(item);
    const label = resolved?.selectedContext?.state === "selected" ? resolved.selectedContext.label : undefined;
    return <span key={key} data-ref={key}>{resolved?.senderRole ?? label ?? "unresolved"}</span>;
  })}</>;
}
const action = spyOn(metadataAction, "structuredUserProvenance");
afterEach(() => { action.mockReset(); setStructuredUserRetryScheduleForTests(null); });
afterAll(() => { action.mockRestore(); });
const wait = async (ms = 60) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };

async function mount(refs: string[]) {
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const render = async (next: string[]) => { await act(async () => root.render(<Probe items={entries(next)} />)); };
  await render(refs);
  return { render, text: (reference: string) => container.querySelector(`[data-ref="${reference}"]`)?.textContent,
    unmount: async () => { await act(async () => root.unmount()); } };
}

test("resolved sender and selected-card labels survive a failed read after the window grows", async () => {
  setStructuredUserRetryScheduleForTests([10, 10]);
  action.mockImplementation(async (refs) => Object.fromEntries(refs.map((reference) => [reference, metadata[reference]])));
  const probe = await mount([A, B]);
  try {
    expect(probe.text(A)).toBe("reviewer");
    expect(probe.text(B)).toBe("Selected fixture");
    action.mockImplementation(async () => { throw new Error("connection unavailable"); });
    await probe.render([A, B, C]);
    expect(probe.text(A)).toBe("reviewer");
    expect(probe.text(B)).toBe("Selected fixture");
    expect(probe.text(C)).toBe("unresolved");
    expect(action.mock.calls.at(-1)).toEqual([[C]]);
    action.mockImplementation(async (refs) => Object.fromEntries(refs.map((reference) => [reference, metadata[reference]])));
    await wait();
    expect(probe.text(A)).toBe("reviewer");
    expect(probe.text(B)).toBe("Selected fixture");
    expect(probe.text(C)).toBe("builder");
    expect(action).toHaveBeenCalledTimes(3);
    await wait();
    expect(action).toHaveBeenCalledTimes(3);
  } finally { await probe.unmount(); }
});

test("persistent failures stop at the retry bound; same-reference rerenders do not restart polling", async () => {
  setStructuredUserRetryScheduleForTests([10, 10]);
  action.mockImplementation(async () => { throw new Error("connection unavailable"); });
  const probe = await mount([A]);
  try {
    await wait();
    expect(action).toHaveBeenCalledTimes(3);
    await probe.render([A]);
    await wait();
    expect(action).toHaveBeenCalledTimes(3);
    expect(probe.text(A)).toBe("unresolved");
  } finally { await probe.unmount(); }
});

test("explicit missing handles stay unresolved and foreign answers never supply their labels", async () => {
  setStructuredUserRetryScheduleForTests([10, 10]);
  action.mockImplementation(async () => ({ [A]: null, [B]: metadata[B] }));
  const probe = await mount([A]);
  try {
    expect(probe.text(A)).toBe("unresolved");
    await wait();
    expect(action).toHaveBeenCalledTimes(1);
    action.mockImplementation(async () => ({ [B]: null }));
    await probe.render([A, B]);
    expect(action.mock.calls.at(-1)).toEqual([[B]]);
    expect(probe.text(B)).toBe("unresolved");
    await wait();
    expect(action).toHaveBeenCalledTimes(2);
  } finally { await probe.unmount(); }
});

test("changing the window discards late answers and cancels the old retry", async () => {
  setStructuredUserRetryScheduleForTests([10, 10]);
  let finish!: (value: Record<string, DeliveredMessageProvenance | null>) => void;
  action.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const probe = await mount([A]);
  try {
    action.mockImplementation(async () => ({ [B]: metadata[B] }));
    await probe.render([B]);
    await act(async () => { finish({ [A]: metadata[A] }); });
    expect(probe.text(A)).toBeUndefined();
    expect(probe.text(B)).toBe("Selected fixture");
    action.mockImplementation(async () => { throw new Error("connection unavailable"); });
    await probe.render([B, C]);
    await probe.render([B]);
    await wait();
    expect(action).toHaveBeenCalledTimes(3);
    expect(probe.text(B)).toBe("Selected fixture");
  } finally { await probe.unmount(); }
});
