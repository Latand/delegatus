import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createInterface } from "node:readline";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";
import { POST as sendPOST } from "@/app/api/conversation-host/route";
import { setConversationHostDependenciesForTests } from "@/app/api/conversation-host/dependencies";
import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";
import { viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy, productionViewerControlDependencies } from "./bindings";
import { setMcpHttpDependenciesForTests } from "./http";
import { ControlEvidenceStore, AsyncControlEvidenceStore, CONTROL_REQUEST_HEADER, CONTROL_RECOVERY_PATH, OUTCOME_LIMIT, controlRequestId, controlEvidenceStore } from "./controlEvidence";
import { Database } from "bun:sqlite";
import { installControlIngress, installServingControlIngress } from "./controlIngress";
import { controlFetch } from "./controlTransport";

const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "control-http-"));
const transcript = path.join(root, "recipient.jsonl");
fs.writeFileSync(transcript, "{}\n");
const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
registry.reconcileConversations([{ engine: "codex", path: transcript, accountId: "fixture-account", launchProfile: emptyLaunchProfile({ cwd: root }),
  turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: "2026-11-12T00:00:00.000Z" }]);
const recipient = Object.values(registry.snapshot().conversations)[0]!;
const seat = "conversation_http_sender";
const domain = {
  registrySnapshot: () => registry.readOnlySnapshot(), sendSettlementPorts: () => ({ registry, client: null }),
  attentionAuthority: () => ({ kind: "root", conversationId: seat }),
  callerAttribution: () => ({ kind: "manager", conversationId: seat, role: "orchestrator" }),
  recoveryPredecessors: () => [], callerProject: () => "fixture-project",
  authorizedSeats: () => [{ conversationId: seat, path: null, project: "fixture-project" }], viewerProjects: () => ["fixture-project"],
};
const tags = internalServiceHeaders("mcp");
let effects = 0;
setConversationHostDependenciesForTests({
  collectImagePayloads: () => ({ images: [], error: null }),
  completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
  enqueueStructuredMessage: async request => {
    effects++;
    const operationId = `operation_${effects}`;
    registry.holdDelivery(recipient.id, request.text, request.clientMessageId!, "text", [], null, { operationId, kind: "send", policy: "queue" });
    return { ok: true, structured: true, target: recipient.id, outcome: "queued", operationId, receipt: { operationId, status: "queued" } } as never;
  },
});
afterAll(() => { setConversationHostDependenciesForTests(null); registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
const listen = async (server: http.Server) => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
const stop = async (server: http.Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
const payload = (answer: Awaited<ReturnType<Client["callTool"]>>) => {
  const text = (answer.content as { text: string }[])[0]!.text;
  try { return JSON.parse(text); } catch { throw new Error(text); }
};

async function fixture() {
  const evidence = new AsyncControlEvidenceStore(path.join(root, `evidence-${effects}.sqlite`));
  await evidence.ready();
  let lostSettlement = false, overrideAnswer: unknown = undefined;
  class ReceiptStore extends SqliteMcpReceiptStore {
    override async settle(...args: Parameters<SqliteMcpReceiptStore["settle"]>) {
      if (lostSettlement) throw new Error("fixture settlement write unavailable");
      return super.settle(...args);
    }
  }
  let receipts = new ReceiptStore(path.join(root, `receipts-${effects}.sqlite`));
  const service = () => createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domain as never), receipts,
    viewerMcpToolPolicy(domain as never), { recovery: viewerMcpRecoverableTools(domain as never) });
  setMcpHttpDependenciesForTests({ service: async () => service(), conversationForCapability: () => seat });
  let mode: "normal" | "before" | "after" | "hold" = "normal", held: (() => Promise<number>) | undefined;
  let posts = 0, lastId = "", recoveryDelayMs = 0;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url!, "http://127.0.0.1");
    const next = new NextRequest(url, { method: request.method, headers: request.headers as HeadersInit,
      ...(request.method === "POST" ? { body } : {}) });
    const answer = url.pathname === "/api/mcp" ? await POST(next) : overrideAnswer !== undefined ? Response.json(overrideAnswer) : await sendPOST(next);
    response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(await answer.text());
  });
  const uninstall = installControlIngress(server, evidence);
  const origin = await listen(server);
  const gateway = http.createServer(async (request, response) => {
    if (request.url?.startsWith(CONTROL_RECOVERY_PATH) && recoveryDelayMs) {
      const delay = recoveryDelayMs; recoveryDelayMs = 0; await Bun.sleep(delay);
    }
    if (request.url === "/api/conversation-host") {
      posts++; lastId = String(request.headers[CONTROL_REQUEST_HEADER]);
      if (mode === "before") { mode = "normal"; request.socket.destroy(); return; }
    }
    const proxy = () => new Promise<number>((resolve, reject) => {
      const outbound = http.request(new URL(request.url!, origin), { method: request.method, headers: request.headers, agent: false }, answer => {
        const chunks: Buffer[] = [];
        answer.on("data", chunk => chunks.push(Buffer.from(chunk)));
        answer.on("end", () => {
          if (request.url === "/api/conversation-host" && mode === "after") { mode = "normal"; request.socket.destroy(); }
          else if (!response.destroyed) { response.writeHead(answer.statusCode!, answer.headers); response.end(Buffer.concat(chunks)); }
          resolve(answer.statusCode!);
        });
      });
      outbound.on("error", reject);
      if (heldBody) outbound.end(heldBody); else request.pipe(outbound);
    });
    let heldBody: Buffer | undefined;
    if (request.url === "/api/conversation-host" && mode === "hold") {
      mode = "normal";
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      heldBody = Buffer.concat(chunks); held = proxy; request.socket.destroy(); return;
    }
    await proxy();
  });
  const gateOrigin = await listen(gateway);
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = gateOrigin;
  const client = new Client({ name: "control-evidence-http", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", origin), { requestInit: { headers: { "x-llv-spawn-capability": "a".repeat(43) } } }));
  return { client, origin, gateOrigin, evidence, mode: (next: typeof mode) => { mode = next; }, posts: () => posts, lastId: () => lastId,
    late: async () => held!(), reopen: () => { receipts.close(); receipts = new ReceiptStore(receipts.filename); },
    override: (value: unknown) => { overrideAnswer = value; }, loseSettlement: (value: boolean) => { lostSettlement = value; },
    delayRecovery: (milliseconds: number) => { recoveryDelayMs = milliseconds; },
    close: async () => {
      await client.close(); await stop(gateway); await stop(server); uninstall(); await evidence.close(); receipts.close(); setMcpHttpDependenciesForTests(null);
      if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previous;
    } };
}

test("SDK reset before ingress settles nonexecution, fences late bytes and permits one safe resend", async () => {
  const f = await fixture(), before = effects;
  const args = { conversationId: recipient.id, text: "send after ingress fence", clientRequestId: "reset-before-ingress" };
  try {
    f.mode("hold");
    const started = Date.now();
    const answer = payload(await f.client.callTool({ name: "send_message", arguments: args }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(answer).toMatchObject({ ok: false, details: { outcome: "not-executed" } });
    expect(effects).toBe(before);
    expect((await f.evidence.observe(f.lastId(), true)).state).toBe("fenced");
    await controlEvidenceStore("client").ready();
    const log = new Database(controlEvidenceStore("client").filename, { readonly: true });
    try { expect(log.query("SELECT code FROM events WHERE id=? AND event='error'").all(f.lastId())).toContainEqual({ code: "ECONNRESET" }); }
    finally { log.close(); }
    f.reopen();
    expect(payload(await f.client.callTool({ name: "send_message", arguments: { ...args, recoveryOnly: true } }))).toMatchObject({ ok: false, details: { outcome: "not-executed" } });
    expect(await f.late()).toBe(409);
    expect(effects).toBe(before);
    const resent = payload(await f.client.callTool({ name: "send_message", arguments: { ...args, clientRequestId: "reset-before-safe-resend" } }));
    expect(resent).toMatchObject({ ok: true, outcome: "queued" });
    expect(effects).toBe(before + 1);
    expect(f.posts()).toBe(2);
  } finally { await f.close(); }
});

test("SDK reset after response reads the committed answer back with exactly one delivery", async () => {
  const f = await fixture(), before = effects;
  const args = { conversationId: recipient.id, text: "recover the committed answer", clientRequestId: "reset-after-response" };
  try {
    f.mode("after");
    const answer = payload(await f.client.callTool({ name: "send_message", arguments: args }));
    expect(answer).toMatchObject({ ok: true, outcome: "queued", operationId: `operation_${before + 1}` });
    expect(await f.evidence.observe(f.lastId(), true)).toMatchObject({ state: "seen", status: 200, outcome: expect.stringContaining(`operation_${before + 1}`) });
    f.reopen();
    expect(payload(await f.client.callTool({ name: "send_message", arguments: { ...args, recoveryOnly: true } }))).toMatchObject({ ok: true, operationId: `operation_${before + 1}` });
    expect(f.posts()).toBe(1); expect(effects).toBe(before + 1);
  } finally { await f.close(); }
});

test("SDK reset recovery waits through a six-second Viewer evidence stall", async () => {
  const f = await fixture(), before = effects;
  try {
    f.mode("before"); f.delayRecovery(6000);
    const answer = payload(await f.client.callTool({ name: "send_message", arguments: {
      conversationId: recipient.id, text: "wait for ingress proof", clientRequestId: "stalled-ingress-proof",
    } }));
    expect(answer).toMatchObject({ ok: false, details: { outcome: "not-executed" } });
    expect(f.posts()).toBe(1); expect(effects).toBe(before);
  } finally { await f.close(); }
}, 20_000);

test("SDK recovery keeps a malformed cached send response unknown", async () => {
  const f = await fixture(), before = effects;
  const args = { conversationId: recipient.id, text: "incomplete backend verdict", clientRequestId: "incomplete-cached-verdict" };
  try {
    f.override({ ok: true });
    expect(payload(await f.client.callTool({ name: "send_message", arguments: args }))).toMatchObject({ ok: false, code: "outcome_unknown" });
    f.reopen();
    expect(payload(await f.client.callTool({ name: "send_message", arguments: { ...args, recoveryOnly: true } }))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(f.posts()).toBe(1); expect(effects).toBe(before);
  } finally { await f.close(); }
});

test("SDK recovery validates and projects the HTTP verdict after losing the MCP receipt write", async () => {
  const f = await fixture();
  const args = { conversationId: recipient.id, text: "recover a consistent backend verdict", clientRequestId: "consistent-cached-verdict" };
  try {
    f.override({ ok: true, operationId: "operation_cached", outcome: "queued", receipt: { operationId: "operation_cached", status: "queued" }, internalOnly: "fixture-private-metadata" });
    f.loseSettlement(true);
    expect(payload(await f.client.callTool({ name: "send_message", arguments: args }))).toMatchObject({ ok: true, operationId: "operation_cached" });
    f.loseSettlement(false); f.reopen();
    const answer = payload(await f.client.callTool({ name: "send_message", arguments: { ...args, recoveryOnly: true } }));
    expect(answer).toMatchObject({ ok: true, outcome: "accepted", state: "queued", operationId: "operation_cached", deliveryConfirmed: false });
    expect(JSON.stringify(answer)).not.toContain("fixture-private-metadata"); expect(f.posts()).toBe(1);
  } finally { await f.close(); }
});

test("ingress recovery requires the internal service proof, bounds bodies, and preserves response and close records", async () => {
  const evidence = new ControlEvidenceStore(path.join(root, "hostile.sqlite"));
  let body = JSON.stringify({ text: "x".repeat(OUTCOME_LIMIT) });
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(body); });
  const uninstall = installControlIngress(server, evidence), origin = await listen(server);
  try {
    const forged = `${Date.now() + 1}-${"f".repeat(64)}`;
    const denied = await controlFetch(new URL(`${CONTROL_RECOVERY_PATH}?id=${forged}`, origin));
    expect(denied.status).toBe(403); await denied.text();
    const id = controlRequestId();
    const response = await controlFetch(new URL("/api/large", origin), { headers: { ...tags, [CONTROL_REQUEST_HEADER]: id } });
    expect(response.headers.get(CONTROL_REQUEST_HEADER)).toBe(id); await response.text();
    expect(evidence.observe(id, true)).toMatchObject({ state: "seen", status: 200, outcome: null });
    const row = evidence.db.query("SELECT closed,written_bytes FROM requests WHERE id=?").get(id) as { closed: number; written_bytes: number };
    expect(row.closed).toBeGreaterThan(0); expect(row.written_bytes).toBeGreaterThan(OUTCOME_LIMIT);
    expect(evidence.observe(forged).state).toBe("seen");
    const lookup = await controlFetch(new URL(`${CONTROL_RECOVERY_PATH}?id=${id}`, origin), { headers: tags });
    const lookupId = lookup.headers.get(CONTROL_REQUEST_HEADER)!;
    expect(lookupId).toMatch(/^\d{13}-[a-f0-9]{64}$/);
    expect(await lookup.json()).toMatchObject({ state: "seen", status: 200, outcome: null });
    expect(evidence.observe(lookupId).status).toBe(200);
    body = JSON.stringify({ text: "я".repeat((OUTCOME_LIMIT - 12) / 2) + "x" });
    expect(Buffer.byteLength(body)).toBe(OUTCOME_LIMIT);
    const bounded = await controlFetch(new URL("/api/utf8", origin), { headers: tags });
    const boundedId = bounded.headers.get(CONTROL_REQUEST_HEADER)!;
    expect(await bounded.text()).toBe(body);
    expect(evidence.observe(boundedId, true).outcome).toBe(body);
    body += " ";
    const large = await controlFetch(new URL("/api/utf8-overflow", origin), { headers: tags });
    expect(await large.text()).toBe(body);
    expect(evidence.observe(large.headers.get(CONTROL_REQUEST_HEADER)!, true).outcome).toBeNull();
  } finally { await stop(server); uninstall(); evidence.close(); }
});

test("SDK control read survives a six-second stall in a separate serving process", async () => {
  const f = await fixture();
  const script = `import http from 'node:http';
    const server = http.createServer((_req, res) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
      res.setHeader('content-type','application/json'); res.end(JSON.stringify({partial:true, omissions:['board']})); });
    server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));
    process.on('SIGTERM',()=>server.closeAllConnections());`;
  const child = (await import("node:child_process")).spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const port = await new Promise<string>((resolve, reject) => {
      lines.once("line", line => resolve(line.trim())); child.once("error", reject);
      child.once("exit", () => reject(new Error("stall fixture exited before its port handshake")));
    });
    process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${port}`;
    const started = Date.now();
    // Exercise a registered real tool through SDK -> exported MCP route ->
    // production binding and control transport; only the downstream data is a fixture.
    const answer = payload(await f.client.callTool({ name: "dismiss_attention", arguments: { project: "fixture-project", kinds: ["memory"], clientRequestId: "stalled-control-read" },
      _meta: { "delegatus/deadlineAt": Date.now() + 12_000 } }));
    expect(answer).toMatchObject({ ok: true, partial: true, omissions: ["board"] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5900);
  } finally { lines.close(); child.kill("SIGKILL"); await exited; await f.close(); }
}, 20_000);

test("body failure and caller abort settle a stalled response without retaining an abort listener", async () => {
  const connections = new Set<http.ServerResponse>();
  const server = http.createServer((_request, response) => {
    connections.add(response); response.once("close", () => connections.delete(response));
    response.writeHead(200, { "content-type": "application/json" }); response.write('{"partial":');
  });
  const origin = await listen(server);
  try {
    const controller = new AbortController();
    const response = await controlFetch(new URL("/stalled-body", origin), { signal: controller.signal });
    const reading = response.json(); controller.abort(new Error("fixture deadline"));
    await expect(reading).rejects.toThrow("fixture deadline");
    const cut = await controlFetch(new URL("/cut-body", origin));
    const decoding = cut.json();
    for (const connection of connections) connection.destroy();
    await expect(decoding).rejects.toThrow();
  } finally { await stop(server); }
});

test.each(["gzip", "deflate", "br"] as const)("the HTTP client preserves %s response decoding", async encoding => {
  const value = { text: "відповідь ".repeat(300) };
  const bytes = Buffer.from(JSON.stringify(value));
  const packed = encoding === "gzip" ? gzipSync(bytes) : encoding === "deflate" ? deflateSync(bytes) : brotliCompressSync(bytes);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": encoding }); response.end(packed);
  });
  const origin = await listen(server);
  try { expect(await (await controlFetch(new URL("/compressed", origin))).json()).toEqual(value); }
  finally { await stop(server); }
});

test("a blocked evidence writer refuses before route invocation while an ordinary peer progresses", async () => {
  const filename = path.join(root, "busy-ingress.sqlite");
  const peer = new ControlEvidenceStore(filename), worker = new AsyncControlEvidenceStore(filename, true, 1000);
  await worker.ready();
  let ordinary = 0;
  const server = http.createServer((_request, response) => { ordinary++; response.end("peer"); });
  const uninstall = installControlIngress(server, worker), origin = await listen(server);
  try {
    peer.db.exec("BEGIN IMMEDIATE");
    const signed = controlFetch(new URL("/mutation", origin), { headers: tags });
    const health = await fetch(new URL("/health", origin)); expect(await health.text()).toBe("peer");
    const refused = await signed; expect(refused.status).toBe(503); expect(await refused.json()).toMatchObject({ admission: "refused" });
    expect(ordinary).toBe(1);
    peer.db.exec("ROLLBACK");
  } finally { if (peer.db.inTransaction) peer.db.exec("ROLLBACK"); await worker.close(); await stop(server); uninstall(); peer.close(); }
});

test("the serving installer observes the real native HTTP server prototype", async () => {
  const uninstall = await installServingControlIngress();
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end('{"ok":true}'); });
  const origin = await listen(server);
  try {
    const id = controlRequestId();
    const response = await controlFetch(new URL("/installed", origin), { headers: { ...tags, [CONTROL_REQUEST_HEADER]: id } });
    expect(response.headers.get(CONTROL_REQUEST_HEADER)).toBe(id); expect(await response.json()).toEqual({ ok: true });
    expect(await controlEvidenceStore("server").observe(id, true)).toMatchObject({ state: "seen", status: 200, outcome: '{"ok":true}' });
  } finally { await stop(server); uninstall(); }
});

test("a peer leaving during admission durably fences the request before invocation", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>(), abandoned = Promise.withResolvers<void>();
  class HeldIngress extends AsyncControlEvidenceStore {
    override async observe(...args: Parameters<AsyncControlEvidenceStore["observe"]>) {
      const answer = await super.observe(...args);
      if (answer.fresh && !args[1]) { entered.resolve(); await release.promise; }
      return answer;
    }
    override async abandon(id: string, nonce: string) { await super.abandon(id, nonce); abandoned.resolve(); }
  }
  const worker = new HeldIngress(path.join(root, "abandoned-ingress.sqlite"));
  await worker.ready();
  let invoked = 0;
  const server = http.createServer((_request, response) => { invoked++; response.end("unexpected"); });
  server.once("connection", socket => socket.once("close", () => closed.resolve()));
  const uninstall = installControlIngress(server, worker), origin = await listen(server);
  const controller = new AbortController(), id = controlRequestId();
  try {
    const request = controlFetch(new URL("/abandon", origin), { headers: { ...tags, [CONTROL_REQUEST_HEADER]: id }, signal: controller.signal });
    await entered.promise;
    controller.abort(new Error("fixture left during admission"));
    await expect(request).rejects.toThrow("fixture left during admission");
    await closed.promise; release.resolve(); await abandoned.promise;
    expect((await worker.observe(id, true)).state).toBe("fenced"); expect(invoked).toBe(0);
  } finally { release.resolve(); await worker.close(); await stop(server); uninstall(); }
});
