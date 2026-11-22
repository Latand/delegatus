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

  test("requires confirmed Antigravity delivery evidence before transitioning spawn operation to delivered (paired control vs deliveryEcho EIO)", async () => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const { FileRuntimeEventStore } = await import("@/lib/runtime/eventStore");
    const { RuntimeJournal } = await import("@/runtime-host/journal");
    const { spawnStructuredConversation, startAntigravityStructuredHost } = await import("@/lib/runtime/structuredSpawn");
    type ChildProcessWithoutNullStreams = import("node:child_process").ChildProcessWithoutNullStreams;

    const runSpawnCase = async (injectDeliveryEchoEio: boolean) => {
      const caseDir = fs.mkdtempSync(path.join(sandbox, injectDeliveryEchoEio ? "spawn-eio-" : "spawn-ok-"));
      const stateDir = path.join(caseDir, "state");
      const workDir = path.join(caseDir, "work");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(workDir, { recursive: true });

      const store = new AgentRegistry(path.join(stateDir, "agent-registry.json"));
      const journal = new RuntimeJournal(path.join(stateDir, "runtime-journal.sqlite"), {
        structuredHosts: true,
        maxEvents: 500,
      });
      const eventStoreDir = path.join(stateDir, "structured-host-events");
      let eioCount = 0;
      let liveHost: import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost | null = null;
      let launchId = "";
      let launchResult: Awaited<ReturnType<typeof spawnStructuredConversation>> | undefined;
      const deferred: Array<() => Promise<void>> = [];
      let closeFakeChild: (code?: number) => void = () => {};

      const makeFakeChild = (): ChildProcessWithoutNullStreams => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        let closed = false;
        const child = Object.assign(emitter, {
          stdin,
          stdout,
          stderr,
          pid: 65_000 + Math.floor(Math.random() * 1_000),
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          killed: false,
          kill: () => { closeFakeChild(0); return true; },
        });
        closeFakeChild = (code = 0) => {
          if (closed) return;
          closed = true;
          child.exitCode = code;
          stdout.end();
          stderr.end();
          emitter.emit("exit", code, null);
          emitter.emit("close", code, null);
        };
        let buffer = "";
        const mintedId = crypto.randomUUID();
        stdin.on("data", (chunk: Buffer | string) => {
          buffer += chunk.toString();
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) {
              const msg = JSON.parse(line) as { id?: number; method?: string };
              if (msg.id !== undefined) {
                let result: unknown = {};
                if (msg.method === "initialize") result = { protocolVersion: 1, agentInfo: { version: "1.5.14" } };
                else if (msg.method === "session/new" || msg.method === "session/resume") result = { sessionId: mintedId };
                else if (msg.method === "session/prompt") result = { stopReason: "end_turn" };
                stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
              }
            }
            nl = buffer.indexOf("\n");
          }
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      };

      type RuntimeOperationCommand = import("@/lib/runtime/contracts").RuntimeOperationCommand;
      type RuntimeReceiptStatus = import("@/lib/runtime/contracts").RuntimeReceiptStatus;
      type RuntimeTransitionDetails = import("@/lib/runtime/contracts").RuntimeTransitionDetails;
      type RuntimeTransitionOptions = import("@/lib/runtime/contracts").RuntimeTransitionOptions;
      const runtimeClient = {
        command: async (command: RuntimeOperationCommand) => journal.executeOperation(command),
        transitionOperation: async (
          operationId: string,
          status: Exclude<RuntimeReceiptStatus, "pending">,
          details?: RuntimeTransitionDetails,
          options?: RuntimeTransitionOptions,
        ) => journal.transitionOperation(operationId, status, details, options),
      } as unknown as RuntimeHostClient;

      try {
        const response = await POST.withDependencies(makeRequest({
          title: injectDeliveryEchoEio ? "Spawn EIO check" : "Spawn control check",
          engine: "antigravity",
          model: "gemini-3.8-flash-low",
          cwd: workDir,
          ["prompt"]: "Confirm delivery",
          clientAttemptId: `ag_spawn_eio_${crypto.randomUUID().slice(0, 8)}`,
        }), {
          registry: () => store,
          assertStructuredRuntime: () => {},
          antigravityBinaryGap: () => null,
          storeImages: () => [],
          resolveHealthySpawnAccount: async () => antigravityAccountForSpawn("default"),
          resolveSpawnAccount: () => antigravityAccountForSpawn("default"),
          resolvePinnedSpawnAdmission: async () => ({
            kind: "admissible",
            basis: "current",
            stale: false,
            retryAt: null,
          }),
          runtimeHostClient: () => runtimeClient,
          defer: (work) => { deferred.push(work); },
          spawnStructuredConversation: async (input) => {
            launchId = input.receipt.launchId;
            launchResult = await spawnStructuredConversation(input, {
              durableSetupTimeoutMs: 5_000,
              startHost: async (spawnInput, capability) => {
                const ledger = new FileRuntimeEventStore(eventStoreDir);
                const origAppend = ledger.append.bind(ledger);
                ledger.append = (session, event) => {
                  if (injectDeliveryEchoEio && event.kind === "item" && event.deliveryEcho) {
                    eioCount += 1;
                    throw Object.assign(new Error("simulated ledger EIO"), { code: "EIO" });
                  }
                  origAppend(session, event);
                };
                const host = await startAntigravityStructuredHost(spawnInput, capability, {
                  viewerMcpServer: null,
                  mcpServers: [],
                  eventStore: ledger,
                  signalProcess: () => { closeFakeChild(0); return true; },
                  processIdentity: () => "fixture-spawn-eio",
                  spawnProcess: () => makeFakeChild(),
                  requestTimeoutMs: 5_000,
                  shutdownGraceMs: 50,
                });
                liveHost = host;
                return host;
              },
              publishHost: async () => async () => {},
              deliverFirst: async (spawnInput) => {
                if (!liveHost) throw new Error("live Antigravity host was not captured");
                const receipt = await liveHost.send({
                  id: `spawn_message_${spawnInput.receipt.launchId}`,
                  text: spawnInput.prompt,
                });
                if (receipt.outcome === "rejected") {
                  throw new Error(`first Antigravity message rejected: ${receipt.reason}`);
                }
              },
            });
            return launchResult;
          },
        });
        expect(response.status).toBe(202);
        expect(deferred).toHaveLength(1);
        await deferred[0]!();
        expect(liveHost).not.toBeNull();
        const host = liveHost!;
        const evidence = (await host.sessionMaterializationEvidence(`spawn_message_${launchId}`)).state;
        const ledgerRead = new FileRuntimeEventStore(eventStoreDir);
        const echoes = ledgerRead.load(host.identity.sessionId).filter((e) => e.kind === "item" && e.deliveryEcho).length;
        const userRows = fs.readFileSync(host.identity.path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string })
          .filter((rec) => rec.type === "user.message").length;
        const runtime = journal.snapshot().recentOperations.find((op) => op.operationId === launchId)?.status;
        const registry = store.spawnRecoverySnapshot([launchId]).receipts[launchId]?.state;
        return {
          eioCount,
          evidence,
          echoes,
          userRows,
          runtime,
          registry,
          launchState: launchResult?.state,
          initialMessage: launchResult?.initialMessage,
        };
      } finally {
        if (liveHost) await (liveHost as import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost).release().catch(() => {});
        store.close();
        journal.close();
      }
    };

    const control = await runSpawnCase(false);
    expect(control).toEqual({
      eioCount: 0,
      evidence: "materialized",
      echoes: 1,
      userRows: 1,
      runtime: "delivered",
      registry: "completed",
      launchState: "settled",
      initialMessage: "delivered",
    });

    const failed = await runSpawnCase(true);
    expect(failed.eioCount).toBe(1);
    expect(failed.evidence).toBe("unavailable");
    expect(failed.echoes).toBe(0);
    expect(failed.userRows).toBe(0);
    expect(failed.runtime).not.toBe("delivered");
    expect(failed.registry).toBe("failed");
    expect(failed.initialMessage).not.toBe("delivered");
  });
});
