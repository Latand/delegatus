import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BoardMenu } from "./compactMenu";
import type { MenuAction } from "./compactMenuModel";
import type { KanbanMenuItem } from "./kanbanMenus";

/* What the first render of a compact menu holds, read as markup: the states
   the browser driver cannot reach in the fixture. No card of the fixture holds
   the orchestrator's conversation, so the refused Hide is read here. */

const item = (id: string, label: string, extra: Partial<MenuAction> = {}): KanbanMenuItem => ({ type: "item", id, label, onSelect: () => {}, ...extra });
const render = (kind: string, items: KanbanMenuItem[]) => {
  const markup = renderToStaticMarkup(<BoardMenu anchor={null as never} label="menu" items={items} onClose={() => {}} kind={kind} />);
  /* The states laid out unseen for measuring are dropped before the first paint. */
  return markup.slice(0, markup.indexOf('class="cm-probe"') === -1 ? undefined : markup.indexOf('class="cm-probe"'));
};

test("the Hide cell says what hiding leaves running, and a refused one says why, in words under the cells", () => {
  const working = render("card", [item("rename", "Rename"), item("hide", "Hide from board", { why: "2 agents keep working. History stays.", note: "2 agents keep working" })]);
  expect(working).toContain('<p class="cm-note" data-cm-note="hide">Hide: 2 agents keep working</p>');
  const why = "Holds the orchestrator's conversation, so it stays on the board";
  const refused = render("card", [item("rename", "Rename"), item("hide", "Hide from board", { disabled: true, why, note: "nothing stops" })]);
  expect(refused).toContain("Hide: Holds the orchestrator&#x27;s conversation, so it stays on the board</p>");
  expect(refused).not.toContain("nothing stops");
  /* A cell with nothing to add draws no line. */
  expect(render("reader", [item("full", "Full pane")])).not.toContain("data-cm-note");
});

test("what High and Low do is written under the priority row, and Normal adds nothing", () => {
  const radio = (id: string, label: string, why: string | null): KanbanMenuItem => ({ type: "radio", id, label, why, checked: id === "priority:normal", onSelect: () => {} });
  const shown = render("card", [radio("priority:high", "High", "Top of the Inbox"), radio("priority:normal", "Normal", null), radio("priority:low", "Low", "Bottom of the Inbox")]);
  expect(shown).toContain('data-cm-ends="priority"><span data-cm-end="priority:high">Top of the Inbox</span><span data-cm-end="priority:low">Bottom of the Inbox</span></p>');
  /* The columns carry no second line, so their row has none under it. */
  expect(render("card", [{ type: "radio", id: "status:inbox", label: "Inbox", status: "inbox", onSelect: () => {} }])).not.toContain("data-cm-ends");
});

test("a key the board answers to is drawn in its cell and named to a screen reader", () => {
  const shown = render("card", [item("rename", "Rename", { kbd: "Enter" }), item("describe", "Add a description", { kbd: "E" }), item("links", "Attach PR or issue…")]);
  const cell = (id: string) => shown.match(new RegExp(`<button[^>]*data-cm-item="${id}"[^]*?</button>`))?.[0] ?? "";
  expect(cell("rename")).toContain('aria-keyshortcuts="Enter"');
  expect(cell("rename")).toContain('<span class="cm-key" aria-hidden="true">↵</span>');
  expect(cell("describe")).toContain('<span class="cm-key" aria-hidden="true">E</span>');
  expect(cell("links")).not.toContain("cm-key");
});

test("Remove from the board is a full row with its explanation in a conversation's menu", () => {
  const shown = render("reader", [item("full", "Full pane"), item("closeOnBoard", "Remove from the board", { why: "The agent keeps working." })]);
  expect(shown).toContain('<span class="lbl">Remove from the board<span class="why">The agent keeps working.</span></span>');
  expect(shown.match(/class="cm-quick"[^]*?<\/div>/)?.[0]).not.toContain("closeOnBoard");
});

test("a pipeline's page keeps what Close and Pause stop on their second lines", () => {
  const lane = (label: string, why: string): KanbanMenuItem => ({ type: "item", label, why, group: "lane:a", onSelect: () => {} });
  const items: KanbanMenuItem[] = [{ type: "head", label: "Pipeline actions", group: "lane:a", note: "Running" }, lane("Pause", "The pipeline does not move on."), lane("Close pipeline", "Stops its agents.")];
  const markup = renderToStaticMarkup(<BoardMenu anchor={null as never} label="menu" items={items} onClose={() => {}} kind="card" />);
  expect(markup).toContain('Close pipeline<span class="why">Stops its agents.</span>');
  expect(markup).toContain('Pause<span class="why">The pipeline does not move on.</span>');
});

test("a closed row that opens in place points down, and only a row that opens a page points right", () => {
  const lane = (label: string): KanbanMenuItem => ({ type: "item", label, group: "lane:a", onSelect: () => {} });
  const items: KanbanMenuItem[] = [item("hold", "Set waiting reason"), item("collapse", "Collapse card"), { type: "head", label: "Pipeline actions", group: "lane:a", note: "Running" }, lane("Pause")];
  const shown = render("card", items);
  const row = (section: string) => shown.match(new RegExp(`<button[^>]*data-cm-section="${section}"[^]*?</button>`))?.[0] ?? "";
  expect(row("more")).toContain('data-cm-opens="expand"');
  expect(row("more")).toContain('aria-expanded="false"');
  expect(row("more")).toContain("lucide-chevron-down");
  expect(row("more")).not.toContain("lucide-chevron-up");
  expect(row("more")).not.toContain("lucide-chevron-right");
  expect(row("lane:a")).toContain('data-cm-opens="drill"');
  expect(row("lane:a")).toContain("lucide-chevron-right");
  expect(row("lane:a")).not.toContain("lucide-chevron-down");
});

test("a pipeline's and a stage's menu are the plain list they were", () => {
  for (const kind of ["pipeline", "stage"]) {
    const markup = renderToStaticMarkup(<BoardMenu anchor={null as never} label="menu" items={[item("pause", "Pause", { why: "The pipeline does not move on." })]} onClose={() => {}} kind={kind} />);
    expect(markup).toBe('<div class="menu" role="menu" aria-label="menu"><button type="button" role="menuitem"><span class="lbl">Pause<span class="why">The pipeline does not move on.</span></span></button></div>');
  }
});
