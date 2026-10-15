import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { AgentRegistry } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "targeted-registry-history-"));
  const data = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05));
  const db = new Database(data.filename, { readonly: true });
  const raw = db.query<{ value_json: string }, []>(`SELECT r.value_json FROM registry_records r
    WHERE r.collection='receipts' AND EXISTS (
      SELECT 1 FROM registry_records c WHERE c.collection='conversations'
        AND c.row_key=json_extract(r.value_json,'$.conversationId'))
    ORDER BY r.row_key LIMIT 1`).get()!;
  const receipt = JSON.parse(raw.value_json) as { launchId: string; conversationId: `conversation_${string}` };
  db.close();
  const reads = new Map<string, number>();
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite",
    onSqliteRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
  });
  registry.readOnlySnapshot();
  reads.clear();
  return { directory, registry, reads, receipt,
    close: () => { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("receipt capability rotation leaves unrelated retained receipts unread", () => {
  const f = fixture();
  try {
    const capability = f.registry.rotateSpawnCapabilityForReceipt(f.receipt.launchId);
    expect(capability).toHaveLength(43);
    expect(f.reads.get("receipts") ?? 0).toBeLessThan(20);
  } finally { f.close(); }
});

test("staging a conversation capability leaves unrelated retained receipts unread", () => {
  const f = fixture();
  try {
    expect(f.registry.stageSpawnCapabilityForConversation(f.receipt.conversationId, "fixture-operation")).not.toBeNull();
    expect(f.reads.get("receipts") ?? 0).toBeLessThan(20);
  } finally { f.close(); }
});

test("an absent original-send key reads only its recipient's retained delivery rows", () => {
  const f = fixture();
  try {
    expect(lookupOriginalSend(f.registry.readOnlySnapshot(), {
      conversationId: f.receipt.conversationId, clientMessageId: "absent-original-key",
    })).toEqual({ kind: "absent" });
    expect(f.reads.get("heldDeliveries") ?? 0).toBeLessThan(20);
    expect(f.reads.get("deliveryOperationOwners") ?? 0).toBeLessThan(20);
  } finally { f.close(); }
});

test("cold claim and quota readers avoid full snapshot construction and observe peer changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "targeted-registry-polls-"));
  let snapshots = 0;
  const data = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.02));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename: data.filename, onSqliteSnapshotLoad: () => { snapshots++; },
  });
  try {
    const before = snapshots;
    expect(registry.ownsStructuredHostClaim({ engine: "codex", sessionId: "absent" }, "synthetic", 1)).toBe(false);
    expect(registry.structuredHostWriteHeldByTermination({ engine: "codex", sessionId: "absent" }, "synthetic", 1)).toBe(false);
    const policy = registry.autoBalancePolicy("codex");
    const observations = registry.quotaObservations("codex");
    expect(snapshots).toBe(before);
    const expected = registry.readOnlySnapshot();
    expect(policy).toEqual(expected.autoBalance.codex);
    expect(observations).toEqual(Object.values(expected.quotaObservations.codex));
    const peer = new Database(data.filename);
    try {
      peer.query("UPDATE registry_meta SET value=json_set(value,'$.codex.enabled',json(?)) WHERE key='autoBalance'").run(JSON.stringify(!policy.enabled));
      expect(registry.autoBalancePolicy("codex").enabled).toBe(!policy.enabled);
    } finally { peer.close(); }
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
