/**
 * The own-message step row's rules that need no layout
 * (docs/design/own-message-steps.md): when the row exists, what its count
 * shows while a sender is still being read, and which conversation the keys
 * go to. Where a step lands and what the row costs the pane are measured in a
 * real browser by `conversationWindow.browser.test.tsx`.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useRef, useState } from "react";
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

interface Pane {
  id: string; own: number; pending?: boolean; identity?: string;
  /** Own messages in loaded history above the page, and whether more is unloaded. */
  olderOwn?: number; olderUnloaded?: boolean; operatorWrote?: boolean; atTail?: boolean;
}
const reader: Record<string, number[]> = {};
const reveals: Record<string, number> = {};
const releases: Record<string, () => void> = {};
const feedRenders: Record<string, number> = {};
/** A pane's layout: its own messages `gap` px apart, the first one a landing's
    gap under the top, in a feed `viewport` px tall. Without one a pane has
    happy-dom's boxes, all zeros. */
const geometry: Record<string, { gap: number; viewport: number }> = {};
const LANDING_GAP = 8;

function Harness({ id, own, pending = false, identity = id, olderOwn = 0, olderUnloaded = false, operatorWrote = false, atTail = false }: Pane) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const steps = useOwnMessageSteps({
    scroller, mount, identity, phone: false, atTail, olderOwn, olderUnloaded, operatorWrote, sendersPending: pending,
    revision: `${own}:${pending}:${olderOwn}`,
    markReaderScroll: (direction) => { (reader[id] ??= []).push(direction); },
    revealOlder: () => { reveals[id] = (reveals[id] ?? 0) + 1; },
  });
  /* Every commit of the component that holds the hook, as the feed does. */
  useEffect(() => { feedRenders[id] = (feedRenders[id] ?? 0) + 1; });
  const { release } = steps;
  useEffect(() => { releases[id] = release; }, [id, release]);
  return (
    <section data-pane={id}>
      <div ref={scroller}>
        {Array.from({ length: own }, (_, index) => (
          <div
            key={index}
            data-own-message=""
            ref={(row) => {
              const shape = geometry[id];
              if (!row || !shape) return;
              const feed = row.parentElement!;
              Object.defineProperty(feed, "clientHeight", { configurable: true, value: shape.viewport });
              Object.defineProperty(feed, "scrollHeight", { configurable: true, get: () => LANDING_GAP + feed.children.length * shape.gap });
              row.getBoundingClientRect = () => {
                const top = LANDING_GAP + index * shape.gap - feed.scrollTop;
                return { top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) };
              };
            }}
          />
        ))}
      </div>
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
  for (const record of [reader, reveals, releases, feedRenders, geometry]) for (const key of Object.keys(record)) delete record[key];
});

const feedOf = (id: string) => host().querySelector(`[data-pane="${id}"] > div`) as HTMLElement;
const previousOf = (id: string) => host().querySelector(`[data-pane="${id}"] [data-own-step-control="previous"]`) as HTMLButtonElement;
async function scrollTo(id: string, top: number): Promise<void> {
  const scroller = feedOf(id);
  scroller.scrollTop = top;
  await act(async () => { scroller.dispatchEvent(new dom.Event("scroll") as unknown as Event); });
  await frames();
}
const pressKey = async (key: "ArrowUp" | "ArrowDown", target?: HTMLElement) => {
  const event = new dom.KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
  await act(async () => { if (target) target.dispatchEvent(event as unknown as Event); else dom.dispatchEvent(event); });
  return event;
};

test("the row exists from the second own message on", async () => {
  await render({ id: "a", own: 0 });
  expect(count("a")).toBeNull();
  await render({ id: "a", own: 1 });
  expect(count("a")).toBeNull();
  await render({ id: "a", own: 2 });
  expect(total("a")).toBe("2");
  expect(host().querySelectorAll('[data-pane="a"] [data-own-step-control]').length).toBe(3);
});

test("the row does not depend on how much history is on the page", async () => {
  geometry.a = { gap: 1000, viewport: 500 };
  /* One own message on the page and older history unloaded: the count is
     open, the row is there and a step back asks for that history. */
  await render({ id: "a", own: 1, olderUnloaded: true });
  expect(count("a")).toBe("1 / 1+");
  expect(previousOf("a").disabled).toBe(false);
  await act(async () => { previousOf("a").click(); });
  expect(reveals.a).toBe(1);
  /* The page slid past every own message during a long turn: they are in
     loaded history above it, the count does not shrink and the keys work. */
  await render({ id: "a", own: 0, olderOwn: 9, atTail: true });
  expect(count("a")).toBe("9 / 9");
  for (const element of host().querySelectorAll("section")) (element as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
  (document.activeElement as unknown as HTMLElement | null)?.blur?.();
  const asked = reveals.a!;
  await pressKey("ArrowUp");
  expect(reveals.a).toBe(asked + 1);
  /* None loaded, history unloaded: only where the operator is known to have written. */
  await render({ id: "a", own: 0, olderUnloaded: true, operatorWrote: true });
  expect(count("a")).toBe("0 / 0+");
  await render({ id: "a", own: 0, olderUnloaded: true });
  expect(count("a")).toBeNull();
  /* Walked to its start with fewer than two: nothing to step between. */
  await render({ id: "a", own: 1, operatorWrote: true });
  expect(count("a")).toBeNull();
});

test("a step waiting for older history ends when something else moves the feed", async () => {
  geometry.a = { gap: 1000, viewport: 500 };
  await render({ id: "a", own: 2, olderUnloaded: true });
  const scroller = feedOf("a");
  /* Waiting: when the page arrives the step finishes on the message it
     brings. The feed keeps the reader's place across a prepend, so the
     message being read is 1000 px further down the page. */
  await act(async () => { previousOf("a").click(); });
  expect(reveals.a).toBe(1);
  expect(reader.a).toEqual([-1]);
  scroller.scrollTop = 1000;
  await render({ id: "a", own: 3, olderUnloaded: true });
  expect(reader.a).toEqual([-1, -1]);
  expect(scroller.scrollTop).toBe(0);
  /* The same wait, and the way back to the tail before the page arrives:
     the page changes nothing about where the reader is. */
  await act(async () => { previousOf("a").click(); });
  expect(reveals.a).toBe(2);
  await act(async () => { releases.a!(); });
  scroller.scrollTop = 3000;
  await render({ id: "a", own: 4, olderUnloaded: true });
  expect(reader.a).toEqual([-1, -1, -1]);
  expect(scroller.scrollTop).toBe(3000);
  /* A reader's own input on the feed ends it as well, trusted or not. */
  await scrollTo("a", 0);
  await act(async () => { previousOf("a").click(); });
  expect(reveals.a).toBe(3);
  await act(async () => { scroller.dispatchEvent(new dom.Event("wheel") as unknown as Event); });
  scroller.scrollTop = 2500;
  await render({ id: "a", own: 5, olderUnloaded: true });
  expect(reader.a).toEqual([-1, -1, -1, -1]);
  expect(scroller.scrollTop).toBe(2500);
});

test("the way back to the tail lets go of a landing that is still being held", async () => {
  geometry.a = { gap: 1000, viewport: 500 };
  await render({ id: "a", own: 4 });
  const scroller = feedOf("a");
  await scrollTo("a", 3000);
  await act(async () => { previousOf("a").click(); });
  expect(scroller.scrollTop).toBe(2000);
  /* Inside the half second the landing is held for. */
  await act(async () => { releases.a!(); });
  scroller.scrollTop = 3500;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
  expect(scroller.scrollTop).toBe(3500);
});

test("a scroll redraws the row and never the feed that holds it", async () => {
  geometry.a = { gap: 1000, viewport: 500 };
  await render({ id: "a", own: 4 });
  await scrollTo("a", 3000);
  expect(count("a")).toBe("4 / 4");
  const before = feedRenders.a;
  await scrollTo("a", 1000);
  expect(count("a")).toBe("2 / 4");
  await scrollTo("a", 0);
  expect(count("a")).toBe("1 / 4");
  expect(feedRenders.a).toBe(before);
});

test("while a sender is still being read the reader's place stays live", async () => {
  geometry.a = { gap: 1000, viewport: 500 };
  await render({ id: "a", own: 4 });
  await scrollTo("a", 3000);
  expect(count("a")).toBe("4 / 4");
  await render({ id: "a", own: 4, pending: true });
  await scrollTo("a", 1000);
  expect(count("a")).toBe("2 / 4");
  await scrollTo("a", 0);
  expect(count("a")).toBe("1 / 4");
  await render({ id: "a", own: 4 });
  expect(count("a")).toBe("1 / 4");
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
  const press = (key: "ArrowUp" | "ArrowDown") => pressKey(key);
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

test("a field, a list or a dialog outside the pane keeps Alt+arrow for itself", async () => {
  geometry.a = { gap: 1000, viewport: 500 };
  await render({ id: "a", own: 3 });
  for (const element of host().querySelectorAll("section")) (element as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
  feedOf("a").scrollTop = 1500;
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.innerHTML = "<select><option>one</option><option>two</option></select><input /><textarea></textarea>";
  document.body.appendChild(dialog);
  for (const field of dialog.children) {
    (field as unknown as HTMLElement).focus();
    expect(document.activeElement).toBe(field);
    for (const key of ["ArrowDown", "ArrowUp"] as const) {
      const event = await pressKey(key, field as unknown as HTMLElement);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(reader.a).toBeUndefined();
  /* The pane's own composer, and no focus anywhere, step as before. */
  (host().querySelector('[data-pane="a"] textarea') as HTMLElement).focus();
  expect((await pressKey("ArrowUp")).defaultPrevented).toBe(true);
  expect(reader.a).toEqual([-1]);
  (document.activeElement as unknown as HTMLElement | null)?.blur?.();
  expect((await pressKey("ArrowUp")).defaultPrevented).toBe(true);
});


test("a step from an empty tail waits through the older page's unread senders", async () => {
  geometry.a = { gap: 1000, viewport: 500 };
  await render({ id: "a", own: 0, olderUnloaded: true, operatorWrote: true, atTail: true });
  await act(async () => { previousOf("a").click(); });
  expect(reader.a).toEqual([-1]);
  expect(reveals.a).toBe(1);
  /* The last page arrived, but its Claude records await the ledger. */
  await render({ id: "a", own: 0, pending: true, operatorWrote: true });
  expect(reader.a).toEqual([-1]);
  const scroller = feedOf("a");
  scroller.scrollTop = 2500;
  /* The ledger's 1.5 + 4 + 10 s revalidations exceed the page deadline. */
  const later = performance.now() + 20_000;
  const clock = spyOn(performance, "now").mockReturnValue(later);
  try {
    await render({ id: "a", own: 3, operatorWrote: true });
    expect(scroller.scrollTop).toBe(2000);
    expect(count("a")).toBe("3 / 3");
  } finally { clock.mockRestore(); }
});
