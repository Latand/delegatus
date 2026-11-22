import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { normalizeRegistry, type DeliveryOperationOwner, type RegistryFile } from "./registry";
import {
  registryKeysMatching,
  registryKeysMatchingBounded,
  registryRowsMatching,
  SqliteAgentRegistryStore,
} from "./sqliteRegistryStore";

const roots: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const AT = "2026-10-01T00:00:00.000Z";

function makeOwner(
  operationId: string,
  conversationId: `conversation_${string}`,
  terminal: boolean,
): DeliveryOperationOwner {
  return {
    conversationId,
    runtimeConversationId: conversationId,
    clientMessageId: `msg_${operationId}`,
    deliveryId: `delivery_${operationId}`,
    requestDigest: `digest_${operationId}`,
    contentDigest: null,
    command: { operationId, origin: { kind: "operator" } } as DeliveryOperationOwner["command"],
    retryOfOperationId: null,
    createdAt: AT,
    terminalState: terminal ? "delivered" : null,
    terminalDisposition: terminal ? "delivered" : null,
    terminalReason: null,
    settledAt: terminal ? AT : null,
  };
}

function createFixture(terminalCount = 1_500) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-owners-index-"));
  roots.push(root);
  const owners: Record<string, DeliveryOperationOwner> = {};
  for (let index = 0; index < terminalCount; index += 1) {
    const id = `op-terminal-${String(index).padStart(5, "0")}`;
    owners[id] = makeOwner(id, "conversation_archived", true);
  }
  owners["op-pending-1"] = makeOwner("op-pending-1", "conversation_live_a", false);
  owners["op-pending-2"] = makeOwner("op-pending-2", "conversation_live_b", false);
  owners["op-pending-3"] = makeOwner("op-pending-3", "conversation_live_c", false);

  const initial: RegistryFile = normalizeRegistry({
    version: 2,
    entries: {},
    receipts: {},
    conversations: {
      conversation_live_a: {
        id: "conversation_live_a",
        engine: "codex",
        createdAt: AT,
        updatedAt: AT,
        generations: [{
          id: "gen_a",
          path: "/sessions/a.jsonl",
          createdAt: AT,
          launchProfile: emptyLaunchProfile({ cwd: "/repo", mcpServers: ["viewer"] }),
        }],
      },
    },
    deliveryOperationOwners: owners,
  });

  const filename = path.join(root, "registry.sqlite");
  let decoded = 0;
  let readRows = 0;
  const open = (readOnly = false) => {
    const store = new SqliteAgentRegistryStore(filename, {
      initialSnapshot: initial,
      normalize: normalizeRegistry,
      readOnly,
      onRowPayloadParse: (collection, count) => {
        if (collection === "deliveryOperationOwners") decoded += count;
      },
      onRowPayloadRead: (collection, count) => {
        if (collection === "deliveryOperationOwners") readRows += count;
      },
    });
    stores.push(store);
    return store;
  };
  return {
    filename,
    open,
    resetCounters: () => { decoded = 0; readRows = 0; },
    decoded: () => decoded,
    readRows: () => readRows,
  };
}

test("single-clause pending deliveryOperationOwners lookup uses the partial index and avoids scanning terminal rows", async () => {
  const f = createFixture(1_500);
  const store = f.open();
  await store.prepareRecoveryIndexes();
  expect(store.archiveInactive(10_000)).toBeGreaterThan(1_000);
  await store.prepareReadOnlySnapshot();

  // Verify SQLite uses the partial index for the single-clause pending query.
  const inspect = new Database(f.filename, { readonly: true });
  try {
    const plan = inspect.query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN SELECT row_key FROM registry_rows INDEXED BY registry_pending_delivery_owner_origin
       WHERE collection='deliveryOperationOwners' AND json_extract(value_json,'$.terminalState') IS NULL
       ORDER BY row_order LIMIT 100`,
    ).all().map(row => row.detail).join(" | ");
    expect(plan).toContain("registry_pending_delivery_owner_origin");
  } finally {
    inspect.close();
  }

  f.resetCounters();
  const view = store.readOnlySnapshot().file;
  const rows = registryRowsMatching(view, "deliveryOperationOwners", "custodyState", "pending");
  expect(rows.map(row => row.command.operationId)).toEqual([
    "op-pending-1",
    "op-pending-2",
    "op-pending-3",
  ]);
  expect(registryKeysMatchingBounded(view, "deliveryOperationOwners", [{ field: "custodyState", value: "pending" }], 2))
    .toEqual(["op-pending-1", "op-pending-2"]);
  expect(registryKeysMatchingBounded(view, "deliveryOperationOwners", [{ field: "custodyState", value: "pending" }], 0))
    .toEqual([]);
  expect(registryKeysMatching(view, "deliveryOperationOwners", "custodyState", [])).toEqual([]);
  expect(f.decoded()).toBeLessThan(10);
  expect(f.readRows()).toBeLessThan(10);

  // Terminal lookup still works accurately without hitting the pending-only partial index.
  const terminalKeys = registryKeysMatching(view, "deliveryOperationOwners", "custodyState", "terminal");
  expect(terminalKeys.length).toBe(1_500);
});

test("pinned readOnlySnapshot stays isolated across concurrent second-connection commits while fresh reads see updates", async () => {
  const f = createFixture(100);
  const reader = f.open();
  const writer = f.open();
  await reader.prepareReadOnlySnapshot();

  const held = reader.readOnlySnapshot().file;
  expect(registryKeysMatching(held, "deliveryOperationOwners", "custodyState", "pending")).toEqual([
    "op-pending-1",
    "op-pending-2",
    "op-pending-3",
  ]);

  // Second SQLite connection transitions one owner to terminal, deletes another, and inserts a new pending owner.
  writer.mutate((file) => {
    const settled = file.deliveryOperationOwners["op-pending-1"]!;
    settled.terminalState = "delivered";
    settled.terminalDisposition = "delivered";
    settled.settledAt = AT;
    delete file.deliveryOperationOwners["op-pending-2"];
    file.deliveryOperationOwners["op-pending-4"] = makeOwner("op-pending-4", "conversation_live_d", false);
  }, false);

  // Held snapshot must retain its exact point-in-time pending set.
  expect(registryKeysMatching(held, "deliveryOperationOwners", "custodyState", "pending")).toEqual([
    "op-pending-1",
    "op-pending-2",
    "op-pending-3",
  ]);
  expect(registryRowsMatching(held, "deliveryOperationOwners", "custodyState", "pending").map(row => row.command.operationId))
    .toEqual(["op-pending-1", "op-pending-2", "op-pending-3"]);

  // Fresh snapshots on both the original store and a newly opened connection see the committed changes.
  for (const freshStore of [reader, f.open(true)]) {
    const fresh = freshStore.readOnlySnapshot().file;
    expect(registryKeysMatching(fresh, "deliveryOperationOwners", "custodyState", "pending")).toEqual([
      "op-pending-3",
      "op-pending-4",
    ]);
    expect(registryRowsMatching(fresh, "deliveryOperationOwners", "custodyState", "pending").map(row => row.command.operationId))
      .toEqual(["op-pending-3", "op-pending-4"]);
  }
});

test("mutate sees uncommitted pending-owner edits immediately and isolates rolled-back mutations and caller array/object mutations", () => {
  const f = createFixture(50);
  const store = f.open();
  const observer = f.open(true);

  // Uncommitted edits inside mutate are visible immediately and vanish on rollback.
  expect(() => {
    store.mutate((file) => {
      file.deliveryOperationOwners["op-pending-1"]!.terminalState = "failed";
      file.deliveryOperationOwners["op-pending-temp"] = makeOwner("op-pending-temp", "conversation_temp", false);
      expect(registryKeysMatching(file, "deliveryOperationOwners", "custodyState", "pending")).toEqual([
        "op-pending-2",
        "op-pending-3",
        "op-pending-temp",
      ]);
      // Second connection cannot see uncommitted transaction edits.
      expect(registryKeysMatching(observer.readOnlySnapshot().file, "deliveryOperationOwners", "custodyState", "pending")).toEqual([
        "op-pending-1",
        "op-pending-2",
        "op-pending-3",
      ]);
      throw new Error("rollback probe");
    }, false);
  }).toThrow("rollback probe");

  // After rollback, original pending set is intact.
  const view = store.readOnlySnapshot().file;
  const rows = registryRowsMatching(view, "deliveryOperationOwners", "custodyState", "pending");
  expect(rows.map(row => row.command.operationId)).toEqual(["op-pending-1", "op-pending-2", "op-pending-3"]);

  // Caller mutating the returned array or attempting to mutate a frozen row does not corrupt subsequent reads.
  expect(() => {
    (rows[0] as { terminalState: string | null }).terminalState = "delivered";
  }).toThrow(TypeError);
  rows.pop();
  const again = registryRowsMatching(view, "deliveryOperationOwners", "custodyState", "pending");
  expect(again.map(row => row.command.operationId)).toEqual(["op-pending-1", "op-pending-2", "op-pending-3"]);
  expect(again[0]!.terminalState).toBeNull();
});

test("read-only store falls back cleanly when the partial pending-owner index is absent on a legacy database", () => {
  const f = createFixture(40);
  const writer = f.open();
  writer.close();

  const raw = new Database(f.filename);
  try {
    raw.exec("DROP INDEX IF EXISTS registry_pending_delivery_owner_origin");
  } finally {
    raw.close();
  }

  const legacyReader = f.open(true);
  const view = legacyReader.readOnlySnapshot().file;
  expect(registryRowsMatching(view, "deliveryOperationOwners", "custodyState", "pending").map(row => row.command.operationId))
    .toEqual(["op-pending-1", "op-pending-2", "op-pending-3"]);
});
