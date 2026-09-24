import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";

import { activeFailureGroup, execFailure, execSuccess, settledGroup, toolEvent } from "../__fixtures__/readableTools";
import type { CmdGroupItem, ToolEvent } from "../parse";
import { CmdGroupCard } from "./CmdGroupCard";

/*
 * Mobile v2 (#1439, lane 4; README §2.6, §4.2): on the phone tool calls are
 * chrome. A clean run of ≥ 2 events folds to one 44 px line with counts and
 * the running tool stays its own last line; a run with a failure is one
 * sunken block of 36 px list items carrying the detail; both expand in place.
 * The desktop group is untouched.
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

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

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

const classOf = (el: Element | null) => el?.getAttribute("class") ?? "";

/** The live trailing run: two settled reads and a third call still running. */
function runningGroup(): CmdGroupItem {
  const calls: ToolEvent[] = [
    { ...execSuccess, id: "r-1", tool: "Read", family: "read", icon: "file" as const, summary: "src/components/cardStatus.ts", command: undefined },
    { ...execSuccess, id: "r-2", tool: "Read", family: "read", icon: "file" as const, summary: "src/components/CardStatusBadge.tsx", command: undefined, ts: "2026-07-10T10:00:01Z", endTs: "2026-07-10T10:00:01.300Z" },
    toolEvent({ id: "r-3", tool: "Edit", family: "edit", icon: "edit", summary: "src/components/cardStatus.ts", status: "run", statusLabel: "running", ts: "2026-07-10T10:00:02Z" }),
  ];
  return {
    kind: "cmd-group",
    ids: calls.map((c) => c.id),
    calls,
    t0: calls[0]!.ts,
    t1: calls[2]!.ts,
    byTool: { Read: 2, Edit: 1 },
    okCount: 2,
    errCount: 0,
    hasErr: false,
    active: true,
  };
}

test("phone: a clean run of two folds to one 44 px line with counts and a time range", () => {
  narrowViewport = true;
  const host = mount(<CmdGroupCard item={settledGroup()} />);
  const fold = host.querySelector("[data-mobile-run-fold]")!;
  expect(fold).toBeTruthy();
  expect(host.querySelectorAll("[data-mobile-run-fold]")).toHaveLength(1);
  expect(classOf(fold)).toContain("min-h-11");
  expect(classOf(fold)).toContain("w-full");
  expect(fold.textContent).toContain("ran 2 commands");
  /* HH:MM (README §5): the two calls share a minute, so one clock, no seconds. */
  expect(fold.textContent).toMatch(/10:00$/);
  expect(fold.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  /* Folded: no readable block, no per-call lines, no desktop details. */
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("ol")).toBeNull();
  expect(host.querySelector("[data-mobile-tool-line]")).toBeNull();
  expect(host.querySelector("details")).toBeNull();
});

test("phone: the fold expands in place to the readable blocks and folds back", () => {
  narrowViewport = true;
  const host = mount(<CmdGroupCard item={settledGroup()} />);
  const fold = host.querySelector("[data-mobile-run-fold]")!;
  click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("ol")).toBeTruthy();
  expect(host.textContent).toContain("git status --short");
  /* Expanded in place: the fold line is still the first thing, above the blocks. */
  expect(host.querySelector("[data-mobile-run]")!.firstElementChild).toBe(fold);
  click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("ol")).toBeNull();
});

test("phone: the running tool stays its own last line under the folded settled calls", () => {
  narrowViewport = true;
  const host = mount(<CmdGroupCard item={runningGroup()} />);
  const run = host.querySelector("[data-mobile-run]")!;
  expect(run.getAttribute("data-mobile-run")).toBe("running");
  /* The two settled reads fold into their shared meaning. */
  const fold = host.querySelector("[data-mobile-run-fold]")!;
  expect(fold.textContent).toContain("read 2 files");
  expect(fold.textContent).not.toContain("Edit");
  /* The running call is the last element, its own line, and says so. */
  const lines = host.querySelectorAll("[data-mobile-tool-line]");
  expect(lines).toHaveLength(1);
  expect(lines[0]!.getAttribute("data-mobile-tool-line")).toBe("running");
  expect(lines[0]!.textContent).toContain(en("mobile2.feed.running", { summary: "src/components/cardStatus.ts" }));
  const last = run.lastElementChild!;
  expect(last.contains(lines[0]!)).toBe(true);
  expect(fold.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  /* The live `active` flag does not force the phone open (README §4.2). */
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("ol")).toBeNull();
});

test("phone: a run ending in the pending question shows the settled calls only — the question card is that line", () => {
  narrowViewport = true;
  const item = runningGroup();
  item.calls[2] = toolEvent({ id: "r-q", tool: "AskUserQuestion", family: "other", icon: "note", summary: "Which format should the export endpoint default to?", status: "run", statusLabel: "running", ts: "2026-07-10T10:00:02Z" });
  item.byTool = { Read: 2, AskUserQuestion: 1 };
  const host = mount(<CmdGroupCard item={item} />);
  const fold = host.querySelector("[data-mobile-run-fold]")!;
  expect(fold.textContent).toContain("read 2 files");
  expect(host.querySelector("[data-mobile-tool-line]")).toBeNull();
  expect(host.textContent).not.toContain("AskUserQuestion");
  expect(host.textContent).not.toContain("Which format");
});

test("phone: a run with a failure is one sunken block of 36 px items, each one compact line", () => {
  narrowViewport = true;
  const host = mount(<CmdGroupCard item={activeFailureGroup()} />);
  const blocks = host.querySelectorAll('[data-mobile-run="failed"]');
  expect(blocks).toHaveLength(1);
  const block = blocks[0]!;
  expect(classOf(block)).toContain("bg-sunken");
  expect(classOf(block)).toContain("w-full");
  expect(host.querySelector("[data-mobile-run-fold]")).toBeNull();
  /* One 36 px list item per call. */
  const rows = block.querySelectorAll("[data-mobile-run-row]");
  expect(rows).toHaveLength(2);
  /* 36 px is the row's floor, never its ceiling: a fixed height is what let a
     wrapping label paint over the row under it (#1938). */
  for (const row of rows) expect(classOf(row)).toContain("min-h-9");
  for (const row of rows) expect(classOf(row)).not.toContain(" h-9");
  expect(rows[0]!.getAttribute("data-mobile-run-row")).toBe("done");
  expect(rows[1]!.getAttribute("data-mobile-run-row")).toBe("failed");
  /* The failure reads as a danger glyph and an exit code in the trailing meta;
     the command itself keeps the same quiet clipped label as every other row. */
  expect(classOf(rows[1])).not.toContain("text-danger");
  expect(classOf(rows[1]!.querySelector("span.flex-1"))).toContain("truncate");
  expect(rows[1]!.textContent).toContain("exit 3");
  expect(classOf(rows[1]!.querySelector("span.text-caption"))).toContain("text-danger");
  for (const row of rows) expect(row.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  /* Nothing the tool said is on the collapsed block — output belongs to the
     readable blocks the tap mounts. */
  expect(block.querySelector("[data-mobile-run-detail]")).toBeNull();
  expect(block.textContent).not.toContain("expected true to be false");
  expect(rows[0]!.nextElementSibling).toBe(rows[1]);
  /* The block itself is the target, and it expands in place. */
  const target = block.querySelector("button")!;
  expect(target.getAttribute("aria-label")).toBe(en("mobile2.feed.runFailed", { count: 2, failed: 1 }));
  expect(target.contains(rows[0]!)).toBe(true);
  expect(host.querySelector("ol")).toBeNull();
  click(target);
  expect(target.getAttribute("aria-expanded")).toBe("true");
  expect(block.querySelector("ol")).toBeTruthy();
  expect(host.textContent).toContain("git status --short");
});

test("phone: a long failure output stays off the collapsed block and arrives with the tap", () => {
  narrowViewport = true;
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const item = activeFailureGroup({ calls: [{ ...execSuccess, id: "b-1" }, toolEvent({ id: "b-2", status: "err", statusLabel: "exit 1", exitCode: 1, outputPreview: long })] });
  const host = mount(<CmdGroupCard item={item} />);
  expect(host.textContent).not.toContain("line 1");
  expect(host.textContent).toContain("exit 1");
  click(host.querySelector("button")!);
  expect(host.textContent).toContain("line 1");
});

test("desktop: the aggregate keeps its details/summary form and none of the phone markers", () => {
  narrowViewport = false;
  const host = mount(
    <>
      <CmdGroupCard item={settledGroup()} />
      <CmdGroupCard item={activeFailureGroup()} />
      <CmdGroupCard item={runningGroup()} />
    </>,
  );
  expect(host.querySelectorAll("details.group\\/grp")).toHaveLength(3);
  for (const details of host.querySelectorAll("details")) expect(classOf(details)).toContain("ml-9");
  expect(host.querySelector("[data-mobile-run]")).toBeNull();
  expect(host.querySelector("[data-mobile-run-fold]")).toBeNull();
  expect(host.querySelector("[data-mobile-run-row]")).toBeNull();
  expect(host.querySelector("[data-mobile-tool-line]")).toBeNull();
  /* A live aggregate is still forced open on the desktop (issue #475). */
  expect(host.querySelectorAll("ol")).toHaveLength(2);
});

test("phone: a failed run ending in the pending question lists the settled calls only; the desktop block keeps the question", () => {
  narrowViewport = true;
  const question = toolEvent({ id: "gf-q", tool: "AskUserQuestion", family: "other", icon: "note", summary: "Which format should the export endpoint default to?", status: "run", statusLabel: "running", ts: "2026-07-10T10:00:02Z" });
  const group = () => activeFailureGroup({ calls: [{ ...execSuccess, id: "gf-1" }, { ...execFailure, id: "gf-2" }, question], byTool: { Bash: 2, AskUserQuestion: 1 } });
  const host = mount(<CmdGroupCard item={group()} />);
  const block = host.querySelector('[data-mobile-run="failed"]')!;
  expect(block).toBeTruthy();
  /* One row per settled call, none for the question: the card under the
     block is that line. */
  const rows = block.querySelectorAll("[data-mobile-run-row]");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.getAttribute("data-mobile-run-row")).toBe("done");
  expect(rows[1]!.getAttribute("data-mobile-run-row")).toBe("failed");
  expect(block.querySelector('[data-mobile-run-row="running"]')).toBeNull();
  expect(host.textContent).not.toContain("Which format");
  expect(host.textContent).not.toContain("AskUserQuestion");
  expect(host.textContent).not.toContain(en("mobile2.feed.running", { summary: "Which format should the export endpoint default to?" }));
  /* The count is the settled calls. */
  const target = block.querySelector("button")!;
  expect(target.getAttribute("aria-label")).toBe(en("mobile2.feed.runFailed", { count: 2, failed: 1 }));
  /* Expanded, the readable blocks are the settled calls too. */
  click(target);
  expect(block.querySelectorAll("ol > li")).toHaveLength(2);
  expect(host.textContent).not.toContain("Which format");
  flushSync(() => root!.unmount());
  root = null;
  /* The desktop aggregate is untouched: every call, the question included. */
  narrowViewport = false;
  const desktop = mount(<CmdGroupCard item={group()} />);
  expect(desktop.querySelectorAll("ol > li")).toHaveLength(3);
  expect(desktop.textContent).toContain("Which format");
  expect(desktop.querySelector("summary")!.textContent).toContain("ran 2 commands");
});
