import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveSpawnRole } from "@/lib/roles/registry";
import { projectForCwd } from "@/lib/scanner/describe";
import { viewerMcpBindings, viewerMcpRecoverableTools, type CallerAttribution, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, createViewerMcpServer, McpToolRefusal, MemoryMcpReceiptStore, TOOL_INPUT_SCHEMAS } from "./server";

let sandbox: string;
let previousStateDir: string | undefined;
beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-deployer-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const SEAT: CallerAttribution = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };
const WORKER: CallerAttribution = { kind: "agent", conversationId: "conversation_worker", role: "builder" };
const OPERATOR: CallerAttribution = { kind: "gateway", conversationId: "conversation_operator", role: null };

function harness(initialCaller: CallerAttribution = SEAT) {
  let caller = initialCaller;
  let seatAuthorized = true;
  const posts: Record<string, unknown>[] = [];
  const store = new MemoryMcpReceiptStore();
  const domain = {
    callerAttribution: () => caller,
    attentionAuthority: () => caller.kind === "gateway"
      ? { kind: "root", conversationId: caller.conversationId }
      : caller.conversationId ? { kind: "worker", conversationId: caller.conversationId, role: caller.role } : { kind: "unidentified" },
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {} }),
    authorizedSeats: () => seatAuthorized ? [{ conversationId: SEAT.conversationId, path: "seat.jsonl", project: projectForCwd(sandbox) }] : [],
    loadTasks: () => [],
  } as unknown as ViewerMcpDomainDependencies;
  const bindings = viewerMcpBindings(undefined, {
    post: async (_pathname, body) => {
      posts.push(body);
      const resolved = resolveSpawnRole(body);
      if (!resolved.ok) throw new McpToolRefusal(resolved.error, { status: 400 });
      return { launchId: "launch_deployer", conversationId: "conversation_deployer", state: "settled", initialMessage: "delivered" };
    },
  }, domain);
  return {
    bindings, posts, store,
    as: (value: CallerAttribution) => { caller = value; },
    revokeSeat: () => { seatAuthorized = false; },
    service: createMcpToolService(bindings, store, undefined, { recovery: viewerMcpRecoverableTools(domain) }),
  };
}

function deployArgs() {
  return {
    clientRequestId: "spawn-deployer-confirm", cwd: sandbox, title: "Deploy approved release",
    ["prompt"]: "The operator approved deployment of this release.",
    role: "deployer", roleParams: { sha: "a".repeat(40) }, confirm: "deploy",
  };
}

test("spawn_agent advertises the deployer's top-level confirmation and its caller restriction", async () => {
  expect(Object.keys(TOOL_INPUT_SCHEMAS.spawn_agent.shape)).toContain("confirm");
  const { service, posts } = harness();
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "spawn-deployer-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "spawn_agent")!;
    expect(tool.inputSchema.properties).toHaveProperty("confirm");
    expect(tool.description).toContain('confirm: "deploy"');
    expect(tool.description).toContain("designated orchestrator seat");
    expect(tool.description).toContain("operator's own session");
    const response = await client.callTool({ name: "spawn_agent", arguments: deployArgs() });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true, conversationId: "conversation_deployer" });
    expect(posts[0]).toHaveProperty("confirm", "deploy");
  } finally {
    await client.close();
    await server.close();
  }
});

test("a worker's deploy confirmation is refused before a receipt is claimed or anything is dispatched", async () => {
  const { service, posts, store } = harness(WORKER);
  const args = deployArgs();
  const result = await service.callTool("spawn_agent", args);
  expect(result).toMatchObject({ ok: false, code: "deployer_spawn_caller_unauthorized", retryable: false });
  expect(result.error).toContain("designated orchestrator seat");
  expect(posts).toEqual([]);
  expect(await store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
});

test("the original missing confirmation and roleParams.confirm refusals retain the role check's reason", async () => {
  const { bindings } = harness();
  const args = { ...deployArgs(), confirm: undefined };
  await expect(bindings.spawn_agent(args)).rejects.toThrow("deployer requires confirm: deploy");
  await expect(bindings.spawn_agent({ ...args, roleParams: { ...args.roleParams, confirm: "deploy" } }))
    .rejects.toThrow("unknown role parameter: confirm (deployer accepts: sha, pr)");
});

test.each([
  { confirm: undefined, roleParams: { sha: "a".repeat(40) }, reason: "deployer requires confirm: deploy" },
  { confirm: "different", roleParams: { sha: "a".repeat(40) }, reason: "deployer requires confirm: deploy" },
  { confirm: undefined, roleParams: { sha: "a".repeat(40), confirm: "deploy" }, reason: "unknown role parameter: confirm (deployer accepts: sha, pr)" },
])("invalid deploy confirmation is refused before claim and dispatch: %j", async ({ confirm, roleParams, reason }) => {
  const { service, bindings, posts, store } = harness();
  const args = { ...deployArgs(), confirm, roleParams };
  expect(await service.callTool("spawn_agent", args)).toMatchObject({ ok: false, error: reason });
  expect(posts).toEqual([]);
  expect(await store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
  await expect(bindings.spawn_agent(args)).rejects.toThrow(reason);
  expect(posts).toEqual([]);
  // A refused confirmation leaves the key available for the approved call.
  expect(await service.callTool("spawn_agent", deployArgs())).toMatchObject({ ok: true, replayed: false });
  expect(posts).toHaveLength(1);
});

test("the target project's seat passes top-level confirm to the role check and replays the same key once", async () => {
  const { service, posts } = harness();
  const args = deployArgs();
  const first = await service.callTool("spawn_agent", args);
  expect(first).toMatchObject({ ok: true, replayed: false, conversationId: "conversation_deployer" });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ confirm: "deploy", role: "deployer", roleParams: args.roleParams });
  expect(await service.callTool("spawn_agent", args)).toEqual({ ...first, replayed: true });
  expect(await service.callTool("spawn_agent", { ...args, recoveryOnly: true }))
    .toMatchObject({ ok: true, replayed: true, outcome: "settled" });
  expect(posts).toHaveLength(1);
  // Confirmation participates in the existing argument digest.
  expect(await service.callTool("spawn_agent", { ...args, confirm: "different" }))
    .toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(posts).toHaveLength(1);
});

test("the operator's identified own session may confirm a deployer", async () => {
  const { service, posts } = harness(OPERATOR);
  expect(await service.callTool("spawn_agent", deployArgs())).toMatchObject({ ok: true });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toHaveProperty("confirm", "deploy");
});

test("the original caller can replay and recover its deployer receipt after seat rotation, but cannot claim a new key", async () => {
  const { service, bindings, posts, store, as, revokeSeat } = harness();
  const args = deployArgs();
  const first = await service.callTool("spawn_agent", args);
  expect(first).toMatchObject({ ok: true, replayed: false });
  revokeSeat();
  as({ ...WORKER, conversationId: SEAT.conversationId });
  expect(await service.callTool("spawn_agent", args)).toEqual({ ...first, replayed: true });
  expect(await service.callTool("spawn_agent", { ...args, recoveryOnly: true }))
    .toMatchObject({ ok: true, replayed: true, outcome: "settled" });
  expect(await service.callTool("spawn_agent", { ...args, confirm: "different" }))
    .toMatchObject({ ok: false, code: "idempotency_conflict" });
  const fresh = { ...args, clientRequestId: "spawn-deployer-after-rotation" };
  for (const recoveryOnly of [false, true]) {
    expect(await service.callTool("spawn_agent", { ...fresh, recoveryOnly }))
      .toMatchObject({ ok: false, code: "deployer_spawn_caller_unauthorized" });
  }
  expect(await store.lookup(`spawn_agent:${fresh.clientRequestId}`)).toBeNull();
  await expect(bindings.spawn_agent(fresh)).rejects.toThrow("only the target project's designated orchestrator seat");
  expect(posts).toHaveLength(1);
  // Another authenticated conversation cannot read the original owner's receipt.
  as(WORKER);
  for (const recoveryOnly of [false, true]) {
    expect(await service.callTool("spawn_agent", { ...args, recoveryOnly }))
      .toMatchObject({ ok: false, code: "recovery_not_permitted" });
  }
  expect(posts).toHaveLength(1);
});

test.each([
  { kind: "agent", conversationId: "conversation_stage", role: "builder" },
  { kind: "unidentified", conversationId: null, role: null },
  { kind: "gateway", conversationId: null, role: null },
  { kind: "manager", conversationId: "conversation_former_seat", role: "orchestrator" },
  { ...SEAT, via: { deputy: "conversation_deputy" } },
] as CallerAttribution[])("a deployer refuses unauthorized caller %j before claim, including caller-supplied authority", async (caller) => {
  const { service, bindings, posts, store } = harness(caller);
  const args = { ...deployArgs(), parentConversationId: SEAT.conversationId, launcherConversationId: SEAT.conversationId };
  expect(await service.callTool("spawn_agent", args))
    .toMatchObject({ ok: false, code: "deployer_spawn_caller_unauthorized", retryable: false });
  expect(await store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
  await expect(bindings.spawn_agent(args)).rejects.toThrow("only the target project's designated orchestrator seat");
  expect(posts).toEqual([]);
});

test("a seat's deploy confirmation cannot authorize another project, even with crossProjectRequest", async () => {
  const { service, posts, store } = harness();
  const cwd = path.join(sandbox, "other-project");
  fs.mkdirSync(cwd);
  const args = { ...deployArgs(), cwd, crossProjectRequest: "The operator asked to deploy this project directly." };
  expect(await service.callTool("spawn_agent", args))
    .toMatchObject({ ok: false, code: "deployer_spawn_caller_unauthorized" });
  expect(await store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
  expect(posts).toEqual([]);
});

test("a refused worker spends no key, so the same call succeeds after that caller becomes the designated seat", async () => {
  const { service, as, posts, store } = harness({ ...WORKER, conversationId: SEAT.conversationId });
  const args = deployArgs();
  expect(await service.callTool("spawn_agent", args)).toMatchObject({ ok: false });
  expect(await store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
  as(SEAT);
  expect(await service.callTool("spawn_agent", args)).toMatchObject({ ok: true, replayed: false });
  expect(posts).toHaveLength(1);
});

test("other roles ignore confirmation and keep worker admission", async () => {
  const { service, posts } = harness(WORKER);
  const args = { ...deployArgs(), role: "builder", roleParams: {}, confirm: "irrelevant" };
  expect(await service.callTool("spawn_agent", args)).toMatchObject({ ok: true });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ role: "builder", confirm: "irrelevant" });
});
