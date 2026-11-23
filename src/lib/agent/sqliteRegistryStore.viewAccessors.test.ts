import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heapStats } from "bun:jsc";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { normalizeRegistry, type RegistryFile } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** Live accessor cells, their functions and the scopes those close over. */
function census() {
  Bun.gc(true);
  const types = heapStats().objectTypeCounts as Record<string, number>;
  return { accessors: types.GetterSetter ?? 0, functions: types.Function ?? 0, scopes: types.JSLexicalEnvironment ?? 0 };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-accessors-"));
  directories.push(directory);
  const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05));
  const open = () => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("the dataset must already exist"); },
    });
    stores.push(store);
    return store;
  };
  const reader = open();
  const writer = open();
  const first = reader.readOnlySnapshot().file;
  const receipt = dataset.grantSubjects.find(subject => subject.collection === "receipts")!.key;
  const delivery = dataset.pendingDeliveryIds[0]!;
  expect(first.receipts[receipt]).toBeDefined();
  expect(first.heldDeliveries[delivery]).toBeDefined();
  return { reader, writer, first, receipt, delivery };
}

/**
 * Every view a caller still holds stays readable, so the cells one view costs
 * are the cells a held view pins. Holding `rounds` views and counting what
 * they added gives the cost of one refresh without relying on what the
 * collector has reached.
 */
function costOfRefreshes(reader: SqliteAgentRegistryStore, rounds: number, write: (round: number) => void) {
  const held: RegistryFile[] = [];
  const before = census();
  for (let round = 1; round <= rounds; round++) {
    write(round);
    held.push(reader.readOnlySnapshot().file);
  }
  const after = census();
  expect(held).toHaveLength(rounds);
  return {
    held,
    accessors: (after.accessors - before.accessors) / rounds,
    functions: (after.functions - before.functions) / rounds,
    scopes: (after.scopes - before.scopes) / rounds,
  };
}

test("a refresh that rewrites one row makes no accessor per row of its collection", () => {
  const { reader, writer, first, receipt } = fixture();
  const rows = Object.keys(first.receipts).length;
  expect(rows).toBeGreaterThan(400);
  const cost = costOfRefreshes(reader, 8, round => writer.mutate((file) => {
    file.receipts[receipt]!.clientAttemptId = `attempt-${round}`;
  }, false));
  // Before the change each refresh made one accessor, function and scope per row.
  expect(cost.accessors).toBeLessThan(rows / 10);
  expect(cost.functions).toBeLessThan(rows / 10);
  expect(cost.scopes).toBeLessThan(rows / 10);
  // Each held view still reads its own version of the row and every other row.
  cost.held.forEach((view, index) => {
    expect(view.receipts[receipt]!.clientAttemptId).toBe(`attempt-${index + 1}`);
    expect(Object.keys(view.receipts)).toEqual(Object.keys(first.receipts));
    expect(Object.isFrozen(view.receipts)).toBe(true);
  });
  expect(first.receipts[receipt]!.clientAttemptId).not.toBe("attempt-1");
});

test("a refresh that rewrites one delivery makes no accessor per archived operation owner", () => {
  const { reader, writer, first, delivery } = fixture();
  const owners = Object.keys(first.deliveryOperationOwners).length;
  const deliveries = Object.keys(first.heldDeliveries).length;
  expect(owners).toBeGreaterThan(400);
  const cost = costOfRefreshes(reader, 8, round => writer.mutate((file) => {
    file.heldDeliveries[delivery]!.text = `rewritten ${round}`;
  }, false));
  expect(cost.accessors).toBeLessThan((owners + deliveries) / 10);
  expect(cost.functions).toBeLessThan((owners + deliveries) / 10);
  expect(cost.scopes).toBeLessThan((owners + deliveries) / 10);
  const operationId = first.heldDeliveries[delivery]!.command.operationId;
  cost.held.forEach((view, index) => {
    expect(view.heldDeliveries[delivery]!.text).toBe(`rewritten ${index + 1}`);
    expect(Object.keys(view.deliveryOperationOwners)).toEqual(Object.keys(first.deliveryOperationOwners));
    expect(view.deliveryOperationOwners[operationId]).toEqual(first.deliveryOperationOwners[operationId]);
  });
});

test("a refresh that adds one row makes one accessor per row and no function per row", () => {
  const { reader, writer, first, receipt } = fixture();
  const rows = Object.keys(first.receipts).length;
  const cost = costOfRefreshes(reader, 8, round => writer.mutate((file) => {
    file.receipts[`added-launch-${round}`] = { ...JSON.parse(JSON.stringify(file.receipts[receipt]!)), launchId: `added-launch-${round}` };
  }, false));
  // A view owns its key list, so a new key costs the accessor cells of one list.
  expect(cost.accessors).toBeLessThan(rows * 1.2);
  expect(cost.functions).toBeLessThan(rows / 10);
  expect(cost.scopes).toBeLessThan(rows / 10);
  cost.held.forEach((view, index) => {
    expect(Object.keys(view.receipts)).toHaveLength(rows + index + 1);
    expect(view.receipts[`added-launch-${index + 1}`]!.launchId).toBe(`added-launch-${index + 1}`);
    expect(view.receipts[`added-launch-${index + 2}`]).toBeUndefined();
  });
});

test("a refresh that adds one row and is read by key makes no accessor per row", () => {
  const { reader, writer, first, receipt } = fixture();
  const rows = Object.keys(first.receipts).length;
  const cost = costOfRefreshes(reader, 8, round => writer.mutate((file) => {
    file.receipts[`keyed-launch-${round}`] = { ...JSON.parse(JSON.stringify(file.receipts[receipt]!)), launchId: `keyed-launch-${round}` };
  }, false));
  // Each held view has its own key list; none of them was asked for its keys.
  expect(cost.accessors).toBeLessThan(rows / 10);
  expect(cost.functions).toBeLessThan(rows / 10);
  expect(cost.scopes).toBeLessThan(rows / 10);
  cost.held.forEach((view, index) => {
    const added = `keyed-launch-${index + 1}`;
    expect(view.receipts[added]!.launchId).toBe(added);
    expect(added in view.receipts).toBe(true);
    expect(`keyed-launch-${index + 2}` in view.receipts).toBe(false);
  });
  // Asking for keys or descriptors gives the view its frozen accessors.
  const last = cost.held.at(-1)!;
  const added = "keyed-launch-8";
  expect(Object.hasOwn(last.receipts, added)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(last.receipts, added)).toMatchObject({ enumerable: true, configurable: false });
  expect(Object.getOwnPropertyDescriptor(last.receipts, added)!.get!.call(last.receipts)).toEqual(last.receipts[added]!);
  expect(Object.isFrozen(last.receipts)).toBe(true);
  expect(Object.isExtensible(cost.held[0]!.receipts)).toBe(false);
  expect(Object.keys(last.receipts)).toHaveLength(rows + 8);
  expect(Object.keys(cost.held[3]!.receipts)).toEqual([...Object.keys(first.receipts), "keyed-launch-1", "keyed-launch-2", "keyed-launch-3", "keyed-launch-4"]);
  expect(Reflect.defineProperty(last.receipts, "other", { value: 1 })).toBe(false);
  expect(Reflect.deleteProperty(last.receipts, added)).toBe(false);
});

test("an archive pass makes no function per archived row of the collection it moves rows into", () => {
  const { reader, writer, first, receipt } = fixture();
  const rows = Object.keys(first.receipts).length;
  const settled = Array.from({ length: 24 }, (_, index) => `settled-launch-${index}`);
  writer.mutate((file) => {
    for (const launchId of settled) {
      file.receipts[launchId] = { ...JSON.parse(JSON.stringify(file.receipts[receipt]!)), launchId, state: "failed", key: null, queuedPinnedSpawn: null };
    }
  }, false);
  reader.readOnlySnapshot();
  let moved = 0;
  const cost = costOfRefreshes(reader, 6, () => { moved += writer.archiveInactive(4); });
  expect(moved).toBe(settled.length);
  // Before the change each pass made a function, a scope and a descriptor for
  // every archived row of the collection the moved rows belong to.
  expect(cost.functions).toBeLessThan(rows / 10);
  expect(cost.scopes).toBeLessThan(rows / 10);
  const judge = new SqliteAgentRegistryStore(writer.filename, {
    normalize: normalizeRegistry,
    initialSnapshot: () => { throw new Error("the dataset must already exist"); },
  });
  stores.push(judge);
  const whole = judge.snapshot().file;
  const last = cost.held.at(-1)!;
  expect(Object.keys(last.receipts)).toEqual(Object.keys(whole.receipts));
  for (const launchId of [...settled, ...Object.keys(first.receipts).slice(0, 25)]) {
    expect(last.receipts[launchId]).toEqual(whole.receipts[launchId]!);
  }
  // A view held from before a pass still reads the rows as they were then.
  expect(cost.held[0]!.receipts[settled[0]!]).toEqual(whole.receipts[settled[0]!]!);
});

test("a new prepared reader takes over the accessors of the reader before it", async () => {
  const { reader, writer, first } = fixture();
  const conversation = Object.keys(first.conversations).at(-1)!;
  const rows = (["receipts", "entries", "heldDeliveries", "deliveryOperationOwners", "conversations"] as const)
    .reduce((total, collection) => total + Object.keys(first[collection]).length, 0);
  await reader.prepareReadOnlySnapshot();
  const held: RegistryFile[] = [];
  const before = census();
  const rounds = 4;
  for (let round = 1; round <= rounds; round++) {
    // A conversation change is not replayed on the published reader: each
    // preparation opens a reader and builds every collection of its view.
    writer.mutate((file) => {
      file.conversations[conversation]!.generations.at(-1)!.launchProfile.title = `prepared ${round}`;
    }, false);
    held.push((await reader.prepareReadOnlySnapshot()).file);
  }
  const after = census();
  // Before the change each prepared reader made an accessor per row and a
  // function and a scope per row and per archived row of its first view.
  expect((after.functions - before.functions) / rounds).toBeLessThan(rows / 5);
  expect((after.scopes - before.scopes) / rounds).toBeLessThan(rows / 5);
  expect((after.accessors - before.accessors) / rounds).toBeLessThan(rows / 5);
  held.forEach((view, index) => {
    expect(view.conversations[conversation]!.generations.at(-1)!.launchProfile.title).toBe(`prepared ${index + 1}`);
    expect(Object.keys(view.receipts)).toEqual(Object.keys(first.receipts));
    expect(Object.isFrozen(view.conversations)).toBe(true);
  });
});

test("an archived operation owner reads the deliveries of the view it is read through", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-accessors-"));
  directories.push(directory);
  const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.02));
  const open = () => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("the dataset must already exist"); },
    });
    stores.push(store);
    return store;
  };
  const reader = open();
  const writer = open();
  const judge = open();
  const operationId = dataset.coldOperationIds[0]!;
  const before = judge.snapshot().file.deliveryOperationOwners[operationId]!;
  const held = reader.readOnlySnapshot().file;
  const views: RegistryFile[] = [];
  const judged: unknown[] = [];
  const states = ["failed", "delivered", "failed"] as const;
  for (const state of states) {
    writer.mutate((file) => { file.heldDeliveries[before.deliveryId]!.state = state; }, false);
    views.push(reader.readOnlySnapshot().file);
    judged.push(judge.snapshot().file.deliveryOperationOwners[operationId]);
  }
  // The owner stays archived while its delivery changes, so each view reads
  // the same archived version against its own delivery, as a whole load does.
  views.forEach((view, index) => {
    expect(view.heldDeliveries[before.deliveryId]!.state).toBe(states[index]!);
    expect(view.deliveryOperationOwners[operationId]).toEqual(judged[index] as typeof before);
  });
  expect(views[0]!.deliveryOperationOwners[operationId]!.terminalState).toBe("failed");
  expect(new Set(judged.map(owner => JSON.stringify(owner))).size).toBeGreaterThan(1);
  expect(held.deliveryOperationOwners[operationId]).toEqual(before);
  expect(Object.keys(views[2]!.deliveryOperationOwners)).toEqual(Object.keys(judge.snapshot().file.deliveryOperationOwners));
});

test("owners synthesized from archived deliveries survive a refresh that takes the archived owners over", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-accessors-"));
  directories.push(directory);
  const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.02));
  // A legacy archived delivery with no stored owner row beside archived owners.
  const operationId = dataset.coldOperationIds[0]!;
  const db = new Database(dataset.filename);
  try {
    expect(db.run("DELETE FROM registry_rows WHERE collection='deliveryOperationOwners' AND row_key=?", [operationId]).changes).toBeGreaterThan(0);
  } finally { db.close(); }
  const open = () => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("the dataset must already exist"); },
    });
    stores.push(store);
    return store;
  };
  const reader = open();
  const writer = open();
  const judge = open();
  const first = reader.readOnlySnapshot().file;
  const synthesized = first.deliveryOperationOwners[operationId];
  expect(synthesized).toBeDefined();
  const delivery = dataset.pendingDeliveryIds[0]!;
  for (let round = 1; round <= 3; round++) {
    writer.mutate((file) => {
      file.heldDeliveries[delivery]!.text = `rewritten ${round}`;
    }, false);
    const view = reader.readOnlySnapshot().file;
    const whole = judge.snapshot().file;
    expect(view.deliveryOperationOwners[operationId]).toEqual(synthesized!);
    expect(Object.keys(view.deliveryOperationOwners)).toEqual(Object.keys(whole.deliveryOperationOwners));
    expect(view.heldDeliveries[delivery]).toEqual(whole.heldDeliveries[delivery]!);
  }
  expect(first.deliveryOperationOwners[operationId]).toEqual(synthesized!);
});
