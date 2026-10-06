import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";

/* The board's scrollers are promoted to compositor scrolling in
   kanbanBoard.css. Without it Chromium scrolls them on the main thread at a
   device pixel ratio under 1.5, and on a populated board every scroll frame
   waited for a repaint of the page. The stylesheet is read here, so dropping
   the promotion from any of them fails. The browser half, that the scroll
   really is compositor-driven, is the kanban browser driver's case. */
const root = postcss.parse(readFileSync(join(import.meta.dir, "kanbanBoard.css"), "utf8"));

const BOARD_SCROLLERS = [".kb .kb-page", ".kb .col-body", ".kb .board.scroll", ".kb .board.reading"];

function declarationsFor(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule") return;
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => { found.set(declaration.prop, declaration.value); });
  });
  return found;
}

test("every board scroller scrolls on the compositor", () => {
  for (const selector of BOARD_SCROLLERS) {
    const declared = declarationsFor(selector);
    expect({ selector, scrolls: /auto|scroll/.test(declared.get("overflow-y") ?? declared.get("overflow-x") ?? declared.get("overflow") ?? "") }).toEqual({ selector, scrolls: true });
    expect({ selector, willChange: declared.get("will-change") ?? null }).toEqual({ selector, willChange: "scroll-position" });
  }
});

/* The board frame was `height: max(440px, 100cqh)` against a size container,
   and its style was re-resolved on every scroll frame of the page, which laid
   the whole board out again: about 11 ms per frame on a busy board, and the
   reason a conversation scrolled inside a card dropped frames. Nothing the
   page scrolls may be sized in container-query height units. */
test("the board frame is not sized against a size container", () => {
  const frame = declarationsFor(".kb .board-frame");
  expect(frame.get("height")).toBe("max(440px, 100%)");
  expect(declarationsFor(".kb .kb-page").get("container-type")).toBe("inline-size");
  const css = readFileSync(join(import.meta.dir, "kanbanBoard.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).not.toMatch(/\d(cqh|cqb)\b/);
  expect(css).not.toMatch(/container-type:\s*size\b/);
});

/* A card is a flex item of its column, and a card whose contents the browser
   skips has no content to keep it from shrinking, so it collapsed to its
   padding above the window and the cards under the pointer jumped by its
   height. Nothing but a width change may take a column's scroll anchoring
   away either. The browser half is the kanban driver's "holds still" case. */
test("a column's cards never shrink, and a column gives up scroll anchoring only for a width change", () => {
  expect(declarationsFor(".kb .card").get("content-visibility")).toBe("auto");
  expect(declarationsFor(".kb .col-body > .card").get("flex-shrink")).toBe("0");
  const unanchored: string[] = [];
  root.walkDecls("overflow-anchor", (declaration) => {
    if (declaration.value !== "none") return;
    const rule = declaration.parent as postcss.Rule;
    unanchored.push(...rule.selectors.filter((selector) => selector.includes(".col-body")));
  });
  expect(unanchored).toEqual([".kb[data-column-layout-active] .board:not(.tabs) .col-body"]);
});
