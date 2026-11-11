import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heapStats } from "bun:jsc";
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
    file.heldDeliveries[delivery]!.updatedAt = new Date(Date.UTC(2026, 9, 13, 0, 0, round)).toISOString();
  }, false));
  expect(cost.accessors).toBeLessThan((owners + deliveries) / 10);
  expect(cost.functions).toBeLessThan((owners + deliveries) / 10);
  expect(cost.scopes).toBeLessThan((owners + deliveries) / 10);
  const operationId = first.heldDeliveries[delivery]!.command.operationId;
  cost.held.forEach((view, index) => {
    expect(view.heldDeliveries[delivery]!.updatedAt).toBe(new Date(Date.UTC(2026, 9, 13, 0, 0, index + 1)).toISOString());
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
  const states = ["failed", "cancelled", "delivered"] as const;
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
