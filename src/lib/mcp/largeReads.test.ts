import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { afterEach, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { MCP_TOOL_NAMES, createMcpToolService, createProductionViewerMcpService, SqliteMcpReceiptStore, MemoryMcpReceiptStore, type McpToolBindings, type McpToolCallContext } from "./server";
import { handleMcpHttpRequest, setMcpHttpDependenciesForTests } from "./http";
import { currentMcpHttpCaller } from "./callerContext";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

const original = { ...process.env };
const listeners: Array<ReturnType<typeof Bun.serve>> = [];

test("the stdio entry's eager imports cannot load Viewer caches or local bindings", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const pending = [path.join(root, "src/lib/mcp/entry.ts")];
  const seen = new Set<string>();
  const forbidden = new Set(["src/lib/agent/registry.ts", "src/lib/scanner/scanCache.ts", "src/lib/mcp/bindings.ts", "src/lib/pipelines/store.ts"]);
  while (pending.length) {
    const filename = pending.pop()!;
    if (seen.has(filename)) continue;
    seen.add(filename);
    expect(forbidden).not.toContain(path.relative(root, filename));
    if (!/\.(?:ts|tsx|mjs)$/.test(filename)) continue;
    const scanner = new Bun.Transpiler({ loader: filename.endsWith(".tsx") ? "tsx" : "ts" });
    const source = fs.readFileSync(filename, "utf8").replace(/^#!.*\n/, "");
    for (const dependency of scanner.scanImports(source)) {
      if (dependency.kind !== "import-statement") continue;
      const candidate = dependency.path.startsWith("@/") ? path.join(root, "src", dependency.path.slice(2))
        : dependency.path.startsWith(".") ? path.resolve(path.dirname(filename), dependency.path) : null;
      if (!candidate) continue;
      const resolved = [candidate, `${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, "index.ts")]
        .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (resolved) pending.push(resolved);
    }
  }
});
afterEach(() => {
  setMcpHttpDependenciesForTests(null);
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const key of ["LLV_SPAWN_CAPABILITY", "LLV_VIEWER_CONTROL_URL", "LLV_VIEWER_CONTROL_TOKEN"]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

test("the production HTTP boundary owns read replay and checks capability revocation on every call", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-large-read-receipts-"));
  const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
  let calls = 0, admitted = true;
  const upstream = createMcpToolService({ resources: async () => {
    expect(currentMcpHttpCaller()?.capability).toBe("a".repeat(43));
    return { sequence: ++calls, payload: "fixture ".repeat(100_000) };
  } } as unknown as McpToolBindings, receipts);
  setMcpHttpDependenciesForTests({ service: async () => upstream, conversationForCapability: () => admitted ? "conversation_fixture" : null });
  fixture(async request => handleMcpHttpRequest(new NextRequest(request)));
  try {
    const service = await createProductionViewerMcpService(false, true);
    const args = { clientRequestId: "large-replay", full: true };
    const first = await service.callTool("resources", args);
    expect(first).toMatchObject({ ok: true, sequence: 1, replayed: false });
    expect(await service.callTool("resources", args)).toEqual({ ...first, replayed: true });
    expect(calls).toBe(1);
    admitted = false;
    expect(await service.callTool("resources", args)).toMatchObject({ ok: false, error: expect.stringContaining("403") });
  } finally { receipts.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("forwarded agent_fleet keeps the authenticated caller rather than accepting a claimed project", async () => {
  const upstream = createMcpToolService({ agent_fleet: async (args: Record<string, unknown>) => {
    expect(currentMcpHttpCaller()?.capability).toBe("a".repeat(43));
    if (args.project && args.project !== "project-one") throw new Error("project_out_of_scope");
    return { scope: { project: "project-one" }, agents: { live: 1 } };
  } } as unknown as McpToolBindings, new MemoryMcpReceiptStore());
  setMcpHttpDependenciesForTests({ service: async () => upstream, conversationForCapability: () => "conversation_worker" });
  fixture(async request => handleMcpHttpRequest(new NextRequest(request)));
  const service = await createProductionViewerMcpService(false, true);
  expect(await service.callTool("agent_fleet", {})).toMatchObject({ ok: true, scope: { project: "project-one" }, agents: { live: 1 } });
  expect(await service.callTool("agent_fleet", { project: "project-two" })).toMatchObject({ ok: false, error: expect.stringContaining("project_out_of_scope") });
});

test.each(["query", "digest"])("lifecycle_events %s replays the Viewer's durable receipt across stdio reconnects", async mode => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifecycle-receipts-"));
  const receiptPath = path.join(directory, "receipts.sqlite");
  let receipts = new SqliteMcpReceiptStore(receiptPath);
  let calls = 0;
  const bindings = { lifecycle_events: async (args: Record<string, unknown>) => {
    expect(currentMcpHttpCaller()?.capability).toBe("a".repeat(43));
    expect(args).toMatchObject({ mode, subscriberId: "fixture-subscriber", acknowledge: true });
    return { mode, cursor: ++calls, journaled: 1, ...(mode === "digest"
      ? { relay: { reason: "terminal", items: [], through: calls, omitted: 0 } }
      : { events: [{ seq: calls, type: "review_verdict" }], count: 1 }) };
  } } as unknown as McpToolBindings;
  let upstream = createMcpToolService(bindings, receipts);
  setMcpHttpDependenciesForTests({ service: async () => upstream, conversationForCapability: () => "conversation_fixture" });
  fixture(async request => handleMcpHttpRequest(new NextRequest(request)));
  try {
    const args = { clientRequestId: `lifecycle-${mode}`, mode, subscriberId: "fixture-subscriber", acknowledge: true };
    const first = await (await createProductionViewerMcpService(false, true)).callTool("lifecycle_events", args);
    expect(first).toMatchObject({ ok: true, mode, cursor: 1, replayed: false });
    // Reopen the durable store and reconnect the stdio facade: an acknowledged
    // digest must replay the original relay without advancing its cursor again.
    receipts.close();
    receipts = new SqliteMcpReceiptStore(receiptPath);
    upstream = createMcpToolService(bindings, receipts);
    const reconnected = await createProductionViewerMcpService(false, true);
    expect(await reconnected.callTool("lifecycle_events", args)).toEqual({ ...first, replayed: true });
    expect(calls).toBe(1);
    expect(await reconnected.callTool("lifecycle_events", { ...args, clientRequestId: `next-${mode}` }))
      .toMatchObject({ ok: true, cursor: 2, replayed: false });
    expect(calls).toBe(2);
  } finally { receipts.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

function fixture(handler: (request: Request) => Promise<Response>) {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  listeners.push(listener);
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${listener.port}`;
  process.env.LLV_SPAWN_CAPABILITY = "a".repeat(43);
  process.env.LLV_VIEWER_CONTROL_TOKEN = "fixture-control-key";
}

test("the stdio bridge bounds concurrent transport calls and frees admission after replies", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reached = 0;
  fixture(async request => {
    const body = await request.json() as { id: string; params: { name: string } };
    reached++;
    await held;
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: { ok: true, toolName: body.params.name } } });
  });
  const service = await createProductionViewerMcpService(false, true);
  const pending = Array.from({ length: 32 }, (_, n) => service.callTool("create_task", withTaskDue({ clientRequestId: `bounded-${n}` })));
  try {
    expect(await service.callTool("create_task", withTaskDue({ clientRequestId: "bounded-next" }))).toMatchObject({ ok: false, retryable: true });
  } finally { release(); }
  expect((await Promise.all(pending)).every(result => result.ok)).toBe(true);
  expect(reached).toBe(32);
  expect(await service.callTool("create_task", withTaskDue({ clientRequestId: "bounded-next" }))).toMatchObject({ ok: true });
  expect(reached).toBe(33);
});

test("every stdio tool runs in the Viewer and preserves its receipt and native work envelope", async () => {
  const calls: Array<Record<string, unknown>> = [];
  fixture(async request => {
    expect(new URL(request.url).pathname).toBe("/api/mcp");
    expect(request.headers.get("x-llv-spawn-capability")).toBe("a".repeat(43));
    expect(request.headers.get("authorization")).toBe("Bearer fixture-control-key");
    const body = await request.json() as { id: string; params: Record<string, unknown> };
    calls.push(body.params);
    const name = body.params.name;
    return Response.json({ jsonrpc: "2.0", id: body.id, result: {
      content: [], structuredContent: { ok: true, toolName: name, clientRequestId: "read-key", replayed: true, marker: "Viewer answer" },
    } });
  });
  const service = await createProductionViewerMcpService(false, true);
  const nativeWork = { threadId: "fixture-thread", turnId: "fixture-turn", turnTrigger: "realtime", callId: "fixture-call", itemId: "fixture-item" };
  for (const name of MCP_TOOL_NAMES) {
    expect(await service.callTool(name, { clientRequestId: "read-key", full: true }, { nativeWork }))
      .toEqual({ ok: true, toolName: name, clientRequestId: "read-key", replayed: true, marker: "Viewer answer" });
  }
  expect(calls).toHaveLength(MCP_TOOL_NAMES.length);
  for (const call of calls) expect(call).toMatchObject({ arguments: { clientRequestId: "read-key", full: true }, _meta: {
    threadId: "fixture-thread", callId: "fixture-call", itemId: "fixture-item",
    "x-codex-turn-metadata": { thread_id: "fixture-thread", turn_id: "fixture-turn", turn_trigger: "realtime" },
  } });
});

test("a refused or malformed remote read never falls back to a local domain read", async () => {
  let status = 403;
  fixture(async () => status === 403
    ? Response.json({ error: { message: "capability revoked" } }, { status })
    : Response.json({ jsonrpc: "2.0", result: null }));
  const service = await createProductionViewerMcpService(false, true);
  expect(await service.callTool("conversation_messages", { conversationId: "local-only" })).toMatchObject({ ok: false, error: expect.stringContaining("403") });
  status = 200;
  expect(await service.callTool("conversation_messages", { conversationId: "local-only" })).toMatchObject({ ok: false, error: expect.stringContaining("malformed") });
});

test("cancelling a delegated read releases the request and the next read works", async () => {
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  fixture(async request => {
    const body = await request.json() as { id: string };
    if (++calls === 1) { reached(); await held; }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: {
      ok: true, toolName: "resources", clientRequestId: null, replayed: false,
    }, content: [] } });
  });
  const service = await createProductionViewerMcpService(false, true);
  const controller = new AbortController();
  const context: McpToolCallContext = { signal: controller.signal, deadlineAt: Date.now() + 5_000 };
  const call = service.callTool("resources", {}, context);
  try {
    expect(await Promise.race([started.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true);
    controller.abort(new Error("fixture cancelled"));
    const result = await Promise.race([call, Bun.sleep(1_000).then(() => null)]);
    expect(result).toMatchObject({ ok: false });
    expect(await service.callTool("resources", {})).toMatchObject({ ok: true });
  } finally { release(); await call; }
});


test("a task mutation whose reply is lost replays once through the Viewer and rechecks policy before replay", async () => {
  let effects = 0, permitted = true, lose = true;
  const upstream = createMcpToolService({ create_task: async () => ({ taskId: `task-${++effects}`, revision: "one" }) } as unknown as McpToolBindings,
    new MemoryMcpReceiptStore(), { permit: () => permitted ? { allowed: true } : { allowed: false, code: "tool_not_permitted", error: "caller no longer admitted" } });
  setMcpHttpDependenciesForTests({ service: async () => upstream, conversationForCapability: () => "conversation_fixture" });
  fixture(async request => {
    const answer = await handleMcpHttpRequest(new NextRequest(request));
    if (lose) { lose = false; return new Response("cut", { status: 502 }); }
    return answer;
  });
  const service = await createProductionViewerMcpService(false, true);
  const args = { clientRequestId: "write-replay", project: "fixture", text: "A task", placement: "unplaced" };
  expect(await service.callTool("create_task", withTaskDue(args))).toMatchObject({ ok: false, code: "outcome_unknown", details: { nextAction: "original-key-lookup" } });
  expect(await service.callTool("create_task", withTaskDue(args))).toMatchObject({ ok: true, taskId: "task-1", replayed: true });
  expect(effects).toBe(1);
  expect(await service.callTool("create_task", withTaskDue({ ...args, text: "Changed payload" }))).toMatchObject({ ok: false });
  permitted = false;
  const denied = await service.callTool("create_task", withTaskDue(args));
  expect(denied).toMatchObject({ ok: false });
  expect(JSON.stringify(denied)).not.toContain("task-1");
  expect(effects).toBe(1);
});

test.skipIf(process.platform !== "linux")("native forwarding proves the kernel peer and the exact request body", async () => {
  const { nativePeerProof, verifyNativePeer } = await import("./nativePeer");
  const body = JSON.stringify({ method: "tools/call", params: { name: "create_task" } });
  const proof = await nativePeerProof(body);
  try {
    expect((await verifyNativePeer(proof.header, body)).pid).toBe(process.pid);
    await expect(verifyNativePeer(proof.header, body + " ")).rejects.toThrow("refused");
    const forged = JSON.parse(Buffer.from(proof.header, "base64url").toString());
    forged.nonce = "a".repeat(43);
    await expect(verifyNativePeer(Buffer.from(JSON.stringify(forged)).toString("base64url"), body)).rejects.toThrow("refused");
  } finally { proof.close(); }
  await expect(verifyNativePeer(proof.header, body)).rejects.toThrow();
});

test.skipIf(process.platform !== "linux")("native peer proof crosses the Viewer's separate temporary filesystem", async () => {
  const { nativePeerProof } = await import("./nativePeer");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-peer-mount-"));
  const hidden = path.join(directory, "parent-only");
  fs.writeFileSync(hidden, "fixture");
  const body = JSON.stringify({ method: "tools/call", params: { name: "list_tasks" } });
  const proof = await nativePeerProof(body);
  try {
    const child = ownFixtureChild(Bun.spawn({ cmd: ["unshare", "--user", "--map-root-user", "--mount",
      "sh", "-c", 'mount -t tmpfs tmpfs "$1" && exec "$2" "$3"', "fixture", directory, process.execPath, path.join(import.meta.dir, "writerConcurrencyChild.ts")],
      env: { ...process.env, LLV_NATIVE_PEER_VERIFY: proof.header, LLV_NATIVE_PEER_BODY: body, LLV_NATIVE_PEER_HIDDEN: hidden }, stdout: "pipe", stderr: "pipe" }));
    const errors = new Response(child.stderr).text();
    const answer = new Response(child.stdout).text();
    const code = await child.exited;
    if (code !== 0) throw new Error(await errors);
    expect(JSON.parse(await answer).pid).toBe(process.pid);
    expect(fs.existsSync(hidden)).toBe(true);
  } finally { proof.close(); await reapFixtureChildren(); fs.rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
