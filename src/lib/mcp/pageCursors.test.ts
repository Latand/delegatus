import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsMcpHttpCaller } from "./callerContext";
import type { McpToolService, McpToolName, McpToolResult } from "./server";
import { McpPageCursorStore, MCP_CURSOR_TTL_MS, mcpPageCursorStore, withMcpPageCursors } from "./pageCursors";

const payload = (result: McpToolResult) => result as unknown as Record<string, unknown>;

test("search page state round-trips through a short caller-bound handle", async () => {
  const upstream = Buffer.from(JSON.stringify({ query: "quartz", state: "s".repeat(550) })).toString("base64url");
  const observed: unknown[] = [];
  const service: McpToolService = { async callTool(toolName, args) {
    observed.push(args.cursor);
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false,
      items: [{ text: args.cursor ? "second" : "first" }], nextCursor: args.cursor ? null : upstream };
  } };
  const paged = withMcpPageCursors(service);
  const call = (args: Record<string, unknown>) => runAsMcpHttpCaller({ capability: "caller-a" }, () => paged.callTool("search_transcripts", args).then(payload));
  const first = await call({ query: "quartz" });
  expect(first.nextCursor).toBeString();
  expect(String(first.nextCursor).length).toBeLessThanOrEqual(24);
  expect(JSON.stringify(first)).not.toContain(upstream);
  const second = await call({ query: "quartz", cursor: first.nextCursor });
  expect(second.items).toEqual([{ text: "second" }]);
  expect(second.nextCursor).toBeNull();
  expect(observed).toEqual([undefined, upstream]);
});

test("unidentified HTTP adapters can page while handles remain isolated by connection", async () => {
  let serial = 0;
  const service = withMcpPageCursors({ async callTool(toolName, args) {
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false,
      items: [args.cursor ?? "first"], nextCursor: args.cursor ? null : "private-adapter-state" };
  } }, new McpPageCursorStore({ token: () => String(++serial).padStart(22, "0") }));
  const call = (caller: Parameters<typeof runAsMcpHttpCaller>[0], cursor?: unknown) =>
    runAsMcpHttpCaller(caller, () => service.callTool("search_transcripts", { query: "quartz", cursor }).then(payload));

  // Compatibility probes with no identity retain pagination within that adapter.
  const first = await call({});
  expect((await call({}, first.nextCursor)).items).toEqual(["private-adapter-state"]);
  // Real HTTP compatibility adapters carry the negotiated connection id.
  expect(await call({ paginationIdentity: "other-connection" }, first.nextCursor)).toMatchObject({ cursorReset: true, items: ["first"] });
});

test("the byte bound evicts oldest state and refuses oversized entries without discarding valid ones", () => {
  let id = 0;
  const store = new McpPageCursorStore({ maxBytes: 700, token: () => String(++id).padStart(22, "0") });
  const first = store.issue("scope", "a".repeat(200))!;
  const second = store.issue("scope", "b".repeat(200))!;
  expect(store.resolve(first, "scope")).toBeNull();
  expect(store.resolve(second, "scope")).toBe("b".repeat(200));
  expect(store.issue("scope", "c".repeat(701))).toBeNull();
  expect(store.resolve(second, "scope")).toBe("b".repeat(200));
});

test("a real serving-process restart resets handles", async () => {
  const modulePath = fileURLToPath(new URL("./pageCursors.ts", import.meta.url));
  const childCode = `import { withMcpPageCursors } from ${JSON.stringify(modulePath)};
    const service = withMcpPageCursors({ async callTool(toolName, args) { return { ok: true, toolName, clientRequestId: null, replayed: false, nextCursor: "saved-state" }; } });
    console.log(JSON.stringify(await service.callTool("search_transcripts", { query: "quartz", ...(process.env.CURSOR_TEST_HANDLE ? {cursor: process.env.CURSOR_TEST_HANDLE} : {}) })));`;
  const child = async (handle?: string) => {
    const processHandle = Bun.spawn([process.execPath, "-e", childCode], {
      env: { ...process.env, CURSOR_TEST_HANDLE: handle }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(), processHandle.exited]);
    expect(err).toBe(""); expect(exit).toBe(0);
    return JSON.parse(out);
  };
  const first = await child();
  expect(String(first.nextCursor).length).toBe(22);
  expect(await child(first.nextCursor)).toMatchObject({ ok: true, cursorReset: true });
});

test("two independently compiled bundles resolve through the same global owner", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cursor-bundles-"));
  try {
    const modules: Array<typeof import("./pageCursors")> = [];
    for (const variant of ["one", "two"]) {
      const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./pageCursors.ts", import.meta.url))],
        outdir: path.join(directory, variant), target: "bun", format: "esm" });
      expect(build.success).toBe(true);
      modules.push(await import(build.outputs[0]!.path));
    }
    expect(modules[0]!.mcpPageCursorStore()).toBe(mcpPageCursorStore());
    const issued = modules[0]!.mcpPageCursorStore().issue("bundle-scope", "bundle-state")!;
    expect(modules[1]!.mcpPageCursorStore().resolve(issued, "bundle-scope")).toBe("bundle-state");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a caller change while awaiting a page cannot issue a handle", async () => {
  const caller = { capability: "before" };
  const service = withMcpPageCursors({ async callTool(toolName) {
    await Promise.resolve(); caller.capability = "after";
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false, nextCursor: "private-state" };
  } });
  expect(await runAsMcpHttpCaller(caller, () => service.callTool("search_transcripts", { query: "quartz" }))).toMatchObject({ cursorReset: true });
});

test("the common service shortens cursor state on fresh calls and receipt replays", async () => {
  const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import("./server");
  const upstream = Buffer.from(JSON.stringify({ scope: "quartz", offset: 12 })).toString("base64url");
  const binding = async () => ({ nextCursor: upstream, hasMore: true });
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, binding])) as unknown as Parameters<typeof createMcpToolService>[0];
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const call = () => runAsMcpHttpCaller({ capability: "service-caller" }, () => service.callTool("search_transcripts", { query: "quartz", clientRequestId: "same-page" }).then(payload));
  const first = await call(), replay = await call();
  expect(String(first.nextCursor).length).toBeLessThanOrEqual(24);
  expect(replay).toMatchObject({ replayed: true, nextCursor: first.nextCursor });
});

test("another caller cannot mint a handle from a foreign receipt with the same request key", async () => {
  const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import("./server");
  const { currentMcpHttpCaller } = await import("./callerContext");
  let calls = 0;
  const binding = async () => { calls++; return { nextCursor: `state-${currentMcpHttpCaller()?.capability}` }; };
  const service = createMcpToolService(Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, binding])) as unknown as Parameters<typeof createMcpToolService>[0], new MemoryMcpReceiptStore());
  const call = (capability: string) => runAsMcpHttpCaller({ capability }, () => service.callTool("search_transcripts", { query: "quartz", clientRequestId: "shared-request" }).then(payload));
  const first = await call("one"), second = await call("two");
  expect(calls).toBe(1);
  expect(second).toMatchObject({ ok: false, cursorReset: true });
  expect(second.nextCursor).toBeUndefined();
  expect(String(first.nextCursor).length).toBe(22);
});

test("non-pagination cursor fields retain their original contract", async () => {
  const service = withMcpPageCursors({ async callTool(toolName, args) {
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false, cursor: args.cursor };
  } });
  expect(await service.callTool("pipeline_action", { cursor: "stage-position" })).toMatchObject({ ok: true, cursor: "stage-position" });
});

test("upstream cursor state that looks like a commit hash round-trips byte for byte", async () => {
  const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import("./server");
  const upstream = "a".repeat(64);
  let received: unknown;
  const binding = async (args: Record<string, unknown>) => {
    received = args.cursor;
    return { nextCursor: args.cursor ? null : upstream };
  };
  const service = createMcpToolService(Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, binding])) as unknown as Parameters<typeof createMcpToolService>[0], new MemoryMcpReceiptStore());
  const call = (args: Record<string, unknown>) => runAsMcpHttpCaller({ capability: "hash-caller" }, () => service.callTool("search_transcripts", args).then(payload));
  const first = await call({ query: "quartz" });
  await call({ query: "quartz", cursor: first.nextCursor });
  expect(received).toBe(upstream);
});

test("the declared cursor families cover every public cursor input", async () => {
  const { TOOL_INPUT_SCHEMAS } = await import("./server");
  const { MCP_PAGE_CURSOR_TOOLS } = await import("./pageCursors");
  const discovered = Object.entries(TOOL_INPUT_SCHEMAS).filter(([, schema]) => "cursor" in schema.shape).map(([name]) => name);
  expect([...MCP_PAGE_CURSOR_TOOLS].sort()).toEqual([...discovered, "relay_service_tools"].sort());
});

const families = [
  ["list_conversations", "nextCursor"], ["search_transcripts", "nextCursor"],
  ["conversation_messages", "cursor"], ["list_flows", "nextCursor"],
  ["list_pipelines", "nextCursor"], ["list_tasks", "nextCursor"],
  ["deployment_status", "nextCursor"], ["deployment_status", "cursor"],
  ["agent_fleet", "nextCursor"], ["agent_activity", "nextCursor"],
  ["dismiss_attention", "nextCursor"], ["curate_rules", "cursor"],
  ["telegram_bot_messages", "nextCursor"], ["relay_owner_history", "nextCursor"],
] as const;

for (const [tool, field] of families) test(`${tool}/${field}: round-trip, caller/tool/filter refusal, expiry and FIFO eviction`, async () => {
  let now = 1000, serial = 0, calls = 0;
  const store = new McpPageCursorStore({ now: () => now, maxEntries: 2,
    token: () => String(++serial).padStart(22, "0") });
  const service = withMcpPageCursors({ async callTool(toolName, args) {
    calls++;
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false,
      rows: [args.cursor ?? "first"], [field]: args.cursor ? null : `private-state-${args.query}`, hasMore: !args.cursor };
  } }, store);
  const call = (args: Record<string, unknown>, caller = "caller-a", name: string = tool) =>
    runAsMcpHttpCaller({ capability: caller }, () => service.callTool(name, args).then(payload));
  const first = await call({ query: "one" });
  const cursor = first[field];
  expect(String(cursor).length).toBeLessThanOrEqual(24);
  const resumed = await call({ query: "one", cursor, clientRequestId: "fresh-key" });
  expect(resumed.rows).toEqual(["private-state-one"]);
  const before = calls;
  for (const refused of [
    await call({ query: "one", cursor }, "caller-b"),
    await call({ query: "changed", cursor }),
    await call({ query: "one", cursor }, "caller-a", tool === "list_tasks" ? "list_flows" : "list_tasks"),
    await call({ query: "one", cursor: "private-state-one" }),
  ]) {
    expect(refused).toMatchObject({ ok: true, cursorReset: true });
    expect(JSON.stringify(refused)).not.toContain("private-state-one");
    expect(refused.rows).toEqual(["first"]);
  }
  expect(calls).toBe(before + 4);
  now += MCP_CURSOR_TTL_MS;
  expect(await call({ query: "one", cursor })).toMatchObject({ ok: true, cursorReset: true, rows: ["first"] });
  const held = await call({ query: "two" });
  await call({ query: "three" });
  // Reading/replaying the first entry does not move it to the end of FIFO.
  await call({ query: "two", cursor: held[field] });
  const newest = await call({ query: "four" });
  expect(await call({ query: "two", cursor: held[field] })).toMatchObject({ ok: true, cursorReset: true, rows: ["first"] });
  expect((await call({ query: "four", cursor: newest[field] })).rows).toEqual(["private-state-four"]);
});

test("owner history retains its cursor-only continuation contract", async () => {
  let latest: Record<string, unknown> = {};
  const service = withMcpPageCursors({ async callTool(toolName, args) {
    latest = args;
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false, nextCursor: args.cursor ? null : "history-state" };
  } });
  const call = (args: Record<string, unknown>) => runAsMcpHttpCaller({ capability: "history-caller" }, () => service.callTool("relay_owner_history", args).then(payload));
  const page = await call({ action: "messages", chat: "fixture-chat", from: "2026-10-10", to: "2026-10-12" });
  expect(await call({ action: "messages", cursor: page.nextCursor })).toMatchObject({ ok: true, nextCursor: null });
  expect(latest).toMatchObject({ chat: "fixture-chat", from: "2026-10-10", to: "2026-10-12", cursor: "history-state" });
  expect(await call({ action: "messages", chat: "other-chat", cursor: page.nextCursor })).toMatchObject({ cursorReset: true });
});

test("nested relay tool cursors bind caller and subtool, retain empty continuation arguments, expire and evict", async () => {
  let now = 0, serial = 0, calls = 0;
  const service = withMcpPageCursors({ async callTool(toolName, args) {
    calls++;
    const requested = args.calls as Array<{ tool: string; arguments: Record<string, unknown>; cursor?: string }>;
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false,
      results: requested.map(call => ({ tool: call.tool, ...(call.cursor ? { page_of: call.cursor } : { arguments: call.arguments }),
        next_cursor: call.cursor ? null : `relay-state-${call.tool}`, output: call.cursor ?? "first" })) };
  } }, new McpPageCursorStore({ now: () => now, maxEntries: 2, token: () => String(++serial).padStart(22, "0") }));
  const call = (tool: string, argumentsValue: Record<string, unknown>, cursor?: unknown, caller = "relay-caller") => runAsMcpHttpCaller({ capability: caller }, () => service.callTool("relay_service_tools", {
    op: "call", calls: [{ tool, arguments: argumentsValue, ...(cursor ? { cursor } : {}) }],
  }).then(payload));
  const first = await call("read", { query: "one" });
  const handle = (first.results as Array<Record<string, unknown>>)[0]!.next_cursor;
  expect(String(handle).length).toBeLessThanOrEqual(24);
  const second = await call("read", {}, handle);
  expect(second.results).toEqual([{ tool: "read", page_of: handle, next_cursor: null, output: "relay-state-read" }]);
  const before = calls;
  for (const reply of [await call("read", {}, handle, "foreign"), await call("other", {}, handle), await call("read", { query: "changed" }, handle)]) {
    expect(reply).toMatchObject({ ok: true, cursorReset: true, results: [{ output: "first" }] });
    expect(JSON.stringify(reply)).not.toContain("relay-state-read");
  }
  expect(calls).toBe(before + 3);
  now = MCP_CURSOR_TTL_MS;
  expect(await call("read", {}, handle)).toMatchObject({ cursorReset: true });
  const held = await call("one", {});
  await call("two", {}); await call("three", {});
  expect(await call("one", {}, (held.results as Array<Record<string, unknown>>)[0]!.next_cursor)).toMatchObject({ cursorReset: true });
});

test("relay pages correlate full original arguments before displayed ids are shortened", async () => {
  const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import("./server");
  const ids = ["a".repeat(64), "a".repeat(8) + "b".repeat(56)];
  const received: Array<Record<string, unknown>> = [];
  const binding = async (args: Record<string, unknown>) => {
    const calls = args.calls as Array<{ tool: string; arguments: Record<string, unknown>; cursor?: string }>;
    received.push(...calls.map(call => ({ ...call.arguments, cursor: call.cursor })));
    return { status: "completed", results: calls.map(call => ({ tool: call.tool, arguments: call.arguments,
      ...(call.cursor ? { page_of: call.cursor } : {}), next_cursor: call.cursor ? null : `state-${call.arguments.id}` })) };
  };
  const service = createMcpToolService(Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, binding])) as never, new MemoryMcpReceiptStore());
  const call = (calls: Array<{ tool: string; arguments: Record<string, unknown>; cursor?: string }>) =>
    runAsMcpHttpCaller({ capability: "relay-correspondence-caller" }, () => service.callTool("relay_service_tools", { op: "call", calls }).then(payload));

  const first = await call(ids.map(id => ({ tool: "read", arguments: { id } })));
  const rows = first.results as Array<Record<string, unknown>>;
  expect(rows.map(row => row.next_cursor)).toEqual([expect.any(String), expect.any(String)]);
  expect(rows[0]!.arguments).toMatchObject({ id: "aaaaaaaa" });
  expect(rows[1]!.arguments).toMatchObject({ id: "aaaaaaaa" });
  expect((rows[0]!.arguments as Record<string, unknown>).id).toBe((rows[1]!.arguments as Record<string, unknown>).id);
  const next = await call(rows.map((row, index) => ({ tool: "read", arguments: { id: ids[index]! }, cursor: row.next_cursor as string })));
  expect(next.results).toHaveLength(2);
  expect((next.results as Array<Record<string, unknown>>).map(row => row.page_of)).toEqual(rows.map(row => row.next_cursor));
  expect(received.slice(2).map(row => row.id)).toEqual(ids);
});
