import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";

/* The lifted card is drawn fully opaque. A group opacity under 1 lets the card
   beneath show through, and its text collides with the lifted card's own rows;
   the shadow and the tilt are the lift cue. */
const root = postcss.parse(readFileSync(join(import.meta.dir, "kanbanBoard.css"), "utf8"));

test("the desktop drag ghost sets no opacity", () => {
  let checked = 0;
  root.walkRules((rule) => {
    if (!rule.selectors.includes(".kb .card.ghost")) return;
    checked += 1;
    rule.walkDecls("opacity", () => { throw new Error(`${rule.selector} sets opacity`); });
  });
  expect(checked).toBeGreaterThan(0);
});
