import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { createGateSandbox, isolatedEnvironment } from "../../../scripts/local-gate";
const original = { ...process.env }, root = createGateSandbox();
Object.assign(process.env, isolatedEnvironment(root, checkEnvironment(original)));
delete process.env.LLV_SPAWN_CAPABILITY;
const { POST: mcpPOST } = await import("@/app/api/mcp/route");
const { POST: connectPOST } = await import("@/app/api/forge/app-connect/route");
const { setMcpHttpDependenciesForTests } = await import("./http");
const { agentRegistry, closeAgentRegistryForTests } = await import("@/lib/agent/registry");
const { spawnCapabilityDigest } = await import("@/lib/agent/callerClaims");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { createMcpToolService, SqliteMcpReceiptStore, McpToolRefusal } = await import("./server");
const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const { AppConnectService, closeAppConnectForm, setAppConnectServiceForTests } = await import("@/lib/forge/appConnect");
const { AppConnectStore } = await import("@/lib/forge/appConnectStore");
const { publishPrototype } = await import("@/lib/prototypeReview/store");
const { findSeatRound } = await import("@/lib/prototypeReview/seatRounds");
const { declareForgeAppRepository, forgeAppRepositories } = await import("@/lib/git/agentForgeCredentials");
const { statePath } = await import("@/lib/configDir");
const { recordProjectRemote } = await import("@/lib/projects/aliases");
const { projectIdentityFromRemote } = await import("@/lib/projects/identity");
const { copiedAppConnectionModule, fakeAppConnection, CONNECT_TARGET, CONNECT_SOURCE, CONNECT_NOW } = await import("@/lib/forge/appConnect.fixture");
import type { AppConnectPorts } from "@/lib/forge/appConnect";

afterAll(() => { setAppConnectServiceForTests(undefined); setMcpHttpDependenciesForTests(null); closeAgentRegistryForTests();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); fs.rmSync(root, { recursive: true, force: true }); });

test("SDK → MCP policy and receipt service → exported route → confirmed credential and declaration; workers are refused", async () => {
  const fake = fakeAppConnection();
  const identity = projectIdentityFromRemote(`https://github.com/${CONNECT_TARGET}.git`, root)!;
  recordProjectRemote(identity);
  const project = identity.project;
  const seatId = "conversation_fixture_connect_seat", workerId = "conversation_fixture_connect_worker";
  const registry = agentRegistry();
  const capability = (conversationId: `conversation_${string}`) => {
    const started = registry.beginSpawnRequest({ engine: "codex", cwd: root, explicitProject: project, transport: "structured", conversationId, role: "builder", clientAttemptId: conversationId,
      launchProfile: emptyLaunchProfile({ cwd: root, project, title: "App connection fixture", role: "worker" }) });
    if (started.kind !== "created") throw new Error("fixture spawn not created");
    registry.settleSpawn(started.receipt.launchId, { key: { engine: "codex", sessionId: conversationId }, artifactPath: path.join(root, `${conversationId}.jsonl`), cwd: root, accountId: "default", status: "unhosted", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    return registry.rotateSpawnCapabilityForReceipt(started.receipt.launchId);
  };
  const seatCapability = capability(seatId), workerCapability = capability(workerId);
  beginOrchestratorSeatIntent({ project, mandate: "Own the fixture project", clientRequestId: "connect-seat", mode: "existing", conversationId: seatId });
  completeOrchestratorSeatIntent({ project, clientRequestId: "connect-seat", conversationId: seatId, path: null });
  fs.writeFileSync(statePath("forge-app-repositories.json"), JSON.stringify([CONNECT_SOURCE]));
  let forms = 0, posts = 0, now = CONNECT_NOW;
  const ports: AppConnectPorts = {
    now: () => now, requestId: () => "a".repeat(32), ownsTraffic: () => true, discover: fake.discover, own: () => true, repository: async repository => ({ repository, id: 6 }),
    publish: async (input, row, beforeWrite) => { forms++; return publishPrototype(input, null, { conversationId: row.conversationId }, row.project, undefined, beforeWrite); },
    telegram: async () => { posts++; }, round: findSeatRound,
    close: row => closeAppConnectForm(row, now),
    declare: (repository, beforeWrite) => declareForgeAppRepository(repository, undefined, beforeWrite), notify: async () => true,
  };
  const store = new AppConnectStore(), engine = new AppConnectService(store, ports);
  setAppConnectServiceForTests(engine);
  let receipts = new SqliteMcpReceiptStore(path.join(root, "receipts.sqlite"));
  const routes: string[] = [];
  const clients: Client[] = [];
  const bindings = viewerMcpBindings(undefined, { post: async (pathname, body, headers) => {
    const answer = await fetch(new URL(pathname, listener.url), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await answer.json() as Record<string, unknown>;
    if (!answer.ok) throw new McpToolRefusal(String(result.error), { code: String(result.code), status: answer.status, retryable: answer.status >= 500 });
    return result;
  } });
  let service = createMcpToolService(bindings, receipts, viewerMcpToolPolicy());
  setMcpHttpDependenciesForTests({ service: async () => service, conversationForCapability: value => registry.conversationIdForSpawnCapabilityDigest(spawnCapabilityDigest(value)) });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    routes.push(new URL(request.url).pathname);
    return new URL(request.url).pathname === "/api/mcp" ? mcpPOST(new NextRequest(request)) : connectPOST(new NextRequest(request));
  } });
  try {
    const client = async (capability: string) => { const value = new Client({ name: "connect-fixture", version: "1" }); clients.push(value);
      await value.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), { requestInit: { headers: { "x-llv-spawn-capability": capability } } })); return value; };
    const seat = await client(seatCapability), worker = await client(workerCapability);
    const connectDescription = (await seat.listTools()).tools.find(tool => tool.name === "github_app_connect")?.description ?? "";
    expect(connectDescription).toContain("without another answer");
    expect(connectDescription).toContain("choose Connect in the form");
    const call = (client: Client, clientRequestId: string, repository = CONNECT_TARGET) => client.callTool({ name: "github_app_connect", arguments: { clientRequestId, repository } });
    const denied = await call(worker, "worker-request");
    expect(denied.structuredContent).toMatchObject({ ok: false, code: "not_permitted", retryable: false }); expect(forms).toBe(0);
    const other = await copiedAppConnectionModule(path.join(root, "app-connect-copy.ts")), lookup = ports.repository;
    ports.repository = async () => { throw new other.AppConnectError("github_unreachable", 503); };
    try { expect((await call(seat, "copied-runtime-refusal")).structuredContent).toMatchObject({ ok: false, code: "github_unreachable", retryable: true }); }
    finally { ports.repository = lookup; }
    expect(forms).toBe(0);
    const completion = spyOn(receipts, "complete").mockImplementation(() => { throw new Error("fixture interrupted completion"); });
    try { expect((await call(seat, "seat-request")).isError).toBe(true); }
    finally { completion.mockRestore(); }
    expect(forms).toBe(1); expect(posts).toBe(1);
    receipts.close(); store.close();
    receipts = new SqliteMcpReceiptStore(path.join(root, "receipts.sqlite"));
    service = createMcpToolService(bindings, receipts, viewerMcpToolPolicy());
    setAppConnectServiceForTests(new AppConnectService(new AppConnectStore(), ports));
    const asked = await call(seat, "seat-request");
    expect(asked.structuredContent).toMatchObject({ ok: true });
    expect(asked.structuredContent).toMatchObject({ state: "awaiting_click", repository: CONNECT_TARGET });
    expect(routes).toContain("/api/forge/app-connect"); expect(forms).toBe(1); expect(posts).toBe(1);
    expect((await call(seat, "seat-request")).structuredContent).toMatchObject({ state: "awaiting_click", repository: CONNECT_TARGET, replayed: true });
    expect(forms).toBe(1);
    expect((await call(seat, "invalid-target", "other-owner/..")).isError).toBe(true);
    fake.set({ covered: true, installed: true }); now += 30_000; await engine.tick();
    expect(forgeAppRepositories()).toEqual([CONNECT_SOURCE, CONNECT_TARGET]);
    expect(store.request(CONNECT_TARGET)?.state).toBe("connected");
    const directDenied = await fetch(new URL("/api/forge/app-connect", listener.url), { method: "POST", headers: { "content-type": "application/json", "x-llv-spawn-capability": workerCapability }, body: JSON.stringify({ clientRequestId: "direct-worker", repository: CONNECT_TARGET }) });
    expect(directDenied.status).toBe(403); expect(await directDenied.json()).toMatchObject({ code: "not_permitted" });
  } finally { for (const client of clients) await client.close(); listener.stop(true); receipts.close(); setMcpHttpDependenciesForTests(null); setAppConnectServiceForTests(undefined); }
}, 60_000);
