import { expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { POST } from "@/app/api/mcp/route";
import { POST as deployPost } from "@/app/api/runtime/deployments/route";
import { needsYouHandler } from "@/app/api/attention/needs-you/handler";
import { readNeedsYou, type NeedsYouReadSources } from "@/lib/attention/needsYouRead";
import { SelfUpdateService } from "@/lib/selfUpdate/service";
import { productionDeps, setSelfUpdateServiceForTests } from "@/lib/selfUpdate/instance";
import { setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";
import { RuntimeJournal } from "@/runtime-host/journal";
import { ViewerDeploymentCoordinator } from "@/runtime-host/deployment";
import { FakeDeploymentAdapter } from "@/runtime-host/fixtures/fakeDeploymentAdapter";
import { setMcpHttpDependenciesForTests } from "./http";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";
import { viewerMcpBindings, viewerMcpToolPolicy, productionViewerControlDependencies } from "./bindings";

const project = "recovery-project", seat = "conversation_recovery_seat";
const authority = { kind: "root", conversationId: seat } as const;
const seats = [{ conversationId: seat, path: null, project }];
const domain = {
  attentionAuthority: () => authority,
  callerAttribution: () => ({ kind: "manager", conversationId: seat, role: "orchestrator" }),
  authorizedSeats: () => seats, callerProject: () => project, viewerProjects: () => [project],
  registrySnapshot: () => ({ entries: {}, conversations: {}, receipts: {}, memberships: {}, lineageEdges: {}, conversationAliases: {} }),
};
const policy = viewerMcpToolPolicy(domain as never, false);

async function sdk(service: ReturnType<typeof createMcpToolService>) {
  setMcpHttpDependenciesForTests({ service: async () => service, conversationForCapability: () => seat });
  let afterCallbackBlockMs = 0;
  const listener = http.createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const abort = new AbortController();
    response.on("close", () => { if (!response.writableFinished) abort.abort(); });
    const answer = await POST(new NextRequest(`http://127.0.0.1:${(listener.address() as { port: number }).port}/api/mcp`, {
      method: "POST", headers: request.headers as HeadersInit, body: Buffer.concat(chunks).toString(), signal: abort.signal,
    }));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string; params?: { name?: string } };
    if (body.method === "tools/call" && body.params?.name === "dismiss_attention" && afterCallbackBlockMs > 0) {
      const blockMs = afterCallbackBlockMs;
      afterCallbackBlockMs = 0;
      // Model a serving-loop stall after the real MCP callback has produced its result.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
    }
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(await answer.text());
  });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "call-recovery", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/api/mcp`), {
    requestInit: { headers: { "x-llv-spawn-capability": "a".repeat(43) } },
  }));
  const url = `http://127.0.0.1:${(listener.address() as { port: number }).port}/api/mcp`;
  return { client, url, setAfterCallbackBlock: (milliseconds: number) => { afterCallbackBlockMs = milliseconds; }, close: async () => {
    await client.close(); listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    setMcpHttpDependenciesForTests(null);
  } };
}
const externalSdkCall = async (url: string, name: string, args: Record<string, unknown>, budgetMs: number) => {
  const script = `
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
    const [url, name, argsJson, budgetText] = process.argv.slice(1);
    const budgetMs = Number(budgetText);
    const client = new Client({ name: "external-deadline-observer", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "x-llv-spawn-capability": "a".repeat(43) } },
    }));
    const startedAt = Date.now();
    const deadlineAt = startedAt + budgetMs;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "timeout", elapsedMs: Date.now() - startedAt }), budgetMs + 100); });
    const call = client.callTool({ name, arguments: JSON.parse(argsJson), _meta: { "delegatus/deadlineAt": deadlineAt } })
      .then(result => ({ kind: "result", elapsedMs: Date.now() - startedAt, result }));
    const observed = await Promise.race([call, timeout]);
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(observed));
    if (observed.kind === "timeout") process.exit(0);
    await client.close();
  `;
  const result = await promisify(execFile)(process.execPath, ["--eval", script, url, name, JSON.stringify(args), String(budgetMs)], {
    cwd: process.cwd(), env: { ...process.env }, timeout: 10_000,
  });
  return JSON.parse(result.stdout) as { kind: "timeout" | "result"; elapsedMs: number; result?: Awaited<ReturnType<Client["callTool"]>> };
};
function payload(answer: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = answer.content;
  if (!Array.isArray(content) || content[0]?.type !== "text") throw Error("missing MCP text result");
  return JSON.parse(content[0].text);
}

test("SDK attention read returns named omissions before its control wait expires and cancels gathering", async () => {
  let readSignal: AbortSignal | undefined, laterReads = 0;
  const sources: NeedsYouReadSources = {
    board: signal => { readSignal = signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
    tasks: async () => { laterReads++; return []; }, pipelines: async () => { laterReads++; return []; },
    dismissals: async () => { laterReads++; return []; }, reports: async () => { laterReads++; return null; },
    admissions: async () => { laterReads++; return []; }, identity: async () => { laterReads++; return id => id; },
    ended: async () => { laterReads++; return { ids: new Set(), complete: true }; },
    decision: async () => { laterReads++; return null; }, locale: async () => "en",
  };
  const handler = needsYouHandler({ caller: () => ({ authority, seats, maintainer: null }), read: (key, options) => readNeedsYou(key, options, "panel", sources) });
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler(new NextRequest(request)) });
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = control.url.origin;
  const store = new SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "attention-http.sqlite"));
  const session = await sdk(createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domain as never), store, policy));
  try {
    const observed = await externalSdkCall(session.url, "dismiss_attention", {
      project, kinds: ["memory"], clientRequestId: "attention-http-read",
    }, 2_000);
    expect(observed.kind).toBe("result");
    expect(observed.elapsedMs).toBeLessThan(2_000);
    expect(payload(observed.result!)).toMatchObject({ ok: true, partial: true, countIsLowerBound: true, omissions: expect.arrayContaining(["board", "liveness"]) });
    expect(readSignal?.aborted).toBe(true);
    expect(laterReads).toBe(0);
    session.setAfterCallbackBlock(1_200);
    const blocked = await externalSdkCall(session.url, "dismiss_attention", {
      project, kinds: ["memory"], clientRequestId: "attention-http-blocked-loop",
    }, 500);
    expect(blocked.kind).toBe("timeout");
    expect(blocked.elapsedMs).toBeLessThan(900);
    expect(laterReads).toBe(0);
  } finally { await session.close(); control.stop(true); store.close(); if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previous; }
});

test("SDK deploy replay durably refuses absent admission and fences the original delayed HTTP POST", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "deploy-http-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"));
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(journal, adapter, { pid: 10, startIdentity: "10:1" });
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "absent.sock");
  setSelfUpdateServiceForTests(new SelfUpdateService({ ...productionDeps(), mode: async () => ({ mode: "managed", record: null, reason: null }) }));
  setDeploymentRuntimeForTests(request => coordinator.requestViewerDeployment(request));
  const release = Promise.withResolvers<void>(), lateAnswer = Promise.withResolvers<unknown>();
  let submissions = 0, reconciliations = 0;
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: async request => {
    if (request.method === "GET") return Response.json({ capability: "viewer-deployments", version: 1, admissionFence: true });
    const text = await request.text(), body = JSON.parse(text);
    if (body.reconcileOnly) reconciliations++;
    else { submissions++; await release.promise; }
    const handle = new URL(request.url).pathname.endsWith("/reconcile")
      ? (await import("@/app/api/runtime/deployments/reconcile/route")).POST : deployPost;
    const response = await handle(new NextRequest(request.url, { method: "POST", headers: request.headers, body: text }));
    if (!body.reconcileOnly) lateAnswer.resolve(await response.clone().json());
    return response;
  } });
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = control.url.origin;
  const store = new SqliteMcpReceiptStore(path.join(root, "mcp.sqlite"));
  const session = await sdk(createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domain as never), store, policy));
  const args = { revision: "a".repeat(40), clientRequestId: "absent-http-deploy" };
  try {
    const initial = session.client.callTool({ name: "deploy_exact_sha", arguments: args, _meta: { "delegatus/deadlineAt": Date.now() + 1500 } });
    const terminal = payload(await initial);
    expect(terminal).toMatchObject({ ok: false, code: "deploy_not_admitted", details: { outcome: "not-executed", evidence: "not-admitted" }, retryable: false });
    release.resolve();
    expect(await lateAnswer.promise).toMatchObject({ code: "deploy_not_admitted" });
    expect(payload(await session.client.callTool({ name: "deploy_exact_sha", arguments: args }))).toMatchObject({ ...terminal, replayed: true });
    expect({ submissions, reconciliations }).toEqual({ submissions: 1, reconciliations: 1 });
    expect(journal.viewerDeploymentByIdempotencyKey(args.clientRequestId)).toBeNull();
    expect(adapter.calls).toEqual([]);
    await expect(coordinator.requestViewerDeployment({ revision: args.revision, idempotencyKey: args.clientRequestId })).rejects.toMatchObject({ code: "deploy_not_admitted" });
  } finally {
    release.resolve();
    if (submissions) await lateAnswer.promise;
    const admitted = journal.viewerDeploymentByIdempotencyKey(args.clientRequestId);
    if (admitted) await coordinator.waitForDeployment(admitted.deploymentId);
    await session.close(); control.stop(true); store.close(); journal.close();
    setDeploymentRuntimeForTests(null); setSelfUpdateServiceForTests(null);
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
