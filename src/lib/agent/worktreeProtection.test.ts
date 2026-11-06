import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { worktreeProtection } from "./worktreeProtection";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { conversationCwdStatus } from "../pipelines/worktreeSweep";

const roots: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("retention reads compact current evidence without hydrating terminal deliveries or unrelated collections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-protection-")); roots.push(root);
  const dataset = buildRegistryPerformanceDataset(root, scaledRegistryPerformanceShape(0.02));
  const counts: Record<string, number> = {};
  const store = new SqliteAgentRegistryStore(dataset.filename, {
    initialSnapshot: () => { throw new Error("already imported"); }, normalize: normalizeRegistry,
    onRowPayloadRead: (kind, count) => { counts[kind] = (counts[kind] ?? 0) + count; },
  }); stores.push(store);
  const expected = worktreeProtection(store.readOnlySnapshot().file);
  for (const key of Object.keys(counts)) delete counts[key];
  const actual = store.worktreeProtectionSnapshot();
  expect(actual).toEqual(expected);
  expect(Object.keys(counts).sort()).toEqual(["conversations", "entries", "heldDeliveries"]);
  expect(counts.heldDeliveries).toBe(Object.keys(expected.heldDeliveries).length);
  expect(JSON.stringify(actual)).not.toContain("mcpServers");
  const at = Date.parse("2026-11-01T00:00:00Z");
  expect(conversationCwdStatus(actual, at, () => false)).toEqual(conversationCwdStatus(expected, at, () => false));
  const peer = new Database(dataset.filename);
  try {
    const first = Object.keys(expected.entries)[0]!;
    peer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.cwd',?) WHERE collection='entries' AND row_key=?")
      .run("/changed-retention-cwd", first);
    expect(store.worktreeProtectionSnapshot()).toEqual(worktreeProtection(store.readOnlySnapshot().file));
  } finally { peer.close(); }
});

test("one protection view pins all collections while a peer changes owners, and the next read sees the commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-protection-peer-")); roots.push(root);
  const dataset = buildRegistryPerformanceDataset(root, scaledRegistryPerformanceShape(0.02));
  const peer = new Database(dataset.filename);
  let change: (() => void) | null = null;
  const store = new SqliteAgentRegistryStore(dataset.filename, {
    initialSnapshot: () => { throw new Error("already imported"); }, normalize: normalizeRegistry,
    onRowPayloadRead: (kind, count) => { if (kind === "entries" && count && change) { const run = change; change = null; run(); } },
  }); stores.push(store);
  try {
    const before = worktreeProtection(store.readOnlySnapshot().file);
    const entry = Object.keys(before.entries)[0]!;
    const conversation = Object.keys(before.conversations)[0]!;
    change = () => peer.transaction(() => {
      peer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.cwd',?) WHERE collection='entries' AND row_key=?")
        .run("/fresh-owner", entry);
      peer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.turn.state','busy') WHERE collection='conversations' AND row_key=?")
        .run(conversation);
    })();
    expect(store.worktreeProtectionSnapshot()).toEqual(before);
    expect(change).toBeNull();
    expect(store.worktreeProtectionSnapshot()).toEqual(worktreeProtection(store.readOnlySnapshot().file));
  } finally { peer.close(); }
});

test("legacy missing delivery state and corrupt image reservations keep the established normalization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-protection-legacy-")); roots.push(root);
  const filename = path.join(root, "registry.sqlite");
  const store = new SqliteAgentRegistryStore(filename, {
    initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }), normalize: normalizeRegistry,
  }); stores.push(store);
  const peer = new Database(filename);
  try {
    for (const [index, state] of [undefined, null, "held", "assigned", "delivery-uncertain", "delivered", "failed"].entries()) {
      const key = `legacy-${index}`;
      peer.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('heldDeliveries',?,?,?)")
        .run(key, JSON.stringify({ id: key, conversationId: "conversation_legacy", state, text: "Continue" }), index);
    }
    peer.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('heldDeliveries',?,?,?)")
      .run("corrupt", JSON.stringify({ id: "corrupt", conversationId: "conversation_legacy", state: "assigned", payloadKind: "runtime-images", runtimeImages: [] }), 8);
    const expected = worktreeProtection(store.readOnlySnapshot().file);
    expect(store.worktreeProtectionSnapshot()).toEqual(expected);
    expect(Object.keys(expected.heldDeliveries)).toEqual(["legacy-0", "legacy-1", "legacy-2", "legacy-3", "legacy-4"]);
    expect(expected.heldDeliveries.corrupt).toBeUndefined();
  } finally { peer.close(); }
});
