import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

/*
 * A send on the production admission path keeps a conversation on the account
 * its project's pool placed it on, while that account is still allowed and
 * still has room. The pool ranks accounts by room and routing only breaks a
 * tie, so routing naming another account says nothing about this thread; moving
 * it there paid for a migration and parked the send behind it. Account and
 * project names are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-placement-"));
const STATE = path.join(SANDBOX, "state");
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = STATE;

const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { resetProjectAliasesForTests } = await import("@/lib/projects/aliases");
const { BINDINGS_SOURCE, resetAccountCollectionsForTests } = await import("@/lib/accounts/accountsStore");
const { clearAccountFixture, seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
const { enqueueStructuredMessage } = await import("./structuredMessageDelivery");
type RuntimeHostClient = import("./client").RuntimeHostClient;
type RuntimeSession = import("./contracts").RuntimeSnapshot["sessions"][number];

const PROJECT = "project-atlas";
const PLACED = "carrier-origin";
const ROUTED = "carrier-north";
const SESSION_ID = "22222222-2222-\x34222-8222-222222222222";
const ARTIFACT = `/sessions/${SESSION_ID}.jsonl`;
const NOW = Date.now();

let registryNumber = 0;

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  resetAccountCollectionsForTests();
  clearAccountFixture(BINDINGS_SOURCE);
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function bindBoth(): void {
  fs.mkdirSync(STATE, { recursive: true });
  seedAccountSource(BINDINGS_SOURCE, {
    schemaVersion: 1,
    bindings: [PLACED, ROUTED].map((accountId) => ({
      engine: "codex",
      accountId,
      project: PROJECT,
      createdAt: "2026-09-28T00:00:00.000Z",
    })),
  });
}

/** A live, fresh sample per account; `usedPercent` 100 is a confirmed exhaustion. */
function quotas(registry: InstanceType<typeof AgentRegistry>, usage: Record<string, number>): void {
  registry.recordQuotaEvaluation({
    engine: "codex",
    observations: Object.entries(usage).map(([accountId, usedPercent]) => ({
      engine: "codex" as const,
      accountId,
      authenticated: true,
      authCheckedAt: new Date(NOW - 1_000).toISOString(),
      limits: {
        session: { usedPercent, resetsAt: Math.floor(NOW / 1_000) + 3_600 },
        weekly: null,
        plan: "max",
        capturedAt: Math.floor((NOW - 1_000) / 1_000),
      },
      provenance: { source: "live" as const, reason: null, staleSince: null },
      observedAt: new Date(NOW - 1_000).toISOString(),
      bootId: "boot-structured-placement",
    })),
    signature: null,
    bootId: "boot-structured-placement",
    now: new Date(NOW).toISOString(),
    minimumGapMs: 60_000,
  });
}

function placedConversation() {
  const registry = new AgentRegistry(path.join(SANDBOX, `registry-${registryNumber += 1}.json`));
  registry.reconcileConversations([{
    engine: "codex",
    path: ARTIFACT,
    accountId: PLACED,
    launchProfile: emptyLaunchProfile({ cwd: "/checkouts/atlas", project: PROJECT }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-09-28T09:00:00.000Z",
  }]);
  registry.setEngineRouting("codex", ROUTED);
  return { registry, conversation: registry.conversationForPath(ARTIFACT)! };
}

function hostedClient(conversationId: string, commands: string[]): RuntimeHostClient {
  const session = {
    conversationId,
    sessionKey: { engine: "codex", sessionId: SESSION_ID },
    hostKind: "codex-app-server",
    host: "hosted",
    turn: "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: null,
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/checkouts/atlas",
    artifactPath: ARTIFACT,
    capabilities: { steer: true, structuredAttention: true, imageInput: { supported: false } },
    activeTurnId: null,
  } as unknown as RuntimeSession;
  return {
    readSession: async () => session,
    command: async (value: { operationId: string; idempotencyKey: string; text: string }) => {
      commands.push(value.text);
      return {
        operationId: value.operationId,
        replayed: false,
        receipt: {
          operationId: value.operationId,
          idempotencyKey: value.idempotencyKey,
          conversationId,
          kind: "send",
          status: "queued",
          queuePosition: 1,
          at: new Date(NOW).toISOString(),
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
}

async function send(registry: InstanceType<typeof AgentRegistry>, conversationId: string, commands: string[]) {
  return await enqueueStructuredMessage(
    { path: ARTIFACT, text: "keep going", clientMessageId: `placement-${registryNumber}`, hasImages: false },
    {
      enabled: () => true,
      client: () => hostedClient(conversationId, commands),
      registry: () => registry,
      kick: () => {},
      requestMigrationTick: () => {},
    },
  );
}

test("a send keeps the healthy pool account the conversation was placed on", async () => {
  bindBoth();
  const { registry, conversation } = placedConversation();
  quotas(registry, { [PLACED]: 40, [ROUTED]: 10 });
  const commands: string[] = [];

  const result = await send(registry, conversation.id, commands);

  expect(result).toMatchObject({ ok: true, structured: true, outcome: "queued" });
  expect(commands).toEqual(["keep going"]);
  const after = registry.conversation(conversation.id)!;
  expect(after.migration).toBeNull();
  expect(after.generations.at(-1)?.accountId).toBe(PLACED);
});

test("a send still follows routing once the placed account has no room left", async () => {
  bindBoth();
  const { registry, conversation } = placedConversation();
  quotas(registry, { [PLACED]: 100, [ROUTED]: 10 });
  const commands: string[] = [];

  const result = await send(registry, conversation.id, commands);

  expect(result).toMatchObject({ ok: true, structured: true, outcome: "held" });
  expect(commands).toEqual([]);
  expect(registry.conversation(conversation.id)?.migration).toMatchObject({ targetId: ROUTED, phase: "requested" });
});

test("a send on an unbound project follows routing exactly as it always did", async () => {
  const { registry, conversation } = placedConversation();
  quotas(registry, { [PLACED]: 40, [ROUTED]: 10 });
  const commands: string[] = [];

  const result = await send(registry, conversation.id, commands);

  expect(result).toMatchObject({ ok: true, structured: true, outcome: "held" });
  expect(commands).toEqual([]);
  expect(registry.conversation(conversation.id)?.migration).toMatchObject({ targetId: ROUTED });
});
