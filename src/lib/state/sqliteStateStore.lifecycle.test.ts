import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { initializeStateCollections, SqliteStateCollection, visitStateCollectionsRows } from "./sqliteStateStore";

test.skipIf(process.platform !== "linux")("a refused collection releases its SQLite descriptors immediately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-collection-lifecycle-"));
  const filename = path.join(root, "state.sqlite");
  const descriptors = () => fs.readdirSync("/proc/self/fd").filter((fd) => {
    try {
      const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
      return target === filename || target === `${filename}-wal` || target === `${filename}-shm`;
    } catch { return false; }
  }).length;
  try {
    initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1,
      migrationId: "fixture", key: (row: { id: string }) => row.id, loadRecords: () => [{ id: "row" }] }]);
    const before = descriptors();
    for (const collection of ["fixture", "missing"]) {
      for (let attempt = 0; attempt < 12; attempt++) {
        expect(() => new SqliteStateCollection(filename, {
          collection, schemaVersion: 2, busyMessage: "fixture is busy",
          key: (row: { id: string }) => row.id,
          decode: (row) => row as { id: string }, clone: (row) => ({ ...row }),
        })).toThrow(collection === "missing" ? "not initialized" : "unsupported");
        expect(descriptors()).toBe(before);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("a refused asynchronous evidence read releases its snapshot and descriptors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-evidence-lifecycle-"));
  const filename = path.join(root, "state.sqlite");
  const descriptors = () => fs.readdirSync("/proc/self/fd").filter(fd => {
    try { return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(filename); }
    catch { return false; }
  }).length;
  try {
    initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1,
      migrationId: "fixture", key: (row: { id: string }) => row.id, loadRecords: () => [{ id: "row" }] }]);
    const before = descriptors();
    for (let attempt = 0; attempt < 12; attempt++) {
      await expect(visitStateCollectionsRows(filename, ["fixture"], () => { throw new Error("evidence refused"); })).rejects.toThrow("evidence refused");
      expect(descriptors()).toBe(before);
    }
    await expect(visitStateCollectionsRows(filename, ["fixture"], () => { throw new Error("no such table in a callback"); })).rejects.toThrow("no such table in a callback");
    expect(descriptors()).toBe(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
