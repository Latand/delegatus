import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { createFeedSession, type FeedEntry } from "@/components/feed/parse";
import type { CueRequest } from "@/lib/audio/cues";
import { installActEnv } from "@/test-helpers/actEnv";

/*
 * S1 against a feed that pauses (docs/design/sound-redesign.md §4.4): calls
 * appended while the feed was paused were heard as the distant murmur, so
 * the first parse after the pause re-baselines silently instead of ringing
 * them as a burst; later calls tick again.
 */

const dom = new HappyWindow();
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement });

const played: CueRequest[] = [];
const actualApp = await import("@/lib/audio/app");
mock.module("@/lib/audio/app", () => ({ ...actualApp, playCue: (request: CueRequest) => { played.push(request); return "played"; } }));
afterAll(() => {
  mock.module("@/lib/audio/app", () => actualApp);
});

const { useToolActivityCues } = await import("./useToolActivityCues");

const userLine = JSON.stringify({ type: "user", timestamp: "2026-07-10T09:59:00Z", message: { content: "run the checks" } });
const toolUse = (id: string) =>
  JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }] } });
const toolResult = (id: string) =>
  JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "ok" }] }] } });

function Probe({ items, windowEnd, paused }: { items: readonly FeedEntry[]; windowEnd: number; paused: boolean }) {
  useToolActivityCues(items, "conv-1", "/transcripts/conv-1.jsonl", windowEnd, true, paused);
  return null;
}

beforeEach(() => {
  played.length = 0;
});

test("calls appended while the feed was paused are absorbed; the next one ticks", () => {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
  let lines = [userLine];
  const paint = (paused: boolean) => flushSync(() => root.render(<Probe items={session.feed(lines, 0, true).items} windowEnd={lines.length} paused={paused} />));

  paint(false);
  lines = [...lines, toolUse("a"), toolResult("a")];
  paint(false);
  expect(played.map((r) => r.eventId)).toEqual(["tool:conv-1:a"]);

  /* Scrolled off screen: the feed stops; resumed, it reads what happened meanwhile. */
  paint(true);
  lines = [...lines, toolUse("b"), toolResult("b"), toolUse("c"), toolResult("c")];
  paint(false);
  expect(played.map((r) => r.eventId)).toEqual(["tool:conv-1:a"]);

  lines = [...lines, toolUse("d"), toolResult("d")];
  paint(false);
  expect(played.map((r) => r.eventId)).toEqual(["tool:conv-1:a", "tool:conv-1:d"]);
  flushSync(() => root.unmount());
});

test("a resume whose first render still holds the paused window waits for the next parse", () => {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
  let lines = [userLine];
  let items = session.feed(lines, 0, true).items;
  const paint = (paused: boolean) => flushSync(() => root.render(<Probe items={items} windowEnd={lines.length} paused={paused} />));

  paint(false);
  paint(true);
  /* Resumed, same window: nothing parsed yet. */
  paint(false);
  lines = [...lines, toolUse("b"), toolResult("b")];
  items = session.feed(lines, 0, true).items;
  paint(false);
  expect(played).toEqual([]);
  lines = [...lines, toolUse("c"), toolResult("c")];
  items = session.feed(lines, 0, true).items;
  paint(false);
  expect(played.map((r) => r.eventId)).toEqual(["tool:conv-1:c"]);
  flushSync(() => root.unmount());
});
