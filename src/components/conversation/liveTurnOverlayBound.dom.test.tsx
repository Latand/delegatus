import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import { createFeedSession, type FeedEntry } from "@/components/feed/parse";
import { normalizeRuntimeLiveTurn, runtimeLiveTurnItems, type RuntimeLiveTurn } from "@/lib/runtime/liveTurn";

import { LIVE_TURN_VISIBLE_ROWS, LiveTurnRows, liveTurnTail } from "./LiveTurnRows";
import { visibleRuntimeLiveTurnItems } from "./liveTurnHandoff";
import {
  LONG_TURN_CALLS,
  longTurnCalls,
  longTurnLiveItems,
  longTurnTranscriptLines,
  staleTranscriptLines,
} from "./liveTurnLongTurn.fixture";

/**
 * The live overlay is the in-flight TAIL of a turn, never a second copy of the
 * transcript.
 *
 * What this file holds is the diagnosis of the reported wall, kept as
 * executable evidence:
 *
 *   (b) claim identity is NOT the defect. A canonical Claude window carrying
 *       the same call ids claims every one of the sixty live rows — folded runs
 *       through `cmd-group.ids`, standalone MCP rows through `tool.id`.
 *   (a) the trigger is a canonical window that is not current: with a stale
 *       one, nothing claims anything, no live row is older than the newest
 *       transcript instant, and every unclaimed row is returned.
 *   (c) the amount is the overflow: `runtimeLiveTurnItems` hands the renderer
 *       the overflow buffer as well as the hot window.
 *
 * The fix is here rather than in either of those: whatever the canonical window
 * is doing, the pane paints a bounded tail and one counted line.
 */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
});

const roots = new Set<Root>();
beforeEach(() => setLocale("en"));
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

function feedOf(lines: string[]): FeedEntry[] {
  return createFeedSession({ engine: "claude", fmt: "claude", cwd: "/workspace/demo/viewer", showSvc: false, lineFilter: "" })
    .feed(lines, 0, true).items;
}

function liveTurn(count = LONG_TURN_CALLS): RuntimeLiveTurn {
  const turn = normalizeRuntimeLiveTurn({ turnId: "turn-long", text: "", items: longTurnLiveItems(count) });
  if (!turn) throw new Error("the fixture produced no live turn");
  return turn;
}

function mount(node: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => { root.render(node); });
  return host;
}

/** Row elements, read by index: spreading a happy-dom NodeList of this size
    exhausts the heap and kills the run without an assertion error. */
function rows(host: HTMLElement): HTMLElement[] {
  const found = host.querySelectorAll("[data-live-turn]");
  const out: HTMLElement[] = [];
  for (let index = 0; index < found.length; index += 1) out.push(found[index] as unknown as HTMLElement);
  return out;
}

const earlierLine = (host: HTMLElement) => host.querySelector("[data-live-turn-earlier]") as HTMLElement | null;

test("a canonical window carrying the same call ids leaves no live row for them", () => {
  const live = liveTurn();
  const canonical = feedOf(longTurnTranscriptLines());
  /* The window really does carry the calls — folded runs and MCP rows alike. */
  const kinds = new Set(canonical.map(({ item }) => item.kind));
  expect(kinds.has("tool")).toBe(true);
  expect(kinds.has("cmd-group")).toBe(true);

  const visible = visibleRuntimeLiveTurnItems(live, canonical, undefined, "running");
  expect(visible).toEqual([]);
  const host = mount(<LiveTurnRows items={visible} />);
  expect(rows(host)).toHaveLength(0);
  expect(earlierLine(host)).toBeNull();
  expect(host.querySelector("[data-live-turn-group]")).toBeNull();
});

test("a stale canonical window claims nothing, and sixty live rows still paint as a bounded tail and one counted line", () => {
  const live = liveTurn();
  const stale = feedOf(staleTranscriptLines());
  const visible = visibleRuntimeLiveTurnItems(live, stale, undefined, "running");
  /* (a) and (c): nothing is claimed, and the overflow buffer is in there too. */
  expect(visible.length).toBe(runtimeLiveTurnItems(live).length);
  expect(visible.length).toBeGreaterThan(LONG_TURN_CALLS);
  expect(live.overflow?.length).toBeGreaterThan(0);

  const host = mount(<LiveTurnRows items={visible} />);
  const painted = rows(host);
  expect(painted.length).toBeGreaterThan(0);
  expect(painted.length).toBeLessThanOrEqual(LIVE_TURN_VISIBLE_ROWS);

  const collapsed = earlierLine(host);
  expect(collapsed).not.toBeNull();
  expect(host.querySelectorAll("[data-live-turn-earlier]").length).toBe(1);
  const earlier = Number(collapsed!.getAttribute("data-live-turn-earlier"));
  /* Every step of the turn is accounted for: painted or counted. */
  expect(earlier + painted.length).toBe(visible.length);
  expect(collapsed!.textContent).toBe(translate("en", "feed.liveEarlierSteps", { count: earlier }));

  /* The rows kept are the NEWEST ones, and the still-running call is among
     them — the overlay exists to show what is in flight. */
  const newest = visible.slice(-LIVE_TURN_VISIBLE_ROWS).map((item) => item.itemId);
  for (const row of painted) expect(newest).toContain(row.dataset.liveTurnItemId!);
  expect(painted.at(-1)!.dataset.liveToolStatus).toBe("run");
});

test("no row reads as a bare «arguments omitted»: a shed call is counted, not listed", () => {
  const live = liveTurn();
  const visible = visibleRuntimeLiveTurnItems(live, feedOf(staleTranscriptLines()), undefined, "running");
  const shed = visible.filter((item) => item.tool?.argsOmitted).length;
  expect(shed).toBeGreaterThan(20);

  for (const lang of ["en", "uk"] as const) {
    setLocale(lang);
    const host = mount(<LiveTurnRows items={visible} />);
    const text = host.textContent ?? "";
    expect(text).not.toContain(translate(lang, "feed.liveToolArgsOmitted"));
    for (const row of rows(host)) expect(row.dataset.liveTool ? row.textContent : "").not.toContain(translate(lang, "feed.liveToolArgsOmitted"));
    expect(earlierLine(host)!.textContent).toBe(
      translate(lang, "feed.liveEarlierSteps", { count: Number(earlierLine(host)!.getAttribute("data-live-turn-earlier")) }),
    );
  }
});

test("a tail of shed calls paints nothing but the count", () => {
  const items = longTurnLiveItems().slice(0, 20).map((item) => item.tool
    ? { ...item, tool: { ...item.tool, args: {}, argsOmitted: true as const } }
    : item);
  const host = mount(<LiveTurnRows items={items} />);
  expect(rows(host)).toHaveLength(0);
  expect(Number(earlierLine(host)!.getAttribute("data-live-turn-earlier"))).toBe(
    items.filter((item) => item.tool || item.text.trim()).length,
  );
});

test("the tail never pulls an older row forward to fill a slot", () => {
  const items = longTurnLiveItems();
  const { rows: kept } = liveTurnTail(items);
  const windowStart = items.length - LIVE_TURN_VISIBLE_ROWS;
  for (const row of kept) expect(items.indexOf(row)).toBeGreaterThanOrEqual(windowStart);
});

test("an explicit omission descriptor is the count, not a row of its own", () => {
  const calls = longTurnCalls(3);
  const { rows: kept, earlier } = liveTurnTail([
    { itemId: null, text: "", phase: "awaiting-echo", startedAt: calls[0]!.at, completedAt: calls[0]!.at, omittedItems: 17, omittedChars: 4_200 },
    { itemId: "msg_demo_tail", text: "Still writing the answer", phase: "streaming", startedAt: calls[1]!.at, completedAt: null },
  ]);
  expect(kept.map((item) => item.itemId)).toEqual(["msg_demo_tail"]);
  expect(earlier).toBe(17);
});
