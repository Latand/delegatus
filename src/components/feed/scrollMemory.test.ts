import { describe, expect, test } from "bun:test";

import { Window } from "happy-dom";

import { BoundedLru, firstRowPastTop, readingRows } from "./scrollMemory";

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

describe("readingRows", () => {
  /* The feed as it renders: rows 60 px apart; an empty reasoning record is a
     `hidden` wrapper whose anchors have no box; a reasoning group's member
     anchors sit inside the row that holds them and end 44 px below its top. */
  const feed = () => {
    const window = new Window();
    const document = window.document;
    const make = (tag: string) => document.createElement(tag) as unknown as HTMLElement;
    const scroller = make("div");
    document.body.appendChild(scroller as never);
    const rect = (element: HTMLElement, top: number, height: number) => {
      (element as unknown as { getBoundingClientRect(): object }).getBoundingClientRect = () => ({ top, bottom: top + height, height });
    };
    const all: HTMLElement[] = [];
    for (let index = 0; index < 40; index += 1) {
      const top = 100 + 60 * index;
      if (index % 5 === 4) {
        const hidden = make("span");
        hidden.setAttribute("hidden", "");
        hidden.setAttribute("data-empty-reasoning", "");
        for (const member of ["a", "b"]) {
          const anchor = make("span");
          anchor.setAttribute("data-feed-key", `empty-${index}-${member}`);
          rect(anchor, 0, 0);
          hidden.appendChild(anchor);
          all.push(anchor);
        }
        scroller.appendChild(hidden);
        continue;
      }
      const row = make("div");
      row.setAttribute("data-feed-key", `row-${index}`);
      rect(row, top, 60);
      all.push(row);
      if (index % 5 === 2) {
        const member = make("span");
        member.setAttribute("data-feed-key", `member-${index}`);
        rect(member, top, 44);
        row.appendChild(member);
        all.push(member);
      }
      scroller.appendChild(row);
    }
    return { scroller, all };
  };

  test("leaves out the anchors that are not laid out or sit inside another row", () => {
    const { scroller } = feed();
    const keys = readingRows(scroller).map((row) => row.dataset.feedKey);
    expect(keys.some((key) => key?.startsWith("empty-") || key?.startsWith("member-"))).toBe(false);
    expect(keys).toHaveLength(32);
  });

  test("bisects to the same row as a linear scan over every anchor", () => {
    const { scroller, all } = feed();
    const rows = readingRows(scroller);
    for (let top = 150; top < 2600; top += 13) {
      expect(firstRowPastTop(rows, top)?.dataset.feedKey).toBe(all.find((row) => row.getBoundingClientRect().bottom > top)?.dataset.feedKey);
    }
  });

  test("the bisection over every anchor lands on the wrong row, which is what the filter prevents", () => {
    const { all } = feed();
    const picks = [];
    for (let top = 150; top < 2600; top += 13) {
      picks.push(firstRowPastTop(all, top)?.dataset.feedKey === all.find((row) => row.getBoundingClientRect().bottom > top)?.dataset.feedKey);
    }
    expect(picks).toContain(false);
  });
});
