import { afterAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "./registry";
import type { ProviderReceipt } from "@/lib/accounts/migration/contracts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capability-handover-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

test.each(["off", "sqlite"] as const)("%s: both migration hosts retain identity until an atomic successor commit", (sqliteMode) => {
  const filename = path.join(root, crypto.randomUUID(), "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  const launch = registry.beginSpawn("codex", root, { cwd: root, title: "Migration identity" });
  const nativeId = crypto.randomUUID();
  registry.settleSpawn(launch.launchId, {
    key: { engine: "codex", sessionId: nativeId }, artifactPath: path.join(root, `${nativeId}.jsonl`),
    cwd: root, accountId: "source", status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  const predecessor = registry.rotateSpawnCapabilityForReceipt(launch.launchId);
  const operationId = crypto.randomUUID();
  const receipt: ProviderReceipt = {
    operationId, nativeId: crypto.randomUUID(), path: path.join(root, "successor.jsonl"), continuityPaths: [],
    historyHash: "history", host: { kind: "codex-app-server", identity: "successor", epoch: 1, verifiedAt: new Date().toISOString() },
  };
  registry.setConversationMigration(launch.conversationId, {
    intentId: "intent", phase: "verifying", targetId: "target", revision: 1, error: null,
    operationId, providerReceipt: receipt, updatedAt: new Date().toISOString(),
  });
  const successor = registry.stageSpawnCapabilityForConversation(launch.conversationId, operationId)!;
  const reloaded = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(predecessor))).toBe(launch.conversationId);
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(successor.capability))).toBe(launch.conversationId);
  expect(() => reloaded.commitSuccessor(launch.conversationId, {
    id: receipt.nativeId, path: receipt.path, accountId: "target",
  }, 2, operationId, receipt)).toThrow("ownership is stale");
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(predecessor))).toBe(launch.conversationId);
  reloaded.commitSuccessor(launch.conversationId, { id: receipt.nativeId, path: receipt.path, accountId: "target" }, 1, operationId, receipt);
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(predecessor))).toBeNull();
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(successor.capability))).toBe(launch.conversationId);
});

test.each(["off", "sqlite"] as const)("%s: discard after restart preserves the predecessor and cannot undo a newer publication or launch", (sqliteMode) => {
  const filename = path.join(root, crypto.randomUUID(), "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  const launch = registry.beginSpawn("codex", root, { cwd: root, title: "Discard identity" });
  const nativeId = crypto.randomUUID();
  registry.settleSpawn(launch.launchId, {
    key: { engine: "codex", sessionId: nativeId }, artifactPath: path.join(root, `${nativeId}.jsonl`),
    cwd: root, accountId: "source", status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  const predecessor = registry.rotateSpawnCapabilityForReceipt(launch.launchId);
  const pending = registry.stageSpawnCapabilityForConversation(launch.conversationId, "first")!;
  const reloaded = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  reloaded.discardSpawnCapabilityForOperation("first");
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(predecessor))).toBe(launch.conversationId);
  expect(reloaded.conversationIdForSpawnCapabilityDigest(pending.digest)).toBeNull();
  const second = reloaded.stageSpawnCapabilityForConversation(launch.conversationId, "second")!;
  reloaded.discardSpawnCapabilityForOperation("first");
  expect(reloaded.conversationIdForSpawnCapabilityDigest(second.digest)).toBe(launch.conversationId);
  const replacement = reloaded.stageSpawnCapabilityForConversation(launch.conversationId, "second")!;
  reloaded.discardSpawnCapabilityForOperation("second", second.digest);
  expect(reloaded.conversationIdForSpawnCapabilityDigest(replacement.digest)).toBe(launch.conversationId);
  const relaunched = reloaded.rotateSpawnCapabilityForReceipt(launch.launchId);
  reloaded.discardSpawnCapabilityForOperation("second");
  expect(reloaded.conversationIdForSpawnCapabilityDigest(replacement.digest)).toBeNull();
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(predecessor))).toBeNull();
  expect(reloaded.conversationIdForSpawnCapabilityDigest(digest(relaunched))).toBe(launch.conversationId);
});
