import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-antigravity-spawn-route-"));
const originalEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  TMPDIR: process.env.TMPDIR,
  LLV_SPAWN_TRANSPORT: process.env.LLV_SPAWN_TRANSPORT,
  LLV_STRUCTURED_HOSTS: process.env.LLV_STRUCTURED_HOSTS,
  LLV_RUNTIME_EVENTS: process.env.LLV_RUNTIME_EVENTS,
  LLV_RUNTIME_HOST_SOCKET: process.env.LLV_RUNTIME_HOST_SOCKET,
  NEXT_PUBLIC_RUNTIME_UI: process.env.NEXT_PUBLIC_RUNTIME_UI,
};

process.env.HOME = path.join(sandbox, "home");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.TMPDIR = path.join(sandbox, "tmp");
process.env.LLV_SPAWN_TRANSPORT = "structured";
process.env.LLV_STRUCTURED_HOSTS = "1";
process.env.LLV_RUNTIME_EVENTS = "1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
for (const dir of [process.env.HOME, process.env.XDG_CONFIG_HOME, process.env.LLV_STATE_DIR, process.env.TMPDIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { POST } = await import("./route");
const { GET: getRoles, PUT: putRoles } = await import("@/app/api/roles/route");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { antigravityAccountForSpawn } = await import("@/lib/accounts/antigravity");
const { roleLaunchChoices } = await import("@/lib/roles/mcpMapping");
const { TOOL_INPUT_SCHEMAS } = await import("@/lib/mcp/server");
type RuntimeHostClient = import("@/lib/runtime/client").RuntimeHostClient;
type SpawnRouteDependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1",
      host: "127.0.0.1",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/spawn and /api/roles for Antigravity", () => {
  let cwd = "";

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(sandbox, "work-"));
  });

  test("admits Antigravity spawns for combined and split model/effort ids and rejects invalid options", async () => {
    const store = new AgentRegistry(path.join(cwd, "agent-registry.json"));
    const captured: Array<{ engine: string; model: string | null; effort: string | null; accountId: string; permissionMode: string | null }> = [];
    const deferred: Array<() => Promise<void>> = [];

    const dependencies: SpawnRouteDependencies = {
      registry: () => store,
      assertStructuredRuntime: () => {},
      antigravityBinaryGap: () => null,
      storeImages: () => [],
      resolveHealthySpawnAccount: async (_engine, requested) => antigravityAccountForSpawn(requested),
      resolveSpawnAccount: (_engine, requested) => antigravityAccountForSpawn(requested),
      resolvePinnedSpawnAdmission: async () => ({
        kind: "admissible",
        basis: "current",
        stale: false,
        retryAt: null,
      }),
      runtimeHostClient: () => ({} as RuntimeHostClient),
      defer: (work) => { deferred.push(work); },
      spawnStructuredConversation: async (input) => {
        captured.push({
          engine: input.engine,
          model: input.spec.launchProfile?.model ?? null,
          effort: input.spec.launchProfile?.effort ?? null,
          accountId: input.account.accountId,
          permissionMode: input.spec.launchProfile?.permissionMode ?? null,
        });
        return {
          ok: true,
          target: null,
          path: path.join(input.account.transcriptRoot, crypto.randomUUID(), "events.jsonl"),
          launchId: input.receipt.launchId,
          conversationId: input.receipt.conversationId,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered",
          state: "settled",
        };
      },
    };

    const splitResponse = await POST.withDependencies(makeRequest({
      title: "Antigravity split runtime",
      engine: "antigravity",
      model: "gemini-4-neon",
      effort: "xhigh",
      cwd,
      ["prompt"]: "Check repository layout",
      clientAttemptId: `ag_split_${crypto.randomUUID().slice(0, 8)}`,
    }), dependencies);
    expect(splitResponse.status).toBe(202);

    const combinedResponse = await POST.withDependencies(makeRequest({
      title: "Antigravity combined runtime",
      engine: "antigravity",
      model: "gemini-4-neon-xhigh",
      cwd,
      ["prompt"]: "Inspect tests",
      clientAttemptId: `ag_comb_${crypto.randomUUID().slice(0, 8)}`,
    }), dependencies);
    expect(combinedResponse.status).toBe(202);

    for (const work of deferred) await work();
    expect(captured).toEqual([
      {
        engine: "antigravity",
        model: "gemini-4-neon",
        effort: "xhigh",
        accountId: "default",
        permissionMode: "bypassPermissions",
      },
      {
        engine: "antigravity",
        model: "gemini-4-neon-xhigh",
        effort: null,
        accountId: "default",
        permissionMode: "bypassPermissions",
      },
    ]);

    const badEffort = await POST.withDependencies(makeRequest({
      title: "Invalid effort",
      engine: "antigravity",
      model: "gemini-4-neon",
      effort: "ultra",
      cwd,
      ["prompt"]: "Should refuse",
      clientAttemptId: `ag_eff_${crypto.randomUUID().slice(0, 8)}`,
    }), dependencies);
    expect(badEffort.status).toBe(400);

    const badModel = await POST.withDependencies(makeRequest({
      title: "Invalid model",
      engine: "antigravity",
      model: "bad model with spaces",
      cwd,
      ["prompt"]: "Should refuse",
      clientAttemptId: `ag_mod_${crypto.randomUUID().slice(0, 8)}`,
    }), dependencies);
    expect(badModel.status).toBe(400);

    const ungrantableMcp = await POST.withDependencies(makeRequest({
      title: "Ungrantable MCP server",
      engine: "antigravity",
      model: "gemini-4-neon",
      mcpServers: ["ungrantable"],
      cwd,
      ["prompt"]: "Should refuse",
      clientAttemptId: `ag_mcp_${crypto.randomUUID().slice(0, 8)}`,
    }), dependencies);
    expect(ungrantableMcp.status).toBe(400);

    const missingBinary = await POST.withDependencies(makeRequest({
      title: "Missing agy binary",
      engine: "antigravity",
      model: "gemini-4-neon",
      cwd,
      ["prompt"]: "Should refuse",
      clientAttemptId: `ag_bin_${crypto.randomUUID().slice(0, 8)}`,
    }), {
      ...dependencies,
      antigravityBinaryGap: () => "Antigravity CLI (agy) was not found on PATH",
    });
    expect(missingBinary.status).toBe(409);
  });

  test("exposes Antigravity in /api/roles launchChoices, PUT overrides, MCP role choices, and MCP spawn/pipeline schemas", async () => {
    const getResponse = await getRoles();
    expect(getResponse.status).toBe(200);
    const catalog = await getResponse.json() as {
      launchChoices: Array<{ engine: string; models: Array<{ id: string; efforts: string[] }> }>;
      roles: Array<{ id: string; config: { engine: string; model: string; effort: string } }>;
    };
    const agChoice = catalog.launchChoices.find((choice) => choice.engine === "antigravity");
    expect(agChoice).toBeDefined();
    expect(agChoice!.models.some((model) => model.id === "gemini-4-neon")).toBe(true);

    const putResponse = await putRoles(new NextRequest("http://127.0.0.1/api/roles", {
      method: "PUT",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({
        overrides: {
          builder: { config: { engine: "antigravity", model: "gemini-4-neon", effort: "xhigh" } },
        },
      }),
    }));
    expect(putResponse.status).toBe(200);
    const updated = await putResponse.json() as typeof catalog;
    expect(updated.roles.find((role) => role.id === "builder")?.config).toEqual({
      engine: "antigravity",
      model: "gemini-4-neon",
      effort: "xhigh",
    });

    const choices = roleLaunchChoices();
    expect(choices.antigravity["gemini-4-neon"]).toEqual(["low", "medium", "high", "xhigh"]);

    expect(TOOL_INPUT_SCHEMAS.spawn_agent.safeParse({
      clientRequestId: `req_${crypto.randomUUID().slice(0, 8)}`,
      title: "Spawn Antigravity via MCP",
      cwd,
      engine: "antigravity",
      model: "gemini-4-neon",
      effort: "high",
      ["prompt"]: "Inspect",
    }).success).toBe(true);

    expect(TOOL_INPUT_SCHEMAS.create_pipeline.safeParse({
      clientRequestId: `req_${crypto.randomUUID().slice(0, 8)}`,
      task: "Run Antigravity stage",
      repoDir: cwd,
      stages: [{
        id: "build",
        kind: "run",
        engine: "antigravity",
        model: "gemini-4-neon",
        effort: "xhigh",
        ["prompt"]: "Implement",
        next: null,
      }],
    }).success).toBe(true);
  });

  test("persists concurrent Antigravity spawns across a second SQLite registry connection and isolates caller mutations", async () => {
    const registryPath = path.join(cwd, "agent-registry.json");
    const store = new AgentRegistry(registryPath);
    const deferred: Array<() => Promise<void>> = [];

    const dependencies: SpawnRouteDependencies = {
      registry: () => store,
      assertStructuredRuntime: () => {},
      antigravityBinaryGap: () => null,
      storeImages: () => [],
      resolveHealthySpawnAccount: async (_engine, requested) => antigravityAccountForSpawn(requested),
      resolveSpawnAccount: (_engine, requested) => antigravityAccountForSpawn(requested),
      resolvePinnedSpawnAdmission: async () => ({
        kind: "admissible",
        basis: "current",
        stale: false,
        retryAt: null,
      }),
      runtimeHostClient: () => ({} as RuntimeHostClient),
      defer: (work) => { deferred.push(work); },
      spawnStructuredConversation: async (input) => {
        const sessionId = crypto.randomUUID();
        const artifactPath = path.join(input.account.transcriptRoot, sessionId, "events.jsonl");
        const settled = input.registry.settleSpawn(input.receipt.launchId, {
          key: { engine: "antigravity", sessionId },
          artifactPath,
          cwd,
          accountId: input.account.accountId,
          status: "live",
          host: null,
          structuredHost: {
            kind: "antigravity-acp",
            endpoint: "stdio:antigravity-acp",
            process: null,
            protocolVersion: "1",
            writerClaimEpoch: 1,
            eventCursor: 0,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          },
          claimEpoch: 1,
          claimOwner: "structured-host:test",
          pendingAction: null,
        });
        if (settled.kind !== "settled") throw new Error(`expected settled spawn, got ${settled.kind}`);
        return {
          ok: true,
          target: null,
          path: artifactPath,
          launchId: input.receipt.launchId,
          conversationId: settled.conversation.id,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered",
          state: "settled",
        };
      },
    };

    const attemptA = `ag_conc_a_${crypto.randomUUID().slice(0, 8)}`;
    const attemptB = `ag_conc_b_${crypto.randomUUID().slice(0, 8)}`;
    const [resA, resB] = await Promise.all([
      POST.withDependencies(makeRequest({
        title: "Concurrent Antigravity A",
        engine: "antigravity",
        model: "gemini-4-neon",
        effort: "high",
        cwd,
        ["prompt"]: "Task A",
        clientAttemptId: attemptA,
      }), dependencies),
      POST.withDependencies(makeRequest({
        title: "Concurrent Antigravity B",
        engine: "antigravity",
        model: "gemini-3.8-flash-low",
        cwd,
        ["prompt"]: "Task B",
        clientAttemptId: attemptB,
      }), dependencies),
    ]);
    expect([resA.status, resB.status]).toEqual([202, 202]);
    await Promise.all(deferred.map((work) => work()));

    const receiptA = store.spawnReceiptForClientAttempt(attemptA)!;
    const receiptB = store.spawnReceiptForClientAttempt(attemptB)!;
    expect(receiptA.engine).toBe("antigravity");
    expect(receiptB.engine).toBe("antigravity");
    expect(receiptA.conversationId).not.toBe(receiptB.conversationId);

    // Caller mutating returned conversation copy must not corrupt stored state.
    const convCopy = store.conversation(receiptA.conversationId)!;
    convCopy.generations[0]!.launchProfile.model = "corrupted-model";
    expect(store.conversation(receiptA.conversationId)!.generations[0]!.launchProfile.model).toBe("gemini-4-neon");

    // A second AgentRegistry instance reading the same SQLite file sees both settled Antigravity conversations.
    const secondConnection = new AgentRegistry(registryPath);
    expect(secondConnection.conversation(receiptA.conversationId)).toMatchObject({
      engine: "antigravity",
      generations: [expect.objectContaining({ accountId: "default", launchProfile: expect.objectContaining({ model: "gemini-4-neon", effort: "high" }) })],
    });
    expect(secondConnection.conversation(receiptB.conversationId)).toMatchObject({
      engine: "antigravity",
      generations: [expect.objectContaining({ accountId: "default", launchProfile: expect.objectContaining({ model: "gemini-3.8-flash-low" }) })],
    });
  });
});
