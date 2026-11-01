import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { FeedItem } from "./FeedItem";
import { buildFeed, createFeedSession, type Item } from "./parse";

/* Issue #650: a Claude assistant record carries the MCP tool that produced the
   turn's context in `attributionMcpServer`/`attributionMcpTool`. That stamp
   sits on the whole record, so every sibling tool_use inherits it — a Bash
   command made after a viewer MCP call used to render as "MCP · viewer ·
   Updating pipeline". A card's identity comes from its own tool_use name, and
   from nothing else. */

const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "recent" } as FileEntry;

const attributed = (block: Record<string, unknown>, ts: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    attributionMcpServer: "viewer",
    attributionMcpTool: "pipeline_action",
    message: { content: [block] },
  });

const toolResult = (id: string, text: string, ts: string) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
  });

/* A conversation shaped like the production repro: a real viewer MCP call, then
   ordinary tool calls that follow it inside attributed records. */
const conversation = [
  JSON.stringify({ type: "user", timestamp: "2026-07-24T10:50:00Z", message: { content: "advance the pipeline" } }),
  attributed({
    type: "tool_use",
    id: "call-viewer",
    name: "mcp__viewer__pipeline_action",
    input: { pipelineId: "pipe-1", action: "update" },
  }, "2026-07-24T10:50:10Z"),
  toolResult("call-viewer", "{\"ok\":true}", "2026-07-24T10:50:11Z"),
  attributed({
    type: "tool_use",
    id: "call-bash",
    name: "Bash",
    input: { command: "bun test src/components/feed/parse.test.ts", description: "Run the feed parser tests", timeout: 600000 },
  }, "2026-07-24T10:51:44Z"),
  toolResult("call-bash", "12 pass", "2026-07-24T10:51:50Z"),
  attributed({
    type: "tool_use",
    id: "call-browse",
    name: "mcp__agent-browser__navigate",
    input: { url: "https://example.invalid/board" },
  }, "2026-07-24T10:52:20Z"),
  attributed({
    type: "tool_use",
    id: "call-read",
    name: "Read",
    input: { file_path: "src/components/feed/parse.ts" },
  }, "2026-07-24T10:52:52Z"),
];

function toolItems(items: Item[]) {
  const byId = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const item of items) {
    if (item.kind === "tool") byId.set(item.id, item);
    if (item.kind === "cmd-group") for (const call of item.calls) byId.set(call.id, call);
  }
  return byId;
}

test("a Bash call after a viewer MCP call keeps its own shell identity", () => {
  const calls = toolItems(buildFeed(claudeFile, conversation, false, "").items);

  const bash = calls.get("call-bash");
  expect(bash).toBeDefined();
  expect(bash!.tool).toBe("Bash");
  expect(bash!.family).toBe("shell");
  expect(bash!.summary).toBe("bun test src/components/feed/parse.test.ts");
  expect(bash!.mcp).toBeUndefined();

  const read = calls.get("call-read");
  expect(read!.tool).toBe("Read");
  expect(read!.mcp).toBeUndefined();

  // The genuine viewer call still gets its MCP identity, from its own name.
  const viewer = calls.get("call-viewer");
  expect(viewer!.mcp).toMatchObject({ serverName: "viewer", toolName: "pipeline_action" });
});

test("a non-viewer MCP call is never relabelled with the record's viewer attribution", () => {
  const calls = toolItems(buildFeed(claudeFile, conversation, false, "").items);

  const browse = calls.get("call-browse");
  expect(browse).toBeDefined();
  expect(browse!.tool).toBe("mcp__agent-browser__navigate");
  expect(browse!.mcp).toBeUndefined();
});

test("the incremental session classifies the same way as a one-shot parse", () => {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  let fed = 0;
  let snapshot: Item[] = [];
  while (fed < conversation.length) {
    fed += 2;
    snapshot = session.feed(conversation.slice(0, fed), 0, true).items.map((entry) => entry.item);
  }
  const calls = toolItems(snapshot);
  expect(calls.get("call-bash")!.mcp).toBeUndefined();
  expect(calls.get("call-browse")!.mcp).toBeUndefined();
  expect(calls.get("call-viewer")!.mcp).toMatchObject({ serverName: "viewer", toolName: "pipeline_action" });
});

test("the feed renders the Bash call as a shell card and the viewer call as an MCP card", () => {
  const calls = toolItems(buildFeed(claudeFile, conversation, false, "").items);

  const bashHtml = renderToStaticMarkup(<FeedItem item={calls.get("call-bash")!} />);
  expect(bashHtml).not.toContain("mcp-call-card");
  expect(bashHtml).not.toContain("Updating pipeline");
  expect(bashHtml).toContain("bun test src/components/feed/parse.test.ts");

  const browseHtml = renderToStaticMarkup(<FeedItem item={calls.get("call-browse")!} />);
  expect(browseHtml).not.toContain("mcp-call-card");
  expect(browseHtml).not.toContain("Updating pipeline");

  const viewerHtml = renderToStaticMarkup(<FeedItem item={calls.get("call-viewer")!} />);
  expect(viewerHtml).toContain("mcp-call-card");
  expect(viewerHtml).toContain("Updating pipeline");
});

/* Codex conversations write the same Viewer calls in their own shapes
   (docs/design/codex-mcp-call-rendering-brief.md). A call gets the identity a
   Claude tool_use gets; a code-mode batch keeps its group; a call that spawns
   or messages an agent stays its own row, the link one click away. */

const codexFile = { path: "/tmp/codex.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
let clock = Date.parse("2026-10-30T09:12:14Z");
const at = () => new Date(clock += 400).toISOString();
const response = (payload: object) => JSON.stringify({ timestamp: at(), type: "response_item", payload });
const event = (payload: object) => JSON.stringify({ timestamp: at(), type: "event_msg", payload });

type NestedCall = { id: string; tool: string; args?: Record<string, unknown>; result?: unknown; status?: string; isError?: boolean; error?: unknown };
const nestedCall = (call: NestedCall) => event({
  type: "item_completed",
  item: {
    type: "McpToolCall",
    id: call.id,
    server: "viewer",
    tool: call.tool,
    arguments: call.args ?? {},
    status: call.status ?? "completed",
    ...(call.error === undefined ? { result: { content: [{ type: "text", text: JSON.stringify(call.result ?? { ok: true }) }], ...(call.isError ? { isError: true } : {}) } } : { error: call.error }),
  },
});

/* One `exec` batch: the wrapper names each call, a typed item per call, then
   the script's own output. */
function codexBatch(callId: string, calls: NestedCall[], output = "Script completed") {
  const source = calls.map((call) => `text(await tools.mcp__viewer__${call.tool}(${JSON.stringify(call.args ?? {})}));`).join("\n");
  return [
    response({ type: "custom_tool_call", call_id: callId, name: "exec", input: source }),
    ...calls.map(nestedCall),
    response({ type: "custom_tool_call_output", call_id: callId, output }),
  ];
}

const flat = (items: Item[]) => items.flatMap((item) => item.kind === "cmd-group" ? item.calls : item.kind === "tool" ? [item] : []);

test("a code-mode Viewer call carries the Claude identity and its parsed result", () => {
  const items = buildFeed(codexFile, [
    ...codexBatch("batch-1", [{ id: "exec-list", tool: "list_tasks", args: { project: "repo-demo" }, result: { count: 2, total: 2 } }]),
  ], false, "").items;
  const [call] = flat(items);
  expect(call.id).toBe("exec-list");
  expect(call.mcp).toMatchObject({ serverName: "viewer", toolName: "list_tasks", args: { project: "repo-demo" }, result: { count: 2, total: 2 } });
  expect(call.status).toBe("ok");
});

test("a non-Viewer code-mode call stays a generic row", () => {
  const items = buildFeed(codexFile, [
    response({ type: "custom_tool_call", call_id: "batch-c", name: "exec", input: 'text(await tools.mcp__catalog__lookup({query:"x"}));' }),
    event({ type: "item_completed", item: { type: "McpToolCall", id: "exec-catalog", server: "catalog", tool: "lookup", arguments: { query: "x" }, status: "completed", result: { content: [{ type: "text", text: "{\"hits\":1}" }] } } }),
    response({ type: "custom_tool_call_output", call_id: "batch-c", output: "Script completed" }),
  ], false, "").items;
  expect(flat(items).map((call) => [call.id, call.mcp])).toEqual([["exec-catalog", undefined]]);
});

test("a completed call whose result says isError reads as a failure", () => {
  const items = buildFeed(codexFile, codexBatch("batch-e", [
    { id: "exec-lesson", tool: "leave_lesson", isError: true, result: { ok: false, error: "Input validation error", code: "tool_failed", retryable: true } },
  ]), false, "").items;
  const [call] = flat(items);
  expect(call.status).toBe("err");
  expect(call.mcp?.result).toMatchObject({ error: "Input validation error", retryable: true });
});

test("a failed call with an error message keeps the message", () => {
  const items = buildFeed(codexFile, codexBatch("batch-r", [
    { id: "exec-refused", tool: "update_task", status: "failed", error: { message: "approval refused" } },
  ]), false, "").items;
  const [call] = flat(items);
  expect(call.status).toBe("err");
  expect(call.mcp?.toolName).toBe("update_task");
  expect(call.outputPreview).toContain("approval refused");
});

test("a direct namespace call is one named row with its result", () => {
  const result = { ok: true, conversationId: "conversation_child_ready", operationId: "op-1" };
  const items = buildFeed(codexFile, [
    response({ type: "function_call", namespace: "mcp__viewer", name: "send_message", call_id: "call_direct", arguments: JSON.stringify({ conversationId: "conversation_child_ready", text: "status?" }) }),
    event({ type: "item_completed", item: { type: "McpToolCall", id: "call_direct", server: "viewer", tool: "send_message", arguments: { conversationId: "conversation_child_ready", text: "status?" }, status: "completed", result: { content: [{ type: "text", text: JSON.stringify(result) }] } } }),
    response({ type: "function_call_output", call_id: "call_direct", output: JSON.stringify(result) }),
  ], false, "").items;
  expect(items.filter((item) => item.kind === "cmd-group")).toHaveLength(0);
  const calls = flat(items);
  expect(calls).toHaveLength(1);
  expect(calls[0].tool).toBe("mcp__viewer__send_message");
  expect(calls[0].mcp).toMatchObject({ toolName: "send_message", result: { conversationId: "conversation_child_ready" } });
});

test("a namespace with a trailing separator and a flat name name the same call", () => {
  for (const shape of [{ namespace: "mcp__viewer__", name: "get_task" }, { name: "mcp__viewer__get_task" }]) {
    const items = buildFeed(codexFile, [
      response({ type: "function_call", ...shape, call_id: "call_flat", arguments: "{\"taskId\":\"task-1\"}" }),
      response({ type: "function_call_output", call_id: "call_flat", output: "{\"taskId\":\"task-1\",\"ok\":true}" }),
    ], false, "").items;
    const calls = flat(items);
    expect(calls).toHaveLength(1);
    expect(calls[0].mcp).toMatchObject({ toolName: "get_task", args: { taskId: "task-1" }, result: { taskId: "task-1" } });
  }
});

test("the July order keeps one spawn row with its identity and result", () => {
  const result = { conversationId: "conversation_child_starting", launchId: "launch-1", state: "starting", ok: true };
  const invocation = { server: "viewer", tool: "spawn_agent", arguments: { prompt: "Audit the parser" } };
  const lines = [
    response({ type: "function_call", namespace: "mcp__viewer", name: "spawn_agent", call_id: "call_spawn", arguments: JSON.stringify(invocation.arguments) }),
    event({ type: "mcp_tool_call_end", call_id: "call_spawn", invocation, result: { Ok: { content: [{ type: "text", text: JSON.stringify(result) }] } } }),
    response({ type: "function_call_output", call_id: "call_spawn", output: JSON.stringify(result) }),
  ];
  const calls = flat(buildFeed(codexFile, lines, false, "").items);
  expect(calls).toHaveLength(1);
  expect(calls[0].family).not.toBe("spawn");
  expect(calls[0].status).not.toBe("run");
  expect(calls[0].mcp).toMatchObject({ toolName: "spawn_agent", result: { conversationId: "conversation_child_starting" } });

  // A begin record after the call adds no second row for the same id.
  const withBegin = [lines[0], event({ type: "mcp_tool_call_begin", call_id: "call_spawn", invocation }), ...lines.slice(1)];
  const again = flat(buildFeed(codexFile, withBegin, false, "").items);
  expect(again.map((call) => call.id)).toEqual(["call_spawn"]);
  expect(again[0].status).not.toBe("run");
});

test("a batch folds its Viewer reads and stands its agent calls alone", () => {
  const items = buildFeed(codexFile, codexBatch("batch-mix", [
    { id: "exec-a", tool: "list_tasks" },
    { id: "exec-b", tool: "get_pipeline" },
    { id: "exec-c", tool: "get_task" },
    { id: "exec-spawn", tool: "spawn_agent", result: { conversationId: "conversation_child_ready" } },
    { id: "exec-send", tool: "send_message", result: { conversationId: "conversation_child_ready" } },
    { id: "exec-seat", tool: "send_message_to_orchestrator", result: { conversationId: "conversation_seat" } },
    { id: "exec-review", tool: "publish_prototype_review" },
  ]), false, "").items;
  const groups = items.filter((item) => item.kind === "cmd-group");
  expect(groups).toHaveLength(1);
  expect(groups[0].kind === "cmd-group" && groups[0].calls.map((call) => call.id)).toEqual(["exec-a", "exec-b", "exec-c"]);
  const standalone = items.filter((item) => item.kind === "tool").map((item) => item.kind === "tool" && item.id);
  expect(standalone).toEqual(["exec-spawn", "exec-send", "exec-seat", "exec-review"]);
});

test("consecutive Claude Viewer calls and Codex direct calls stand alone", () => {
  const claude = [
    JSON.stringify({ type: "assistant", timestamp: at(), message: { content: [{ type: "tool_use", id: "c1", name: "mcp__viewer__list_tasks", input: {} }] } }),
    toolResult("c1", "{\"count\":0}", at()),
    JSON.stringify({ type: "assistant", timestamp: at(), message: { content: [{ type: "tool_use", id: "c2", name: "mcp__viewer__get_task", input: {} }] } }),
    toolResult("c2", "{\"ok\":true}", at()),
  ];
  const claudeItems = buildFeed(claudeFile, claude, false, "").items;
  expect(claudeItems.some((item) => item.kind === "cmd-group")).toBe(false);
  expect(claudeItems.filter((item) => item.kind === "tool")).toHaveLength(2);

  const direct = ["call_1", "call_2"].flatMap((id) => [
    response({ type: "function_call", namespace: "mcp__viewer", name: "list_tasks", call_id: id, arguments: "{}" }),
    response({ type: "function_call_output", call_id: id, output: "{\"count\":0}" }),
  ]);
  const directItems = buildFeed(codexFile, direct, false, "").items;
  expect(directItems.some((item) => item.kind === "cmd-group")).toBe(false);
  expect(directItems.filter((item) => item.kind === "tool")).toHaveLength(2);
});

test("the screenshot's three batches keep three groups of named calls", () => {
  const read = (id: string, tool = "list_tasks"): NestedCall => ({ id, tool, result: { count: 1 } });
  const lines = [
    ...codexBatch("b7", [read("exec-71"), read("exec-72", "get_pipeline"), read("exec-73"), read("exec-74", "get_task"),
      { id: "exec-75", tool: "leave_lesson", isError: true, result: { ok: false, error: "Input validation error" } }, read("exec-76"), read("exec-77", "update_task")]),
    JSON.stringify({ timestamp: at(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checked the board." }] } }),
    ...codexBatch("b4", [read("exec-41"), read("exec-42"), read("exec-43"), read("exec-44")]),
    JSON.stringify({ timestamp: at(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Updated two tasks." }] } }),
    ...codexBatch("b2", [read("exec-21"), read("exec-22")]),
  ];
  const groups = buildFeed(codexFile, lines, false, "").items.flatMap((item) => item.kind === "cmd-group" ? [item] : []);
  expect(groups.map((group) => [group.calls.length, group.errCount])).toEqual([[7, 1], [4, 0], [2, 0]]);
  expect(groups.every((group) => group.calls.every((call) => call.mcp?.serverName === "viewer"))).toBe(true);
});

test("a Codex Viewer call's identity keeps the feed's argument and result redaction", () => {
  const key = ["api", "key"].join("_");
  const sentinel = "invented-sensitive-value";
  const items = buildFeed(codexFile, codexBatch("batch-s", [
    { id: "exec-secret", tool: "update_task", args: { taskId: "task-1", [key]: sentinel }, result: { taskId: "task-1", [key]: sentinel } },
  ]), false, "").items;
  const [call] = flat(items);
  expect(call.mcp?.toolName).toBe("update_task");
  expect(JSON.stringify(call)).not.toContain(sentinel);
});

/* A script that stopped part way: one call returned, the next never did. The
   batch reads as its two named calls, the one it stopped on carrying the
   script's error, and the wrapper's raw source is not shown again. */
function partialBatch(callId: string, named: NestedCall[], returned: number, output: string) {
  const source = named.map((call) => `text(await tools.mcp__viewer__${call.tool}(${JSON.stringify(call.args ?? {})}));`).join("\n");
  return [
    response({ type: "custom_tool_call", call_id: callId, name: "exec", input: source }),
    ...named.slice(0, returned).map(nestedCall),
    response({ type: "custom_tool_call_output", call_id: callId, output }),
  ];
}

const stopped = () => partialBatch("batch-p", [
  { id: "exec-p-list", tool: "list_pipelines", args: { project: "repo-demo" }, result: { count: 2 } },
  { id: "exec-p-flow", tool: "get_flow", args: { flowId: "flow_review" } },
  { id: "exec-p-flow-2", tool: "get_flow", args: { flowId: "flow_build" } },
], 1, "Script failed\nError: flow_review: request timed out");

test("a script that stopped part way names its unfinished calls and drops its wrapper row", () => {
  const items = buildFeed(codexFile, stopped(), false, "").items;
  const groups = items.filter((item): item is Extract<Item, { kind: "cmd-group" }> => item.kind === "cmd-group");
  expect(groups).toHaveLength(1);
  const calls = groups[0].calls;
  expect(calls.map((call) => call.mcp?.toolName)).toEqual(["list_pipelines", "get_flow", "get_flow"]);
  expect(calls.some((call) => call.id === "batch-p")).toBe(false);
  expect(calls.map((call) => call.status)).toEqual(["ok", "err", "err"]);
  // Each unfinished call keeps the arguments its source named, in order.
  expect(calls.slice(1).map((call) => call.mcp?.args)).toEqual([{ flowId: "flow_review" }, { flowId: "flow_build" }]);
  // No result is invented for a call that never returned.
  expect(calls.slice(1).map((call) => call.mcp?.result)).toEqual([null, null]);
  // Nor a duration: the call never ended.
  expect(calls.slice(1).map((call) => [call.endTs, call.durationMs])).toEqual([[undefined, undefined], [undefined, undefined]]);
  // The script's error sits on the call it stopped on, once.
  expect(calls[1].outputPreview).toBe("Error: flow_review: request timed out");
  expect(calls[2].outputPreview).toBe("The script stopped before this call");
  expect(groups[0].errCount).toBe(2);
  const html = renderToStaticMarkup(<FeedItem item={groups[0]} />);
  expect(html).not.toContain("viewer · list_pipelines");
});

test("the incremental Codex session reads a stopped script the same way as a one-shot parse", () => {
  const lines = stopped();
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  let snapshot: Item[] = [];
  for (let fed = 1; fed <= lines.length; fed += 1) snapshot = session.feed(lines.slice(0, fed), 0, true).items.map((entry) => entry.item);
  const shape = (items: Item[]) => flat(items).map((call) => [call.id, call.status, call.mcp?.toolName, call.outputPreview]);
  expect(shape(snapshot)).toEqual(shape(buildFeed(codexFile, lines, false, "").items));
  expect(flat(snapshot).some((call) => call.id === "batch-p")).toBe(false);
});

test("a stopped script with an operation other than a Viewer call keeps its wrapper row", () => {
  const lines = [
    response({ type: "custom_tool_call", call_id: "batch-m", name: "exec",
      input: 'text(await tools.mcp__viewer__list_tasks({}));\ntext(await tools.exec_command({cmd: "git status"}));' }),
    nestedCall({ id: "exec-m-list", tool: "list_tasks", result: { count: 1 } }),
    response({ type: "custom_tool_call_output", call_id: "batch-m", output: "Script failed\nError: spawn refused" }),
  ];
  const calls = flat(buildFeed(codexFile, lines, false, "").items);
  expect(calls.map((call) => call.id)).toEqual(["batch-m", "exec-m-list"]);
});

test("a script that completed without reaching every call adds no failed rows", () => {
  const lines = partialBatch("batch-c", [
    { id: "exec-c-list", tool: "list_tasks", result: { count: 1 } },
    { id: "exec-c-task", tool: "get_task", args: { taskId: "task-1" } },
  ], 1, "Script completed");
  const calls = flat(buildFeed(codexFile, lines, false, "").items);
  expect(calls.every((call) => call.status !== "err")).toBe(true);
  expect(calls.some((call) => call.id.includes("unfinished"))).toBe(false);
});
