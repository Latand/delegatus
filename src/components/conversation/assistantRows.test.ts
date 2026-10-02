import { expect, test } from "bun:test";
import type { FeedEntry } from "../feed/parse";
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
  const second = { ...echo, key: "second", item: { ...echo.item, text: "Second fragment" } } as FeedEntry;
  const state = projectAssistantHandoff(null, live("awaiting-echo"), [echo, second], claims);
  const rendered = rows([echo, second], state);
  expect(state.pending).toEqual([]);
  expect(new Set(rendered.map(row => row.key)).size).toBe(2);
  expect(rendered.map(row => "text" in row.item ? row.item.text : "")).toEqual(["The answer", "Second fragment"]);
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
