import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { hostlessConversations, hostlessConversationEvidence } from "./hostlessRegistryEvidence";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hostless-evidence-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation("codex", path.join(directory, "transcript.jsonl"), null);
  const key = { engine: "codex" as const, sessionId: conversation.generations[0]!.id };
  registry.upsert({ key, artifactPath: conversation.generations[0]!.path, cwd: directory, accountId: null,
    status: "dead", host: null, structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  return { directory, registry, conversation, key: `codex:${key.sessionId}`,
    close: () => { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("aliased ended owners retain their proof and a pending aliased launch withdraws it", () => {
  const f = fixture();
  try {
    const alias = `conversation_${randomUUID()}` as const;
    const intermediate = `conversation_${randomUUID()}` as const;
    const launch = f.registry.beginSpawn("codex", f.directory, { title: "Pending launch fixture" });
    const snapshot = f.registry.snapshot();
    snapshot.conversationAliases[alias] = intermediate;
    snapshot.conversationAliases[intermediate] = f.conversation.id;
    delete snapshot.receipts[launch.launchId];
    const proof = { key: f.key, endedAt: snapshot.entries[f.key]!.updatedAt };
    expect(hostlessConversations(snapshot).get(alias)).toEqual(proof);
    expect(hostlessConversationEvidence(snapshot, alias)).toEqual(proof);
    snapshot.receipts[launch.launchId] = { ...launch, conversationId: intermediate };
    expect(hostlessConversations(snapshot).has(alias)).toBe(false);
    expect(hostlessConversationEvidence(snapshot, alias)).toBeNull();
  } finally { f.close(); }
});

test("a fresh owner, pending action or replacement generation withdraws an ended-row verdict", () => {
  const f = fixture();
  try {
    const snapshot = f.registry.snapshot();
    expect(hostlessConversationEvidence(snapshot, f.conversation.id)).not.toBeNull();
    const entry = snapshot.entries[f.key]!;
    entry.claimOwner = "new-writer";
    expect(hostlessConversationEvidence(snapshot, f.conversation.id)).toBeNull();
    entry.claimOwner = null;
    entry.pendingAction = "spawn";
    expect(hostlessConversationEvidence(snapshot, f.conversation.id)).toBeNull();
    entry.pendingAction = null;
    entry.status = "live";
    expect(hostlessConversationEvidence(snapshot, f.conversation.id)).toBeNull();
    entry.status = "dead";
    snapshot.conversations[f.conversation.id]!.generations.push({
      ...snapshot.conversations[f.conversation.id]!.generations[0]!, id: randomUUID(),
    });
    expect(hostlessConversations(snapshot).has(f.conversation.id)).toBe(false);
    expect(hostlessConversationEvidence(snapshot, f.conversation.id)).toBeNull();
  } finally { f.close(); }
});

test("warm ended-owner discovery and one-row revalidation do not reread retained receipt history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hostless-retained-history-"));
  const shape = { ...scaledRegistryPerformanceShape(0.03), receipts: 13_000 };
  buildRegistryPerformanceDataset(directory, shape);
  const reads = new Map<string, number>();
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite",
    onSqliteRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
  });
  try {
    const snapshot = registry.readOnlySnapshot();
    const expected = hostlessConversations(snapshot);
    expect(expected.size).toBeGreaterThan(20);
    reads.clear();
    expect(hostlessConversations(snapshot)).toEqual(expected);
    expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBeLessThan(10);
    const id = expected.keys().next().value!;
    reads.clear();
    expect<ReturnType<typeof hostlessConversationEvidence> | undefined>(hostlessConversationEvidence(registry.readOnlySnapshot(), id)).toEqual(expected.get(id));
    expect((reads.get("conversations") ?? 0) + (reads.get("entries") ?? 0)).toBeLessThan(10);
    expect(reads.get("receipts") ?? 0).toBeLessThan(200);
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
