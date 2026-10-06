import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { compactMenuPresenter } from "./compactMenus.prototype";
import type { MenuAction } from "./compactMenus.prototype.model";
import type { KanbanMenuItem } from "./kanbanMenus";

/* What the first render of a layout holds, read as markup: the states the
   browser driver cannot reach in the fixture. No card of the fixture holds the
   orchestrator's conversation, so the refused Hide is read here. */

const item = (id: string, label: string, extra: Partial<MenuAction> = {}): KanbanMenuItem => ({ type: "item", id, label, onSelect: () => {}, ...extra });
const render = (variant: 1 | 2 | 3, kind: string, items: KanbanMenuItem[]) => {
  const markup = renderToStaticMarkup(<>{compactMenuPresenter(variant)({ anchor: null as never, label: "menu", items, onClose: () => {}, kind })}</>);
  /* The states laid out unseen for measuring are dropped before the first paint. */
  return markup.slice(0, markup.indexOf('class="cm-probe"') === -1 ? undefined : markup.indexOf('class="cm-probe"'));
};

test("a Hide cell that is refused says why in words, in the recommended variant", () => {
  const why = "Holds the orchestrator's conversation, so it stays on the board";
  const shown = render(1, "card", [item("rename", "Rename"), item("hide", "Hide from board", { disabled: true, why })]);
  expect(shown).toContain('data-cm-note="hide"');
  expect(shown).toContain("Hide: Holds the orchestrator&#x27;s conversation, so it stays on the board</p>");
  /* A Hide that works adds no line. */
  expect(render(1, "card", [item("rename", "Rename"), item("hide", "Hide from board", { why: "Stops nothing." })])).not.toContain("data-cm-note");
});

test("Remove from the board is a full row with its explanation in the recommended conversation menu", () => {
  const shown = render(1, "reader", [item("full", "Full pane"), item("closeOnBoard", "Remove from the board", { why: "The agent keeps working." })]);
  expect(shown).toContain('<span class="lbl">Remove from the board<span class="why">The agent keeps working.</span></span>');
  expect(shown.match(/class="cm-quick"[^]*?<\/div>/)?.[0]).not.toContain("closeOnBoard");
});

test("a pipeline's page keeps what Close and Pause stop on their second lines", () => {
  const lane = (label: string, why: string): KanbanMenuItem => ({ type: "item", label, why, group: "lane:a", onSelect: () => {} });
  const items: KanbanMenuItem[] = [{ type: "head", label: "Pipeline actions", group: "lane:a", note: "Running" }, lane("Pause", "The pipeline does not move on."), lane("Close pipeline", "Stops its agents.")];
  for (const variant of [1, 2, 3] as const) {
    const markup = renderToStaticMarkup(<>{compactMenuPresenter(variant)({ anchor: null as never, label: "menu", items, onClose: () => {}, kind: "card" })}</>);
    expect(markup).toContain('Close pipeline<span class="why">Stops its agents.</span>');
    expect(markup).toContain('Pause<span class="why">The pipeline does not move on.</span>');
  }
});

test("a row that opens in place points down and only a row that opens a page points right", () => {
  const lane = (label: string): KanbanMenuItem => ({ type: "item", label, group: "lane:a", onSelect: () => {} });
  const items: KanbanMenuItem[] = [item("hold", "Set waiting reason"), item("collapse", "Collapse card"), { type: "head", label: "Pipeline actions", group: "lane:a", note: "Running" }, lane("Pause")];
  const shown = render(1, "card", items);
  const row = (section: string) => shown.match(new RegExp(`<button[^>]*data-cm-section="${section}"[^]*?</button>`))?.[0] ?? "";
  expect(row("more")).toContain('data-cm-opens="expand"');
  expect(row("more")).toContain("lucide-chevron-down");
  expect(row("more")).not.toContain("lucide-chevron-right");
  expect(row("lane:a")).toContain('data-cm-opens="drill"');
  expect(row("lane:a")).toContain("lucide-chevron-right");
  expect(row("lane:a")).not.toContain("lucide-chevron-down");
});
