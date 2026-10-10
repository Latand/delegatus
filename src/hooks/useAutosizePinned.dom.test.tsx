import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useAutosizePinned } from "./useAutosizePinned";

/*
 * An empty field is as tall as its placeholder, and the placeholder changes on
 * its own: right after a rotation the phone's composer swapped «message the
 * agent» for «message the agent — reconnecting to its session…», which wraps to
 * a second line at 390 px. Measured only on value changes, the field kept one
 * line and showed the tops of the second line's letters over the tools row.
 */

const dom = new Window({ width: 390, height: 800 });
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

const LINE_PX = 22;
const SHORT = "message the agent";
const LONG = "message the agent — reconnecting to its session…";

/* One 22 px line per 30 characters of whatever the empty field shows; the
   hook adds its 2 px of border. */
Object.defineProperty(dom.HTMLTextAreaElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLTextAreaElement) {
    const shown = this.value || this.placeholder;
    return Math.max(1, Math.ceil(shown.length / 30)) * LINE_PX;
  },
});

function Field({ placeholder }: { placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useAutosizePinned(ref, "", { maxPx: 200, pinned: false });
  return <textarea ref={ref} value="" readOnly rows={1} placeholder={placeholder} />;
}

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  dom.document.body.replaceChildren();
});

test("an empty field grows when its placeholder becomes longer than one line", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  flushSync(() => root!.render(<Field placeholder={SHORT} />));
  const field = host.querySelector("textarea")!;
  expect(field.style.height).toBe(`${LINE_PX + 2}px`);

  flushSync(() => root!.render(<Field placeholder={LONG} />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(field.style.height).toBe(`${2 * LINE_PX + 2}px`);

  flushSync(() => root!.render(<Field placeholder={SHORT} />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(field.style.height).toBe(`${LINE_PX + 2}px`);
});

/* The composer's owner keeps the hook while the textarea itself is replaced
   (the phone's chat screen, the PiP move); the new element arrives with no
   height of its own and the text has not changed. */
function Remounting({ generation }: { generation: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [field, setField] = useState<HTMLTextAreaElement | null>(null);
  useAutosizePinned(ref, "", { maxPx: 200, pinned: false, field });
  return (
    <textarea
      key={generation}
      ref={(el) => { ref.current = el; setField(el); }}
      value=""
      readOnly
      rows={1}
      placeholder={LONG}
    />
  );
}

test("a replaced field is sized as it arrives, with no text change to prompt it", () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  flushSync(() => root!.render(<Remounting generation={1} />));
  const first = host.querySelector("textarea")!;
  expect(first.style.height).toBe(`${2 * LINE_PX + 2}px`);

  flushSync(() => root!.render(<Remounting generation={2} />));
  const second = host.querySelector("textarea")!;
  expect(second).not.toBe(first);
  expect(second.style.height).toBe(`${2 * LINE_PX + 2}px`);
});
