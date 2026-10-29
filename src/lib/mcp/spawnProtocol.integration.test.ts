import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { POST } from "@/app/api/spawn/route";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { resetCodexProtocolAdmissionsForTest, resolveCodexProtocol } from "@/lib/accounts/codexPinnedProtocol";
import { retainProviderRedactionSecrets } from "@/lib/accounts/providerSecretRedaction";
import { spawnStructuredConversation } from "@/lib/runtime/structuredSpawn";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { RuntimeJournal } from "@/runtime-host/journal";
import { projectForCwd } from "@/lib/scanner/describe";
import { viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy, productionDomainDependencies, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore, McpDispatchVerdictError } from "./server";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetCodexProtocolAdmissionsForTest();
});

async function fixture(mode: string, version = "0.165.0") {
  resetCodexProtocolAdmissionsForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-protocol-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = { ...process.env };
  cleanups.push(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    LLV_STATE_DIR: path.join(root, "state"), HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), LLV_SPAWN_TRANSPORT: "structured",
    LLV_STRUCTURED_HOSTS: "1", LLV_RUNTIME_EVENTS: "1", NEXT_PUBLIC_RUNTIME_UI: "1",
    LLV_RUNTIME_HOST_SOCKET: path.join(root, "unused.sock"),
  });
  for (const directory of ["home", "config", "state", "account"]) fs.mkdirSync(path.join(root, directory));
  const binary = path.join(root, "codex");
  fs.writeFileSync(binary, `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  if (process.env.FIXTURE_MODE === "version-exit") process.exit(2);
  console.log(process.env.FIXTURE_MODE === "version-invalid" ? "unknown version" : "codex-cli ${version}");
  process.exit(0);
}
if (!args.includes("generate-json-schema")) { console.log("[]"); process.exit(0); }
const mode = process.env.FIXTURE_MODE;
fs.appendFileSync(process.env.FIXTURE_CALLS, "generate\\n");
if (mode === "exit") process.exit(2);
if (mode === "timeout") await new Promise(() => {});
const out = args[args.indexOf("--out") + 1];
fs.mkdirSync(out, { recursive: true });
if (mode === "missing") process.exit(0);
const name = args.includes("--experimental") ? "experimental" : "stable";
const schema = mode === "parse" ? "{" : mode === "break" ? '{"definitions":{}}'
  : fs.readFileSync(path.join(process.env.FIXTURE_SCHEMAS, name + ".json"), "utf8");
fs.writeFileSync(path.join(out, "codex_app_server_protocol.schemas.json"), schema);
`, { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = binary;
  const account = { engine: "codex" as const, accountId: "account-a", kind: "managed" as const,
    home: path.join(root, "account"), transcriptRoot: path.join(root, "sessions"),
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_CALLS: path.join(root, "calls"),
      FIXTURE_SCHEMAS: path.resolve(import.meta.dir, "../accounts/protocol/0.164.0") } };
  const registryPath = path.join(root, "registry.json");
  let registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  cleanups.push(() => { setAgentRegistryForTests(null); registry.close(); });
  const journal = new RuntimeJournal(path.join(root, "runtime"));
  cleanups.push(() => journal.close());
  const runtime = {
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
  } as RuntimeHostClient;
  const work: Array<() => Promise<void>> = [];
  let dispatches = 0;
  let launchFailure: unknown = new Error("fixture launch ended before its transcript");
  let useStructured = false, hostStarts = 0;
  let interceptRefusal: (() => Promise<void>) | null = null;
  const dependencies = { ...POST.productionDependencies,
    preflightProtocol: async (input: Parameters<NonNullable<typeof POST.productionDependencies.preflightProtocol>>[0]) => {
      try { await POST.productionDependencies.preflightProtocol!(input); }
      catch (error) { await interceptRefusal?.(); throw error; }
    },
    registry: () => registry, assertStructuredRuntime: () => {}, engineReadiness: () => "connected" as const,
    autonomousStructured: true, resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    runtimeHostClient: () => runtime,
    storeImages: () => [], defer: (callback: () => Promise<void>) => { work.push(callback); },
    spawnStructuredConversation: async (input: Parameters<typeof spawnStructuredConversation>[0]): ReturnType<typeof spawnStructuredConversation> => {
      if (useStructured) return spawnStructuredConversation(input, { startHost: async () => { hostStarts++; throw launchFailure; } });
      throw launchFailure;
    },
  };
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: request => POST.withDependencies(new NextRequest(request), dependencies),
  });
  cleanups.push(() => http.stop(true));
  let caller = { kind: "gateway" as const, conversationId: "conversation_operator", role: null };
  const domain: ViewerMcpDomainDependencies = { ...productionDomainDependencies,
    registrySnapshot: () => registry.readOnlySnapshot(),
    callerAttribution: () => caller, callerProject: () => projectForCwd(root),
    attentionAuthority: () => ({ kind: "root", conversationId: "conversation_operator", role: null }),
    noticeCapableViewOpen: () => true, adoptRootSession: () => {},
    completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
  };
  let dispatchedBody: Record<string, unknown> | null = null;
  let dispatchedHeaders: Record<string, string> = {};
  const bindings = viewerMcpBindings(undefined, {
    post: async (pathname, body, headers) => {
      dispatches++; dispatchedBody = body; dispatchedHeaders = headers ?? {};
      const response = await fetch(new URL(pathname, http.url), { method: "POST",
        headers: { ...headers, origin: http.url.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new McpDispatchVerdictError(String(payload.error), { status: response.status, code: String(payload.code) });
      return payload;
    },
  }, domain);
  const storePath = path.join(root, "mcp.sqlite");
  let store = new SqliteMcpReceiptStore(storePath);
  cleanups.push(() => store.close());
  const openService = () => createMcpToolService(bindings, store, viewerMcpToolPolicy(domain), { recovery: viewerMcpRecoverableTools(domain) });
  let service = openService();
  const server = createViewerMcpServer({ callTool: (...args) => service.callTool(...args) });
  const client = new Client({ name: "protocol-fixture", version: "1" });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(transport), server.connect(serverTransport)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const args = { clientRequestId: "protocol-spawn-request", cwd: root, engine: "codex", title: "Inspect launch protocol", prompt: "Inspect launch protocol" };
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>;
  return { root, registry: () => registry, work, bindings, call, args, account,
    holdRefusal: () => {
      let enter!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      interceptRefusal = async () => { enter(); await held; };
      return { ready, release };
    },
    admitPeer: async (changePrompt: boolean, changeAccount = false) => {
      if (changeAccount) account.accountId = "account-b";
      account.env.FIXTURE_MODE = "compatible";
      const response = await fetch(new URL("/api/spawn", http.url), { method: "POST",
        headers: { ...dispatchedHeaders, origin: http.url.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ ...dispatchedBody, ...(changePrompt ? { prompt: "Different launch work" } : {}) }), signal: AbortSignal.timeout(45_000) });
      return await response.json() as Record<string, unknown>;
    },
    hostStarts: () => hostStarts,
    failWith: (error: unknown, structured = false) => {
      launchFailure = error; useStructured = structured;
    }, dispatches: () => dispatches,
    restart: () => { registry.close(); registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
      setAgentRegistryForTests(registry); store.close(); store = new SqliteMcpReceiptStore(storePath); service = openService(); },
    asForeign: () => { caller = { ...caller, conversationId: "conversation_foreign" }; domain.callerProject = () => "foreign-project";
      domain.callerAttribution = () => ({ kind: "agent", conversationId: "conversation_foreign", role: "builder" }); },
  };
}

for (const [mode, cause] of [["exit", "exit 2"], ["missing", "ENOENT"], ["parse", "not JSON"], ["break", "not an additive extension"], ["timeout", "timed out"],
  ["version-exit", "cannot identify executable version"], ["version-invalid", "cannot identify executable version"]]) {
  test(`MCP refuses ${mode} protocol validation before reserving or dispatching a launch`, async () => {
    const f = await fixture(mode!);
    const answer = await f.call("spawn_agent", f.args);
    expect(answer).toMatchObject({ ok: false });
    expect(String(answer.error)).toContain(mode!.startsWith("version-") ? "CLI unknown" : "CLI 0.165.0");
    expect(String(answer.error)).toContain("Supported: 0.164.0");
    expect(String(answer.error)).toContain("cause:");
    expect(String(answer.error)).toContain(cause!);
    expect(answer).not.toHaveProperty("conversationId");
    expect(f.registry().readOnlySnapshot().receipts).toEqual({});
    expect(f.work).toHaveLength(0);
    f.restart();
    const replay = await f.call("spawn_agent", f.args);
    expect(replay).toMatchObject({ ok: false, replayed: true });
    expect(f.dispatches()).toBe(1);
  }, 45_000);
}

test.each(["0.164.0", "0.165.0"])("production preflight accepts compatible CLI %s and its returned id stays readable", async version => {
  const f = await fixture("compatible", version);
  const answer = await f.call("spawn_agent", f.args);
  expect(answer).toMatchObject({ ok: true, state: "starting" });
  const id = String(answer.conversationId);
  expect(await f.call("get_conversation", { conversationId: id })).toMatchObject({ ok: true, state: "starting", evidence: "spawn-receipt" });
  const calls = path.join(f.root, "calls");
  expect(fs.existsSync(calls)).toBe(version === "0.165.0");
  expect(f.work).toHaveLength(1);
  await f.work[0]!();
  const receipt = f.registry().spawnReceiptForClientAttempt("mcp_spawn_" + (await import("node:crypto")).createHash("sha256").update(f.args.clientRequestId).digest("hex"));
  expect(receipt).toMatchObject({ state: "failed", artifactPath: null, key: null });
  f.restart();
  const failed = await f.call("spawn_agent", f.args);
  expect(failed).toMatchObject({ ok: true, replayed: true, state: "failed", launched: false, outcome: "settled" });
  for (const recoveryOnly of [false, true, false]) {
    expect(await f.call("spawn_agent", { ...f.args, ...(recoveryOnly ? { recoveryOnly } : {}) })).toMatchObject({
      ok: true, replayed: true, state: "failed", launched: false,
    });
  }
  expect(f.dispatches()).toBe(1);
  expect(await f.call("get_conversation", { conversationId: id })).toMatchObject({ ok: true, state: "failed", reason: receipt!.error });
  expect(await f.call("get_conversation", { conversationId: id, tailLines: 10 })).toMatchObject({ ok: true, state: "failed" });
  const attention = await f.call("request_attention", { clientRequestId: "failed-launch-attention", target: { kind: "conversation", conversationId: id },
    reason: "Inspect the failed launch", contextLabel: "Launch failed", waitFor: "accepted" });
  expect(attention).toMatchObject({ ok: true });
  expect(JSON.stringify(attention)).toContain(`spawn:${receipt!.launchId}`);
  // The same route response is also consumed directly by the MCP binding.
  expect(await f.bindings.spawn_agent({ ...f.args, clientRequestId: receipt!.clientAttemptId })).toMatchObject({ state: "failed", launched: false, reason: receipt!.error });
});

for (const structured of [false, true])
test(`a deferred protocol refusal keeps supported versions and its redacted cause after restart (structured=${structured})`, async () => {
  const f = await fixture("compatible");
  const answer = await f.call("spawn_agent", f.args);
  const sensitive = ["fixture", "provider", "private", "value"].join("-");
  retainProviderRedactionSecrets([sensitive]);
  let failure: unknown;
  try { await resolveCodexProtocol("0.166.0", "unused", f.account.env, async () => { throw new Error(`generator failed (exit 2) ${"detail. ".repeat(14)}DECISIVE EXIT 2 ${sensitive}`); }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  f.failWith(failure, structured);
  await f.work[0]!();
  f.restart();
  expect(f.hostStarts()).toBe(structured ? 1 : 0);
  const read = await f.call("get_conversation", { conversationId: answer.conversationId });
  expect(String(read.reason)).toContain("Supported: 0.164.0");
  expect(String(read.reason)).toContain("cause: generator failed (exit 2)");
  expect(String(read.reason)).toContain("DECISIVE EXIT 2");
  expect(JSON.stringify(read)).not.toContain(sensitive);
  expect(String(read.reason)).not.toContain(sensitive.split("-").slice(0, 2).join("-"));
  const child = Bun.spawn([process.execPath, "--eval", `
    import { AgentRegistry, setAgentRegistryForTests } from "./src/lib/agent/registry";
    import { viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy, productionDomainDependencies } from "./src/lib/mcp/bindings";
    import { createMcpToolService, SqliteMcpReceiptStore } from "./src/lib/mcp/server";
    import { projectForCwd } from "./src/lib/scanner/describe";
    const registry = new AgentRegistry(process.env.FIXTURE_REGISTRY, undefined, undefined, { sqliteMode: "off" });
    setAgentRegistryForTests(registry);
    try {
      const domain = { ...productionDomainDependencies,
        callerAttribution: () => ({ kind: "gateway", conversationId: "conversation_operator", role: null }),
        callerProject: () => projectForCwd(process.env.FIXTURE_ROOT),
        attentionAuthority: () => ({ kind: "root", conversationId: "conversation_operator", role: null }) };
      const bindings = viewerMcpBindings(undefined, undefined, domain);
      const store = new SqliteMcpReceiptStore(process.env.FIXTURE_MCP);
      try {
        const service = createMcpToolService(bindings, store, viewerMcpToolPolicy(domain), { recovery: viewerMcpRecoverableTools(domain) });
        console.log(JSON.stringify({ conversation: await bindings.get_conversation({ conversationId: process.env.FIXTURE_CONVERSATION }),
          replay: await service.callTool("spawn_agent", JSON.parse(process.env.FIXTURE_ARGS)) }));
      } finally { store.close(); }
    } finally { registry.close(); }
  `], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000), env: { ...process.env,
    FIXTURE_REGISTRY: path.join(f.root, "registry.json"), FIXTURE_CONVERSATION: String(answer.conversationId),
    FIXTURE_MCP: path.join(f.root, "mcp.sqlite"), FIXTURE_ROOT: f.root, FIXTURE_ARGS: JSON.stringify(f.args) } });
  const [output, diagnostic, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, diagnostic }).toMatchObject({ exit: 0 });
  expect(JSON.parse(output)).toMatchObject({ conversation: { state: "failed", reason: read.reason },
    replay: { ok: true, replayed: true, state: "failed", launched: false, reason: read.reason } });
  f.asForeign();
  expect(await f.call("get_conversation", { conversationId: answer.conversationId })).toMatchObject({ ok: false });
  expect(await f.call("request_attention", { clientRequestId: "foreign-launch-attention", target: { kind: "conversation", conversationId: answer.conversationId },
    reason: "Inspect a launch", contextLabel: "Launch failed", waitFor: "accepted" })).toMatchObject({ ok: false });
});

for (const scenario of ["same", "prompt", "account"] as const)
test(`a refused protocol probe reconciles a concurrently admitted request (${scenario})`, async () => {
  const changed = scenario === "prompt";
  const f = await fixture("exit");
  const held = f.holdRefusal();
  const first = f.call("spawn_agent", f.args);
  try {
    await Promise.race([held.ready, first.then(() => { throw new Error("spawn did not wait for its protocol probe"); })]);
    const peer = await f.admitPeer(changed, scenario === "account");
    expect(peer).toMatchObject({ ok: true, state: "starting" });
    held.release();
    const answer = await first;
    if (changed) {
      expect(answer).toMatchObject({ ok: false });
      expect(answer).not.toHaveProperty("conversationId");
    } else {
      expect(answer).toMatchObject({ ok: true, state: "starting", conversationId: peer.conversationId, launchId: peer.launchId });
      expect(await f.call("get_conversation", { conversationId: peer.conversationId })).toMatchObject({ ok: true, evidence: "spawn-receipt" });
    }
    expect(f.work).toHaveLength(1);
    expect(Object.values(f.registry().readOnlySnapshot().receipts)).toHaveLength(1);
  } finally { held.release(); await first; }
});
