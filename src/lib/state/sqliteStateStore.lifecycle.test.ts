import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { initializeStateCollections, SqliteStateCollection, visitStateCollectionsRows, stateCollectionsInitialized } from "./sqliteStateStore";

test("publication readers leave an older schema to its startup owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-state-reader-"));
  const filename = path.join(root, "state.sqlite");
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  const env: NodeJS.ProcessEnv = { ...process.env, LLV_STATE_DIR: root, LLV_GATE_STATE_DIR: root,
    HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root };
  delete env.LLV_STATE_OWNER;
  const run = (code: string, startupOwner = false) => {
    const result = spawnSync(process.execPath, ["-e", code], { cwd: process.cwd(),
      env: startupOwner ? { ...env, LLV_STATE_OWNER: "viewer" } : env, encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const setup = `
    const { initializeStateCollections } = await import("./src/lib/state/sqliteStateStore.ts");
    const seed = { collection: "fixture", schemaVersion: 1, migrationId: "one", key: row => row.id, loadRecords: () => [{ id: "kept" }] };
    initializeStateCollections(process.env.LLV_STATE_DIR + "/state.sqlite", [seed]);
  `;
  const denied = `
    import { mock } from "bun:test";
    const ownership = await import("./src/lib/stateOwnership.ts");
    // Only the ownership decision is substituted; the real hook/store graph
    // and schema checks run against a private database in each fresh process.
    mock.module("./src/lib/stateOwnership.ts", () => ({ ...ownership,
      mayRunStateStartupMutation: () => false,
      assertStateStartupMutation: (directory, step) => { throw new ownership.StateStartupMutationRefused(step, directory, {}); },
    }));
    const { initializeStateCollections, SqliteStateCollection } = await import("./src/lib/state/sqliteStateStore.ts");
    const filename = process.env.LLV_STATE_DIR + "/state.sqlite";
    const seed = { collection: "fixture", schemaVersion: 1, migrationId: "one", key: row => row.id, loadRecords: () => { throw new Error("must not import"); } };
    const options = { ...seed, busyMessage: "busy", readOnlyOpen: false, decode: value => value, clone: structuredClone };
  `;
  try {
    const git = spawnSync("git", ["init", "-q", checkout], { env, encoding: "utf8" });
    expect(git.status, git.stderr).toBe(0);
    run(setup + `
      const { cloudCheckConfig } = await import("./scripts/cloud-check-config.ts");
      if (await cloudCheckConfig(${JSON.stringify(checkout)}) !== null) throw new Error("unexpected Cloud setup");
    `);
    // Any new derived index can make a compatible stored collection look old.
    // The authority index upgrade exposed this path in the pre-push hook.
    const db = new Database(filename);
    db.exec("DROP INDEX pipeline_evidence_changed");
    const schema = () => db.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    const before = schema();
    try {
      for (const code of [
        `await import("./scripts/local-gate.ts"); await import("./scripts/privacy-publication-gate.ts");`,
        `initializeStateCollections(filename, [seed]);`,
        `const store = new SqliteStateCollection(filename, options); try { if (store.get("kept")?.id !== "kept") throw new Error("lost row"); } finally { store.close(); }`,
        `const { cloudCheckConfig } = await import("./scripts/cloud-check-config.ts"); if (await cloudCheckConfig(${JSON.stringify(checkout)}) !== null) throw new Error("unexpected Cloud setup");`,
        `try { new SqliteStateCollection(filename, { ...options, schemaVersion: 2 }); throw new Error("accepted incompatible collection"); } catch (error) { if (!String(error).includes("unsupported fixture SQLite schema")) throw error; }`,
        `try { initializeStateCollections(filename, [seed], { reimportExisting: true }); throw new Error("accepted reimport"); } catch (error) { if (!(error instanceof ownership.StateStartupMutationRefused) || !String(error).includes("state database schema")) throw error; }`,
        `try { initializeStateCollections(filename, [{ ...seed, collection: "missing" }]); throw new Error("accepted import"); } catch (error) { if (!(error instanceof ownership.StateStartupMutationRefused)) throw error; }`,
      ]) {
        run(denied + code);
        expect(schema()).toEqual(before);
        expect(db.query("SELECT value_json FROM state_rows WHERE collection='fixture' ORDER BY row_key").all()).toEqual([{ value_json: '{"id":"kept"}' }]);
      }
    } finally { db.close(); }
    // The declared startup path still upgrades and writes on its next boot.
    run(setup + `
      const { SqliteStateCollection } = await import("./src/lib/state/sqliteStateStore.ts");
      const store = new SqliteStateCollection(process.env.LLV_STATE_DIR + "/state.sqlite", { ...seed, busyMessage: "busy", decode: value => value, clone: structuredClone });
      try { await store.mutate(async (rows, persist) => { rows.push({ id: "owner" }); await persist(); }); if (!store.get("owner")) throw new Error("owner write lost"); } finally { store.close(); }
    `, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

test("reopening repairs every core index before indexed queries can run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-schema-readiness-"));
  const filename = path.join(root, "state.sqlite");
  const seed = [{ collection: "fixture", schemaVersion: 1, migrationId: "fixture",
    key: (row: { id: string }) => row.id, loadRecords: () => [{ id: "row" }] }];
  try {
    initializeStateCollections(filename, seed);
    const db = new Database(filename);
    try {
      const schema = () => db.query<{ type: string; name: string; tbl_name: string }, []>(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type, name",
      ).all();
      const complete = schema();
      const indexes = complete.filter(row => row.type === "index" && ["state_rows", "state_changes"].includes(row.tbl_name) && !row.name.startsWith("sqlite_autoindex_"));
      expect(indexes.filter(row => row.name.startsWith("state_rows_task_"))).toHaveLength(11);
      expect(indexes.some(row => row.name === "state_rows_task_finding")).toBe(true);
      expect(indexes.some(row => row.name === "state_rows_task_due")).toBe(true);
      for (const { name } of indexes) {
        db.exec(`DROP INDEX "${name}"`);
        initializeStateCollections(filename, seed);
        expect(schema()).toEqual(complete);
      }
      db.exec("DROP INDEX state_rows_task_due");
      db.exec(`CREATE INDEX state_rows_task_due ON state_rows(
        json_extract(value_json,'$.project'),
        round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000), row_key)
        WHERE collection='tasks' AND json_valid(value_json)
          AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
          AND json_extract(value_json,'$.status') <> 'done'`);
      initializeStateCollections(filename, seed);
      expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='state_rows_task_due'").get()!.sql)
        .toContain("coalesce(json_extract(value_json,'$.machine'),'')");
      db.exec("DROP INDEX state_rows_task_due");
      db.exec(`CREATE INDEX state_rows_task_due ON state_rows(
        json_extract(value_json,'$.project'), coalesce(json_extract(value_json,'$.machine'),''),
        CASE json_extract(value_json,'$.priority') WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END,
        max(round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000),
          coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0)), row_key)
        WHERE collection='tasks' AND json_valid(value_json)
          AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
          AND json_extract(value_json,'$.status') <> 'done'`);
      initializeStateCollections(filename, seed);
      expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='state_rows_task_due'").get()!.sql)
        .not.toContain("max(");
      // A ready database opens without requesting SQLite's writer lock.
      db.exec("BEGIN IMMEDIATE");
      try { initializeStateCollections(filename, seed); }
      finally { db.exec("ROLLBACK"); }
    } finally { db.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
