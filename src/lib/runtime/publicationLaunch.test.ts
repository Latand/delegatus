import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, type ProcessIdentity } from "../processIdentity";
import { realExec } from "../workflows/provision";
import { CpuAdmissionQueue } from "./cpuAdmission";
import { stampPublicationPreparer } from "./publicationLaunch";

const directories: string[] = [];
const children: { kill(): void; exited: Promise<number> }[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function lockDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publication-launch-"));
  directories.push(dir);
  return { dir, file: path.join(dir, "admission.sqlite") };
}
/** A live process the test owns, standing in for a spawned preparer. */
function live() {
  const child = Bun.spawn(["sleep", "30"]);
  children.push(child);
  return child;
}
async function ended(): Promise<ProcessIdentity> {
  const child = Bun.spawn(["true"]);
  const identity = captureProcessIdentity(child.pid);
  await child.exited;
  return identity;
}
const rows = (file: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return db.query("SELECT 1 FROM sqlite_master WHERE name = 'publication_launches'").get()
      ? db.query<{ identity: string; operation: string }, []>("SELECT identity, operation FROM publication_launches ORDER BY rowid").all() : [];
  } finally { db.close(); }
};

test("a queue file without launch records reads none and forgets nothing", () => {
  const { file } = lockDir();
  const queue = new CpuAdmissionQueue(file);
  try {
    expect(queue.publicationLaunches()).toEqual([]);
    queue.forgetPublicationLaunch(captureProcessIdentity(process.pid));
    expect(rows(file)).toEqual([]);
  } finally { queue.close(); }
});

test("a launch record survives reopening, prunes exited processes and is forgotten by identity", async () => {
  const { file } = lockDir();
  const first = captureProcessIdentity(live().pid), gone = await ended();
  let queue = new CpuAdmissionQueue(file);
  queue.recordPublicationLaunch(gone, "earlier");
  queue.recordPublicationLaunch(first, "one");
  queue.close();
  // A restarted Viewer and every gate helper read the same rows.
  queue = new CpuAdmissionQueue(file);
  try {
    expect(queue.publicationLaunches()).toEqual([{ identity: first, operation: "one" }]);
    const second = captureProcessIdentity(live().pid);
    queue.recordPublicationLaunch(second, "two");
    // Recording the same process again replaces its row.
    queue.recordPublicationLaunch(first, "one");
    expect(queue.publicationLaunches()).toEqual([{ identity: second, operation: "two" }, { identity: first, operation: "one" }]);
    queue.forgetPublicationLaunch(first);
    expect(queue.publicationLaunches()).toEqual([{ identity: second, operation: "two" }]);
  } finally { queue.close(); }
});

test("launch records stay bounded and malformed rows are never read as launches", () => {
  const { file } = lockDir();
  const owner = captureProcessIdentity(process.pid);
  let now = 1_000;
  // Every recorded process reads as alive, so only the bound removes rows.
  const queue = new CpuAdmissionQueue(file, () => now, undefined, undefined, undefined, { status: () => "alive", exited: () => false });
  try {
    // Live identities of one process under distinct operations stand in for
    // 70 concurrent publications; the newest 64 remain.
    for (let index = 0; index < 70; index++) {
      now++;
      queue.recordPublicationLaunch({ ...owner, bootEpoch: `${owner.bootEpoch}#${index}` }, `operation-${index}`);
    }
    const kept = queue.publicationLaunches().map(launch => launch.operation);
    expect(kept).toHaveLength(64);
    expect(kept[0]).toBe("operation-6");
    expect(kept.at(-1)).toBe("operation-69");
    const db = new Database(file);
    try {
      db.query("DELETE FROM publication_launches").run();
      for (const identity of ["not json", "null", JSON.stringify({ pid: "1", startIdentity: "1:2", bootEpoch: "b" }), JSON.stringify({ pid: 1, startIdentity: null, bootEpoch: "b" })]) {
        db.query("INSERT INTO publication_launches VALUES (?, 'forged', 1)").run(identity);
      }
    } finally { db.close(); }
    expect(queue.publicationLaunches()).toEqual([]);
    // The next record prunes rows whose identity cannot be read.
    queue.recordPublicationLaunch(owner, "current");
    expect(rows(file)).toEqual([{ identity: JSON.stringify(owner), operation: "current" }]);
  } finally { queue.close(); }
});

test.skipIf(process.platform !== "linux")("the Viewer stamps the spawned preparer in the queue its gates open and releases it", async () => {
  const { dir, file } = lockDir();
  const child = live();
  const stamp = stampPublicationPreparer(child.pid, "operation-one", { LLV_GATE_LOCK_DIR: dir });
  await stamp.recorded;
  expect(rows(file)).toEqual([{ identity: JSON.stringify(captureProcessIdentity(child.pid)), operation: "operation-one" }]);
  await stamp.release();
  expect(rows(file)).toEqual([]);
  // A second release finds nothing left to remove.
  await stamp.release();
  expect(rows(file)).toEqual([]);
});

test.skipIf(process.platform !== "linux")("no operation, or a child that already ended, leaves no launch record", async () => {
  const { dir, file } = lockDir();
  const child = live();
  const unnamed = stampPublicationPreparer(child.pid, undefined, { LLV_GATE_LOCK_DIR: dir });
  await unnamed.recorded; await unnamed.release();
  const gone = await ended();
  const late = stampPublicationPreparer(gone.pid, "operation-one", { LLV_GATE_LOCK_DIR: dir });
  await late.recorded; await late.release();
  expect(fs.existsSync(file) ? rows(file) : []).toEqual([]);
});

test.skipIf(process.platform !== "linux")("a held queue writer delays the stamp asynchronously and an exhausted deadline records nothing", async () => {
  const { dir, file } = lockDir();
  new CpuAdmissionQueue(file).close();
  const holder = new Database(file);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    holder.exec("BEGIN IMMEDIATE");
    const child = live();
    const stamp = stampPublicationPreparer(child.pid, "operation-one", { LLV_GATE_LOCK_DIR: dir });
    // The call returned while the writer is still held in this same thread, so
    // it did not wait for the writer synchronously. One macrotask later the
    // record is still pending: the retry yields to the event loop instead of
    // settling (or failing) inside the call.
    expect(holder.inTransaction).toBe(true);
    const firstSettled = await Promise.race([
      stamp.recorded.then(() => "recorded"),
      new Promise<string>(resolve => setTimeout(() => resolve("macrotask"), 0)),
    ]);
    expect(firstSettled).toBe("macrotask");
    expect(rows(file)).toEqual([]);
    holder.exec("COMMIT");
    await stamp.recorded;
    expect(rows(file)).toEqual([{ identity: JSON.stringify(captureProcessIdentity(child.pid)), operation: "operation-one" }]);

    holder.exec("BEGIN IMMEDIATE");
    const other = live();
    const refused = stampPublicationPreparer(other.pid, "operation-two", { LLV_GATE_LOCK_DIR: dir }, 100);
    await refused.recorded;
    holder.exec("COMMIT");
    expect(warn.mock.calls.map(call => call[0])).toEqual(["[publication-launch] the preparer launch was not recorded (SQLITE_BUSY)"]);
    expect(rows(file).map(row => row.operation)).toEqual(["operation-one"]);
    // Nothing was recorded, so its release removes nothing.
    await refused.release();
    await stamp.release();
    expect(rows(file)).toEqual([]);
  } finally {
    warn.mockRestore();
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
});

test("realExec reports the spawned child once, and a failing observer neither fails nor orphans it", async () => {
  const seen: number[] = [];
  const observed = await realExec("bash", ["-c", "echo $$"], process.cwd(), {}, { onSpawn: pid => seen.push(pid) });
  expect(observed.code).toBe(0);
  expect(seen).toEqual([Number(observed.stdout.trim())]);
  const failing = await realExec("bash", ["-c", "echo done"], process.cwd(), {}, { onSpawn: () => { throw new Error("observer failure"); } });
  expect(failing).toMatchObject({ code: 0, stdout: "done\n" });
});
