import { expect, test } from "bun:test";
import { createFeedSession, type FeedEntry } from "../feed/parse";
import type { RuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import { appendRuntimeLiveTurnDelta, projectRuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";
import { mergeAssistantRows, projectAssistantHandoff, retainedAssistantItems } from "./assistantRows";
import { runtimeLiveTurnItems } from "@/lib/runtime/liveTurn";
import { liveTurnTail } from "./LiveTurnRows";

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
  const late = { ...event, key: "late", anchorKey: "row:4:0", item: { ...event.item, ts: "2026-10-02T10:00:02.001Z" } } as FeedEntry;
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
  const nextTurn = projectAssistantHandoff(state, { ...expandedReplay, turnId: "next-turn",
    items: [{ ...expandedReplay.items[0], startedAt: "2026-10-02T10:01:00Z" }] }, [], claims, "running");
  expect(nextTurn.pending).toHaveLength(1);
});

test("a consumed stream stays retired when the producer carries it into the next turn", () => {
  const first = appendRuntimeLiveTurnDelta(null, "first-turn", "The answer", "2026-10-02T10:00:00Z");
  let state = projectAssistantHandoff(null, first, [], claims);
  state = projectAssistantHandoff(state, first, [echo], new Set(["answer"]));
  expect(state.pending).toEqual([]);
  const second = appendRuntimeLiveTurnDelta(first, "second-turn", "New reply", "2026-10-02T10:01:00Z");
  state = projectAssistantHandoff(state, second, [], new Set(["answer"]), "unknown");
  expect(state.pending.map(entry => entry.live.text)).toEqual(["New reply"]);
});

test("a legacy stream without timestamps remembers its complete canonical echo", () => {
  const legacy = { turnId: "legacy", text: "The ans" };
  let state = projectAssistantHandoff(null, legacy, [], claims);
  state = projectAssistantHandoff(state, null, [echo], new Set(["answer"]));
  expect(state.pending).toEqual([]);
  state = projectAssistantHandoff(state, { ...legacy, text: "The answer" }, [], new Set(["answer"]), "unknown");
  expect(state.pending).toEqual([]);
  state = projectAssistantHandoff(state, { turnId: "legacy-next", text: "The answer" }, [], claims, "running");
  expect(state.pending.map(entry => entry.live.text)).toEqual(["The answer"]);
});

test("timestamp-free legacy turns own distinct pending occurrences and their echoes", () => {
  let state = projectAssistantHandoff(null, { turnId: "legacy-first", text: "Done" }, [], claims);
  const first = state.pending[0].key;
  state = projectAssistantHandoff(state, { turnId: "legacy-second", text: "Done with details" }, [], claims);
  expect(state.pending.map(entry => entry.live.text)).toEqual(["Done", "Done with details"]);
  const second = state.pending[1].key;
  const laterEcho = { ...echo, item: { ...echo.item, text: "Done with details", sourceId: "legacy-second-answer" } } as FeedEntry;
  state = projectAssistantHandoff(state, null, [laterEcho], claims);
  expect(state.pending.map(entry => entry.key)).toEqual([first]);
  expect(state.bindings.get(laterEcho.key)?.key).toBe(second);
});

test("idless echoes own a single occurrence even when a later answer repeats the text", () => {
  const second = { ...echo, key: "second", item: { ...echo.item, ts: "2026-10-02T10:01:00Z", sourceId: "second-answer" } } as FeedEntry;
  const state = projectAssistantHandoff(null, live("awaiting-echo", null), [echo, later, second], claims);
  expect(state.bindings.size).toBe(1);
  expect(rows([echo, later, second], state).map(row => row.key)).toEqual(["assistant-pending:0", "later", "second"]);
});

test.each(["A cited answer", "VERDICT: APPROVE\n\nThe implementation passes."])("split canonical projections adopt one idless stream: %s", (body) => {
  const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[contract]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>";
  const text = `${body}\n\n${citation}`;
  const stream = appendRuntimeLiveTurnDelta(null, "split-turn", text, "2026-10-02T10:00:00Z");
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  const record = (id: string, timestamp: string) => JSON.stringify({ type: "response_item", timestamp,
    payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] } });
  const feed = session.feed([record("split-answer", "2026-10-02T10:00:01Z"), record("next-answer", "2026-10-02T10:01:01Z")], 0, false).items;
  let state = projectAssistantHandoff(null, stream, [], claims);
  const original = state.pending[0].key;
  state = projectAssistantHandoff(state, null, feed, new Set(["split-answer"]));
  expect(state.pending).toEqual([]);
  expect(state.bindings.size).toBe(2);
  const rendered = rows(feed, state);
  expect(rendered[0].key).toBe(original);
  expect(rendered.map(row => row.item.kind)).toEqual([body.startsWith("VERDICT") ? "review" : "prose", "mem-citation", body.startsWith("VERDICT") ? "review" : "prose", "mem-citation"]);
  expect(new Set(rendered.map(row => row.key)).size).toBe(4);
  state = projectAssistantHandoff(state, stream, [], new Set(["split-answer"]), "unknown");
  expect(state.pending).toEqual([]);
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

test("a clipped idless stream adopts its complete canonical answer after missed completion", () => {
  const text = "Opening context. " + "The response continues with readable prose. ".repeat(1800) + "Final answer.";
  const stream = appendRuntimeLiveTurnDelta(null, "clipped-turn", text, "2026-10-02T10:00:00Z")!;
  expect(stream.items![0].omittedChars).toBeGreaterThan(0);
  expect(text.endsWith(stream.items![0].text)).toBe(true);
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  const feed = session.feed([JSON.stringify({ type: "response_item", timestamp: "2026-10-02T10:00:01Z",
    payload: { type: "message", id: "clipped-answer", role: "assistant", content: [{ type: "output_text", text }] } })], 0, false).items;
  let state = projectAssistantHandoff(null, stream, [], claims);
  const original = state.pending[0].key;
  state = projectAssistantHandoff(state, null, feed, new Set(["clipped-answer"]), "unknown");
  expect(state.pending).toEqual([]);
  expect(rows(feed, state)).toHaveLength(1);
  expect(rows(feed, state)[0].key).toBe(original);
});

test("a clipped identified completion suppresses its event-first full-text mirror", () => {
  const text = "Opening context. " + "The response continues with readable prose. ".repeat(1800) + "Final answer.";
  const completed = projectRuntimeLiveTurnItem(null, "clipped-turn", { type: "agentMessage", id: "clipped-answer", text }, "completed", "2026-10-02T10:00:01Z")!;
  expect(completed.items![0].omittedChars).toBeGreaterThan(0);
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  const feed = session.feed([JSON.stringify({ type: "event_msg", timestamp: "2026-10-02T10:00:01Z",
    payload: { type: "agent_message", message: text } })], 0, false).items;
  const state = projectAssistantHandoff(null, completed, feed, claims);
  expect(state.pending).toHaveLength(1);
  expect(state.hiddenEchoes.size).toBe(1);
  expect(rows(feed, state)).toHaveLength(1);
});

test("idle turns fence stranded streaming drafts while completed replies await their own echo", () => {
  const streaming = live("streaming", null);
  const state = projectAssistantHandoff(null, streaming, [], claims, "running");
  expect(projectAssistantHandoff(state, null, [later], claims, "unknown").pending).toHaveLength(1);
  expect(projectAssistantHandoff(state, null, [later], claims, "idle").pending).toEqual([]);
  expect(projectAssistantHandoff(null, live("awaiting-echo"), [later], claims, "idle").pending).toHaveLength(1);
});

test("folded transport descriptors count retained replies once during prolonged transcript lag", () => {
  let live: RuntimeLiveTurn | null = null;
  let state = projectAssistantHandoff(null, null, [], claims);
  for (let index = 0; index < 550; index++) {
    live = projectRuntimeLiveTurnItem(live, "lagging-turn", { type: "agentMessage", id: `answer-${index}`, text: `Answer ${index}` }, "completed", new Date(1760000000000 + index).toISOString());
    state = projectAssistantHandoff(state, live, [], claims);
  }
  const descriptors = runtimeLiveTurnItems(live);
  const tail = liveTurnTail(retainedAssistantItems(state, live, descriptors.filter(item => item.tool || !item.text.trim())));
  expect(tail.rows).toHaveLength(8);
  expect(tail.earlier).toBe(542);
  live = projectRuntimeLiveTurnItem(live, "lagging-turn", { type: "assistant", uuid: "omitted-batch",
    message: { content: [], omittedToolCalls: 10 } }, "completed", new Date(1760000001000).toISOString());
  state = projectAssistantHandoff(state, live, [], claims);
  const mixed = retainedAssistantItems(state, live, runtimeLiveTurnItems(live).filter(item => item.tool || !item.text.trim()));
  expect(mixed.find(item => item.itemId === "omitted-tools:omitted-batch")?.omittedItems).toBe(10);
  live = projectRuntimeLiveTurnItem(live, "lagging-turn", { type: "assistant", message: { content: [], omittedToolCalls: 20 } }, "completed", new Date(1760000002000).toISOString());
  state = projectAssistantHandoff(state, live, [], claims);
  const unidentified = retainedAssistantItems(state, live, runtimeLiveTurnItems(live).filter(item => item.tool || !item.text.trim()));
  expect(unidentified.find(item => item.completedAt === new Date(1760000002000).toISOString())?.omittedItems).toBe(20);
});

test("a later clipped descriptor preserves the reply already observed by this pane", () => {
  const firstText = "Already read prefix: " + "a".repeat(30000);
  const first = projectRuntimeLiveTurnItem(null, "budget-turn", { type: "agentMessage", id: "first", text: firstText }, "completed", "2026-10-02T10:00:00Z")!;
  let state = projectAssistantHandoff(null, first, [], claims);
  const second = projectRuntimeLiveTurnItem(first, "budget-turn", { type: "agentMessage", id: "second", text: "b".repeat(40000) }, "completed", "2026-10-02T10:00:01Z")!;
  expect(second.items![0].text.length).toBeLessThan(firstText.length);
  state = projectAssistantHandoff(state, second, [], claims);
  expect(state.pending[0].live.text).toBe(firstText);
  expect(state.pending[0].live.omittedChars ?? 0).toBe(0);
  const rewritten = { ...second, items: [{ ...second.items![0], text: "Corrected answer", omittedChars: 0 }] };
  state = projectAssistantHandoff(state, rewritten, [], claims);
  expect(state.pending[0].live.text).toBe("Corrected answer");
});

test("a fresh runtime window keeps old cached replies separate from its own unseen omissions", () => {
  let old: RuntimeLiveTurn | null = null;
  let state = projectAssistantHandoff(null, null, [], claims);
  for (let index = 0; index < 10; index++) {
    old = projectRuntimeLiveTurnItem(old, "old-turn", { type: "agentMessage", id: `old-${index}`, text: `Old answer ${index}` }, "completed", new Date(1760000000000 + index).toISOString());
    state = projectAssistantHandoff(state, old, [], claims);
  }
  state = projectAssistantHandoff(state, null, [], claims);
  let fresh: RuntimeLiveTurn | null = null;
  for (let index = 0; index < 550; index++) fresh = projectRuntimeLiveTurnItem(fresh, "fresh-turn", { type: "agentMessage", id: `fresh-${index}`, text: `Fresh answer ${index}` }, "completed", new Date(1760000001000 + index).toISOString());
  state = projectAssistantHandoff(state, fresh, [], claims);
  const retained = retainedAssistantItems(state, fresh, runtimeLiveTurnItems(fresh).filter(item => item.tool || !item.text.trim()))
    .sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""));
  const tail = liveTurnTail(retained);
  expect(tail.rows).toHaveLength(8);
  expect(tail.earlier).toBe(552);
});
