import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "bun:test";

type RuntimeHostClient = import("./client").RuntimeHostClient;
type RegistryFile = import("@/lib/agent/registry").RegistryFile;

/** Each importing test file owns its environment, fixtures and cleanup. */
export async function startupFinalizationFixture() {
  // Clear inherited credentials, runtime endpoints and provider roots BEFORE imports.
  // TMPDIR is supplied on private disk by the invoking test environment.
  const ambient = { ...process.env };
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-finalization-"));
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, { PATH: ambient.PATH, NODE_ENV: "test",
    LLV_VIEWER_CONTROL_URL: ambient.LLV_VIEWER_CONTROL_URL ?? "http://127.0.0.1:1",
    DELEGATUS_CPU_PRESSURE: "off" });
  for (const [name, suffix] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", LLV_STATE_DIR: "state", TMPDIR: "tmp", CODEX_HOME: "codex", LLV_CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", LLV_CLAUDE_HOME: "claude" })) {
    const directory = path.join(isolated, suffix);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    process.env[name] = directory;
  }
  fs.mkdirSync(path.join(isolated, "sockets"), { mode: 0o700 });

  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  afterAll(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, ambient);
    fs.rmSync(isolated, { recursive: true, force: true });
  });

  function fixture(failedCount: number, fullHistory = false, historyCount = 8078, grantedRoots = 0) {
    const directory = fs.mkdtempSync(path.join(isolated, "fixture-"));
    const filename = path.join(directory, "registry.json");
    const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = seed.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: directory, title: "Historical failed launch" }),
    });
    seed.failSpawn(begun.receipt.launchId, "historical failure");
    if (fullHistory) {
      const artifactPath = path.join(directory, "history-seed.jsonl");
      const conversation = seed.ensureConversation("codex", artifactPath, null);
      const sessionId = conversation.generations.at(-1)!.id;
      const delivery = seed.holdDelivery(conversation.id, "Historical delivery", "history-seed", "text");
      seed.recordDeliveryOutcome(delivery.id, "failed", "historical failure");
      seed.upsert({
        key: { engine: "codex", sessionId }, artifactPath, cwd: directory, accountId: null,
        launchProfile: emptyLaunchProfile({ cwd: directory }), status: "dead", host: null,
        structuredHost: { kind: "codex-app-server", endpoint: "stdio:released", process: null,
          eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null,
          pendingAttention: [], activeFlags: [] },
        claimEpoch: 0, claimOwner: null, pendingAction: null,
      });
    }
    const data = JSON.parse(fs.readFileSync(filename, "utf8")) as RegistryFile;
    const receipt = data.receipts[begun.receipt.launchId]!;
    data.receipts = {};
    for (let i = 0; i < failedCount; i++) {
      const launchId = `historical_launch_${i}`;
      data.receipts[launchId] = { ...receipt, launchId, conversationId: `conversation_history_${i}` };
    }
    if (fullHistory) {
      const entry = Object.values(data.entries)[0]!;
      const conversation = Object.values(data.conversations)[0]!;
      data.entries = {};
      data.conversations = {};
      for (let i = 0; i < historyCount; i++) {
        const id = `conversation_history_${i}` as const;
        const sessionId = `history_${i}`;
        const artifactPath = path.join(directory, `${sessionId}.jsonl`);
        // Operator roots holding a grantable connector, spread through the history as they are in production.
        const mcpServers = i % 85 === 0 && i / 85 < grantedRoots ? ["viewer", "telegram"] : ["viewer"];
        if (i < 5188) data.entries[`codex:${sessionId}`] = {
          ...entry, key: { engine: "codex", sessionId }, artifactPath,
          launchProfile: { ...entry.launchProfile!, mcpServers },
        };
        data.conversations[id] = {
          ...conversation, id,
          ...(mcpServers.length > 1 ? { agentRole: null, delegationDepth: 0 } : {}),
          turn: { state: "terminal", source: "assistant", terminalAt: receipt.createdAt, observedAt: receipt.createdAt },
          generations: conversation.generations.map((generation) => ({
            ...generation, id: sessionId, path: artifactPath, launchProfile: { ...generation.launchProfile, mcpServers },
          })),
        };
      }
      const held = Object.values(data.heldDeliveries)[0]!;
      data.heldDeliveries = {};
      for (let i = 0; i < 1719; i++) {
        const id = `historical_delivery_${i}`;
        data.heldDeliveries[id] = {
          ...held, id, conversationId: `conversation_history_${i}`, clientMessageId: id,
          command: { ...held.command, operationId: `historical_operation_${i}` },
          state: i < 153 ? "failed" : "delivered",
        };
      }
      for (let i = failedCount; i < 6623; i++) {
        const launchId = `historical_launch_${i}`;
        data.receipts[launchId] = {
          ...receipt, launchId, conversationId: `conversation_history_${i}`,
          state: i < 6458 ? "completed" : i < 6590 ? "conflicted" : i < 6611 ? "starting"
            : i < 6618 ? "host-verified" : i < 6622 ? "pane-bound" : "path-pending",
        };
      }
    }
    fs.writeFileSync(filename, JSON.stringify(data));
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    const client = {
      snapshot: async () => journal.snapshot(),
      readSnapshot: async (kind, conversationIds) => {
        const { projectSnapshotRead } = await import("./snapshotReads");
        return projectSnapshotRead(journal.snapshotRead({ version: 1, kind, ...(conversationIds ? { conversationIds } : {}) }), kind, conversationIds);
      },
      events: async (after) => journal.replay(after),
      append: async (event) => journal.append(event),
      command: async (command) => journal.executeOperation(command),
      operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
      producerCursor: async (kind, prefix) => journal.producerCursor(kind, prefix),
      effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
      transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
    } satisfies Partial<RuntimeHostClient> as RuntimeHostClient;
    return { directory, registry, journal, client };
  }
  return { fixture, isolated };
}
