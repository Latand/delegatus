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

/** The first row whose bottom edge is below `top`, the row at the top of a
 * scrolled viewport. Rows stack in document order, so their bottoms never
 * decrease down the feed and the answer is found by bisection: a handful of
 * rect reads instead of one per row above the viewport, which grew with every
 * page of history the reader expanded. */
export function firstRowPastTop<Row extends { getBoundingClientRect(): { bottom: number } }>(rows: readonly Row[], top: number): Row | undefined {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle]!.getBoundingClientRect().bottom > top) high = middle; else low = middle + 1;
  }
  return rows[low];
}
