import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { procBackend } from "@/lib/proc";

import { reconcileMigrations, type HeldDeliveryPort } from "./coordinator";
import { emptyLaunchProfile, type SuccessorProviderPort, type ViewerConversationId } from "./contracts";

/*
 * A Claude launch the pool placed off the routed account, whose first message
 * was held behind a migration to the routed one before it could run (#2057).
 * Nothing ever wrote its transcript, and the only thing that could is that
 * held message, so the migration must end instead of waiting on the file. A
 * running conversation whose file is merely missing for a moment must still
 * wait: its history is real and the fork needs it.
 */

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The production provider forks the source's history: it is never virtual,
    and a source with no history must never reach it. */
function forkingProvider(): SuccessorProviderPort & { created: number } {
  const provider = {
    created: 0,
    async create(): Promise<never> {
      provider.created += 1;
      throw new Error("a source with no transcript has no history to fork");
    },
    async verify() {},
  };
  return provider;
}

function recordingPort(): HeldDeliveryPort & { delivered: { text: string; path: string }[] } {
  const delivered: { text: string; path: string }[] = [];
  return {
    delivered,
    async deliver({ delivery, path: pathname }) {
      delivered.push({ text: delivery.text, path: pathname });
      return "delivered";
    },
  };
}

/** A structured Claude launch staged on `pooled` while routing names `routed`:
    the receipt waits for its path and nothing has been written to disk. */
function stagedLaunch() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-never-started-source-"));
  sandboxes.push(sandbox);
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"));
  registry.setEngineRouting("claude", "routed");
  const begun = beginLegacySpawnFixture(registry, {
    engine: "claude",
    cwd: sandbox,
    transport: "structured",
    accountId: "pooled",
    accountPin: false,
  });
  if (begun.kind !== "created") throw new Error("expected a launch receipt");
  const sessionId = "0f0f0f0f-0000-\x34000-8000-000000000001";
  const sourcePath = path.join(sandbox, "projects", `${sessionId}.jsonl`);
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId },
    artifactPath: sourcePath,
    cwd: sandbox,
    accountId: "pooled",
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("expected launch staging");
  expect(staged.receipt.state).toBe("path-pending");
  expect(fs.existsSync(sourcePath)).toBe(false);
  return { registry, launchId: begun.receipt.launchId, conversationId: staged.conversation.id, sessionId, sourcePath, sandbox };
}

/** The stranded shape the incident left behind: a send that did not say it was
    the launch's own opened the lazy move, and the first message sits behind it. */
function strand(registry: AgentRegistry, conversationId: ViewerConversationId, launchId: string) {
  const migration = registry.requestConversationMigrationToActiveAccount(conversationId).migration;
  expect(migration).toMatchObject({ targetId: "routed", phase: "requested" });
  const held = registry.holdDelivery(conversationId, "the launch's mandate", `spawn_${launchId}`);
  expect(held).toMatchObject({ state: "held", attempts: 0 });
  return held;
}

test("a never-started source ends its migration and its held first message is delivered on the placed account", async () => {
  const { registry, launchId, conversationId, sourcePath } = stagedLaunch();
  const held = strand(registry, conversationId, launchId);
  const provider = forkingProvider();
  const port = recordingPort();

  await reconcileMigrations(provider, port, registry);

  const conversation = registry.conversation(conversationId)!;
  expect(conversation.migration?.phase).toBe("rolled-back");
  expect(conversation.generations).toHaveLength(1);
  expect(conversation.generations[0]).toMatchObject({ accountId: "pooled", path: sourcePath });
  expect(provider.created).toBe(0);
  expect(port.delivered).toEqual([{ text: "the launch's mandate", path: sourcePath }]);
  expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({ state: "delivered", attempts: 1 });
  expect(registry.pendingDeliveries(conversationId)).toEqual([]);

  /* The next send does not reopen the same move. */
  expect(registry.requestConversationMigrationToActiveAccount(conversationId).migration?.phase).toBe("rolled-back");
});

test("a live structured host idle at its composer does not stop a never-started source from ending", async () => {
  const { registry, launchId, conversationId, sessionId, sourcePath, sandbox } = stagedLaunch();
  const identity = procBackend.processIdentity(process.pid);
  if (!identity) throw new Error("expected this process to have a start identity");
  registry.upsert({
    key: { engine: "claude", sessionId },
    artifactPath: sourcePath,
    cwd: sandbox,
    accountId: "pooled",
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:broker",
      process: { pid: process.pid, startIdentity: identity },
      eventCursor: 1,
      protocolVersion: "v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${identity}`,
    pendingAction: null,
  });
  strand(registry, conversationId, launchId);
  const port = recordingPort();

  await reconcileMigrations(forkingProvider(), port, registry);

  expect(registry.conversation(conversationId)?.migration?.phase).toBe("rolled-back");
  expect(port.delivered).toHaveLength(1);
});

test("a launch whose first message already ran still waits while its transcript is missing", async () => {
  const { registry, launchId, conversationId } = stagedLaunch();
  const first = registry.holdDelivery(conversationId, "the launch's mandate", `spawn_${launchId}`);
  const generationId = registry.conversation(conversationId)!.generations.at(-1)!.id;
  registry.beginDeliveryAttempt(first.id, generationId);
  registry.recordDeliveryOutcome(first.id, "delivered", null);
  const next = strand(registry, conversationId, `${launchId}-next`);
  const provider = forkingProvider();
  const port = recordingPort();

  await reconcileMigrations(provider, port, registry);

  expect(registry.conversation(conversationId)?.migration?.phase).toBe("requested");
  expect(provider.created).toBe(0);
  expect(port.delivered).toEqual([]);
  expect(registry.snapshot().heldDeliveries[next.id]).toMatchObject({ state: "held", attempts: 0 });
});

test("a running conversation whose transcript is briefly missing still waits", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-never-started-source-"));
  sandboxes.push(sandbox);
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"));
  const sourcePath = path.join(sandbox, "projects", "0f0f0f0f-0000-\x34000-8000-000000000002.jsonl");
  registry.reconcileConversations([{
    engine: "claude",
    path: sourcePath,
    accountId: "pooled",
    launchProfile: emptyLaunchProfile({ cwd: sandbox, project: "viewer" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-09-28T09:00:00.000Z",
  }]);
  const conversationId = registry.conversationForPath(sourcePath)!.id;
  registry.requestConversationReseat(conversationId, "routed");
  const held = registry.holdDelivery(conversationId, "continue", "running-send");
  const provider = forkingProvider();
  const port = recordingPort();

  await reconcileMigrations(provider, port, registry);

  expect(registry.conversation(conversationId)?.migration?.phase).toBe("requested");
  expect(provider.created).toBe(0);
  expect(port.delivered).toEqual([]);
  expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({ state: "held" });
});
