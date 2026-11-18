import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { registryRowProjection, SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { installRegistryArchive } from "./registryArchive";
import { DatabaseReplacedError } from "@/lib/state/currentDatabase";
import { archiveRetirementReport, installArchiveRetirement, observeSupersededArchive, RETIREMENT_GRACE_MS, retirementApproval, retirementApprovalFile } from "./registryArchiveRetirement";
import { approveFixture, preservation, replayAnswers, RETIREMENT_NOW, retirementFixture } from "./registryArchiveRetirement.fixture";

const roots: string[] = [];
const handles: { close(): void }[] = [];
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root,{ recursive: true,force: true });
});
function fixture(count = 40) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"archive-retirement-")); roots.push(root);
  const filename = retirementFixture(root,count);
  const db = new Database(filename); db.run("PRAGMA foreign_keys=ON"); handles.push(db);
  const store = new SqliteAgentRegistryStore(filename,{
    normalize: normalizeRegistry,
    initialSnapshot: () => { throw new Error("retirement fixture must already be imported"); },
  }); handles.push(store);
  return { root,filename,db,store };
}
function eligible(db: Database) {
  const report = archiveRetirementReport(db,RETIREMENT_NOW);
  const rows = report.collections as { eligibleRows: number; eligibleBytes: number }[];
  return { rows: rows.reduce((n,r) => n+r.eligibleRows,0),bytes: rows.reduce((n,r) => n+r.eligibleBytes,0) };
}
function child(filename: string, mode: string) {
  const version = new Database(":memory:");
  const minimum = String(version.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version).startsWith("3.39."); version.close();
  const preload = minimum ? ["--preload",path.join(import.meta.dir,"../state/minimumSqlite.preload.ts")] : [];
  const process = Bun.spawn([Bun.which("bun")!,...preload,path.join(import.meta.dir,"registryArchiveRetirement.fixture.ts"),filename,mode],{ env: { ...Bun.env },stdout: "pipe",stderr: "pipe" });
  return Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()]);
}

test("dry run is read-only, counts logical cold rows once, and requires a valid separate approval", () => {
  const { filename,db,store } = fixture();
  const before = preservation(db), changes = db.query("SELECT total_changes() AS n").get();
  const report = archiveRetirementReport(db,RETIREMENT_NOW);
  expect(eligible(db).rows).toBeGreaterThan(1);
  expect(report.collections.reduce((n,r) => n+Number((r).logicalRows),0))
    .toBe((db.query("SELECT COUNT(*) AS n FROM registry_records").get() as { n: number }).n);
  expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(store.prepareArchiveRetirement()).toBeUndefined();
  expect(store.retireSupersededArchive()).toBe(0);
  expect(fs.existsSync(retirementApprovalFile(filename))).toBe(false);
  expect(preservation(db)).toEqual(before);
  for (const value of [{}, { category: "B1" }, { category: "A",digest: "invalid" }]) {
    fs.writeFileSync(retirementApprovalFile(filename),JSON.stringify(value));
    expect(retirementApproval(filename)).toBeNull();
    expect(store.prepareArchiveRetirement()).toBeUndefined();
  }
  approveFixture(filename); expect(retirementApproval(filename)).not.toBeNull();
  const valid = JSON.parse(fs.readFileSync(retirementApprovalFile(filename),"utf8"));
  for (const patch of [{ graceMs: 0 },{ batchSize: 251 },{ cycleBatches: 5 },{ databaseIdentity: "another-file" }]) {
    fs.writeFileSync(retirementApprovalFile(filename),JSON.stringify({ ...valid,...patch }));
    expect(retirementApproval(filename)).toBeNull();
  }
});

test("grace, immutable mapped versions, high-water marks and atomic rollback are enforced", () => {
  const { filename,db,store } = fixture(); approveFixture(filename);
  const before = preservation(db), expected = eligible(db);
  const revision = db.query("SELECT * FROM registry_meta WHERE key='revision'").get();
  const journal = db.query("SELECT MAX(seq) AS n FROM registry_changes").get();
  const observation = store.prepareArchiveRetirement()!;
  expect(store.retireSupersededArchive(observation,RETIREMENT_NOW)).toBe(0);
  const live = db.query<{ id: number }, []>("SELECT archive_id AS id FROM registry_cold LIMIT 1").get()!.id;
  db.run("INSERT OR IGNORE INTO registry_archive_retirements VALUES (?,'fixture',0,0)",[live]);
  expect(() => db.run("DELETE FROM registry_archive WHERE id=?",[live])).toThrow("retained");
  expect(() => db.run("UPDATE registry_archive SET row_order=0 WHERE id=?",[live])).toThrow("immutable");
  db.run("DELETE FROM registry_archive_retirements WHERE id=?",[live]);
  installRegistryArchive(db); // Reopening an older installer cannot undo the guard.
  expect(store.retireSupersededArchive(undefined,RETIREMENT_NOW+RETIREMENT_GRACE_MS-1)).toBe(0);
  db.run("CREATE TRIGGER refuse_retirement BEFORE DELETE ON registry_archive BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  expect(() => store.retireSupersededArchive(undefined,RETIREMENT_NOW+RETIREMENT_GRACE_MS+1)).toThrow("fixture rollback");
  expect(eligible(db)).toEqual(expected);
  db.run("DROP TRIGGER refuse_retirement");
  expect(store.retireSupersededArchive(undefined,RETIREMENT_NOW+RETIREMENT_GRACE_MS+1)).toBe(expected.rows);
  expect(preservation(db)).toEqual(before);
  expect(db.query("SELECT * FROM registry_meta WHERE key='revision'").get()).toEqual(revision);
  expect(db.query("SELECT MAX(seq) AS n FROM registry_changes").get()).toEqual(journal);
  db.run("INSERT INTO registry_archive(collection,row_key,value_json,row_order) VALUES ('receipts','high-water','{}',999999)");
  expect(archiveRetirementReport(db,RETIREMENT_NOW).collections.some(r => (r as { highWaterRows: number }).highWaterRows>0)).toBe(true);
  expect(observeSupersededArchive(db).rows.some(r => r.id === Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id))).toBe(false);
});

test("SIGKILL after the second committed batch resumes the durable ledger and preserves every replay class", async () => {
  const { filename,db } = fixture(160); approveFixture(filename,7);
  const expected = eligible(db), before = preservation(db), replay = await replayAnswers(filename,160);
  for (const name of ["pending","openOwners","uncertainOwners","openReceipts","switches","intents","compactions"] as const) expect(before[name].count).toBeGreaterThan(0);
  expect(await child(filename,"observe")).toEqual([0,"",""]);
  expect((db.query("SELECT COUNT(*) AS n FROM registry_archive_retirements").get() as { n: number }).n).toBe(expected.rows);
  const killed = await child(filename,"kill"); expect(killed[0]).toBe(137);
  expect(killed[2]).toBe("");
  const retired = db.query<{ n: number }, []>("SELECT SUM(retired) AS n FROM registry_archive_retirement_totals").get()!.n;
  expect(retired).toBe(14);
  expect((db.query("SELECT COUNT(*) AS n FROM registry_archive_retirements").get() as { n: number }).n+retired).toBe(expected.rows);
  expect(preservation(db)).toEqual(before);
  expect(await child(filename,"complete")).toEqual([0,"",""]);
  expect(eligible(db)).toEqual({ rows: 0,bytes: 0 });
  expect(db.query("SELECT SUM(retired) AS rows,SUM(bytes) AS bytes FROM registry_archive_retirement_totals").get()).toEqual(expected);
  expect(preservation(db)).toEqual(before);
  expect(await replayAnswers(filename,160)).toEqual(replay);
  expect(await child(filename,"complete")).toEqual([0,"",""]);
  expect(db.query("SELECT SUM(retired) AS rows,SUM(bytes) AS bytes FROM registry_archive_retirement_totals").get()).toEqual(expected);
},60_000);

test("held lazy and projected views require a fresh snapshot after retirement", () => {
  const { filename,db,store } = fixture();
  const held = store.readOnlySnapshot().file;
  const projected = store.readOnlySnapshot().file;
  db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.error','new version') WHERE collection='receipts' AND row_key='retention-launch-10'");
  while (store.archiveInactive(250)) { /* rearchive */ }
  approveFixture(filename);
  store.retireSupersededArchive(store.prepareArchiveRetirement(),RETIREMENT_NOW);
  store.retireSupersededArchive(undefined,RETIREMENT_NOW+RETIREMENT_GRACE_MS+1);
  expect(() => held.receipts["retention-launch-10"]).toThrow(DatabaseReplacedError);
  expect(() => registryRowProjection(projected,{ id: "retirement-held",collection: "receipts",project: row => row.error })).toThrow(DatabaseReplacedError);
  expect(store.readOnlySnapshot().file.receipts["retention-launch-10"]!.error).toBe("new version");
});

test("duplicate cold mappings share one archive fetch and stay readable after restart and retirement", () => {
  const { filename,db,store } = fixture(8);
  const duplicate = db.query<{ archive_id: number }, []>(
    "SELECT archive_id FROM registry_cold WHERE collection='receipts' AND row_key='retention-launch-5'").get()!.archive_id;
  db.run("UPDATE registry_cold SET archive_id=? WHERE collection='receipts' AND row_key='retention-launch-4'",[duplicate]);
  const projector = { id: "retirement-duplicate-receipt-launch",collection: "receipts" as const,project: (row: { launchId: string }) => row.launchId };
  const expected = registryRowProjection(store.readOnlySnapshot().file,projector);
  expect(expected).toHaveLength(8);
  expect(expected.map(([key]) => key)).toContain("retention-launch-4");

  store.close();
  handles.splice(handles.indexOf(store),1);
  const reopened = new SqliteAgentRegistryStore(filename,{
    initialSnapshot: () => { throw new Error("retirement fixture must already be imported"); },
    normalize: normalizeRegistry,
  }); handles.push(reopened);
  expect(registryRowProjection(reopened.readOnlySnapshot().file,projector)).toEqual(expected);

  approveFixture(filename);
  const observation = reopened.prepareArchiveRetirement()!;
  reopened.retireSupersededArchive(observation,RETIREMENT_NOW);
  reopened.retireSupersededArchive(undefined,RETIREMENT_NOW+RETIREMENT_GRACE_MS+1);
  expect(registryRowProjection(reopened.readOnlySnapshot().file,projector)).toEqual(expected);
  expect(db.query("SELECT 1 FROM registry_archive WHERE id=?").get(duplicate)).not.toBeNull();
});

test("sparse AUTOINCREMENT history counts retained rows and resumes across a process restart", async () => {
  const { filename,db } = fixture();
  db.run("DELETE FROM registry_cold");
  db.run("DROP TRIGGER registry_archive_immutable_delete");
  db.run("DELETE FROM registry_archive");
  db.run("DELETE FROM registry_rows");
  db.run("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('receipts','current','{}',10)");
  const archive = db.query("INSERT INTO registry_archive(id,collection,row_key,value_json,row_order) VALUES (?,'receipts',?,'{}',10)");
  const mapping = db.query("INSERT INTO registry_cold(collection,row_key,archive_id) VALUES ('receipts',?,?)");
  db.transaction(() => {
    for (let n=0;n<2_000;n++) {
      const id=20_000_000+n*1_000_000, key=`mapped-${n}`;
      archive.run(id,key); mapping.run(key,id);
    }
    db.query("INSERT INTO registry_archive(id,collection,row_key,value_json,row_order) VALUES (?,'receipts','eligible','{}',1)").run(2_020_000_000);
  })();
  installArchiveRetirement(db);
  approveFixture(filename);

  const page = observeSupersededArchive(db);
  expect(page.rows).toEqual([]);
  expect(page.nextCursor).toBe(2_019_000_000);
  expect(db.query("SELECT COUNT(*) AS n FROM registry_archive_retirements").get()).toEqual({ n: 0 });
  const store = new SqliteAgentRegistryStore(filename,{
    initialSnapshot: () => { throw new Error("sparse retirement fixture must already be imported"); },
    normalize: normalizeRegistry,
  }); handles.push(store);
  store.retireSupersededArchive(page,RETIREMENT_NOW); // Persist the page before the reader process restarts.
  expect(observeSupersededArchive(db).cursor).toBe(2_019_000_000);
  expect(await child(filename,"observe")).toEqual([0,"",""]);
  expect(db.query("SELECT id FROM registry_archive_retirements").all()).toEqual([{ id: 2_020_000_000 }]);
  expect(db.query("SELECT COUNT(*) AS n FROM registry_archive").get()).toEqual({ n: 2_001 });
});

test("revoking approval during writer admission or after a committed batch stops further work", async () => {
  const { filename,db } = fixture(); approveFixture(filename,1);
  const registry = new AgentRegistry(path.join(path.dirname(filename),"agent-registry.json"),undefined,undefined,{ sqliteMode: "sqlite",sqliteFilename: filename }); handles.push(registry);
  const original = registry.deliveryWrite.bind(registry);
  const before = db.query("SELECT * FROM registry_archive_retirement_state").all();
  const admission = spyOn(registry,"deliveryWrite").mockImplementation(async (label,write) => {
    fs.unlinkSync(retirementApprovalFile(filename)); return original(label,write);
  });
  expect(await registry.retireSupersededArchive()).toBe(0);
  expect(db.query("SELECT * FROM registry_archive_retirement_state").all()).toEqual(before);
  admission.mockRestore(); approveFixture(filename,1);
  expect(await child(filename,"observe")).toEqual([0,"",""]);
  db.run("UPDATE registry_archive_retirements SET observed_at=0");
  const afterBatch = spyOn(registry,"deliveryWrite").mockImplementation(async (label,write) => {
    const result = await original(label,write); fs.rmSync(retirementApprovalFile(filename),{ force: true }); return result;
  });
  try { expect(await registry.retireSupersededArchive()).toBe(1); }
  finally { afterBatch.mockRestore(); }
});


test("mapped and high-water versions cannot retire after observation, and a missing guard fails closed", () => {
  const { filename,db,store } = fixture(); approveFixture(filename);
  const observation = store.prepareArchiveRetirement()!;
  const candidate = observation.rows[0]!;
  db.run("INSERT INTO registry_cold(collection,row_key,archive_id) VALUES ('damaged','identity',?)",[candidate.id]);
  store.retireSupersededArchive(observation,RETIREMENT_NOW);
  expect(db.query("SELECT id FROM registry_archive_retirements WHERE id=?").get(candidate.id)).toBeNull();
  db.run("INSERT OR IGNORE INTO registry_archive_retirements VALUES (?,'damaged',0,0)",[candidate.id]);
  expect(() => db.run("DELETE FROM registry_archive WHERE id=?",[candidate.id])).toThrow("retained");
  store.retireSupersededArchive(undefined,RETIREMENT_NOW+RETIREMENT_GRACE_MS+1);
  expect(db.query("SELECT id FROM registry_archive WHERE id=?").get(candidate.id)).not.toBeNull();
  db.run("INSERT INTO registry_archive(collection,row_key,value_json,row_order) VALUES ('no-current-rows','orphan','{}',7)");
  const high = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id);
  db.run("INSERT INTO registry_archive_retirements VALUES (?,'no-current-rows',2,0)",[high]);
  expect(() => db.run("DELETE FROM registry_archive WHERE id=?",[high])).toThrow("retained");
  const state = db.query("SELECT * FROM registry_archive_retirement_state").all();
  db.run("DROP TRIGGER registry_archive_immutable_delete");
  expect(() => store.retireSupersededArchive(store.prepareArchiveRetirement(),RETIREMENT_NOW)).toThrow("guard is not installed");
  expect(db.query("SELECT * FROM registry_archive_retirement_state").all()).toEqual(state);
});

test("the real controller admits at most four transactions and 1000 retirements per cycle", async () => {
  const { filename,db } = fixture(600); approveFixture(filename);
  expect(await child(filename,"observe")).toEqual([0,"",""]);
  db.run("UPDATE registry_archive_retirements SET observed_at=0");
  const registry = new AgentRegistry(path.join(path.dirname(filename),"agent-registry.json"),undefined,undefined,{ sqliteMode: "sqlite",sqliteFilename: filename }); handles.push(registry);
  const pending = (db.query("SELECT COUNT(*) AS n FROM registry_archive_retirements").get() as { n: number }).n;
  expect(pending).toBeGreaterThan(1000);
  expect(await registry.retireSupersededArchive()).toBe(1000);
  expect((db.query("SELECT COUNT(*) AS n FROM registry_archive_retirements").get() as { n: number }).n).toBe(pending-1000);
  expect(await registry.retireSupersededArchive()).toBe(pending-1000);
});
