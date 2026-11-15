import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
test("receipt discovery seeks bounded keys, including history, and keyed facts follow peer writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-registry-")); roots.push(root);
  const seed = new AgentRegistry(path.join(root, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const initial = seed.snapshot(); seed.close();
  const time = "2035-01-01T00:00:00.000Z";
  for (let i = 0; i < 70; i++) {
    const launchId = `launch-${String(i).padStart(3, "0")}`;
    initial.receipts[launchId] = normalizeRegistry({ version: 2, entries: {}, receipts: { [launchId]: { launchId, state: "failed", createdAt: time,
      engine: "codex", cwd: "/fixture", conversationId: `conversation_${i}`, launchProfile: { cwd: "/fixture" } } } }).receipts[launchId]!;
  }
  const filename = path.join(root, "agent-registry.sqlite"), writer = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry });
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: filename, deferColdKeyInitialization: true });
  try {
    const first = registry.temporaryDataReceiptKeys("", 32); expect(first).toHaveLength(32); expect(first[0]).toBe("launch-000");
    expect(registry.temporaryDataReceiptKeys(first.at(-1)!, 32)[0]).toBe("launch-032");
    expect(registry.temporaryDataFacts({ launchId: "launch-001" }).receipt?.state).toBe("failed");
    writer.mutate(file => { file.receipts["launch-001"]!.error = "peer update"; }, false);
    expect(registry.temporaryDataFacts({ launchId: "launch-001" }).receipt?.error).toBe("peer update");
    writer.archiveInactive(1000);
    expect(registry.temporaryDataReceiptKeys("", 32)).toEqual(first);
    expect(registry.temporaryDataFacts({ launchId: "launch-001" }).receipt?.error).toBe("peer update");
    expect(() => registry.temporaryDataReceiptKeys("", 33)).toThrow("invalid retention receipt page");
  } finally { registry.close(); writer.close(); }
});
test("unindexed JSON mode refuses discovery instead of reading whole history on each tick", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-registry-json-")); roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  try { expect(() => registry.temporaryDataReceiptKeys("")).toThrow("retention requires the indexed registry"); }
  finally { registry.close(); }
});

test("native-session facts retain pipeline membership even when its spawn receipt is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-membership-")); roots.push(root);
  const seed = new AgentRegistry(path.join(root, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = seed.ensureConversation("codex", "/sessions/retention-native.jsonl", "default");
  seed.rememberMembership(conversation.id, { kind: "pipeline", containerId: "lane-fixed", role: "builder", slot: "build", stageId: null,
    stageOrder: null, round: null, parentConversationId: null });
  const initial = seed.snapshot(); seed.close();
  const filename = path.join(root, "agent-registry.sqlite"), store = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry });
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: filename });
  try {
    const facts = registry.temporaryDataFacts({ key: { engine: "codex", sessionId: conversation.generations.at(-1)!.id } });
    expect(facts.receipt).toBeNull(); expect(facts.pipelines).toEqual(["lane-fixed"]);
  } finally { registry.close(); store.close(); }
});
