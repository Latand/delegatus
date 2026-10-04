/** A fixed-size recency map for lightweight per-conversation UI memory. */
export class BoundedLru<Value> {
  private readonly values = new Map<string, Value>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("BoundedLru limit must be a positive integer");
  }

  get size(): number {
    return this.values.size;
  }

  get(key: string): Value | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) return;
      this.values.delete(oldest);
    }
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

/** The anchors that can be the row at the top of a viewport: the feed's own
 * rows in document order. Two kinds of `[data-feed-key]` element never are.
 * An empty reasoning record keeps its source identities inside a `hidden`
 * wrapper, so they have no box and a rect of zeros. A reasoning group's member
 * anchors sit inside the row that holds them and end above that row's bottom.
 * Either one breaks the non-decreasing bottoms the bisection below relies on.
 * Both stay reachable by key; only the reading position skips them. */
export function readingRows(root: ParentNode): HTMLElement[] {
  const cached = readings.get(root);
  if (cached) {
    /* `takeRecords` hands over mutations the observer has not delivered yet,
       so a read made right after a commit (a layout effect) sees them. */
    const changed = cached.watch.takeRecords().length > 0 || cached.stale;
    if (!changed) return cached.rows;
    cached.stale = false;
    cached.rows = scanReadingRows(root);
    return cached.rows;
  }
  const rows = scanReadingRows(root);
  const Observer = (root as Node).ownerDocument?.defaultView?.MutationObserver;
  if (Observer) {
    const reading: Reading = { rows, stale: false, watch: new Observer(() => { reading.stale = true; }) };
    reading.watch.observe(root as Node, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-feed-key", "data-empty-reasoning"] });
    readings.set(root, reading);
  }
  return rows;
}

/* The scan is two selector passes over every node under the feed, and the
   second one is an ancestor walk per row: about 4 ms for two thousand rows on
   a desktop, so about 15 ms at 4x CPU, on every scroll event. The rows only
   change when the feed's own markup does, so the answer is kept per root and
   rebuilt when a mutation says it may have changed. The array is shared:
   callers read it, they do not edit it. */
interface Reading { rows: HTMLElement[]; stale: boolean; watch: MutationObserver }
const readings = new WeakMap<ParentNode, Reading>();

function scanReadingRows(root: ParentNode): HTMLElement[] {
  const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-feed-key]"));
  const inside = new Set(root.querySelectorAll("[data-feed-key] [data-feed-key], [data-empty-reasoning] [data-feed-key]"));
  return inside.size ? anchors.filter((anchor) => !inside.has(anchor)) : anchors;
}

/** The first row whose bottom edge is below `top`, the row at the top of a
 * scrolled viewport. Rows stack in document order, so their bottoms never
 * decrease down the feed (given `readingRows`) and the answer is found by
 * bisection: a handful of rect reads instead of one per row above the
 * viewport, which grew with every page of history the reader expanded. */
export function firstRowPastTop<Row extends { getBoundingClientRect(): { bottom: number } }>(rows: readonly Row[], top: number): Row | undefined {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle]!.getBoundingClientRect().bottom > top) high = middle; else low = middle + 1;
  }
  return rows[low];
}
