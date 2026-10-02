import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStateCollections, SqliteStateCollection, injectStateWriteFaultForTests, StateLeaseLostError, STATE_LEASE_MAX_AGE_MS } from "./sqliteStateStore";

import { FileTransactionBusyError } from "./fileTransaction";
import { StateDiskFullError, setStateFreeBytesProbeForTests, noteStateCommit, noteStateDiskFull, stateWriteHealth } from "./diskFull";

type Row = { key: string; value: number };
const directories: string[] = [];
afterEach(() => { injectStateWriteFaultForTests(null); setStateFreeBytesProbeForTests(null); noteStateCommit(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(collection = "probe", filename?: string) {
  if (!filename) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-lease-recovery-"));
    directories.push(dir);
    filename = path.join(dir, "state.sqlite");
  }
  const options = { collection, schemaVersion: 1, busyMessage: `${collection} busy`,
    key: (row: Row) => row.key, decode: (raw: unknown) => raw as Row, clone: (row: Row) => ({ ...row }) };
  initializeStateCollections(filename, [{ ...options, migrationId: "probe", loadRecords: () => [] }]);
  return new SqliteStateCollection<Row>(filename, options);
}

test("a disk-full release preserves the callback result and its committed row", async () => {
  const c = setup();
  const db = new Database(c.filename);
  db.exec(`CREATE TRIGGER full_release BEFORE DELETE ON state_leases BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END`);
  try {
    expect(await c.mutate((rows, persist) => { rows.push({ key: "x", value: 1 }); persist(); return 42; })).toBe(42);
    expect(c.get("x")?.value).toBe(1);
    expect(db.query("SELECT owner_token FROM state_leases").get()).not.toBeNull();
  } finally { db.exec("DROP TRIGGER full_release"); db.close(); }
});

const full = () => Object.assign(new Error("database or disk is full"), { name: "SQLiteError", code: "SQLITE_FULL", errno: 13 });
function token(c: SqliteStateCollection<Row>) {
  const db = new Database(c.filename, { readonly: true });
  try { return db.query<{ owner_token: string }, [string]>("SELECT owner_token FROM state_leases WHERE collection = ?").get("probe")?.owner_token; }
  finally { db.close(); }
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(20);
  expect(check()).toBe(true);
}
test("the owner's next write replaces its abandoned token without waiting for the timer", async () => {
  const c = setup();
  injectStateWriteFaultForTests({ site: "release", collection: "probe", error: full() });
  expect(await c.mutate((rows, persist) => { rows.push({ key: "x", value: 1 }); persist(); return 42; })).toBe(42);
  const first = token(c);
  expect(first).toBeDefined();
  const start = Date.now();
  c.boundedPatch(1, (tx) => tx.put({ key: "x", value: 2 }));
  expect(Date.now() - start).toBeLessThan(1000);
  expect(c.get("x")?.value).toBe(2);
  expect(token(c)).not.toBe(first);
  injectStateWriteFaultForTests(null);
  await until(() => token(c) === undefined);
});
test("abandoned release retries without another store call", async () => {
  const c = setup();
  injectStateWriteFaultForTests({ site: "release", collection: "probe", times: 3, error: full() });
  c.boundedPatch(1, (tx) => tx.put({ key: "x", value: 1 }));
  expect(token(c)).toBeDefined();
  await until(() => token(c) === undefined);
});
test("continuous failed releases cannot postpone another collection's abandoned retry", async () => {
  const first = setup();
  const noisy = setup("noisy", first.filename);
  injectStateWriteFaultForTests({ site: "release", collection: "probe", times: 1, error: full() });
  first.boundedPatch(1, (tx) => tx.put({ key: "x", value: 1 }));
  expect(token(first)).toBeDefined();
  injectStateWriteFaultForTests({ site: "release", collection: "noisy", error: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }) });
  let value = 0;
  const traffic = setInterval(() => noisy.boundedPatch(1, (tx) => tx.put({ key: "x", value: ++value })), 100);
  try {
    await until(() => token(first) === undefined, 5_250);
    expect(value).toBeGreaterThan(0);
  } finally {
    clearInterval(traffic);
    injectStateWriteFaultForTests(null);
    await until(() => {
      const db = new Database(first.filename, { readonly: true });
      try { return db.query("SELECT * FROM state_leases").get() === null; }
      finally { db.close(); }
    }, 6_000);
  }
}, 15_000);
test("expired live owner is fenced inside the write transaction", async () => {
  const c = setup();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const old = c.mutate(async (rows, persist) => { enter(); await gate; rows.push({ key: "x", value: 1 }); persist(); });
  // Install the rejection handler before opening the gate.
  const oldResult = old.catch((error: unknown) => error);
  await entered;
  const db = new Database(c.filename);
  db.query("UPDATE state_leases SET acquired_at = ?").run(Date.now() - STATE_LEASE_MAX_AGE_MS - 1000);
  db.close();
  await c.mutate((rows, persist) => { rows.push({ key: "x", value: 2 }); persist(); });
  resume();
  const error = await oldResult;
  expect(error).toBeInstanceOf(StateLeaseLostError);
  expect(error).toBeInstanceOf(FileTransactionBusyError);
  expect(c.get("x")?.value).toBe(2);
});
test("a live owner's young lease still blocks", async () => {
  const c = setup();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const owner = c.mutate(async () => { enter(); await gate; });
  await entered;
  const db = new Database(c.filename);
  db.query("UPDATE state_leases SET acquired_at = ?").run(Date.now() - 60_000);
  db.close();
  try { await expect(c.mutate(() => {}, undefined, false, 200)).rejects.toBeInstanceOf(FileTransactionBusyError); }
  finally { resume(); await owner; }
});
test("patchSync releases its companion even when its own release fails", async () => {
  const c = setup("b_own");
  const companion = setup("a_companion", c.filename);
  injectStateWriteFaultForTests({ site: "release", collection: "b_own", times: 1, error: full() });
  c.patchSync(() => ({ records: [{ key: "x", value: 1 }], companion: { records: [{ key: "y", value: 2 }], deleteKeys: [] } }), { companion });
  const db = new Database(c.filename, { readonly: true });
  try {
    expect(db.query("SELECT * FROM state_leases WHERE collection = 'a_companion'").get()).toBeNull();
    await until(() => db.query("SELECT * FROM state_leases WHERE collection = 'b_own'").get() === null);
    expect(companion.get("y")?.value).toBe(2);
  } finally { db.close(); }
});
test("operation's commit failure survives a failed release and rolls back its rows", () => {
  const c = setup();
  injectStateWriteFaultForTests({ site: "commit", collection: "probe", error: full() });
  injectStateWriteFaultForTests({ site: "release", collection: "probe", error: full() });
  expect(() => c.boundedPatch(1, (tx) => tx.put({ key: "x", value: 1 }))).toThrow(StateDiskFullError);
  expect(c.get("x")).toBeNull();
});
test("successful lease bookkeeping preserves a failed data-write alert until a data commit", () => {
  const c = setup();
  setStateFreeBytesProbeForTests(() => 1024 ** 3);
  injectStateWriteFaultForTests({ site: "commit", collection: "probe", error: full() });
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(() => c.boundedPatch(1, (tx) => tx.put({ key: "x", value: 1 }))).toThrow(StateDiskFullError);
    expect(stateWriteHealth(path.dirname(c.filename)).state).toBe("disk-full");
  }
  injectStateWriteFaultForTests(null);
  c.boundedPatch(1, (tx) => tx.put({ key: "x", value: 2 }));
  expect(stateWriteHealth(path.dirname(c.filename)).state).toBe("ok");
});
test("read-only patches and unchanged persistence cannot certify disk recovery", async () => {
  const c = setup();
  c.boundedPatch(1, (tx) => tx.put({ key: "x", value: 1 }));
  setStateFreeBytesProbeForTests(() => 1024 ** 3);
  noteStateDiskFull("data write");
  expect(c.boundedPatch(1, (tx) => tx.get("x"))?.value).toBe(1);
  expect(stateWriteHealth(path.dirname(c.filename)).state).toBe("disk-full");
  await c.mutate((_rows, persist) => persist());
  expect(stateWriteHealth(path.dirname(c.filename)).state).toBe("disk-full");
  c.boundedPatch(1, (tx) => tx.put({ key: "x", value: 2 }));
  expect(stateWriteHealth(path.dirname(c.filename)).state).toBe("ok");
});
async function childOwner(c: SqliteStateCollection<Row>) {
  const dir = path.dirname(c.filename);
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "stateLeaseOwner.fixture.ts"), dir], {
    env: { ...process.env, LLV_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe",
  });
  try { await until(() => fs.existsSync(path.join(dir, "ready"))); }
  catch (error) { child.kill(); await child.exited; throw error; }
  return { child, dir, stop: async () => {
    fs.writeFileSync(path.join(dir, "stop"), "");
    const code = await Promise.race([child.exited, Bun.sleep(3000).then(() => { child.kill(); throw new Error("fixture child did not exit"); })]);
    expect(code).toBe(0);
  } };
}
test("cross-process recovery leaves the original owner alive", async () => {
  const c = setup();
  const owner = await childOwner(c);
  setStateFreeBytesProbeForTests(() => 1024 ** 3);
  try {
    await expect(c.mutate(() => {}, undefined, false, 300)).rejects.toBeInstanceOf(FileTransactionBusyError);
    fs.writeFileSync(path.join(owner.dir, "lift"), "");
    await c.mutate((rows, persist) => { rows.push({ key: "parent", value: 2 }); persist(); }, undefined, false, 10_000);
    expect(c.get("parent")?.value).toBe(2);
    expect(() => process.kill(owner.child.pid, 0)).not.toThrow();
  } finally { await owner.stop(); }
});
test.each(["async", "sync"])("%s full-disk contender exits within two seconds", async (mode) => {
  const c = setup();
  const owner = await childOwner(c);
  setStateFreeBytesProbeForTests(() => 0);
  try {
    const start = Date.now();
    if (mode === "async") await expect(c.mutate(() => {})).rejects.toBeInstanceOf(StateDiskFullError);
    else expect(() => c.boundedPatch(1, () => {})).toThrow(StateDiskFullError);
    expect(Date.now() - start).toBeLessThan(2000);
  } finally { await owner.stop(); }
});
