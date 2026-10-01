import { describe, expect, test } from "bun:test";

import { BoundedLru, firstRowPastTop } from "./scrollMemory";

test("the scroll-memory boundary evicts one least-recently-used reader", () => {
  const memory = new BoundedLru<number>(300);
  memory.set("active-reader", 0);
  for (let index = 1; index < 300; index += 1) memory.set(`reader-${index}`, index);

  expect(memory.get("active-reader")).toBe(0);
  memory.set("reader-300", 300);

  expect(memory.size).toBe(300);
  expect(memory.get("active-reader")).toBe(0);
  expect(memory.get("reader-1")).toBeUndefined();
  expect(memory.get("reader-299")).toBe(299);
  expect(memory.get("reader-300")).toBe(300);
});

describe("firstRowPastTop", () => {
  const stack = (heights: number[]) => {
    let top = 0;
    const reads = { count: 0 };
    const rows = heights.map((height) => {
      const row = { top, bottom: top + height, getBoundingClientRect() { reads.count += 1; return row; } };
      top += height;
      return row;
    });
    return { rows, reads };
  };

  test("finds the same row as a linear scan wherever the viewport top falls", () => {
    const { rows } = stack([40, 0, 120, 30, 0, 0, 75, 200, 10]);
    for (let top = -10; top <= 560; top += 7) {
      expect(firstRowPastTop(rows, top)).toBe(rows.find((row) => row.getBoundingClientRect().bottom > top));
    }
  });

  test("is undefined past the last row and for an empty feed", () => {
    expect(firstRowPastTop(stack([10, 10]).rows, 1000)).toBeUndefined();
    expect(firstRowPastTop([], 0)).toBeUndefined();
  });

  test("reads a logarithmic number of rects in a long feed", () => {
    const { rows, reads } = stack(Array.from({ length: 4000 }, () => 25));
    const row = firstRowPastTop(rows, 25 * 3000 + 5);
    expect(row).toBe(rows[3000]!);
    expect(reads.count).toBeLessThanOrEqual(13);
  });
});
