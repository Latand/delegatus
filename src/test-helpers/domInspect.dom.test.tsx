/**
 * A failed element comparison stays a failure (#2182): React-rendered
 * happy-dom nodes print as one line through `domInspect.ts`, which the test
 * preload installs, so Bun's `toBe` reports the mismatch instead of losing it
 * while it formats the React tree hung on each node.
 */
import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";

import { describeNode } from "./domInspect";

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const saved = { window: G.window, document: G.document };
Object.assign(globalThis, { window: dom, document: dom.document });
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");

const roots: Root[] = [];
afterAll(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  await new Promise((resolve) => setTimeout(resolve, 0));
  Object.assign(globalThis, saved);
  await dom.happyDOM.abort();
});

function Row({ index }: { index: number }): ReactNode {
  return createElement("li", { "data-row": String(index), className: "row" }, createElement("span", null, `Row ${index}`));
}

function mountRows(count: number): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(createElement("ul", { "data-list": "rows" }, Array.from({ length: count }, (_, index) => createElement(Row, { key: index, index })))));
  return host as unknown as HTMLElement;
}

test("toBe fails, quickly and naming both nodes, when two React-rendered elements differ", () => {
  const host = mountRows(400);
  const row = host.querySelector<HTMLElement>('[data-row="7"]')!;
  expect(Object.keys(row).some((key) => key.startsWith("__reactFiber$"))).toBe(true);

  const started = performance.now();
  let message = "";
  try {
    expect(dom.document.body).toBe(row as never);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain('Expected: <li data-row="7" class="row">');
  expect(message).toContain("Received: <body>");
  expect(performance.now() - started).toBeLessThan(2_000);
  /* The same element still passes, and .not still refuses it. */
  expect(host.querySelector('[data-row="7"]')).toBe(row);
  expect(() => expect(row).not.toBe(row)).toThrow();
});

test("a node describes itself in one line", () => {
  const element = dom.document.createElement("section");
  element.setAttribute("data-kanban-reader", "conversation_plain-1");
  element.setAttribute("class", "reader");
  element.setAttribute("style", "color: red");
  expect(describeNode(element as never)).toBe('<section data-kanban-reader="conversation_plain-1" class="reader">');
  element.setAttribute("aria-label", "x".repeat(60));
  expect(describeNode(element as never)).toBe(`<section data-kanban-reader="conversation_plain-1" class="reader" aria-label="${"x".repeat(40)}…">`);
  expect(describeNode(dom.document.createTextNode("Ready to review") as never)).toBe('#text "Ready to review"');
  expect(describeNode(dom.document as never)).toBe("#document");
});
