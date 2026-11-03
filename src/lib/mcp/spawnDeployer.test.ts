import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { attentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { canonicalProject, persistProjectAliases } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { projectForCwd } from "@/lib/scanner/describe";
import { callerAttributionFrom, viewerMcpBindings, viewerMcpRecoverableTools, type CallerAttribution, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, createViewerMcpServer, McpToolRefusal, MemoryMcpReceiptStore, TOOL_INPUT_SCHEMAS } from "./server";

let sandbox: string;
let previousStateDir: string | undefined;
let registry: AgentRegistry;
beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-deployer-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  registry = new AgentRegistry(path.join(sandbox, "registry.json"));
  setAgentRegistryForTests(registry);
});
afterEach(() => {
  registry.close();
  setAgentRegistryForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const SEAT: CallerAttribution = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };
const WORKER: CallerAttribution = { kind: "agent", conversationId: "conversation_worker", role: "builder" };
const OPERATOR: CallerAttribution = { kind: "gateway", conversationId: "conversation_operator", role: null };

function harness(initialCaller: CallerAttribution = SEAT, overrides: Partial<ViewerMcpDomainDependencies> = {}) {
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
    ...overrides,
  } as unknown as ViewerMcpDomainDependencies;
  const bindings = viewerMcpBindings(undefined, {
    post: async (_pathname, body) => {
      posts.push(body);
      const resolved = resolveSpawnRole(body);
      if (!resolved.ok) throw new McpToolRefusal(resolved.error, { status: 400 });
      return { launchId: "launch_deployer", conversationId: "conversation_deployer", state: "settled", initialMessage: "delivered" };
    },
  }, domain);
  const recovery = viewerMcpRecoverableTools(domain);
  return {
    bindings, posts, store, recovery,
    as: (value: CallerAttribution) => { caller = value; },
    revokeSeat: () => { seatAuthorized = false; },
    service: createMcpToolService(bindings, store, undefined, { recovery }),
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
    .rejects.toThrow("unknown role parameter: confirm (deployer accepts: sha, mode, pr)");
});

test.each([
  { confirm: undefined, roleParams: { sha: "a".repeat(40) }, reason: "deployer requires confirm: deploy" },
  { confirm: "different", roleParams: { sha: "a".repeat(40) }, reason: "deployer requires confirm: deploy" },
  { confirm: undefined, roleParams: { sha: "a".repeat(40), confirm: "deploy" }, reason: "unknown role parameter: confirm (deployer accepts: sha, mode, pr)" },
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

const ALIAS_TARGET = "repo-11111111111111111111111111111111";
const ALIAS_MIDDLE = "repo-22222222222222222222222222222222";
const FOREIGN_PROJECT = "repo-33333333333333333333333333333333";
const SEATED_AT = "2026-01-01T00:00:00.000Z";

function designate(project: string, conversationId: string, key = "fixture-designation") {
  beginOrchestratorSeatIntent({ project, conversationId, mandate: "Own this board", clientRequestId: key, mode: "existing", now: SEATED_AT });
  expect(completeOrchestratorSeatIntent({ project, conversationId, clientRequestId: key, path: null,
    preparedAuthCredentialBaseline: null, now: SEATED_AT }).kind).toBe("activated");
}

/** Real alias store, designation reader and manager validation. Only kernel and
 * registry facts are supplied; no caller label or authorized-seat list is supplied. */
function aliasHarness(direction: "cwd" | "seat" | "chain" = "cwd") {
  fs.mkdirSync(path.join(sandbox, ".git"));
  fs.writeFileSync(path.join(sandbox, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(sandbox, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/fixture.git\n');
  const cwdProject = projectForCwd(sandbox)!;
  const project = direction === "seat" ? cwdProject : ALIAS_TARGET;
  const storedProject = direction === "seat" ? ALIAS_TARGET : project;
  designate(storedProject, SEAT.conversationId!);
  const registrations = direction === "chain"
    ? [{ source: cwdProject, target: ALIAS_MIDDLE }, { source: ALIAS_MIDDLE, target: project }]
    : [{ source: direction === "seat" ? ALIAS_TARGET : cwdProject, target: project }];
  expect(persistProjectAliases(registrations.map(row => ({ ...row, displayName: "Deployment fixture" })))).toBe(true);
  let callerId = SEAT.conversationId!;
  let factsProject = storedProject;
  let superseded = false;
  let hasGeneration = true;
  let known = true;
  let conflict = false;
  let deputy = false;
  const registry = {
    conversationAuthorityFacts: (id: string) => id === SEAT.conversationId && known
      ? { project: factsProject, superseded, hasGeneration, directories: [sandbox] } : null,
    canonicalConversationId: (id: string) => id,
  } as unknown as AgentRegistry;
  const seats = () => authorizedManagerSeats(productionManagerAuthoritySources(registry));
  const authority = () => attentionCallerAuthority({
    ancestry: () => [101, 100],
    hosted: () => [{ conversationId: callerId, pids: [100], role: "orchestrator" }],
    rootConversationId: () => "conversation_operator",
    capabilityPresented: () => true,
    capabilityCallerConversationId: () => conflict ? "conversation_conflict" : callerId,
  });
  const attribution = () => callerAttributionFrom(authority(), id => seats().some(seat => seat.conversationId === id),
    () => deputy ? SEAT.conversationId : null);
  const h = harness(SEAT, { authorizedSeats: seats, attentionAuthority: authority, callerAttribution: attribution });
  return { ...h, cwdProject, project, seats, attribution,
    caller: (id: string) => { callerId = id; },
    facts: (value: { project?: string; superseded?: boolean; hasGeneration?: boolean; known?: boolean; conflict?: boolean; deputy?: boolean }) => {
      factsProject = value.project ?? factsProject;
      superseded = value.superseded ?? superseded;
      hasGeneration = value.hasGeneration ?? hasGeneration;
      known = value.known ?? known;
      conflict = value.conflict ?? conflict;
      deputy = value.deputy ?? deputy;
    },
    rotate: () => designate(project, "conversation_successor", "fixture-rotation"),
  };
}

for (const direction of ["cwd", "seat", "chain"] as const) {
  test(`validated seat and read lookup agree with deployer admission through ${direction} aliases`, async () => {
    const h = aliasHarness(direction);
    expect(h.attribution()).toMatchObject({ kind: "manager", conversationId: SEAT.conversationId });
    expect(h.seats()).toEqual([{ conversationId: SEAT.conversationId, path: null, project: h.project }]);
    for (const project of [h.cwdProject, ALIAS_TARGET]) {
      expect(await h.service.callTool("get_orchestrator", { project })).toMatchObject({ ok: true, designated: true,
        conversationId: SEAT.conversationId });
    }
    const args = deployArgs();
    expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: true, replayed: false });
    expect(await h.store.lookup(`spawn_agent:${args.clientRequestId}`)).toMatchObject({ binding: {
      caller: { conversationId: SEAT.conversationId }, target: { identity: sandbox },
    } });
    expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: true, replayed: true });
    expect(h.posts).toHaveLength(1);
  });

  test(`explicit project names agree with the cwd through ${direction} aliases`, async () => {
    const h = aliasHarness(direction);
    for (const [index, project] of [h.cwdProject, ALIAS_TARGET, "Deployment fixture"].entries()) {
      const args = { ...deployArgs(), project, clientRequestId: `alias-explicit-${index}` };
      expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: true, replayed: false });
    }
    expect(h.posts).toHaveLength(3);
  });
}

test.each(["worker", "unknown", "superseded", "no-generation", "cross-project", "conflicting-evidence", "deputy", "revoked", "conflicting-seats"])(
  "aliases grant no deployer authority to %s, even with supplied parent and root identities", async (scenario) => {
    const h = aliasHarness();
    if (scenario === "worker" || scenario === "deputy") h.caller("conversation_worker");
    if (scenario === "unknown") h.facts({ known: false });
    if (scenario === "superseded") h.facts({ superseded: true });
    if (scenario === "no-generation") h.facts({ hasGeneration: false });
    if (scenario === "cross-project") h.facts({ project: FOREIGN_PROJECT });
    if (scenario === "conflicting-evidence") h.facts({ conflict: true });
    if (scenario === "deputy") h.facts({ deputy: true });
    if (scenario === "revoked") h.rotate();
    if (scenario === "conflicting-seats") designate(FOREIGN_PROJECT, SEAT.conversationId!, "conflicting-seat");
    const args = { ...deployArgs(), parentConversationId: SEAT.conversationId, launcherConversationId: SEAT.conversationId,
      rootConversationId: "conversation_operator", callerAttribution: SEAT, crossProjectRequest: "Deploy this project" };
    expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: false, code: "deployer_spawn_caller_unauthorized" });
    expect(await h.store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
    await expect(h.bindings.spawn_agent(args)).rejects.toThrow("only the target project's designated orchestrator seat");
    expect(h.posts).toEqual([]);
  },
);

test("an alias permits receipt recovery after revocation without renewing launch authority", async () => {
  const h = aliasHarness();
  const args = deployArgs();
  const first = await h.service.callTool("spawn_agent", args);
  expect(first).toMatchObject({ ok: true });
  h.rotate();
  expect(h.attribution().kind).toBe("agent");
  for (const recoveryOnly of [false, true]) {
    expect(await h.service.callTool("spawn_agent", { ...args, recoveryOnly })).toMatchObject({ ok: true, replayed: true });
    const fresh = { ...args, clientRequestId: "alias-after-rotation", recoveryOnly };
    expect(await h.service.callTool("spawn_agent", fresh)).toMatchObject({ ok: false, code: "deployer_spawn_caller_unauthorized" });
    expect(await h.store.lookup(`spawn_agent:${fresh.clientRequestId}`)).toBeNull();
  }
  h.caller("conversation_worker");
  expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: false, code: "recovery_not_permitted" });
  expect(h.posts).toHaveLength(1);
});

test("revocation after a deployer claim is rechecked before dispatch through an alias", async () => {
  const h = aliasHarness();
  const claim = h.store.claim.bind(h.store);
  let claims = 0;
  h.store.claim = async (...args) => {
    claims += 1;
    const result = await claim(...args);
    h.rotate();
    return result;
  };
  expect(await h.service.callTool("spawn_agent", deployArgs())).toMatchObject({ ok: false, details: {
    code: "deployer_spawn_caller_unauthorized", outcome: "not-executed", evidence: "dispatch-refused",
  } });
  expect(claims).toBe(1);
  expect(h.posts).toEqual([]);
});

test.each(["unknown", "ambiguous", "unrelated", "cycle"])("%s project evidence stays refused before claim", async (scenario) => {
  const h = aliasHarness();
  let project = "missing-project";
  if (scenario === "unrelated" || scenario === "ambiguous") {
    designate(FOREIGN_PROJECT, "conversation_foreign", "foreign-seat");
    expect(persistProjectAliases([{ source: "foreign-name", target: FOREIGN_PROJECT,
      displayName: scenario === "ambiguous" ? "Deployment fixture" : "Foreign fixture" }])).toBe(true);
    project = scenario === "ambiguous" ? "Deployment fixture" : FOREIGN_PROJECT;
  }
  if (scenario === "cycle") {
    // A corrupt historical map must not make two different cycle members equal.
    projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), () => ({
      next: { aliases: { [h.cwdProject]: ALIAS_TARGET, [ALIAS_TARGET]: h.cwdProject }, displayNames: {} }, result: undefined,
    }));
    expect(canonicalProject(h.cwdProject)).toBe(h.cwdProject);
    expect(canonicalProject(ALIAS_TARGET)).toBe(ALIAS_TARGET);
    project = ALIAS_TARGET;
  }
  const args = { ...deployArgs(), project, crossProjectRequest: "Deploy this project" };
  expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: false });
  expect(await h.store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
  await expect(h.bindings.spawn_agent(args)).rejects.toThrow();
  expect(h.posts).toEqual([]);
  expect(orchestratorSeatFor(ALIAS_TARGET).active?.conversationId).toBe(SEAT.conversationId);
});

test("the validated operator's own session can launch through an alias", async () => {
  const h = aliasHarness();
  h.caller("conversation_operator");
  expect(h.attribution()).toMatchObject({ kind: "gateway", conversationId: "conversation_operator" });
  expect(await h.service.callTool("spawn_agent", deployArgs())).toMatchObject({ ok: true });
  expect(h.posts).toHaveLength(1);
});

test("revocation after binding refuses an alias launch before the claim", async () => {
  const h = aliasHarness();
  const bind = h.recovery.spawn_agent!.bind;
  h.recovery.spawn_agent!.bind = async args => {
    const binding = await bind(args);
    h.rotate();
    return binding;
  };
  const args = deployArgs();
  expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: false, code: "deployer_spawn_caller_unauthorized" });
  expect(await h.store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
  expect(h.posts).toEqual([]);
});

test("an unrecognized repository key remains unrelated even when the caller supplies its seat project", async () => {
  const h = aliasHarness();
  projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), () => ({
    next: { aliases: {}, displayNames: {} }, result: undefined,
  }));
  expect(h.attribution().kind).toBe("manager");
  for (const project of [undefined, ALIAS_TARGET]) {
    const args = { ...deployArgs(), project, crossProjectRequest: "Deploy this project" };
    expect(await h.service.callTool("spawn_agent", args)).toMatchObject({ ok: false });
    expect(await h.store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
    await expect(h.bindings.spawn_agent(args)).rejects.toThrow();
  }
  expect(h.posts).toEqual([]);
});


test("the shared pipeline binding resolves a trusted cwd alias and still rejects contradictory names", async () => {
  const h = aliasHarness();
  const args = { clientRequestId: "alias-pipeline-binding", repoDir: sandbox, project: ALIAS_TARGET };
  expect(await h.recovery.create_pipeline!.bind(args)).toMatchObject({
    caller: { conversationId: SEAT.conversationId }, target: { project: h.cwdProject, identity: sandbox },
  });
  designate(FOREIGN_PROJECT, "conversation_foreign", "foreign-seat");
  await expect(h.recovery.create_pipeline!.bind({ ...args, project: FOREIGN_PROJECT, crossProjectRequest: "Work here" }))
    .rejects.toThrow("project contradicts the canonical project of repoDir");
  expect(h.posts).toEqual([]);
});
