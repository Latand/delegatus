import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { createReceiptStore, type ReceiptTimers } from "./MobileReceipt";
import { MobileSheet, MobileSheetRow, SHEET_CLOSE_DRAG_PX, SHEET_EXPAND_DRAG_PX, SHEET_FLICK_PX_PER_MS, sheetRelease } from "./MobileSheet";

/*
 * The sheet primitive (mobile v2 §2 rule 1, §3.3, §5): a modal over the
 * current screen that closes on the scrim, the ×, Escape, or a drag of its
 * handle past 80 px; a shorter drag springs back. Its receipt slot sits
 * between the body and the footer.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
/* React schedules passive work on a later tick: let it run before the
   globals go, or it dereferences a window that is no longer there. */
afterAll(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; } });

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); dom.document.body.style.overflow = ""; roots = []; });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; dom.document.body.style.overflow = ""; });

function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const sheet = (host: HTMLElement) => host.querySelector('[data-mobile2-sheet="menu"]') as unknown as HTMLElement | null;
const pointer = (type: string, clientY: number) => new dom.PointerEvent(type, { bubbles: true, cancelable: true, clientY, pointerId: 1 } as never) as unknown as Event;

function open(): { host: HTMLElement; closes: () => number } {
  let closes = 0;
  const host = mount(
    <MobileSheet name="menu" title="atlas" onClose={() => { closes += 1; }}>
      <button type="button" data-testid="row">New agent</button>
    </MobileSheet>,
  );
  return { host, closes: () => closes };
}

test("a sheet is a modal dialog over the screen: it takes focus, locks the body, names itself", () => {
  const { host } = open();
  const dialog = sheet(host)!;
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-label")).toBe("atlas");
  expect(dialog.className).toContain("max-h-[88%]");
  expect(dom.document.body.style.overflow).toBe("hidden");
  expect(dom.document.activeElement).toBe(dialog as never);
  /* Its × is a 44 px target that carries the harness hook. */
  const close = host.querySelector("[data-mobile2-close]") as unknown as HTMLElement;
  expect(close.className).toContain("h-11");
  expect(close.className).toContain("w-11");
});

test("the × and the scrim close it; a tap inside does not", () => {
  const { host, closes } = open();
  flushSync(() => (host.querySelector('[data-testid="row"]') as unknown as HTMLElement).click());
  expect(closes()).toBe(0);
  flushSync(() => (host.querySelector("[data-mobile2-close]") as unknown as HTMLElement).click());
  expect(closes()).toBe(1);
  flushSync(() => (host.querySelector("[data-mobile2-scrim]") as unknown as HTMLElement).click());
  expect(closes()).toBe(2);
});

test("Escape closes it", () => {
  const { closes } = open();
  flushSync(() => {
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
  });
  expect(closes()).toBe(1);
});

test("a drag of the handle past 80 px closes; the sheet follows the finger on the way", () => {
  const { host, closes } = open();
  const grab = host.querySelector("[data-mobile2-grab]") as unknown as HTMLElement;
  const dialog = sheet(host)!;
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 500)));
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 560)));
  expect(dialog.style.transform).toBe("translateY(60px)");
  expect(dialog.style.transition).toBe("none");
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 500 + SHEET_CLOSE_DRAG_PX + 21)));
  expect(dialog.style.transform).toBe(`translateY(${SHEET_CLOSE_DRAG_PX + 21}px)`);
  flushSync(() => grab.dispatchEvent(pointer("pointerup", 500 + SHEET_CLOSE_DRAG_PX + 21)));
  expect(closes()).toBe(1);
});

test("a shorter drag springs back over 200 ms and keeps the sheet open", () => {
  const { host, closes } = open();
  const header = host.querySelector("[data-mobile2-sheet-header]") as unknown as HTMLElement;
  const dialog = sheet(host)!;
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 300)));
  flushSync(() => header.dispatchEvent(pointer("pointermove", 340)));
  expect(dialog.style.transform).toBe("translateY(40px)");
  flushSync(() => header.dispatchEvent(pointer("pointerup", 340)));
  expect(closes()).toBe(0);
  expect(dialog.style.transform).toBe("");
  expect(dialog.style.transition).toContain("200ms");
  /* An upward pull never moves it. */
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 300)));
  flushSync(() => header.dispatchEvent(pointer("pointermove", 200)));
  expect(dialog.style.transform).toBe("translateY(0px)");
  flushSync(() => header.dispatchEvent(pointer("pointercancel", 200)));
  expect(closes()).toBe(0);
});

test("a pointer that lands on the × or another header control is that control's tap, never a drag: no capture, no follow", () => {
  /* happy-dom has no pointer capture; in Chromium a captured pointer's click
     is retargeted to the capturing element, which is how a captured header
     swallowed the ×. The contract under test: the sheet asks for capture only
     when the drag starts from the handle or the title, never from a control,
     and a control's own click still fires. */
  const captures: string[] = [];
  const proto = dom.HTMLElement.prototype as unknown as { setPointerCapture?: (this: HTMLElement, pointerId: number) => void };
  const original = proto.setPointerCapture;
  proto.setPointerCapture = function () {
    captures.push(this.hasAttribute("data-mobile2-sheet-header") ? "header" : this.hasAttribute("data-mobile2-grab") ? "grab" : this.tagName);
  };
  try {
    let nexts = 0;
    let closes = 0;
    const host = mount(
      <MobileSheet
        name="attention"
        title="Needs you · 3"
        onClose={() => { closes += 1; }}
        extra={<button type="button" data-testid="next" onClick={() => { nexts += 1; }}>Next</button>}
      >
        <div>rows</div>
      </MobileSheet>,
    );
    const dialog = host.querySelector('[data-mobile2-sheet="attention"]') as unknown as HTMLElement;
    const header = host.querySelector("[data-mobile2-sheet-header]") as unknown as HTMLElement;
    const close = host.querySelector("[data-mobile2-close]") as unknown as HTMLElement;
    const next = host.querySelector('[data-testid="next"]') as unknown as HTMLElement;
    /* Each control in the browser's own order: pointerdown on it, a move well
       past the 80 px close threshold, pointerup, then the click. A drag that
       leaked out of the control would take the transition, follow the finger
       and close the sheet before the click ever ran. */
    const far = 300 + SHEET_CLOSE_DRAG_PX + 40;
    flushSync(() => next.dispatchEvent(pointer("pointerdown", 300)));
    expect(dialog.style.transition).toBe("");
    flushSync(() => header.dispatchEvent(pointer("pointermove", far)));
    expect(dialog.style.transform).toBe("");
    flushSync(() => header.dispatchEvent(pointer("pointerup", far)));
    expect(closes).toBe(0);
    expect(nexts).toBe(0);
    flushSync(() => next.click());
    expect(nexts).toBe(1);
    expect(closes).toBe(0);
    flushSync(() => close.dispatchEvent(pointer("pointerdown", 300)));
    expect(dialog.style.transition).toBe("");
    flushSync(() => header.dispatchEvent(pointer("pointermove", far)));
    expect(dialog.style.transform).toBe("");
    flushSync(() => header.dispatchEvent(pointer("pointerup", far)));
    /* The × closes on its own click, never on the pointer that preceded it. */
    expect(closes).toBe(0);
    flushSync(() => close.click());
    expect(closes).toBe(1);
    expect(captures).toEqual([]);
    /* The title text and the handle still start one, and capture it. */
    const title = header.querySelector("h2") as unknown as HTMLElement;
    flushSync(() => title.dispatchEvent(pointer("pointerdown", 300)));
    flushSync(() => header.dispatchEvent(pointer("pointermove", 340)));
    expect(dialog.style.transform).toBe("translateY(40px)");
    flushSync(() => header.dispatchEvent(pointer("pointerup", 340)));
    const grab = host.querySelector("[data-mobile2-grab]") as unknown as HTMLElement;
    flushSync(() => grab.dispatchEvent(pointer("pointerdown", 300)));
    flushSync(() => grab.dispatchEvent(pointer("pointercancel", 300)));
    expect(captures).toEqual(["header", "grab"]);
    expect(closes).toBe(1);
  } finally {
    if (original) proto.setPointerCapture = original;
    else delete proto.setPointerCapture;
  }
});

test("the receipt slot inside a sheet sits between the body and the footer", () => {
  const timers: ReceiptTimers = { set: () => 1, clear: () => {} };
  const store = createReceiptStore(timers);
  const host = mount(
    <MobileSheet name="menu" title="atlas" onClose={() => {}} receiptStore={store} footer={<button type="button" data-testid="foot">Rotate</button>}>
      <div data-testid="body-row">row</div>
    </MobileSheet>,
  );
  expect(host.querySelector("[data-mobile2-receipt]")).toBeNull();
  flushSync(() => { store.show("Reset used"); });
  const receipt = host.querySelector('[data-mobile2-receipt-placement="sheet"]') as unknown as HTMLElement;
  expect(receipt).not.toBeNull();
  expect(sheet(host)!.contains(receipt as never)).toBe(true);
  const body = host.querySelector("[data-mobile2-sheet-body]") as unknown as HTMLElement;
  const foot = host.querySelector('[data-testid="foot"]') as unknown as HTMLElement;
  expect(body.compareDocumentPosition(receipt as never) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(receipt.compareDocumentPosition(foot as never) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a fullscreen sheet has no handle and never drags", () => {
  let closes = 0;
  const host = mount(
    <MobileSheet name="rotate" title="Replace the orchestrator" full onClose={() => { closes += 1; }}>
      <div>draft</div>
    </MobileSheet>,
  );
  expect(host.querySelector("[data-mobile2-grab]")).toBeNull();
  const dialog = host.querySelector('[data-mobile2-sheet="rotate"]') as unknown as HTMLElement;
  expect(dialog.className).toContain("h-full");
  /* The body takes the height left over, so the footer stands at the screen's foot. */
  expect((host.querySelector("[data-mobile2-sheet-body]") as unknown as HTMLElement).className.split(" ")).toContain("flex-1");
  const header = host.querySelector("[data-mobile2-sheet-header]") as unknown as HTMLElement;
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 100)));
  flushSync(() => header.dispatchEvent(pointer("pointermove", 400)));
  flushSync(() => header.dispatchEvent(pointer("pointerup", 400)));
  expect(dialog.style.transform).toBe("");
  expect(closes).toBe(0);
});

/*
 * Which of a row's two texts gives way (#1681).
 *
 * The default is the label, because a trailing slot is normally a word or a
 * count. A row whose trailing text is a whole clause has to invert it, and the
 * opt-in is what keeps every other row byte-identical.
 */
test("a row truncates its label by default and its trailing text on request", () => {
  const host = mount(
    <>
      <MobileSheetRow label="Seat tick" trailing={<span data-probe="default">a very long trailing clause indeed</span>} testId="row-default" />
      <MobileSheetRow label="Seat tick" trailingShrinks trailing={<span data-probe="inverted">a very long trailing clause indeed</span>} testId="row-inverted" />
    </>,
  );
  const parts = (testId: string) => {
    const row = host.querySelector(`[data-testid="${testId}"]`) as unknown as HTMLElement;
    return { label: row.children[0] as unknown as HTMLElement, trailing: row.children[1] as unknown as HTMLElement };
  };

  /* Default: the label is the flexible, truncating element. */
  const fixed = parts("row-default");
  expect(fixed.label.className).toContain("flex-1");
  expect(fixed.label.className).toContain("truncate");
  expect(fixed.trailing.className).toContain("shrink-0");

  /* Inverted: the label holds its size and the clause beside it truncates. */
  const inverted = parts("row-inverted");
  expect(inverted.label.className).toContain("shrink-0");
  expect(inverted.label.className).not.toContain("flex-1");
  expect(inverted.trailing.className).toContain("flex-1");
  expect(inverted.trailing.className).not.toContain("shrink-0");
});

/*
 * Every phone «…» menu opens through this sheet, so its body is where a line
 * that will not shrink would make a menu scroll sideways. The body scrolls
 * down and never across, for the sheet that sizes to its content and for the
 * full one (docs/design/mobile-menu-overflow-brief.md). happy-dom has no layout:
 * the stylesheet's rule is read off the classes, and the browser case in
 * issue1671Evidence.browser.test.tsx reads the widths.
 */
test("a sheet body scrolls vertically and never sideways, sized to content or full", () => {
  const host = mount(
    <>
      <MobileSheet name="menu" title="atlas" onClose={() => undefined}><span>rows</span></MobileSheet>
      <MobileSheet name="stage" title="stage" full onClose={() => undefined}><span>rows</span></MobileSheet>
    </>,
  );
  const bodies = [...host.querySelectorAll("[data-mobile2-sheet-body]")] as unknown as HTMLElement[];
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    const classes = body.className.split(/\s+/);
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overflow-x-hidden");
    expect(classes).not.toContain("overflow-x-auto");
    expect(classes).not.toContain("overflow-x-scroll");
  }
});

/*
 * The second detent (an `expandable` sheet, the phone's «Чекають на вас»):
 * the handle pulls it up to nearly the full screen and back down, a flick does
 * the same, only the first detent closes. happy-dom has no layout: the sheet's
 * offsetHeight is read off the inline height the drag pins, and the clock is
 * the test's, so the flick is deterministic. The browser case in
 * issue1671Evidence.browser.test.tsx reads the real heights at 390 and 440.
 */
const LOW = 300;
const HIGH = 780;
let clock = 0;
const realNow = performance.now.bind(performance);
beforeEach(() => { clock = 1000; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

function openExpandable(): { host: HTMLElement; dialog: HTMLElement; grab: HTMLElement; header: HTMLElement; closes: () => number } {
  let closes = 0;
  const host = mount(
    <MobileSheet name="attention" title="Needs you · 3" expandable onClose={() => { closes += 1; }}>
      <button type="button" data-testid="row">row</button>
    </MobileSheet>,
  );
  const dialog = host.querySelector('[data-mobile2-sheet="attention"]') as unknown as HTMLElement;
  Object.defineProperty(dialog, "offsetHeight", {
    configurable: true,
    get: () => {
      const height = dialog.style.height;
      if (height.endsWith("px")) return parseFloat(height);
      return height === "auto" ? LOW : HIGH;
    },
  });
  return {
    host,
    dialog,
    grab: host.querySelector("[data-mobile2-grab]") as unknown as HTMLElement,
    header: host.querySelector("[data-mobile2-sheet-header]") as unknown as HTMLElement,
    closes: () => closes,
  };
}

/** Drag `target` by `dy` over `ms`, in two moves, and release. */
function dragBy(target: HTMLElement, dy: number, ms = 400, from = 600) {
  flushSync(() => target.dispatchEvent(pointer("pointerdown", from)));
  clock += ms / 2;
  flushSync(() => target.dispatchEvent(pointer("pointermove", from + dy / 2)));
  clock += ms / 2;
  flushSync(() => target.dispatchEvent(pointer("pointermove", from + dy)));
  return () => flushSync(() => target.dispatchEvent(pointer("pointerup", from + dy)));
}

test("an expandable sheet opens at the first detent; the others have no detent at all", () => {
  const { dialog, host } = openExpandable();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
  expect(dialog.className).toContain("max-h-[88%]");
  expect(dialog.className).not.toContain("env(safe-area-inset-top)");
  const plain = open().host;
  expect(sheet(plain)!.hasAttribute("data-mobile2-detent")).toBe(false);
  /* A plain sheet ignores an upward pull, as before. */
  const grab = plain.querySelector("[data-mobile2-grab]") as unknown as HTMLElement;
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 600)));
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 300)));
  flushSync(() => grab.dispatchEvent(pointer("pointerup", 300)));
  expect(sheet(plain)!.hasAttribute("data-mobile2-detent")).toBe(false);
  expect(sheet(plain)!.style.height).toBe("");
  expect(host).toBeDefined();
});

test("pulling the handle up grows the sheet with the finger and leaves it at the second detent", () => {
  const { dialog, grab, closes } = openExpandable();
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 600)));
  expect(dialog.style.height).toBe(`${LOW}px`);
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 500)));
  expect(dialog.style.height).toBe(`${LOW + 100}px`);
  /* It stops at the second detent however far the finger goes. */
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 0)));
  expect(dialog.style.height).toBe(`${HIGH}px`);
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 450)));
  clock += 500;
  flushSync(() => grab.dispatchEvent(pointer("pointerup", 450)));
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("expanded");
  expect(dialog.className).toContain("h-[calc(100%-env(safe-area-inset-top)-3.5rem)]");
  expect(dialog.className).not.toContain("max-h-[88%]");
  /* Its body takes the height the header leaves, the list scrolls there. */
  expect((dialog.querySelector("[data-mobile2-sheet-body]") as unknown as HTMLElement).className.split(" ")).toContain("flex-1");
  expect(closes()).toBe(0);
});

test("a short pull springs back; a pull past the expand distance opens", () => {
  const { dialog, grab } = openExpandable();
  dragBy(grab, -(SHEET_EXPAND_DRAG_PX - 10))();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
  dragBy(grab, -(SHEET_EXPAND_DRAG_PX + 10))();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("expanded");
});

test("a quick flick up opens it and a quick flick down folds it, whatever the distance", () => {
  const { dialog, grab, header } = openExpandable();
  /* 30 px in 40 ms is 0.75 px/ms: under the distance, over the speed. */
  dragBy(grab, -30, 40)();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("expanded");
  dragBy(header, 30, 40)();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
  /* The same distance slowly does neither. */
  dragBy(grab, -30, 1000)();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
});

test("a pause before the lift is not a flick", () => {
  const { dialog, grab } = openExpandable();
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 600)));
  clock += 20;
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 570)));
  clock += 400;
  flushSync(() => grab.dispatchEvent(pointer("pointerup", 570)));
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
});

test("from the second detent a drag down folds to the first and never closes; the first then closes as before", () => {
  const { dialog, grab, header, closes } = openExpandable();
  dragBy(grab, -200)();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("expanded");
  /* A short drag down springs back to the second detent. */
  dragBy(grab, 50)();
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("expanded");
  /* While it is dragged the sheet shrinks with the finger, no further than the first detent. */
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 100)));
  flushSync(() => header.dispatchEvent(pointer("pointermove", 200)));
  expect(dialog.style.height).toBe(`${HIGH - 100}px`);
  flushSync(() => header.dispatchEvent(pointer("pointermove", 900)));
  expect(dialog.style.height).toBe(`${LOW}px`);
  expect(dialog.style.transform).toBe("");
  clock += 600;
  flushSync(() => header.dispatchEvent(pointer("pointerup", 900)));
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
  expect(closes()).toBe(0);
  /* At the first detent the old rule holds: past 80 px closes. */
  dragBy(grab, SHEET_CLOSE_DRAG_PX + 20)();
  expect(closes()).toBe(1);
});

test("a cancelled drag keeps the detent it started from", () => {
  const { dialog, grab } = openExpandable();
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 600)));
  clock += 100;
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 200)));
  flushSync(() => grab.dispatchEvent(pointer("pointercancel", 200)));
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
});

test("a tap on the handle switches the detent; a tap on the header does not", () => {
  const { dialog, grab, header } = openExpandable();
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 600)));
  flushSync(() => grab.dispatchEvent(pointer("pointerup", 600)));
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("expanded");
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 600)));
  flushSync(() => grab.dispatchEvent(pointer("pointerup", 600)));
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 600)));
  flushSync(() => header.dispatchEvent(pointer("pointerup", 600)));
  expect(dialog.getAttribute("data-mobile2-detent")).toBe("collapsed");
});

test("the × and Escape close it from the second detent", () => {
  const { host, grab, closes } = openExpandable();
  dragBy(grab, -200)();
  flushSync(() => (host.querySelector("[data-mobile2-close]") as unknown as HTMLElement).click());
  expect(closes()).toBe(1);
  flushSync(() => {
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
  });
  expect(closes()).toBe(2);
});

test("what a release does, by detent, distance and speed", () => {
  const fast = SHEET_FLICK_PX_PER_MS + 0.1;
  expect(sheetRelease({ detent: "collapsed", dy: -SHEET_EXPAND_DRAG_PX, velocity: 0 })).toBe("expand");
  expect(sheetRelease({ detent: "collapsed", dy: -SHEET_EXPAND_DRAG_PX + 1, velocity: 0 })).toBe("stay");
  expect(sheetRelease({ detent: "collapsed", dy: -20, velocity: -fast })).toBe("expand");
  expect(sheetRelease({ detent: "collapsed", dy: -2, velocity: -fast })).toBe("stay");
  expect(sheetRelease({ detent: "collapsed", dy: SHEET_CLOSE_DRAG_PX + 1, velocity: 0 })).toBe("close");
  expect(sheetRelease({ detent: "collapsed", dy: 30, velocity: fast })).toBe("stay");
  expect(sheetRelease({ detent: "expanded", dy: SHEET_CLOSE_DRAG_PX + 1, velocity: 0 })).toBe("collapse");
  expect(sheetRelease({ detent: "expanded", dy: 30, velocity: fast })).toBe("collapse");
  expect(sheetRelease({ detent: "expanded", dy: 30, velocity: 0.1 })).toBe("stay");
  expect(sheetRelease({ detent: "expanded", dy: -100, velocity: -fast })).toBe("stay");
});
