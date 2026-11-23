import { afterAll, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tick-instructions-mcp-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key); fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.DELEGATUS_CODEX_HOME = process.env.LLV_CODEX_HOME;
process.env.DELEGATUS_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "absent-runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent-control.sock");
process.env.LLV_STRUCTURED_HOSTS = "0";
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
const { defaultSeatTickSettings, readSeatTickSettings, writeSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
const { setLegacyDocumentWriteHookForTests } = await import("@/lib/state/legacyDocumentStore");
const { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { setMcpHttpDependenciesForTests } = await import("./http");
const { POST } = await import("@/app/api/mcp/route");
const project = "tick-instruction-fixture";
const seat = "conversation_fixture_seat";
const replacement = "conversation_fixture_successor";
const cap = "c".repeat(43);
let sequence = 0;
function designate(conversationId: string) {
  const clientRequestId = `tick-designation-${++sequence}`;
  beginOrchestratorSeatIntent({ project, mandate: "Review the board", clientRequestId, mode: "existing", conversationId });
  completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null });
  return orchestratorSeatFor(project).active!;
}
afterAll(() => { setMcpHttpDependenciesForTests(null); setLegacyDocumentWriteHookForTests(null); setSystemTime(); fs.rmSync(sandbox, { recursive: true, force: true }); });

test("reason inheritance, stale designation, schema and write receipts through the HTTP MCP server", async () => {
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const predecessor = designate("conversation_fixture_predecessor");
  const active = designate(seat);
  const actor = { kind: "manager" as const, project, conversationId: seat, seatEpoch: active.seatEpoch };
  const inherited = [{ text: "x".repeat(301), author: null, at: null },
    { text: "y".repeat(139), author: { ...actor, conversationId: predecessor.conversationId, seatEpoch: predecessor.seatEpoch }, at: "2026-11-04T12:00:00Z" },
    { text: "z".repeat(47), author: { ...actor, seatEpoch: null }, at: "2026-11-05T12:00:00Z" }];
  const seed = () => writeSeatTickSettings(project, { ...defaultSeatTickSettings(project), reason: inherited.map(line => line.text).join("\n"), instructionLines: inherited });
  seed();
  const dependencies = { ...productionDomainDependencies, callerProject: () => project,
    callerAttribution: () => ({ kind: "manager" as const, conversationId: seat, role: "orchestrator" }),
    authorizedSeats: () => [{ conversationId: orchestratorSeatFor(project).active!.conversationId, project }] as never };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  let calls = 0, writes = 0, requests = 0, failNext = false;
  setMcpHttpDependenciesForTests({ service: async () => ({ callTool: async (name, args, context) => { calls++; const before = JSON.stringify(readSeatTickSettings(project)); const answer = await service.callTool(name, args, context); if (JSON.stringify(readSeatTickSettings(project)) !== before) writes++; return answer; } }), conversationForCapability: value => value === cap ? seat : null });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    requests++;
    const message = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
    if (failNext && message?.method === "tools/call") return new Response("fixture transport unavailable", { status: 503 });
    return POST(new NextRequest(request));
  } });
  const client = new Client({ name: "tick-settings-fixture", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/api/mcp`), { requestInit: { headers: { "x-llv-spawn-capability": cap } } }));
    const call = (clientRequestId: string, args: Record<string, unknown>) => client.callTool({ name: "seat_tick_settings", arguments: { clientRequestId, project, ...args } }, undefined, { timeout: 2000 });
    const beforeFailure = calls;
    failNext = true;
    await expect(call("rewrite-transport", { reason: "r".repeat(360) })).rejects.toThrow();
    failNext = false;
    expect(calls).toBe(beforeFailure); expect(writes).toBe(0);
    expect(readSeatTickSettings(project).reason).toHaveLength(489);
    const result = await call("rewrite-transport", { reason: "r".repeat(360) });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ changed: true, replacedInherited: inherited });
    const written = readSeatTickSettings(project);
    expect(written.reason).toBe("r".repeat(360));
    expect(written.instructionsReviewedAt).toBe("2026-11-12T12:00:00.000Z");
    expect(writes).toBe(1);
    const payload = result.structuredContent;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("MCP reply is not a structured object");
    expect((await call("rewrite-transport", { reason: "r".repeat(360) })).structuredContent).toEqual({ ...payload, replayed: true });
    expect(writes).toBe(1);
    const operatorLine = { text: "Operator stop", author: { kind: "gateway" as const, project: null, conversationId: null, seatEpoch: null }, at: "2026-11-12T11:00:00Z" };
    writeSeatTickSettings(project, { ...written, reason: written.reason + "\n" + operatorLine.text, instructionLines: [...written.instructionLines!, operatorLine] });
    const protectedWrite = await call("keep-operator", { reason: "Reviewed" });
    expect(protectedWrite.isError, JSON.stringify(protectedWrite)).not.toBe(true);
    expect(readSeatTickSettings(project).instructionLines).toContainEqual(operatorLine);
    expect(readSeatTickSettings(project).reason).toBe("Reviewed\nOperator stop");
    const read = await call("read-reviewed", { verbose: true });
    expect(read.structuredContent).toMatchObject({ settings: { instructionsReviewedAt: written.instructionsReviewedAt } });
    const beforeInvalid = writes;
    expect((await call("bad-reason", { reason: 42 })).isError).toBe(true);
    expect((await call("over-limit", { reason: "r".repeat(501) })).isError).toBe(true);
    expect(writes).toBe(beforeInvalid);
    const serviceCalls = calls;
    const denied = await fetch(`http://127.0.0.1:${listener.port}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(denied.ok).toBe(false); expect(calls).toBe(serviceCalls);
    setLegacyDocumentWriteHookForTests(null); seed();
    // Rotate immediately before the settings mutation reads its committed row.
    setLegacyDocumentWriteHookForTests(collection => { if (collection === "seat_tick_settings") { setLegacyDocumentWriteHookForTests(null); designate(replacement); } });
    const rotated = await call("rotated-before-lock", { reason: "r".repeat(360) });
    expect(rotated.isError).toBe(true);
    expect(readSeatTickSettings(project).reason).toHaveLength(489);
    const former = await call("former-short", { reason: "old" });
    expect(former.isError, JSON.stringify(former)).not.toBe(true);
    expect(readSeatTickSettings(project).reason).toBe(inherited.map(line => line.text).join("\n") + "\nold");
    expect(readSeatTickSettings(project).instructionsReviewedAt).toBeUndefined();
    expect(requests).toBeGreaterThan(calls);
  } finally { await client.close(); listener.stop(true); setMcpHttpDependenciesForTests(null); setLegacyDocumentWriteHookForTests(null); }
}, 60_000);
