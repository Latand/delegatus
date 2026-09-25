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
