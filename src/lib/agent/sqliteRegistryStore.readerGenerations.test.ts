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

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-generations-"));
  directories.push(directory);
  const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05));
  let completeLoads = 0;
  const open = (counted: boolean) => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("the dataset must already exist"); },
      ...(counted ? { onSnapshotLoad: () => { completeLoads += 1; } } : {}),
    });
    stores.push(store);
    return store;
  };
  const reader = open(true);
  const writer = open(false);
  const judge = open(false);
  const receipt = dataset.grantSubjects.find(subject => subject.collection === "receipts")!.key;
  return { dataset, reader, writer, judge, receipt, completeLoads: () => completeLoads };
}

function accessors(): number {
  Bun.gc(true);
  return (heapStats().objectTypeCounts as Record<string, number>).GetterSetter ?? 0;
}

test("a preparation after a few commits replays them and assembles no new view of the whole registry", async () => {
  const { dataset, reader, writer, judge, receipt, completeLoads } = fixture();
  const first = (await reader.prepareReadOnlySnapshot()).file;
  const loaded = completeLoads();
  expect(loaded).toBeGreaterThan(0);
  const held: RegistryFile[] = [];
  const before = accessors();
  const rounds = 10;
  for (let round = 1; round <= rounds; round++) {
    writer.mutate((file) => { file.receipts[receipt]!.clientAttemptId = `attempt-${round}`; }, false);
    const prepared = await reader.prepareReadOnlySnapshot();
    expect(prepared.revision).toBe(judge.snapshot().revision);
    held.push(prepared.file);
  }
  // Every held view is a view a caller may still be reading: before the
  // change each one kept its own reader and one accessor per archived row.
  expect(completeLoads()).toBe(loaded);
  expect((accessors() - before) / rounds).toBeLessThan(dataset.coldRows / 2);
  held.forEach((view, index) => {
    expect(view.receipts[receipt]!.clientAttemptId).toBe(`attempt-${index + 1}`);
    expect(Object.keys(view.receipts)).toEqual(Object.keys(first.receipts));
  });
  expect(first.receipts[receipt]!.clientAttemptId).not.toBe("attempt-1");
  expect(held.at(-1)!.receipts[receipt]).toEqual(judge.snapshot().file.receipts[receipt]!);
  expect(reader.readOnlySnapshot().file).toBe(held.at(-1)!);
});

test("a preparation after more commits than one step replays takes the cooperative path", async () => {
  const { reader, writer, judge, receipt, completeLoads } = fixture();
  await reader.prepareReadOnlySnapshot();
  const loaded = completeLoads();
  for (let round = 1; round <= 300; round++) {
    writer.mutate((file) => { file.receipts[receipt]!.clientAttemptId = `attempt-${round}`; }, false);
  }
  const prepared = await reader.prepareReadOnlySnapshot();
  expect(completeLoads()).toBe(loaded + 1);
  expect(prepared.file.receipts[receipt]!.clientAttemptId).toBe("attempt-300");
  expect(prepared.revision).toBe(judge.snapshot().revision);
}, 60_000);
