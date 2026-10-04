import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* The in-card conversation height in kanbanBoard.css must stay above the
   pre-role-frames min(620px, 74vh) at every window height. The declaration is
   read from the stylesheet and evaluated here, so a changed formula fails. */
const css = readFileSync(join(import.meta.dir, "kanbanBoard.css"), "utf8");

test("the in-card conversation height is at least the old height at every window height", () => {
  const declared = /--conv-in-card-h:\s*([^;]+);/.exec(css)?.[1]?.trim();
  expect(declared).toBe("calc(max(min(700px, 84dvh), 100dvh - 180px) - var(--reason-row-h, 0px))");
  /* The reason-filter row under the bar comes out of the height; it is 0 where the filters share the bar. */
  const rowHeight = Number(/\.kb:has\(> \.reason-filter-row\)\s*\{\s*--reason-row-h:\s*(\d+)px;/.exec(css)?.[1]);
  expect(rowHeight).toBe(35);
  const inCard = (h: number, row: number) => Math.max(Math.min(700, 0.84 * h), h - 180) - row;
  const before = (h: number) => Math.min(620, 0.74 * h);
  for (const row of [0, rowHeight]) for (let h = 480; h <= 2160; h += 10) expect(inCard(h, row)).toBeGreaterThan(before(h));
  for (const h of [720, 768, 800, 900, 950, 1080]) expect(inCard(h, 0) - before(h)).toBeGreaterThanOrEqual(60);
  for (const h of [720, 768, 800, 900, 950, 1080]) expect(inCard(h, rowHeight) - before(h)).toBeGreaterThanOrEqual(25);
});

test("the seat's default height is 75% of the window, its drag stop", () => {
  expect(/--seat-default-h:\s*([^;]+);/.exec(css)?.[1]?.trim()).toBe("75dvh");
});
