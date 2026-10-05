import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

/*
 * The redesign prototype answers the product's "⋯" buttons with a dialog
 * (docs/design/interface-redesign.md). The product declares a menu on them, so
 * while the prototype is mounted each one has to declare a dialog, and what it
 * declared before has to come back when the prototype goes.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const { useDialogTriggers } = await import("./interfaceRedesign.prototype");

function Prototype({ on }: { on: boolean }) {
  useDialogTriggers(on, "[data-menu]");
  return null;
}

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

const trigger = (popup: string | null) => {
  const button = document.createElement("button");
  button.setAttribute("data-menu", "");
  if (popup) button.setAttribute("aria-haspopup", popup);
  document.body.append(button);
  return button;
};

test("an intercepted trigger declares a dialog while the prototype is mounted, and what it declared before once it is gone", async () => {
  const menu = trigger("menu");
  const bare = trigger(null);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Prototype on />); });
  expect(menu.getAttribute("aria-haspopup")).toBe("dialog");
  expect(bare.getAttribute("aria-haspopup")).toBe("dialog");

  /* A trigger the product mounts later (a card scrolled into the board) is answered too. */
  let late: HTMLElement;
  await act(async () => { late = trigger("menu"); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(late!.getAttribute("aria-haspopup")).toBe("dialog");

  await act(async () => { root!.unmount(); });
  root = null;
  expect(menu.getAttribute("aria-haspopup")).toBe("menu");
  expect(late!.getAttribute("aria-haspopup")).toBe("menu");
  expect(bare.hasAttribute("aria-haspopup")).toBe(false);
});

test("a variant that intercepts nothing leaves the product's declaration alone", async () => {
  const menu = trigger("menu");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Prototype on={false} />); });
  expect(menu.getAttribute("aria-haspopup")).toBe("menu");
});
