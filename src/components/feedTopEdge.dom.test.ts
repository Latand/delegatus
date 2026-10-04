import { expect, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ width: 390, height: 844 });
Object.assign(globalThis, { window: dom, document: dom.document, Node: dom.Node, HTMLElement: dom.HTMLElement, getComputedStyle: dom.getComputedStyle.bind(dom) });
const { inkEdgeCut, restingDelta, rowEdgeCut } = await import("./feedTopEdge");

const ROW_PX = 100;
const VIEWPORT_PX = 400;

/* A feed of `count` rows, each ROW_PX tall, stacked from the scroller's top.
   Geometry is faked from the row's index and the scroll position; `reads`
   counts every layout read, the cost the edge reading must keep small. */
function feedAt(count: number, scrollTop: number) {
  const scroller = document.createElement("div") as unknown as HTMLElement;
  let reads = 0;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} }) as DOMRect;
  Object.defineProperty(scroller, "scrollHeight", { value: count * ROW_PX });
  Object.defineProperty(scroller, "clientHeight", { value: VIEWPORT_PX });
  Object.defineProperty(scroller, "scrollTop", { value: scrollTop, writable: true });
  scroller.getBoundingClientRect = () => rect(0, VIEWPORT_PX);
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("div") as unknown as HTMLElement;
    row.setAttribute("data-feed-key", `row-${index}`);
    row.getBoundingClientRect = () => { reads += 1; return rect(index * ROW_PX - scrollTop, ROW_PX); };
    scroller.append(row);
  }
  return { scroller, reads: () => reads };
}

test("a row cut at the edge is found without measuring the rows above it", () => {
  /* The edge cuts row 2,000 thirty pixels from its top. */
  const feed = feedAt(3_000, 2_000 * ROW_PX + 30);
  expect(rowEdgeCut(feed.scroller)).toEqual({ hidden: 30, shown: 70 });
  expect(feed.reads()).toBeLessThan(40);
});

test("the settle reads a boundary and a cut row the same as the full scan would", () => {
  const onBoundary = feedAt(500, 250 * ROW_PX);
  expect(rowEdgeCut(onBoundary.scroller)).toEqual({ hidden: 0, shown: 0 });
  expect(restingDelta(onBoundary.scroller)).toBe(0);
  const cut = feedAt(500, 250 * ROW_PX + 30);
  expect(restingDelta(cut.scroller)).toBe(-30);
  const nearBottom = feedAt(500, 250 * ROW_PX + 80);
  expect(restingDelta(nearBottom.scroller)).toBe(20);
});

test("the ink reading also skips the rows above the edge", () => {
  const feed = feedAt(3_000, 2_000 * ROW_PX + 30);
  Object.assign(document, { elementFromPoint: () => null });
  expect(inkEdgeCut(feed.scroller)).toBeNull();
  expect(feed.reads()).toBeLessThan(40);
});

test("a feed with no feed rows still reads every row", () => {
  const scroller = document.createElement("div") as unknown as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { value: 1_000 });
  Object.defineProperty(scroller, "clientHeight", { value: VIEWPORT_PX });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: VIEWPORT_PX, height: VIEWPORT_PX, left: 0, right: 390, width: 390 }) as DOMRect;
  const item = document.createElement("li") as unknown as HTMLElement;
  item.getBoundingClientRect = () => ({ top: -30, bottom: 70, height: 100, left: 0, right: 390, width: 390 }) as DOMRect;
  scroller.append(item);
  expect(rowEdgeCut(scroller)).toEqual({ hidden: 30, shown: 70 });
});

test("a rest on a row boundary reads the rows beside the edge, however many rows are mounted", () => {
  /* The browser's hit test at the edge lands on the container that holds the
     rows, not on a row: the probes of the ink reading would then walk one
     rectangle per mounted row. On a boundary nothing crosses the edge, so they
     are not asked. */
  const readsAtBoundary = (count: number) => {
    const feed = feedAt(count, (count / 2) * ROW_PX);
    const content = document.createElement("div") as unknown as HTMLElement;
    content.getBoundingClientRect = () => ({ top: -(count / 2) * ROW_PX, bottom: (count / 2) * ROW_PX, height: count * ROW_PX, left: 0, right: 390, width: 390 }) as DOMRect;
    content.append(...Array.from(feed.scroller.children));
    feed.scroller.append(content);
    let probes = 0;
    Object.assign(document, { elementFromPoint: () => { probes += 1; return content; } });
    expect(restingDelta(feed.scroller)).toBe(0);
    expect(probes).toBe(0);
    return feed.reads();
  };
  const few = readsAtBoundary(150);
  const many = readsAtBoundary(1_500);
  expect(many).toBeLessThan(40);
  /* The bisection to the edge is logarithmic: ten times the rows costs a few
     more reads, not ten times as many. */
  expect(many).toBeLessThanOrEqual(few + 6);
});
