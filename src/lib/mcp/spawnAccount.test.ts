import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { POST } from "@/app/api/spawn/route";
import { AgentRegistry } from "@/lib/agent/registry";
import { BINDINGS_SOURCE, resetAccountCollectionsForTests } from "@/lib/accounts/accountsStore";
import { clearAccountFixture, seedAccountSource } from "@/lib/accounts/accountsStoreFixture";
import { projectForCwd } from "@/lib/scanner/describe";
import { viewerMcpBindings, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, createViewerMcpServer, McpToolRefusal, MemoryMcpReceiptStore } from "./server";

const fixture = () => crypto.randomUUID();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-account-"));
let testNumber = 0;
let previousState: string | undefined;
let previousCodexBinary: string | undefined;
let previousRuntimeSocket: string | undefined;
let registry: AgentRegistry;

{
  previousState = process.env.LLV_STATE_DIR;
  previousCodexBinary = process.env.LLV_CODEX_BINARY;
  previousRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(sandbox, "account"));
  const binary = path.join(sandbox, "codex-fixture");
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; elif [ "$3 $4" = "mcp list" ]; then echo "[]"; else exit 1; fi\n', { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = binary;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "unused-runtime.sock");
}

beforeEach(async () => {
  /* A team claimed by an earlier test must not turn a later owner call into a sign-in demand. */
  (await import("@/lib/team/store")).resetTeamStoreForTests();
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "team"), { recursive: true, force: true });
  resetAccountCollectionsForTests();
  clearAccountFixture(BINDINGS_SOURCE);
  registry?.close();
  registry = new AgentRegistry(path.join(sandbox, `registry-${++testNumber}.json`), undefined, undefined, { sqliteMode: "off" });
});

afterAll(() => {
  registry.close();
  resetAccountCollectionsForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
  else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  if (previousRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = previousRuntimeSocket;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function bind(accounts: string[]) {
  seedAccountSource(BINDINGS_SOURCE, {
    schemaVersion: 1,
    bindings: accounts.map(accountId => ({ engine: "codex", accountId, project: projectForCwd(sandbox), createdAt: "2026-10-01T00:00:00.000Z" })),
  });
}

function harness() {
  let resolvedAccount: string | undefined;
  const resolutions: { requested: string | null | undefined; project: string | null | undefined }[] = [];
  const accountContext = (accountId: string) => ({
    engine: "codex" as const, accountId, kind: "managed" as const,
    home: path.join(sandbox, "account"), transcriptRoot: path.join(sandbox, "sessions"), env: { NODE_ENV: "test" as const },
  });
  const routeDependencies: NonNullable<Parameters<typeof POST.withDependencies>[1]> = {
    ...POST.productionDependencies,
    registry: () => registry,
    assertStructuredRuntime: () => {},
    engineReadiness: () => "connected",
    autonomousStructured: true,
    runtimeHostClient: () => ({} as ReturnType<typeof POST.productionDependencies.runtimeHostClient>),
    resolveSpawnAccount: (_engine, accountId) => accountContext(accountId ?? "account-a"),
    resolveHealthySpawnAccount: async (_engine, requested, project) => {
      resolutions.push({ requested, project });
      return accountContext(resolvedAccount ?? requested ?? "account-a");
    },
    storeImages: () => [],
    defer: () => {},
    spawnStructuredConversation: async () => { throw new Error("a real agent must never launch"); },
  };
  const bindings = viewerMcpBindings(undefined, {
    post: async (pathname, body, headers) => {
      const response = await POST.withDependencies(new NextRequest(`http://127.0.0.1${pathname}`, {
        method: "POST", headers: { ...headers, host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify(body),
      }), routeDependencies);
      const payload = await response.json();
      if (!response.ok) throw new McpToolRefusal(payload.error, { status: response.status, code: payload.code });
      return payload;
    },
  }, {
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_seat", role: "orchestrator" }),
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {} }),
    authorizedSeats: () => [{ conversationId: "conversation_seat", path: "seat.jsonl", project: projectForCwd(sandbox) }],
    loadTasks: () => [],
  } as unknown as ViewerMcpDomainDependencies);
  return { bindings, routeDependencies, resolutions, resolveAs: (account: string) => { resolvedAccount = account; } };
}

async function withClient(run: (client: Client, fixture: ReturnType<typeof harness>) => Promise<void>) {
  const fixture = harness();
  const server = createViewerMcpServer(createMcpToolService(fixture.bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "spawn-account-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client, fixture); }
  finally { await client.close(); await server.close(); }
}

function requestId() { return `spawn-account-fixture-${testNumber}`; }

function args(account?: string | null) {
  return { clientRequestId: requestId(), cwd: sandbox, title: "Inspect account routing", ["prompt"]: "Inspect routing", engine: "codex", model: "gpt-6.1-sol", ...(account === undefined ? {} : { account }) };
}

test("an MCP account pin reaches the spawn route and its durable launch receipt", async () => {
  bind(["account-a", "account-b"]);
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(resolutions).toEqual([{ requested: "account-b", project: projectForCwd(sandbox) }]);
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-b", accountPin: true });
  });
});

test("the MCP spawn route refuses an account outside the target project's binding before reservation", async () => {
  bind(["account-a"]);
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(response.structuredContent).toMatchObject({ ok: false, details: { status: 409, code: "project_account_refused" } });
    const payload = response.structuredContent as { error: string };
    expect(payload.error).toContain("account-a");
    expect(payload.error).toContain("account-b");
    expect(resolutions).toEqual([]);
    expect(registry.spawnReceiptForClientAttempt(requestId())).toBeNull();
  });
});

test("an advertised account pin cannot reserve a launch onto a resolver fallback", async () => {
  bind(["account-a", "account-b"]);
  await withClient(async (client, { resolveAs }) => {
    resolveAs("account-a");
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(response.structuredContent).toMatchObject({ ok: true, state: "failed", launched: false, outcome: "settled" });
    expect(registry.spawnReceiptForClientAttempt(requestId())?.state).toBe("failed");
  });
});

test.each([null, undefined])("account %j leaves selection to the target project and records the selected account", async account => {
  bind(["account-a"]);
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args(account) });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(resolutions).toEqual([{ requested: undefined, project: projectForCwd(sandbox) }]);
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-a", accountPin: false });
  });
});

test("an unbound target project accepts a named account", async () => {
  await withClient(async client => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-b" });
  });
});

test.each(["merger", "deployer", "reviewer"])("a %s preset honours the advertised account", async role => {
  bind(["account-a", "account-b"]);
  const reviewed = registry.ensureConversation("codex", path.join(sandbox, "reviewed.jsonl"), "account-a");
  const roleArgs = role === "merger" ? { roleParams: { prs: `1@${"a".repeat(40)}` } }
    : role === "deployer" ? { roleParams: { sha: "a".repeat(40) }, confirm: "deploy" }
    : { roleParams: { diffSource: "PR #1" }, reviews: reviewed.id };
  await withClient(async client => {
    const response = await client.callTool({ name: "spawn_agent", arguments: { ...args("account-b"), role, ...roleArgs } });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-b", agentRole: role });
  });
});

test("a pin replays once and a changed account conflicts with the original MCP request", async () => {
  bind(["account-a", "account-b"]);
  await withClient(async (client, { resolutions }) => {
    const request = { name: "spawn_agent", arguments: args("account-b") };
    expect((await client.callTool(request)).structuredContent).toMatchObject({ ok: true, replayed: false });
    expect((await client.callTool(request)).structuredContent).toMatchObject({ ok: true, replayed: true });
    expect((await client.callTool({ ...request, arguments: args("account-a") })).structuredContent)
      .toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(resolutions).toHaveLength(1);
  });
});

test.each([42, {}, true])("invalid account %j is refused at the MCP schema before dispatch", async account => {
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: { ...args(), account } });
    expect(response.isError).toBe(true);
    expect(resolutions).toEqual([]);
    expect(registry.spawnReceiptForClientAttempt(requestId())).toBeNull();
  });
});

test("conflicting advertised and legacy accounts are refused by the spawn route", async () => {
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: { ...args("account-b"), accountId: "account-a" } });
    expect(response.structuredContent).toMatchObject({ ok: false, error: "account and accountId must agree", details: { status: 400 } });
    expect(resolutions).toEqual([]);
  });
});

test("the spawn HTTP route validates account without relying on the MCP schema", async () => {
  const { routeDependencies, resolutions } = harness();
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ ...args(), clientAttemptId: requestId(), account: 42 }),
  }), routeDependencies);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "account must be a string or null" });
  expect(resolutions).toEqual([]);
});

test("a workspace launch uses its default account pool and refuses an explicit pin outside it", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { claimInstall } = await import("@/lib/team/members");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { setWorkspaceDefaults } = await import("@/lib/team/workspaceDefaults");
  const { selectProjectAccount } = await import("@/lib/accounts/projectSelection");
  const { mintSession } = await import("@/lib/team/sessions");
  const team = teamStore();
  const owner = claimInstall(team, "Owner", { surface: "desktop", browser: "chrome" }, Date.parse("2026-10-20T09:00:00Z")).member;
  const id = `w_${"a".repeat(32)}`;
  createWorkspace(team, owner, { id, name: "Alpha", projects: [projectForCwd(sandbox)!] });
  await setWorkspaceDefaults(team, owner, id, { accounts: { codex: ["account-b"] } });
  try {
    await withClient(async (client, { routeDependencies }) => {
      const resolve = routeDependencies.resolveSpawnAccount;
      routeDependencies.resolveHealthySpawnAccount = async (engine, requested, project) => {
        const selected = selectProjectAccount({ engine, project: project ?? null, accounts: [{ id: "account-a", authPresent: true }, { id: "account-b", authPresent: true }],
          observations: [], bindings: [], requestedId: requested, preferredId: "account-a", unbound: "engine-default" });
        if (selected.kind !== "available") throw new Error("no account allowed");
        return resolve(engine, selected.accountId);
      };
      expect((await client.callTool({ name: "spawn_agent", arguments: args() })).structuredContent).toMatchObject({ ok: true });
      expect(registry.spawnReceiptForClientAttempt(requestId())?.accountId).toBe("account-b");
      const rejected = await client.callTool({ name: "spawn_agent", arguments: { ...args("account-a"), clientRequestId: `${requestId()}-denied` } });
      expect(rejected.structuredContent).toMatchObject({ ok: false, details: { code: "project_account_refused" } });
      expect(registry.spawnReceiptForClientAttempt(`${requestId()}-denied`)).toBeNull();
      const memberId = "m_workspace_member";
      team.insertMember({ id: memberId, name: "Member", role: "member", status: "active", color: "teal", telegram: null,
        createdAt: "2026-10-20T09:00:00.000Z", createdBy: owner.id, revokedAt: null });
      team.putWorkspaceMember(id, memberId, "member", owner.id, "2026-10-20T09:00:00.000Z");
      const cookie = mintSession(team, memberId, "claim", { surface: "desktop", browser: "chrome" }).value;
      const direct = (clientAttemptId: string, accountId?: string) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
        method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `llv_member=${cookie}` },
        body: JSON.stringify({ ...args(), clientAttemptId, ...(accountId ? { accountId } : {}) }),
      }), routeDependencies);
      const refused = await direct("workspace-member-pin-refused", "account-a");
      expect({ status: refused.status, body: await refused.json() }).toMatchObject({ status: 409, body: { code: "project_account_refused" } });
      expect(registry.spawnReceiptForClientAttempt("workspace-member-pin-refused")).toBeNull();
      expect((await direct("workspace-member-pin-accepted", "account-b")).status).toBe(202);
      expect(registry.spawnReceiptForClientAttempt("workspace-member-pin-accepted")?.launchProfile.workspace).toEqual({ memberId, workspaceId: id });
      const select = routeDependencies.resolveHealthySpawnAccount;
      routeDependencies.resolveHealthySpawnAccount = async (...input) => {
        const selected = await select(...input);
        await setWorkspaceDefaults(team, owner, id, { accounts: { codex: ["account-a"] } });
        return selected;
      };
      expect((await direct("workspace-member-pool-edited")).status).toBe(409);
      expect(registry.spawnReceiptForClientAttempt("workspace-member-pool-edited")).toBeNull();
    });
  } finally { resetTeamStoreForTests(); }
});

test("a member's launch that names an account is refused where the project has no account list, and says the same for any account", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { claimInstall } = await import("@/lib/team/members");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { mintSession } = await import("@/lib/team/sessions");
  const team = teamStore();
  const owner = claimInstall(team, "Owner", { surface: "desktop", browser: "chrome" }, Date.parse("2026-10-20T09:00:00Z")).member;
  const id = `w_${"c".repeat(32)}`;
  createWorkspace(team, owner, { id, name: "Alpha", projects: [projectForCwd(sandbox)!] });
  const memberId = "m_no_list_member";
  team.insertMember({ id: memberId, name: "Member", role: "member", status: "active", color: "teal", telegram: null,
    createdAt: "2026-10-20T09:00:00.000Z", createdBy: owner.id, revokedAt: null });
  team.putWorkspaceMember(id, memberId, "member", owner.id, "2026-10-20T09:00:00.000Z");
  const cookie = mintSession(team, memberId, "claim", { surface: "desktop", browser: "chrome" }).value;
  try {
    await withClient(async (client, { routeDependencies, resolutions }) => {
      const direct = (clientAttemptId: string, accountId?: string) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
        method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `llv_member=${cookie}` },
        body: JSON.stringify({ ...args(), clientAttemptId, ...(accountId ? { accountId } : {}) }),
      }), routeDependencies);
      /* One account that exists and one that never did: the same answer, decided before any account is read. */
      const answers: { status: number; body: { error: string; code: string; reason: string } }[] = [];
      for (const [attempt, account] of [["no-list-existing", "account-a"], ["no-list-unknown", "account-zzz"]] as const) {
        const response = await direct(attempt, account);
        answers.push({ status: response.status, body: await response.json() });
        expect(registry.spawnReceiptForClientAttempt(attempt)).toBeNull();
      }
      expect(answers[0]).toMatchObject({ status: 409, body: { code: "project_account_refused", reason: "no_account_list" } });
      expect(answers[1]!.status).toBe(answers[0]!.status);
      expect(answers[1]!.body.code).toBe(answers[0]!.body.code);
      expect(answers[1]!.body.reason).toBe(answers[0]!.body.reason);
      expect(answers[1]!.body.error.replaceAll("account-zzz", "account-a")).toBe(answers[0]!.body.error);
      expect(resolutions).toEqual([]);
      /* No account named: Delegatus picks, as before. */
      expect((await direct("no-list-automatic")).status).toBe(202);
      expect(registry.spawnReceiptForClientAttempt("no-list-automatic")?.launchProfile.workspace).toEqual({ memberId, workspaceId: id });
      /* An agent bound to the member is refused the same way through spawn_agent. */
      routeDependencies.workspacePrincipal = { memberId, workspaceId: id };
      const refused = await client.callTool({ name: "spawn_agent", arguments: { ...args("account-a"), clientRequestId: `${requestId()}-agent` } });
      expect(refused.structuredContent).toMatchObject({ ok: false, details: { status: 409, code: "project_account_refused" } });
      expect(registry.spawnReceiptForClientAttempt(`${requestId()}-agent`)).toBeNull();
      /* The owner, with no member principal, still names any account. */
      routeDependencies.workspacePrincipal = null;
      expect((await client.callTool({ name: "spawn_agent", arguments: { ...args("account-a"), clientRequestId: `${requestId()}-owner` } })).structuredContent).toMatchObject({ ok: true });
    });
  } finally { resetTeamStoreForTests(); }
});

test("a pin outside a set pool is refused with the reason that says so", async () => {
  bind(["account-b"]);
  const { routeDependencies } = harness();
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ ...args("account-a"), clientAttemptId: "owner-outside-pool" }),
  }), routeDependencies);
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 409, body: { code: "project_account_refused", reason: "outside_account_list" } });
});

test("an automatic launch by a member with no account list reveals no account in a service tier refusal, and the owner's refusal still lists them", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { claimInstall } = await import("@/lib/team/members");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { mintSession } = await import("@/lib/team/sessions");
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const team = teamStore();
  const owner = claimInstall(team, "Owner", { surface: "desktop", browser: "chrome" }, Date.parse("2026-10-20T09:00:00Z")).member;
  const id = `w_${"8".repeat(32)}`;
  createWorkspace(team, owner, { id, name: "Alpha", projects: [projectForCwd(sandbox)!] });
  const memberId = "m_tier_member";
  team.insertMember({ id: memberId, name: "Member", role: "member", status: "active", color: "teal", telegram: null,
    createdAt: "2026-10-20T09:00:00.000Z", createdBy: owner.id, revokedAt: null });
  team.putWorkspaceMember(id, memberId, "member", owner.id, "2026-10-20T09:00:00.000Z");
  const memberCookie = mintSession(team, memberId, "claim", { surface: "desktop", browser: "chrome" }).value;
  const ownerCookie = mintSession(team, owner.id, "claim", { surface: "desktop", browser: "chrome" }).value;
  const hidden = createManagedCodexAccount("Hidden Account Label");
  fs.writeFileSync(path.join(hidden.home, "auth.json"), "{}");
  fs.writeFileSync(path.join(hidden.home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", service_tiers: [] }] }));
  try {
    const { routeDependencies } = harness();
    /* The real resolver: its tier refusal is the one that lists accounts. */
    routeDependencies.resolveHealthySpawnAccount = (await import("@/lib/accounts/manager")).resolveHealthySpawnAccount;
    const launch = async (clientAttemptId: string, cookie: string) => {
      const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
        method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `llv_member=${cookie}` },
        body: JSON.stringify({ ...args(), clientAttemptId, model: "gpt-6.1-sol", effort: "high", serviceTier: "ultrafast" }),
      }), routeDependencies);
      return { status: response.status, body: await response.json() as { error: string; code: string } };
    };
    const member = await launch("tier-member", memberCookie);
    expect(member).toEqual({ status: 409, body: { code: "service_tier_unavailable", error: "no account offers serviceTier ultrafast for model gpt-6.1-sol" } });
    expect(JSON.stringify(member.body)).not.toContain(hidden.label);
    expect(JSON.stringify(member.body)).not.toContain(hidden.id);
    expect(registry.spawnReceiptForClientAttempt("tier-member")).toBeNull();
    const operator = await launch("tier-owner", ownerCookie);
    expect(operator.status).toBe(409);
    expect(operator.body.error).toContain(hidden.label);
    expect(operator.body.error).toContain(hidden.id);
  } finally { resetTeamStoreForTests(); }
});

test("a member's automatic launch refused for capacity names no account and no limit window, and the owner's refusal keeps them", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { claimInstall } = await import("@/lib/team/members");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { mintSession } = await import("@/lib/team/sessions");
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const team = teamStore();
  const owner = claimInstall(team, "Owner", { surface: "desktop", browser: "chrome" }, Date.parse("2026-10-20T09:00:00Z")).member;
  const id = `w_${"8".repeat(32)}`;
  createWorkspace(team, owner, { id, name: "Alpha", projects: [projectForCwd(sandbox)!] });
  const memberId = "m_tier_member";
  team.insertMember({ id: memberId, name: "Member", role: "member", status: "active", color: "teal", telegram: null,
    createdAt: "2026-10-20T09:00:00.000Z", createdBy: owner.id, revokedAt: null });
  team.putWorkspaceMember(id, memberId, "member", owner.id, "2026-10-20T09:00:00.000Z");
  const memberCookie = mintSession(team, memberId, "claim", { surface: "desktop", browser: "chrome" }).value;
  const ownerCookie = mintSession(team, owner.id, "claim", { surface: "desktop", browser: "chrome" }).value;
  const hidden = createManagedCodexAccount("Hidden Account Label");
  fs.writeFileSync(path.join(hidden.home, "auth.json"), "{}");
  fs.writeFileSync(path.join(hidden.home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", service_tiers: [] }] }));
  try {
    const { routeDependencies } = harness();
    /* The real resolver: its tier refusal is the one that lists accounts. */
    routeDependencies.resolveHealthySpawnAccount = async () => { const { ProjectAccountRefusedError } = await import("@/lib/accounts/manager"); throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt: null, allowedAccountIds: [hidden.id] }, "codex", projectForCwd(sandbox)); };
    const launch = async (clientAttemptId: string, cookie: string) => {
      const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
        method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `llv_member=${cookie}` },
        body: JSON.stringify({ ...args(), clientAttemptId, model: "gpt-6.1-sol", effort: "high", serviceTier: "ultrafast" }),
      }), routeDependencies);
      return { status: response.status, body: await response.json() as { error: string; code: string } };
    };
    const member = await launch("tier-member", memberCookie);
    expect(member.status).toBe(409);
    expect(JSON.stringify(member.body)).not.toContain(hidden.label);
    expect(JSON.stringify(member.body)).not.toContain(hidden.id);
    expect(registry.spawnReceiptForClientAttempt("tier-member")).toBeNull();
    const operator = await launch("tier-owner", ownerCookie);
    expect(operator.status).toBe(409);
    expect(operator.body.error).toContain(hidden.id);
    expect(member.body.error).not.toContain("resetsAt");
    expect(member.body.error).not.toMatch(/allowed codex accounts/);
  } finally { resetTeamStoreForTests(); }
});

test("a member's automatic launch refused by the real selection with every account at its limit names no account and no reset time, and no launch is created", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { claimInstall } = await import("@/lib/team/members");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { mintSession } = await import("@/lib/team/sessions");
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const team = teamStore();
  const owner = claimInstall(team, "Owner", { surface: "desktop", browser: "chrome" }, Date.parse("2026-10-20T09:00:00Z")).member;
  const id = `w_${"8".repeat(32)}`;
  createWorkspace(team, owner, { id, name: "Alpha", projects: [projectForCwd(sandbox)!] });
  const memberId = "m_tier_member";
  team.insertMember({ id: memberId, name: "Member", role: "member", status: "active", color: "teal", telegram: null,
    createdAt: "2026-10-20T09:00:00.000Z", createdBy: owner.id, revokedAt: null });
  team.putWorkspaceMember(id, memberId, "member", owner.id, "2026-10-20T09:00:00.000Z");
  const memberCookie = mintSession(team, memberId, "claim", { surface: "desktop", browser: "chrome" }).value;
  const ownerCookie = mintSession(team, owner.id, "claim", { surface: "desktop", browser: "chrome" }).value;
  const hidden = createManagedCodexAccount("Hidden Account Label");
  fs.writeFileSync(path.join(hidden.home, "auth.json"), "{}");
  fs.writeFileSync(path.join(hidden.home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", service_tiers: [] }] }));
  try {
    const { routeDependencies } = harness();
    /* The real resolver: its tier refusal is the one that lists accounts. */
    routeDependencies.resolveHealthySpawnAccount = (await import("@/lib/accounts/manager")).resolveHealthySpawnAccount;
    const liveRegistry = (await import("@/lib/agent/registry")).agentRegistry();
    const now = new Date().toISOString();
    /* Every codex account this file created is at its limit, so no sibling's lack of an observation can win the selection. */
    const { listCodexAccounts } = await import("@/lib/accounts/codex");
    for (const account of listCodexAccounts()) liveRegistry.recordQuotaObservation({ engine: "codex", accountId: account.id, authenticated: true,
      authCheckedAt: now, observedAt: now, bootId: "fixture-boot", provenance: { source: "live", reason: null, staleSince: null },
      limits: { plan: "pro", session: { usedPercent: 100, resetsAt: Math.floor(Date.now()/1000)+3600 }, weekly: { usedPercent: 100, resetsAt: Math.floor(Date.now()/1000)+86400 }, tiers: [], capturedAt: Math.floor(Date.now()/1000) } });
    const launch = async (clientAttemptId: string, cookie: string) => {
      const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
        method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `llv_member=${cookie}` },
        body: JSON.stringify({ ...args(), clientAttemptId, model: "gpt-6.1-sol", effort: "high" }),
      }), routeDependencies);
      return { status: response.status, body: await response.json() as { error: string; code: string } };
    };
    const member = await launch("tier-member", memberCookie);
    expect(member).toMatchObject({ status: 409, body: { code: "project_account_refused" } });
    expect(JSON.stringify(member.body)).not.toContain(hidden.label);
    expect(JSON.stringify(member.body)).not.toContain(hidden.id);
    expect(registry.spawnReceiptForClientAttempt("tier-member")).toBeNull();
    const operator = await launch("tier-owner", ownerCookie);
    expect(operator.status).toBe(409);
    expect(operator.body.error).toContain(hidden.id);
    expect(operator.body.error).toContain("resetsAt=");
    expect(member.body.error).not.toContain("resetsAt");
    expect(member.body.error).not.toMatch(/allowed codex accounts/);
  } finally { resetTeamStoreForTests(); }
});

test("a member's automatic Claude launch refused by the real health pass names no account, count or sign-in step, for the browser and for a member-bound agent, and the owner's refusal keeps them", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { claimInstall } = await import("@/lib/team/members");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { mintSession } = await import("@/lib/team/sessions");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const team = teamStore();
  const owner = claimInstall(team, "Owner", { surface: "desktop", browser: "chrome" }, Date.parse("2026-10-20T09:00:00Z")).member;
  const id = `w_${"9".repeat(32)}`;
  createWorkspace(team, owner, { id, name: "Alpha", projects: [projectForCwd(sandbox)!] });
  const memberId = "m_health_member";
  team.insertMember({ id: memberId, name: "Member", role: "member", status: "active", color: "teal", telegram: null,
    createdAt: "2026-10-20T09:00:00.000Z", createdBy: owner.id, revokedAt: null });
  team.putWorkspaceMember(id, memberId, "member", owner.id, "2026-10-20T09:00:00.000Z");
  const memberCookie = mintSession(team, memberId, "claim", { surface: "desktop", browser: "chrome" }).value;
  const ownerCookie = mintSession(team, owner.id, "claim", { surface: "desktop", browser: "chrome" }).value;
  /* A signed-in account whose access token ran out and that holds no refresh token: the health pass finds nothing to launch on. */
  const hidden = createManagedClaudeAccount("Hidden Health Label");
  fs.writeFileSync(path.join(hidden.home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: fixture(), expiresAt: Date.now() - 3_600_000, scopes: ["user:inference"], subscriptionType: "max" },
  }), { mode: 0o600 });
  try {
    await withClient(async (client, { routeDependencies }) => {
      /* The real resolver: its health refusal is the one that lists accounts and says where to sign in. */
      routeDependencies.resolveHealthySpawnAccount = (await import("@/lib/accounts/manager")).resolveHealthySpawnAccount;
      const body = (clientAttemptId: string) => JSON.stringify({ ...args(), engine: "claude", model: "opus", clientAttemptId });
      const launch = async (clientAttemptId: string, cookie: string) => {
        const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
          method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `llv_member=${cookie}` },
          body: body(clientAttemptId),
        }), routeDependencies);
        return { status: response.status, body: await response.json() as { error: string; code?: string } };
      };
      /* Positive control: the owner receives the diagnostic that names the account and the repair. */
      const operator = await launch("health-owner", ownerCookie);
      expect({ status: operator.status, error: operator.body.error }).toMatchObject({ status: 503 });
      expect(operator.body.error).toContain(hidden.label);
      expect(operator.body.error).toMatch(/Re-login/);
      /* The member's browser call. */
      const member = await launch("health-member", memberCookie);
      expect(member).toMatchObject({ status: 409, body: { code: "project_account_refused" } });
      const leaks = [hidden.label, hidden.id, "Re-login", "Accounts", "healthy", "Main", " or "];
      for (const fragment of leaks) expect(JSON.stringify(member.body)).not.toContain(fragment);
      expect(registry.spawnReceiptForClientAttempt("health-member")).toBeNull();
      /* A member-bound agent reaches the same route and gets the same words. */
      routeDependencies.workspacePrincipal = { memberId, workspaceId: id };
      const agent = await client.callTool({ name: "spawn_agent", arguments: { ...args(), engine: "claude", model: "opus", clientRequestId: `${requestId()}-health-agent` } });
      expect(agent.structuredContent).toMatchObject({ ok: false, details: { status: 409, code: "project_account_refused" } });
      for (const fragment of leaks) expect(JSON.stringify(agent.structuredContent)).not.toContain(fragment);
      expect((agent.structuredContent as { error: string }).error).toStartWith("no claude account can take work for project ");
      expect(registry.spawnReceiptForClientAttempt(`${requestId()}-health-agent`)).toBeNull();
    });
  } finally { resetTeamStoreForTests(); }
});
