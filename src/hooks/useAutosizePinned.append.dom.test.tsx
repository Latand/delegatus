import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useAutosizePinned } from "./useAutosizePinned";

/*
 * The field is measured by collapsing it to 0px and reading its scrollHeight,
 * which lays the whole composer out a second time. Typing at the end of the
 * text can only add lines, so it reads the height of the box as it stands; every
 * edit that can shorten the text still collapses.
 */

const dom = new Window({ width: 800, height: 600 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MutationObserver: dom.MutationObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

const LINE_PX = 18;
const COLUMNS = 10;
/* Heights the field had whenever its content height was read: "0px" is a
   collapsed measurement. */
let reads: string[] = [];

/* A borderless box of ten columns: the content is as many lines as the text
   needs; a collapsed box reports its content, a taller one its own height. */
Object.defineProperty(dom.HTMLTextAreaElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLTextAreaElement) {
    reads.push(this.style.height);
    const content = Math.max(1, Math.ceil(this.value.length / COLUMNS)) * LINE_PX;
    return Math.max(content, parseFloat(this.style.height) || 0);
  },
});
Object.defineProperty(dom.HTMLTextAreaElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLTextAreaElement) { return parseFloat(this.style.height) || 0; },
});

function Field({ value, maxPx = 200 }: { value: string; maxPx?: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useAutosizePinned(ref, value, { maxPx, pinned: false });
  return <textarea ref={ref} value={value} readOnly rows={1} />;
}

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  reads = [];
  dom.document.body.replaceChildren();
});

function mount(value: string, maxPx?: number) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  flushSync(() => root!.render(<Field value={value} maxPx={maxPx} />));
  return { field: host.querySelector("textarea")!, set: (next: string) => flushSync(() => root!.render(<Field value={next} maxPx={maxPx} />)) };
}

test("typing at the end of the text never collapses the field and still grows it by a line", () => {
  const { field, set } = mount("");
  expect(field.style.height).toBe(`${LINE_PX + 2}px`);
  reads = [];
  let text = "";
  for (let key = 0; key < 25; key++) {
    text += "x";
    set(text);
    const lines = Math.ceil(text.length / COLUMNS);
    expect(field.style.height).toBe(`${lines * LINE_PX + 2}px`);
  }
  expect(reads.filter((height) => height === "0px")).toEqual([]);
});

test("a deletion collapses the field and lets it shrink", () => {
  const { field, set } = mount("x".repeat(25));
  expect(field.style.height).toBe(`${3 * LINE_PX + 2}px`);
  reads = [];
  set("x".repeat(9));
  expect(reads).toContain("0px");
  expect(field.style.height).toBe(`${LINE_PX + 2}px`);
});

test("a replacement of equal length collapses the field", () => {
  const { field, set } = mount("x".repeat(25));
  reads = [];
  set("y".repeat(25));
  expect(reads).toContain("0px");
  expect(field.style.height).toBe(`${3 * LINE_PX + 2}px`);
});

test("a changed ceiling is measured afresh and the field never exceeds it", () => {
  const { field, set } = mount("x".repeat(95), 60);
  expect(field.style.height).toBe("60px");
  reads = [];
  set("x".repeat(96));
  expect(reads.filter((height) => height === "0px")).toEqual([]);
  expect(field.style.height).toBe("60px");
});
