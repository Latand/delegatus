import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { AgentRegistry, normalizeRegistry, type RegistryFile } from "./registry";
import { registryRowsMatching, SqliteAgentRegistryStore } from "./sqliteRegistryStore";

/* The shared read-only registry view (viewer-hot-path-clones): every reader of
   `readOnlySnapshot` holds the same objects, so none may change them, and every
   write must reach the next read. Each case owns a mkdtemp directory. */

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-readonly-view-"));
  directories.push(directory);
  const seed = new AgentRegistry(path.join(directory, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = seed.ensureConversation("codex", "/sessions/readonly-view.jsonl", "default");
  const delivery = seed.holdDelivery(conversation.id, "held for the view", "readonly-view");
  const kept = seed.beginSpawn("codex", "/repo/kept", { title: "Kept receipt" });
  const removed = seed.beginSpawn("codex", "/repo/removed", { title: "Removed receipt" });
  const initial = seed.snapshot();
  seed.close();
  const filename = path.join(directory, "agent-registry.sqlite");
  const open = () => {
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry });
    stores.push(store);
    return store;
  };
  return { filename, open, conversation, delivery, kept: kept.launchId, removed: removed.launchId };
}

function attempt(write: () => void): boolean {
  try {
    write();
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return false;
  }
}

test("a reader cannot replace a collection of the shared view, even through the loader's accessor", () => {
  const { open, kept } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  /* The regression: a frozen loaded file still ran its accessor's setter. */
  expect(attempt(() => { (view as { receipts: RegistryFile["receipts"] }).receipts = {}; })).toBe(false);
  expect(attempt(() => { (view as { conversationRevision: unknown }).conversationRevision = {}; })).toBe(false);
  expect(Object.getOwnPropertyDescriptor(view, "receipts")).toMatchObject({ writable: false, configurable: false });
  expect(store.readOnlySnapshot().file.receipts[kept]).toBeDefined();
});

test("a reader cannot add, replace or delete a row, or change a meta value, of the shared view", () => {
  const { open, kept, conversation } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const receipt = view.receipts[kept]!;
  expect(attempt(() => { view.receipts["receipt-added-by-a-reader"] = receipt; })).toBe(false);
  expect(attempt(() => { view.receipts[kept] = { ...receipt, error: "replaced by a reader" }; })).toBe(false);
  expect(attempt(() => { delete view.receipts[kept]; })).toBe(false);
  expect(attempt(() => { delete view.conversations[conversation.id]; })).toBe(false);
  expect(attempt(() => { view.engineRouting.codex.revision += 1; })).toBe(false);
  expect(attempt(() => { view.conversationRevision.codex += 1; })).toBe(false);

  const next = store.readOnlySnapshot().file;
  expect(next).toBe(view);
  expect(Object.keys(next.receipts)).not.toContain("receipt-added-by-a-reader");
  expect(next.receipts[kept]).toBe(receipt);
  expect(next.conversations[conversation.id]).toBeDefined();
  expect(next.engineRouting.codex.revision).toBe(store.snapshot().file.engineRouting.codex.revision);
});

test("a reader cannot change a row's own fields or anything nested in it, and the next reader keeps the originals", () => {
  const { open, kept, conversation, delivery } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const receipt = view.receipts[kept]!;
  const row = view.conversations[conversation.id]!;
  const held = view.heldDeliveries[delivery.id]!;
  const originalPath = row.generations[0]!.path;
  const originalOperation = held.command.operationId;

  /* The review's reproduction: each of these used to land in the next read. */
  expect(attempt(() => { receipt.error = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { row.generations[0]!.path = "/sessions/reader-corruption.jsonl"; })).toBe(false);
  expect(attempt(() => { held.command.operationId = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { (held.command as { text?: string }).text = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { held.text = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { row.generations.push(row.generations[0]!); })).toBe(false);
  expect(attempt(() => { row.continuityPaths.push("/sessions/reader-corruption.jsonl"); })).toBe(false);
  expect(attempt(() => { row.generations.splice(0, 1); })).toBe(false);
  expect(attempt(() => { delete (held.command as { kind?: string }).kind; })).toBe(false);
  for (const value of [receipt, row, row.generations, row.generations[0], held, held.command]) {
    expect(Object.isFrozen(value)).toBe(true);
  }

  const next = store.readOnlySnapshot().file;
  expect(next.receipts[kept]?.error).toBeNull();
  expect(next.conversations[conversation.id]?.generations).toHaveLength(1);
  expect(next.conversations[conversation.id]?.generations[0]?.path).toBe(originalPath);
  expect(next.heldDeliveries[delivery.id]?.command).toEqual(store.snapshot().file.heldDeliveries[delivery.id]!.command);
  expect(next.heldDeliveries[delivery.id]?.command.operationId).toBe(originalOperation);
  expect(next.heldDeliveries[delivery.id]?.text).toBe("held for the view");
});

test("the store's parse cache stays its own: the view shares no object with it, and a write still edits the row", () => {
  const { open, kept, conversation } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const viewObjects = new Set<unknown>();
  const walk = (value: unknown) => {
    if (value === null || typeof value !== "object" || viewObjects.has(value)) return;
    viewObjects.add(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(view);
  const parsed = (store as unknown as { rowCache: Map<string, Map<string, { parsed: unknown }>> }).rowCache;
  for (const rows of parsed.values()) {
    for (const { parsed: row } of rows.values()) {
      const shared: unknown[] = [];
      const visit = (value: unknown) => {
        if (value === null || typeof value !== "object") return;
        if (viewObjects.has(value)) shared.push(value);
        expect(Object.isFrozen(value)).toBe(false);
        for (const child of Object.values(value)) visit(child);
      };
      visit(row);
      expect(shared).toEqual([]);
    }
  }

  store.mutate((file) => {
    file.receipts[kept]!.error = "written after a read";
    file.conversations[conversation.id]!.continuityPaths.push("/sessions/written-after-a-read.jsonl");
  }, false);
  const next = store.readOnlySnapshot().file;
  expect(next.receipts[kept]?.error).toBe("written after a read");
  expect(next.conversations[conversation.id]?.continuityPaths).toContain("/sessions/written-after-a-read.jsonl");
  expect(Object.isFrozen(next.conversations[conversation.id]?.continuityPaths)).toBe(true);
  expect(view.receipts[kept]?.error).toBeNull();
  expect(view.conversations[conversation.id]?.continuityPaths).not.toContain("/sessions/written-after-a-read.jsonl");
});

test("a write built from a view row can still be edited inside its mutation, and the view stays as it was", () => {
  const { open, kept, conversation } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const row = view.conversations[conversation.id]!;
  const path = row.generations[0]!.path;
  const revision = view.engineRouting.codex.revision;

  /* `upsert({ ...view.entries[id], … })` is how a writer reaches this: the
     spread is new, everything nested in it is the view's own frozen object. */
  store.mutate((file) => {
    file.conversations[conversation.id] = { ...row, title: "spread from the view" };
    file.conversations[conversation.id]!.generations[0]!.path = "/sessions/edited-in-the-mutation.jsonl";
    file.conversations[conversation.id]!.continuityPaths.push("/sessions/pushed-in-the-mutation.jsonl");
    file.receipts[kept]!.launchProfile = view.receipts[kept]!.launchProfile;
    file.receipts[kept]!.launchProfile!.title = "edited in the mutation";
    file.engineRouting = view.engineRouting;
    file.engineRouting.codex.revision += 1;
  }, false);

  const next = store.readOnlySnapshot().file;
  expect(next.conversations[conversation.id]?.title).toBe("spread from the view");
  expect(next.conversations[conversation.id]?.generations[0]?.path).toBe("/sessions/edited-in-the-mutation.jsonl");
  expect(next.conversations[conversation.id]?.continuityPaths).toContain("/sessions/pushed-in-the-mutation.jsonl");
  expect(next.receipts[kept]?.launchProfile?.title).toBe("edited in the mutation");
  expect(next.engineRouting.codex.revision).toBe(revision + 1);
  expect(row.generations[0]!.path).toBe(path);
  expect(row.continuityPaths).not.toContain("/sessions/pushed-in-the-mutation.jsonl");
  expect(view.receipts[kept]?.launchProfile?.title).toBe("Kept receipt");
  expect(view.engineRouting.codex.revision).toBe(revision);
});

test("a reload copies only the rows whose decided value changed", () => {
  const { open, kept, removed, conversation, delivery } = fixture();
  const reader = open();
  const writer = open();
  const before = reader.readOnlySnapshot().file;

  writer.mutate((file) => { file.receipts[kept]!.error = "written elsewhere"; }, false);
  const after = reader.readOnlySnapshot().file;
  expect(after).not.toBe(before);
  expect(after.receipts[kept]).not.toBe(before.receipts[kept]);
  expect(after.receipts[kept]?.error).toBe("written elsewhere");
  expect(after.receipts[removed]).toBe(before.receipts[removed]);
  expect(after.conversations[conversation.id]).toBe(before.conversations[conversation.id]);
  expect(after.heldDeliveries[delivery.id]).toBe(before.heldDeliveries[delivery.id]);
  expect(before.receipts[kept]?.error).toBeNull();
});

test("two readers share one view and neither can corrupt the other; a detached snapshot stays mutable", () => {
  const { open, kept } = fixture();
  const store = open();
  const first = store.readOnlySnapshot().file;
  const second = store.readOnlySnapshot().file;
  expect(second).toBe(first);
  expect(attempt(() => { delete first.receipts[kept]; })).toBe(false);
  expect(second.receipts[kept]).toBeDefined();

  const detached = store.snapshot().file;
  expect(Object.isFrozen(detached)).toBe(false);
  detached.receipts = {};
  expect(Object.keys(detached.receipts)).toHaveLength(0);
  expect(store.readOnlySnapshot().file.receipts[kept]).toBeDefined();
});

test("every local write reaches the next read, and the view a reader already holds stays as it was", () => {
  const { open, kept, removed } = fixture();
  const store = open();
  const before = store.readOnlySnapshot().file;
  const template = before.receipts[kept]!;

  store.mutate((file) => { file.receipts[kept]!.error = "updated locally"; }, false);
  const updated = store.readOnlySnapshot().file;
  expect(updated.receipts[kept]?.error).toBe("updated locally");
  expect(before.receipts[kept]?.error).toBeNull();
  /* The view a local commit patches in place of a reload is frozen too. */
  expect(Object.isFrozen(updated)).toBe(true);
  expect(Object.isFrozen(updated.receipts)).toBe(true);

  store.mutate((file) => { file.receipts["receipt-added-locally"] = { ...structuredClone(template), launchId: "receipt-added-locally" }; }, false);
  expect(store.readOnlySnapshot().file.receipts["receipt-added-locally"]?.launchId).toBe("receipt-added-locally");

  store.mutate((file) => { delete file.receipts[removed]; }, false);
  expect(store.readOnlySnapshot().file.receipts[removed]).toBeUndefined();
  expect(before.receipts[removed]).toBeDefined();

  store.mutate((file) => { file.engineRouting.codex.revision += 7; }, false);
  const meta = store.readOnlySnapshot().file;
  expect(meta.engineRouting.codex.revision).toBe(before.engineRouting.codex.revision + 7);
  expect(Object.isFrozen(meta.engineRouting.codex)).toBe(true);
});

test("a write by another connection reaches the next read, with or without a revision", () => {
  const { open, filename, kept } = fixture();
  const reader = open();
  const writer = open();
  const before = reader.readOnlySnapshot().file;

  writer.mutate((file) => { file.receipts[kept]!.error = "written elsewhere"; }, false);
  expect(reader.readOnlySnapshot().file.receipts[kept]?.error).toBe("written elsewhere");

  /* A commit that rewrites a row without advancing the revision. */
  const db = new Database(filename);
  try {
    db.query("UPDATE registry_rows SET value_json = json_set(value_json, '$.error', ?) WHERE collection = 'receipts' AND row_key = ?")
      .run("written without a revision", kept);
  } finally {
    db.close();
  }
  const after = reader.readOnlySnapshot().file;
  expect(after.receipts[kept]?.error).toBe("written without a revision");
  expect(Object.isFrozen(after.receipts)).toBe(true);
  expect(before.receipts[kept]?.error).toBeNull();
});

test("the view keeps the keyed readers of the loaded file, and a complete read forgets deleted rows", () => {
  const { open, conversation, delivery, removed } = fixture();
  const reader = open();
  const writer = open();
  const view = reader.readOnlySnapshot().file;
  expect(registryRowsMatching(view, "heldDeliveries", "conversationId", conversation.id).map((row) => row.id)).toEqual([delivery.id]);

  const parsed = (store: SqliteAgentRegistryStore) =>
    (store as unknown as { rowCache: Map<string, Map<string, unknown>> }).rowCache.get("receipts")!;
  expect(parsed(reader).has(removed)).toBe(true);
  writer.mutate((file) => { delete file.receipts[removed]; }, false);
  expect(reader.readOnlySnapshot().file.receipts[removed]).toBeUndefined();
  expect(parsed(reader).has(removed)).toBe(false);
});
