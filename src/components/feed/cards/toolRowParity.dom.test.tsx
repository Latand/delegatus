import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { FeedItem } from "../FeedItem";
import { buildFeed } from "../parse";
import {
  claudePhoneRowLines,
  codexPhoneRowLines,
  ENV_PREFIXED_COMMAND,
  WRAPPED_COMMAND,
} from "../__fixtures__/codexPhoneRows";

/*
 * #1938. A Codex tool row and a Claude tool row are the same row: one compact
 * line whose label is clipped, one trailing verdict, and nothing of what the
 * tool said until the row is expanded. happy-dom lays nothing out, so the
 * painted overlap this contract prevents is measured in a real browser
 * (`kanbanBoard.browser.test.tsx`, "codex tool rows on a phone"). What is
 * checked here is the contract that made the overlap possible: a label allowed
 * to wrap inside a row whose height is fixed.
 */

let narrowViewport = false;

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === normalize(MOBILE_LAYOUT_QUERY) ? narrowViewport : false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

const dom = new Window({ url: "http://localhost/" });
(dom as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  narrowViewport = false;
  dom.document.body.replaceChildren();
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

function click(el: Element): void {
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

const cls = (el: Element | null) => el?.getAttribute("class") ?? "";

function feed(engine: "codex" | "claude"): Element {
  const file = { path: `/workspace/demo-${engine}.jsonl`, engine, fmt: engine, cwd: "/workspace/demo" } as FileEntry;
  const lines = engine === "codex" ? codexPhoneRowLines() : claudePhoneRowLines();
  const items = buildFeed(file, lines, false, "").items;
  return mount(<>{items.map((item, index) => <FeedItem key={index} item={item} />)}</>);
}

/** The clipped label of a row: the flexible span between the glyph and the
    meta, or the span inside it that holds the text when the row keeps a trailing
    part unclipped (the group header's failure count). */
const labelOf = (row: Element): Element | null => {
  const flexible = row.querySelector("span.flex-1");
  return flexible?.querySelector(":scope > span.truncate") ?? flexible ?? null;
};
const labels = (host: Element) =>
  [...host.querySelectorAll("[data-tool-row]")].map(labelOf).filter(Boolean) as Element[];

for (const engine of ["codex", "claude"] as const) {
  for (const width of ["phone", "desktop"] as const) {
    test(`${engine} rows on the ${width}: every label is one clipped line in a row that can grow`, () => {
      narrowViewport = width === "phone";
      const host = feed(engine);
      const rows = [...host.querySelectorAll("[data-tool-row]")];
      expect(rows.length).toBeGreaterThan(5);
      for (const row of rows) {
        /* A fixed height plus a wrapping label is exactly what painted one
           command over the next one (#1938); neither half may come back. */
        expect(cls(row)).not.toMatch(/(?:^|\s)h-\d/);
      }
      const shown = labels(host);
      expect(shown.length).toBeGreaterThan(5);
      for (const label of shown) {
        expect(cls(label)).toContain("truncate");
        expect(cls(label)).not.toContain("whitespace-normal");
        expect(cls(label)).not.toContain("break-words");
        expect(cls(label)).not.toContain("font-semibold");
      }
    });

    test(`${engine} rows on the ${width}: a failure is a quiet accent and a single verdict`, () => {
      narrowViewport = width === "phone";
      const host = feed(engine);
      const failed = [...host.querySelectorAll('[data-tool-row="failed"]')];
      expect(failed.length).toBeGreaterThan(0);
      for (const row of failed) {
        /* The row never paints its own text in danger; the chip does that. The
           quiet tone comes from the row (the phone's run list) or from the
           label (the standalone line) — one of the two always carries it. */
        expect(cls(row)).not.toContain("text-danger");
        const label = labelOf(row)!;
        expect(cls(label)).not.toContain("text-danger");
        expect(`${cls(row)} ${cls(label)}`).toContain("text-secondary");
        expect(row.textContent).toContain("exit 2");
        // One trailing verdict, not an exit code beside a repeated status word.
        expect(row.textContent).not.toContain("exit 2 · error");
        expect((row.textContent ?? "").match(/exit 2/g)).toHaveLength(1);
      }
    });

    test(`${engine} rows on the ${width}: nothing the tool said is on a collapsed row`, () => {
      narrowViewport = width === "phone";
      const host = feed(engine);
      for (const row of host.querySelectorAll("[data-tool-row]")) {
        expect(row.textContent).not.toContain("expected the row box");
        expect(row.textContent).not.toContain("bun test v1.3.3");
      }
    });
  }
}

test("phone: the label leads with the real command, and the wrapper survives in the expanded block", () => {
  narrowViewport = true;
  const host = feed("codex");
  const text = [...host.querySelectorAll("[data-tool-row]")].map((row) => row.textContent ?? "").join("\n");
  /* The one-line label drops the proxy, the shell wrapper and the environment
     assignments, so the command itself gets the row's width. */
  expect(text).toContain("bun run scripts/collect-rows.ts --width 390");
  expect(text).not.toContain("sandboxctl proxy");
  expect(text).toContain("bun test src/components/feed/cards/toolRow.dom.test.tsx");
  expect(text).not.toContain("DEMO_CONFIG_HOME");
  /* Opening the row is what shows the command as it actually ran. */
  const line = [...host.querySelectorAll("details")]
    .find((details) => details.textContent?.includes("bun run scripts/collect-rows.ts"))!;
  click(line.querySelector("summary")!);
  expect(line.textContent).toContain(WRAPPED_COMMAND);
  const envLine = [...host.querySelectorAll("details")]
    .find((details) => details.textContent?.includes("toolRow.dom.test.tsx"))!;
  click(envLine.querySelector("summary")!);
  expect(envLine.textContent).toContain(ENV_PREFIXED_COMMAND.replace(/\s+/g, " "));
});

test("both engines read the same eight rows with the same labels", () => {
  narrowViewport = true;
  const read = (engine: "codex" | "claude") => {
    const host = feed(engine);
    const shown = labels(host).map((label) => (label.textContent ?? "").trim());
    if (root) flushSync(() => root!.unmount());
    root = null;
    dom.document.body.replaceChildren();
    return shown;
  };
  expect(read("codex")).toEqual(read("claude"));
});
