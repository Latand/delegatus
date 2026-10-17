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

/* The seat's conversation and a column are two panels. Neither passes a scroll
   that reaches its end on to `.kb-page`, which holds the seat and a full page
   of board and so always has somewhere to go. Only the vertical axis is
   contained: the shorthand also stops the sideways wheel and trackpad that move
   the board's columns, and the browser's back and forward swipe. The page
   scrolls from its own scrollbar and from the heads
   (docs/design/independent-panel-scroll.md). The browser half is the kanban
   driver's "independent panel scroll" case. */
test("the seat's conversation and a column keep their vertical scroll to themselves", () => {
  const SEAT_CONVERSATION = ".kb .seat [data-orchestrator-conversation] [data-log-feed-scroller]";
  for (const selector of [".kb .col-body", SEAT_CONVERSATION]) {
    expect({ selector, overscroll: declarationsFor(selector).get("overscroll-behavior-y") ?? null }).toEqual({ selector, overscroll: "contain" });
  }
  const sideways: string[] = [];
  root.walkDecls(/^overscroll-behavior(-x|-inline)?$/, (declaration) => {
    const rule = declaration.parent as postcss.Rule;
    if (rule.selectors.some((selector) => selector.includes(".col-body") || selector.includes("data-log-feed-scroller"))) sideways.push(`${rule.selector} { ${declaration.prop} }`);
  });
  expect(sideways).toEqual([]);
});

/* The lock traps the way back up once the page has scrolled to the tasks, so
   the page keeps one strip pinned to its top, outside both panels, for the
   wheel to land on. It takes no layout, it sits above the seat and the column
   heads, and the board gives up its 32 px so the strip covers no row at the
   page's end. The browser half is the same driver case. */
test("the strip that returns the page to the seat is pinned to the page and costs the board 32 px", () => {
  const strip = declarationsFor(".kb .kb-page > .seat-return");
  expect(strip.get("position")).toBe("sticky");
  expect(strip.get("top")).toBe("0");
  expect(strip.get("height")).toBe("0");
  expect(Number(strip.get("z-index"))).toBeGreaterThan(Number(declarationsFor(".kb .seat-grip").get("z-index")));
  expect(declarationsFor(".kb .kb-page > .seat-return > button").get("height")).toBe("32px");
  expect(declarationsFor(".kb .kb-page:has(> .seat-return) > .board-frame").get("height")).toBe("max(440px, 100% - 32px)");
  expect(declarationsFor(".kb .kb-page:has(> .seat-return) > .board-frame").get("height")).not.toBe(declarationsFor(".kb .board-frame").get("height"));
});
