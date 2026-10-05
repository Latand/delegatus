/**
 * The own-message step row's rules that need no layout
 * (docs/design/own-message-steps.md): when the row exists, what its count
 * shows while a sender is still being read, and which conversation the keys
 * go to. Where a step lands and what the row costs the pane are measured in a
 * real browser by `conversationWindow.browser.test.tsx`.
 */
import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

const dom = new Window();
installActEnv();
class NoResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  ResizeObserver: NoResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { OwnMessageStepRow, useOwnMessageSteps } = await import("./OwnMessageSteps");

interface Pane { id: string; own: number; pending?: boolean; identity?: string }
const reader: Record<string, number[]> = {};

function Harness({ id, own, pending = false, identity = id }: Pane) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const steps = useOwnMessageSteps({
    scroller, mount, identity, phone: false, olderUnloaded: false, sendersPending: pending, revision: `${own}:${pending}`,
    markReaderScroll: (direction) => { (reader[id] ??= []).push(direction); },
    revealOlder: () => undefined,
  });
  return (
    <section data-pane={id}>
      <div ref={scroller}>{Array.from({ length: own }, (_, index) => <div key={index} data-own-message="" />)}</div>
      <div ref={setMount} />
      {steps.shown && mount ? createPortal(<OwnMessageStepRow steps={steps} phone={false} />, mount) : null}
      <textarea />
    </section>
  );
}

let root: Root | null = null;
const host = () => document.body as unknown as HTMLElement;
const frames = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
async function render(...panes: Pane[]): Promise<void> {
  if (!root) {
    const element = document.createElement("div");
    document.body.appendChild(element);
    root = createRoot(element as unknown as HTMLElement);
  }
  await act(async () => { root!.render(<>{panes.map((pane) => <Harness key={pane.id} {...pane} />)}</>); });
  await frames();
}
const count = (id: string) => host().querySelector(`[data-pane="${id}"] [data-own-step-control="count"]`)?.textContent ?? null;
const total = (id: string) => count(id)?.split(" / ")[1] ?? null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.innerHTML = "";
  for (const key of Object.keys(reader)) delete reader[key];
});

test("the row exists from the second own message on", async () => {
  await render({ id: "a", own: 0 });
  expect(count("a")).toBeNull();
  await render({ id: "a", own: 1 });
  expect(count("a")).toBeNull();
  await render({ id: "a", own: 2 });
  expect(total("a")).toBe("2");
  expect(host().querySelectorAll('[data-pane="a"] [data-own-step-control]').length).toBe(3);
});

test("while a sender is still being read the count keeps the last settled number", async () => {
  await render({ id: "a", own: 3 });
  expect(total("a")).toBe("3");
  /* A record whose sender the ledger has not named yet is a system row for a
     moment: one own message fewer on the page, and the same count on the row. */
  await render({ id: "a", own: 2, pending: true });
  expect(total("a")).toBe("3");
  await render({ id: "a", own: 4, pending: true });
  expect(total("a")).toBe("3");
  await render({ id: "a", own: 4 });
  expect(total("a")).toBe("4");
});

test("a conversation whose senders have never been read shows no row until they are", async () => {
  await render({ id: "a", own: 2, pending: true });
  expect(count("a")).toBeNull();
  await render({ id: "a", own: 5 });
  expect(total("a")).toBe("5");
  /* Another conversation in the same pane starts from nothing held. */
  await render({ id: "a", own: 3, pending: true, identity: "other" });
  expect(count("a")).toBeNull();
});

test("Alt+arrow steps the conversation that holds the focus, or the only one", async () => {
  const press = async (key: "ArrowUp" | "ArrowDown") => {
    await act(async () => { dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })); });
  };
  const scrolled = (id: string) => {
    const scroller = host().querySelector(`[data-pane="${id}"] > div`) as HTMLElement;
    scroller.scrollTop = 100;
    for (const row of scroller.children) (row as HTMLElement).getBoundingClientRect = () => ({ top: -100, bottom: -60, left: 0, right: 0, width: 0, height: 40, x: 0, y: -100, toJSON: () => ({}) });
  };
  await render({ id: "a", own: 3 }, { id: "b", own: 3 });
  for (const element of host().querySelectorAll("section")) (element as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
  scrolled("a");
  scrolled("b");
  /* Two conversations and the focus in neither: the keys belong to nobody. */
  await press("ArrowUp");
  expect(reader).toEqual({});
  (host().querySelector('[data-pane="b"] textarea') as HTMLElement).focus();
  await press("ArrowUp");
  expect(reader.a).toBeUndefined();
  expect(reader.b).toEqual([-1]);
  /* A bare arrow, or Alt with another modifier, is the composer's own. */
  await act(async () => { dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
  await act(async () => { dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, shiftKey: true, bubbles: true })); });
  expect(reader.b).toEqual([-1]);

  await render({ id: "a", own: 3 });
  for (const element of host().querySelectorAll("section")) (element as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
  scrolled("a");
  (document.activeElement as unknown as HTMLElement | null)?.blur?.();
  await press("ArrowUp");
  expect(reader.a).toEqual([-1]);
});
