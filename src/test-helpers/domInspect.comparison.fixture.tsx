/**
 * The child half of `domInspect.dom.test.tsx` (#2182). It mounts a React list
 * into happy-dom and makes one element comparison, so the parent can bound
 * Bun's failure formatter from outside this process: a formatter that blocks
 * here never returns control to anything inside it.
 *
 * Run as `bun [--preload domInspect.ts] domInspect.comparison.fixture.tsx
 * <mode>`. It prints `comparing` just before the comparison under test and
 * `done` after it, each written synchronously; an uncaught assertion ends it
 * with exit 1 and Bun's own failure text on stderr.
 */
import { expect } from "bun:test";
import { writeSync } from "node:fs";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";

const mode = process.argv[2];
const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document });
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");

function Row({ index }: { index: number }): ReactNode {
  return createElement("li", { "data-row": String(index), className: "row" }, createElement("span", null, `Row ${index}`));
}

const host = dom.document.createElement("div");
dom.document.body.appendChild(host);
const root = createRoot(host as unknown as Element);
flushSync(() => root.render(createElement("ul", { "data-list": "rows" }, Array.from({ length: 400 }, (_, index) => createElement(Row, { key: index, index })))));
const row = host.querySelector('[data-row="7"]')!;
const other = host.querySelector('[data-row="8"]')!;
if (!Object.keys(row).some((key) => key.startsWith("__reactFiber$"))) throw new Error("the row carries no React fiber");

if (mode === "stall") {
  /* A formatter that never returns: only the parent can end this run. */
  Object.defineProperty(row, Bun.inspect.custom, { value: () => { for (;;) { /* blocks */ } } });
}

/* Written straight to the descriptor: a buffered line would never leave a
   process that the formatter then blocks. */
writeSync(1, "comparing\n");
if (mode === "mismatch" || mode === "stall") {
  expect(dom.document.body).toBe(row as never);
} else if (mode === "identity") {
  expect(host.querySelector('[data-row="7"]')).toBe(row);
  expect(row).not.toBe(other);
  let refusal = "";
  try {
    expect(row).not.toBe(row);
  } catch (error) {
    refusal = String(error);
  }
  if (!refusal.includes('<li data-row="7" class="row">')) throw new Error(`.not.toBe(same) did not refuse by name: ${JSON.stringify(refusal.slice(0, 200))}`);
} else {
  throw new Error(`unknown mode ${JSON.stringify(mode)}`);
}
flushSync(() => root.unmount());
writeSync(1, "done\n");
await dom.happyDOM.abort();
