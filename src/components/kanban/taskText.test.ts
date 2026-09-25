import { describe, expect, test } from "bun:test";

import { clipTitle } from "./taskText";

describe("clipTitle", () => {
  test("keeps a title of up to 48 characters whole", () => {
    const title = "Restore search results after the index rebuild";
    expect(title.length).toBe(46);
    expect(clipTitle(title)).toBe(title);
    expect(clipTitle("x".repeat(48))).toBe("x".repeat(48));
  });

  test("cuts back to the last word when the limit lands inside one", () => {
    const title = "Повернути результати пошуку після перебудови індексу";
    expect(title.slice(0, 46).endsWith(" і")).toBe(true);
    expect(clipTitle(title)).toBe("Повернути результати пошуку після перебудови…");
  });

  test("keeps the whole last word when the limit lands on a space", () => {
    const title = `${"a".repeat(20)} ${"b".repeat(25)} tail words`;
    expect(title[46]).toBe(" ");
    expect(clipTitle(title)).toBe(`${"a".repeat(20)} ${"b".repeat(25)}…`);
  });

  test("still cuts one long word at the limit", () => {
    expect(clipTitle("y".repeat(60))).toBe(`${"y".repeat(46)}…`);
    expect(clipTitle(`ab ${"z".repeat(60)}`)).toBe(`ab ${"z".repeat(43)}…`);
  });
});
