import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { initializeStateCollections, SqliteStateCollection, visitStateCollectionsRows, stateCollectionsInitialized } from "./sqliteStateStore";

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


test("the shared reader evicts a switched directory, follows replacement and reopens after process restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"state-shared-reader-"));
  const seed = (name: string) => [{ collection: name,schemaVersion: 1,migrationId: name,
    key: (row: { id: string }) => row.id,loadRecords: () => [{ id: name }] }];
  const first = path.join(root,"first.sqlite"), replacement = path.join(root,"replacement.sqlite");
  try {
    initializeStateCollections(first,seed("first"));
    initializeStateCollections(replacement,seed("replacement"));
    expect(stateCollectionsInitialized(first,seed("first"))).toBe(true);
    expect(stateCollectionsInitialized(replacement,seed("replacement"))).toBe(true);
    expect(stateCollectionsInitialized(first,seed("first"))).toBe(true);
    // VACUUM produces a complete replacement without copying an active WAL.
    const db = new Database(replacement);
    const ready = path.join(root,"ready.sqlite");
    try { db.query("VACUUM INTO ?").run(ready); } finally { db.close(); }
    fs.renameSync(first,path.join(root,"previous.sqlite"));
    fs.renameSync(ready,first);
    expect(stateCollectionsInitialized(first,seed("first"))).toBe(false);
    expect(stateCollectionsInitialized(first,seed("replacement"))).toBe(true);
    const peer = await import("./sqliteStateStore.ts" + "?shared-reader-peer");
    peer.resetStateReadonlyConnectionCountForTests();
    expect(peer.readStateCollectionRows(first,"replacement")).toEqual([{ id: "replacement" }]);
    expect(peer.stateReadonlyConnectionCountForTests()).toBe(0);
    const source = `import { stateCollectionsInitialized,stateReadonlyConnectionCountForTests } from ${JSON.stringify(path.join(import.meta.dir,"sqliteStateStore.ts"))};
      const seed=[{collection:"replacement",schemaVersion:1,migrationId:"replacement",key:r=>r.id,loadRecords:()=>[]}];
      console.log(JSON.stringify([stateCollectionsInitialized(process.argv[1],seed),stateReadonlyConnectionCountForTests()]));`;
    for (let restart = 0; restart < 2; restart++) {
      const child = Bun.spawnSync({ cmd: [process.execPath,"-e",source,first],
        env: { ...process.env,LLV_STATE_DIR: path.join(root,"state"),LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },stdout: "pipe",stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual([true,1]);
    }
  } finally { fs.rmSync(root,{ recursive: true,force: true }); }
});
