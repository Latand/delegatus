import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import { AccountStatusDot } from "./AccountStatusDot";

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
});
installActEnv();

/* The page has no layout here: an element's box is the `data-box` it carries ("left,top,right,bottom"),
   and a range over an element answers with that element's own box. */
const boxOf = (element: Element | null): DOMRect => {
  const [left = 0, top = 0, right = 0, bottom = 0] = (element?.getAttribute("data-box") ?? "0,0,0,0").split(",").map(Number);
  return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect;
};
const protoOf = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
const rangeProto = Object.getPrototypeOf(document.createRange()) as { getClientRects: (this: { startContainer: Node }) => DOMRect[] };
const real = { box: protoOf.getBoundingClientRect, rects: rangeProto.getClientRects };
const frames: Array<() => void> = [];
const globals = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const savedFrames = { raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame };

afterEach(() => {
  protoOf.getBoundingClientRect = real.box;
  rangeProto.getClientRects = real.rects;
  globals.requestAnimationFrame = savedFrames.raf;
  globals.cancelAnimationFrame = savedFrames.caf;
  frames.length = 0;
  document.body.replaceChildren();
});

async function mount(rows: string) {
  protoOf.getBoundingClientRect = function (this: Element) {
    return boxOf(this.getAttribute("role") === "tooltip" ? { getAttribute: () => "120,40,400,90" } as unknown as Element : this);
  };
  rangeProto.getClientRects = function (this: { startContainer: Node }) { return [boxOf(this.startContainer as Element)]; };
  globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
  globals.cancelAnimationFrame = () => {};
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(
    <div data-accounts-scroller>
      <div data-account-row="own">
        <div data-account-head>
          <AccountStatusDot accountId="own-id" label="Own" word="signed in" tone="success" plan="Pro plan" note="Next for unpinned work" phone={false} />
          <button type="button" data-account-toggle="own" data-box="30,0,200,20">Own</button>
        </div>
        <div data-account-line data-testid="near" data-box="40,60,300,76">Near line</div>
        <div data-account-line data-testid="far" data-box="40,300,300,316">Far line</div>
      </div>
      <div data-account-row="other" data-testid="other-row">
        <div data-account-head><button type="button" data-account-toggle="other" data-box="130,80,260,100">Other</button></div>
        <div data-account-line data-testid="other-line" data-box="40,320,300,336">Other line</div>
      </div>
      {rows ? <div data-testid="marker">{rows}</div> : null}
    </div>,
  ));
  return { host, unmount: () => act(async () => root.unmount()) };
}
const run = async () => { await act(async () => { while (frames.length) frames.shift()!(); }); };
const hidden = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.style.visibility === "hidden";

test("the dot is named by the row and its state, and opens its words with the plan, the note and the id", async () => {
  const view = await mount("");
  const dot = view.host.querySelector<HTMLButtonElement>("[data-account-status]")!;
  expect(dot.getAttribute("aria-label")).toBe("Own: signed in");
  expect(dot.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.querySelector("[data-account-status-popover]")).toBeNull();
  await act(async () => dot.click());
  expect(dot.getAttribute("aria-expanded")).toBe("true");
  const popover = document.body.querySelector("[data-account-status-popover]")!;
  expect(popover.textContent).toBe("Signed in · Pro plan · Next for unpinned workown-id");
  expect(document.getElementById(dot.getAttribute("aria-describedby")!)?.getAttribute("role")).toBe("tooltip");
  await view.unmount();
});

test("Escape and a press outside close it", async () => {
  const view = await mount("");
  const dot = view.host.querySelector<HTMLButtonElement>("[data-account-status]")!;
  await act(async () => dot.click());
  await act(async () => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); });
  expect(document.body.querySelector("[data-account-status-popover]")).toBeNull();
  await act(async () => dot.click());
  expect(document.body.querySelector("[data-account-status-popover]")).not.toBeNull();
  await act(async () => { document.body.dispatchEvent(new dom.Event("pointerdown", { bubbles: true }) as unknown as Event); });
  expect(document.body.querySelector("[data-account-status-popover]")).toBeNull();
  await view.unmount();
});

test("Escape on the focused dot closes its words and leaves the dialog around it alone", async () => {
  let heard = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(
    // The dialog's own Escape handler is an ancestor of every row.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div role="dialog" onKeyDown={(event) => { if (event.key === "Escape") heard += 1; }}>
      <div data-account-row="own"><div data-account-head><AccountStatusDot accountId="own" label="Own" word="signed in" tone="success" plan={null} note={null} phone={false} /></div></div>
    </div>,
  ));
  const dot = host.querySelector<HTMLButtonElement>("[data-account-status]")!;
  const escape = () => act(async () => { dot.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
  await act(async () => dot.click());
  expect(dot.getAttribute("aria-expanded")).toBe("true");
  await escape();
  expect(dot.getAttribute("aria-expanded")).toBe("false");
  expect(heard).toBe(0);
  // With nothing open, Escape goes on to the dialog.
  await escape();
  expect(heard).toBe(1);
  await act(async () => root.unmount());
});

test("while open it hides the lines it lies over whole, and a row whose head it reaches with its dividers; closing restores them", async () => {
  const view = await mount("");
  const dot = view.host.querySelector<HTMLButtonElement>("[data-account-status]")!;
  await act(async () => dot.click());
  await run();
  await run();
  // The popover lies at 120..400 × 40..90: the near line (60..76) is under it, the far one is not.
  expect(hidden(view.host, "near")).toBe(true);
  expect(hidden(view.host, "far")).toBe(false);
  // Another row's name is reached: the row goes whole, so no control stays without its owner.
  expect(hidden(view.host, "other-line")).toBe(true);
  expect(view.host.querySelector<HTMLElement>('[data-account-row="other"] [data-account-head]')!.style.visibility).toBe("hidden");
  await act(async () => dot.click());
  expect(hidden(view.host, "near")).toBe(false);
  expect(hidden(view.host, "other-line")).toBe(false);
  expect(view.host.querySelector<HTMLElement>('[data-account-row="other"] [data-account-head]')!.style.visibility).toBe("");
  await view.unmount();
});
