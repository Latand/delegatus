import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { copyAgentStateRow } from "@/lib/agentState/store";
import { fixtureRegistry, FIXTURE_SESSION } from "@/lib/agentState/testFixture";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { normalizeRegistry } from "./registry";
import { registryRowsMatching, SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const kinds = ["codex-app-server"];
const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-process-entries-"));
  close.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "registry.sqlite");
  const processIdentity = captureProcessIdentity(process.pid);
  const seed = fixtureRegistry(root, "codex", processIdentity, null);
  const template = seed.entries[`codex:${FIXTURE_SESSION}`]!;
  let reads = 0;
  const open = () => {
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: seed, normalize: normalizeRegistry,
      onRowPayloadRead: (collection, n) => { if (collection === "entries") reads += n; } });
    close.push(() => store.close());
    return store;
  };
  const store = open();
  const db = new Database(filename);
  close.push(() => db.close());
  const hot = db.query("INSERT INTO registry_rows(collection,row_key,row_order,value_json) VALUES ('entries',?,?,?)");
  const archive = db.query<{ id: number }, [string, number, string]>(
    "INSERT INTO registry_archive(collection,row_key,row_order,value_json) VALUES ('entries',?,?,?) RETURNING id");
  const map = db.query("INSERT INTO registry_cold(collection,row_key,archive_id) VALUES ('entries',?,?)");
  const add = (id: string, order: number, live = false) => {
    const key = `codex:${id}`;
    const json = JSON.stringify({ ...template, key: { engine: "codex", sessionId: id }, status: live ? "live" : "dead",
      structuredHost: { ...template.structuredHost, process: live ? processIdentity : null } });
    hot.run(key, order, json);
    if (!live) map.run(key, archive.get(key, order, json)!.id);
  };
  const select = (reader = store) => reader.readAgentStateProcessEntries(kinds, copyAgentStateRow);
  const ordinary = () => store.read(file => registryRowsMatching(file, "entries", "structuredHost.kind", kinds)
    .filter(entry => entry.structuredHost?.process).map(entry => copyAgentStateRow(entry)));
  return { store, db, open, add, select, ordinary, processIdentity, reads: () => reads };
}

test("schema changes revalidate a processless archive version before skipping it", () => {
  const { db, open, add, select, ordinary, processIdentity } = fixture();
  db.transaction(() => add("restored", 10))();
  const key = "codex:restored";
  const id = db.query<{ archive_id: number }, [string]>(
    "SELECT archive_id FROM registry_cold WHERE collection='entries' AND row_key=?").get(key)!.archive_id;
  const trigger = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE name='registry_archive_immutable_update'").get()!.sql;
  const schema = () => db.query<{ schema_version: number }, []>("PRAGMA main.schema_version").get()!.schema_version;
  const rewrite = (patch: object) => {
    const before = schema();
    db.transaction(() => {
      db.exec("DROP TRIGGER registry_archive_immutable_update");
      db.run("UPDATE registry_archive SET value_json=json_patch(value_json,?) WHERE id=?", [JSON.stringify({ structuredHost: patch }), id]);
      db.exec(trigger);
    })();
    expect(schema()).toBeGreaterThan(before);
  };
  expect(select()).toEqual(ordinary());
  rewrite({ process: processIdentity });
  const fresh = select(open());
  expect(fresh.map(entry => entry.key.sessionId)).toEqual([FIXTURE_SESSION, "restored"]);
  expect(fresh).toEqual(ordinary());
  expect(select()).toEqual(fresh);

  rewrite({ process: null });
  expect(select().map(entry => entry.key.sessionId)).toEqual([FIXTURE_SESSION]);
  rewrite({ eventCursor: -1 });
  for (const read of [ordinary, () => select(open()), () => select()]) {
    expect(read).toThrow("structured host event cursor is invalid");
  }
});

test("excess processless archive entries fall back to ordinary reads in collection order", () => {
  const { store, db, add, select, ordinary, reads } = fixture();
  const retained = () => store["processlessArchiveEntries"];
  const limit = 2048;
  db.transaction(() => {
    for (let i = 0; i < limit; i++) add(`older-${i}`, 100 + i);
    add("middle", 80, true);
    add("last", 5000, true);
  })();
  expect(select()).toEqual(ordinary());
  expect(retained().size).toBe(limit);
  expect(retained().has("codex:older-2047")).toBe(true);
  db.transaction(() => {
    for (let i = 0; i < 48; i++) add(`earlier-${i}`, 5 + i);
    add("first", 2, true);
  })();
  const expected = ordinary();
  expect(expected.map(entry => entry.key.sessionId)).toEqual([FIXTURE_SESSION, "first", "middle", "last"]);
  expect(select()).toEqual(expected);
  expect(retained().size).toBe(limit);
  expect(retained().has("codex:older-2047")).toBe(false);
  const before = reads();
  expect(select()).toEqual(expected);
  expect(reads() - before).toBe(expected.length + 48);
}, 30_000);
