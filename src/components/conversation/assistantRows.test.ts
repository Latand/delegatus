import { expect, test } from "bun:test";
import { createFeedSession, type FeedEntry } from "../feed/parse";
import type { RuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import { mergeAssistantRows, projectAssistantHandoff } from "./assistantRows";

const later: FeedEntry = { key: "later", anchorKey: "row:1:0", item: {
  kind: "user", ts: "2026-10-02T10:00:05Z", text: "Next request",
} };
const echo: FeedEntry = { key: "echo", anchorKey: "row:2:0", item: {
  kind: "prose", ts: "2026-10-02T10:00:01Z", text: "The answer", engine: "claude", sourceId: "answer",
} };
const live = (phase: "streaming" | "awaiting-echo", itemId: string | null = "answer"): RuntimeLiveTurn => ({
  turnId: "turn", text: "The answer", items: [{ itemId, text: "The answer", phase,
    startedAt: "2026-10-02T10:00:00Z", completedAt: phase === "streaming" ? null : "2026-10-02T10:00:01Z" }],
});
const claims = new Set<string>();
const rows = (feed: FeedEntry[], state: ReturnType<typeof projectAssistantHandoff>) => mergeAssistantRows(
  feed.map(entry => ({ ...entry, kind: "item" })), state,
  ({ key, live }) => ({ key, anchorKey: key, kind: "item", item: { ...echo.item, text: live.text } as typeof echo.item }),
);

test("a parser reset for a filter keeps the answer binding on its own transcript row", () => {
  const lines = [
    { type: "user", timestamp: "2026-10-02T10:00:00Z", message: { content: "Please respond" } },
    { type: "assistant", timestamp: "2026-10-02T10:00:01Z", message: { id: "answer", content: [{ type: "text", text: "The answer" }] } },
    { type: "user", timestamp: "2026-10-02T10:00:05Z", message: { content: "Next answer request" } },
  ].map(value => JSON.stringify(value));
  const parse = (lineFilter: string) => createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter }).feed(lines, 0, false).items;
  const initial = parse("");
  const state = projectAssistantHandoff(null, live("awaiting-echo", null), initial, claims);
  expect(state.pending).toEqual([]);
  const filtered = parse("answer");
  const reconnected = projectAssistantHandoff(state, null, filtered, claims);
  const rendered = rows(filtered, reconnected);
  expect(rendered.map(row => "text" in row.item ? row.item.text : "")).toEqual(["The answer", "Next answer request"]);
  expect(rendered[0].key).toBe("assistant-pending:0");
  expect(rendered[1].key).not.toBe("assistant-pending:0");
});

test("stream, completion, missing reconnect snapshot and delayed echo keep one row in its slot", () => {
  let state = projectAssistantHandoff(null, live("streaming", null), [], claims);
  const key = state.pending[0].key;
  state = projectAssistantHandoff(state, live("awaiting-echo"), [later], claims);
  expect(rows([later], state).map(row => row.key)).toEqual([key, "later"]);
  state = projectAssistantHandoff(state, null, [later], claims);
  expect(rows([later], state).map(row => row.key)).toEqual([key, "later"]);
  state = projectAssistantHandoff(state, null, [later, echo], claims);
  expect(state.pending).toEqual([]);
  expect(rows([later, echo], state).map(row => row.key)).toEqual([key, "later"]);
  state = projectAssistantHandoff(state, live("awaiting-echo"), [later, echo], new Set(["answer"]));
  expect(rows([later, echo], state).map(row => row.key)).toEqual([key, "later"]);
  state = projectAssistantHandoff(state, live("awaiting-echo"), [later], new Set(["answer"]));
  expect(rows([later], state).map(row => row.key)).toEqual(["later"]);
});

test("unclaimed old replies go before newer rows; ids distinguish identical answers", () => {
  let state = projectAssistantHandoff(null, live("awaiting-echo"), [later], claims);
  state = projectAssistantHandoff(state, { ...live("awaiting-echo"), items: [{ ...live("awaiting-echo").items![0], itemId: "another" }] }, [later], claims);
  expect(state.pending).toHaveLength(2);
  state = projectAssistantHandoff(state, null, [later, echo], claims);
  expect(state.pending.map(entry => entry.live.itemId)).toEqual(["another"]);
  expect(rows([later, echo], state).at(-1)?.key).toBe("later");
});

test("structured multi-row echoes claim all projections once with unique keys", () => {
  const second = { ...echo, key: "second", anchorKey: "row:2:1", item: { ...echo.item, text: "Second fragment" } } as FeedEntry;
  const state = projectAssistantHandoff(null, live("awaiting-echo"), [echo, second], claims);
  const rendered = rows([echo, second], state);
  expect(state.pending).toEqual([]);
  expect(new Set(rendered.map(row => row.key)).size).toBe(2);
  expect(rendered.map(row => "text" in row.item ? row.item.text : "")).toEqual(["The answer", "Second fragment"]);
  const upgraded = [echo, second].map((entry, index) => ({ ...entry, anchorKey: `row:3:${index}`,
    item: { ...entry.item, ts: "2026-10-02T10:00:01.500Z" } }));
  const rebound = projectAssistantHandoff(state, null, upgraded, claims);
  expect(rows(upgraded, rebound).map(row => row.key)).toEqual(rendered.map(row => row.key));
});

test("Codex event-first suppression consumes one occurrence inside the mirror boundary", () => {
  const event = { ...echo, key: "event", item: { ...echo.item, engine: "codex", sourceId: undefined } } as FeedEntry;
  const repeated = { ...event, key: "second-event", anchorKey: "row:3:0" };
  const identified = { ...event, key: "other-source", item: { ...event.item, sourceId: "other-answer" } } as FeedEntry;
  const late = { ...event, key: "late", item: { ...event.item, ts: "2026-10-02T10:00:02.001Z" } } as FeedEntry;
  const feed = [event, repeated, identified, late];
  const state = projectAssistantHandoff(null, live("awaiting-echo"), feed, claims);
  expect([...state.hiddenEchoes]).toEqual(["event"]);
  expect(state.pending).toHaveLength(1);
  expect(rows(feed, state).map(row => row.key)).toEqual(["assistant-pending:0", "second-event", "other-source", "late"]);
  const claimed = projectAssistantHandoff(null, live("awaiting-echo"), feed, new Set(["answer"]));
  expect(claimed.pending).toEqual([]);
  expect(claimed.hiddenEchoes.size).toBe(0);
});

test("a missed completion after reconnect replaces an idless streaming prefix", () => {
  const streaming = live("streaming", null);
  streaming.items![0].text = "The ans";
  let state = projectAssistantHandoff(null, streaming, [], claims);
  const key = state.pending[0].key;
  state = projectAssistantHandoff(state, null, [echo], new Set(["answer"]));
  expect(state.pending).toEqual([]);
  expect(rows([echo], state).map(row => row.key)).toEqual([key]);
  state = projectAssistantHandoff(state, streaming, [later], new Set(["answer"]));
  expect(state.pending).toEqual([]);
  const expandedReplay = { ...streaming, items: [{ ...streaming.items![0], text: "The answer" }] };
  state = projectAssistantHandoff(state, expandedReplay, [later], new Set(["answer"]), "unknown");
  expect(state.pending).toEqual([]);
  const nextTurn = projectAssistantHandoff(state, { ...expandedReplay, turnId: "next-turn" }, [], claims, "running");
  expect(nextTurn.pending).toHaveLength(1);
});

test("idless echoes own a single occurrence even when a later answer repeats the text", () => {
  const second = { ...echo, key: "second", item: { ...echo.item, ts: "2026-10-02T10:01:00Z", sourceId: "second-answer" } } as FeedEntry;
  const state = projectAssistantHandoff(null, live("awaiting-echo", null), [echo, later, second], claims);
  expect(state.bindings.size).toBe(1);
  expect(rows([echo, later, second], state).map(row => row.key)).toEqual(["assistant-pending:0", "later", "second"]);
});

test("same-instant prose and tools preserve the host's source order", () => {
  const prose = live("awaiting-echo").items![0];
  const tool = { ...prose, itemId: "tool", text: "", tool: { name: "Bash", engine: "claude" as const, status: "ok" as const, args: { command: "pwd" } } };
  const toolRow = { kind: "delta", key: "tool", instant: Date.parse(prose.startedAt!), liveOrder: 1 };
  for (const first of [true, false]) {
    const state = projectAssistantHandoff(null, { turnId: "turn", text: prose.text, items: first ? [prose, tool] : [tool, prose] }, [], claims);
    const result = mergeAssistantRows([{ ...toolRow, liveOrder: first ? 1 : 0 }], state,
      ({ key }) => ({ kind: "item", key, instant: Date.parse(prose.startedAt!), liveOrder: first ? 0 : 1 }));
    expect(result.map(row => row.kind)).toEqual(first ? ["item", "delta"] : ["delta", "item"]);
  }
});

test("idle turns fence stranded streaming drafts while completed replies await their own echo", () => {
  const streaming = live("streaming", null);
  const state = projectAssistantHandoff(null, streaming, [], claims, "running");
  expect(projectAssistantHandoff(state, null, [later], claims, "unknown").pending).toHaveLength(1);
  expect(projectAssistantHandoff(state, null, [later], claims, "idle").pending).toEqual([]);
  expect(projectAssistantHandoff(null, live("awaiting-echo"), [later], claims, "idle").pending).toHaveLength(1);
});
