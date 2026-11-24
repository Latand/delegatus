import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, type ProcessIdentity } from "../processIdentity";
import { realExec } from "../workflows/provision";
import { CpuAdmissionQueue, PUBLICATION_LAUNCH_PROOF_ENV, publicationLaunchDigest } from "./cpuAdmission";
import { newPublicationLaunchProof, publicationLaunchQueueFile, stampPublicationPreparer } from "./publicationLaunch";

const directories: string[] = [];
// One launch secret per test file; each stamp below is handed it as the
// Viewer hands the preparer it spawns.
const PROOF = newPublicationLaunchProof(), DIGEST = publicationLaunchDigest(PROOF);
const launchEnv = (dir: string, extra: Record<string, string> = {}) => ({ LLV_GATE_LOCK_DIR: dir, [PUBLICATION_LAUNCH_PROOF_ENV]: PROOF, ...extra });
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
    return db.query("SELECT 1 FROM sqlite_master WHERE name = 'publication_launch_proofs'").get()
      ? db.query<{ identity: string; operation: string; proof: string }, []>("SELECT identity, operation, proof FROM publication_launch_proofs ORDER BY rowid").all() : [];
  } finally { db.close(); }
};
const row = (pid: number, operation: string) => ({ identity: JSON.stringify(captureProcessIdentity(pid)), operation, proof: DIGEST });

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
  queue.recordPublicationLaunch(gone, "earlier", DIGEST);
  queue.recordPublicationLaunch(first, "one", DIGEST);
  queue.close();
  // A restarted Viewer and every gate helper read the same rows.
  queue = new CpuAdmissionQueue(file);
  try {
    expect(queue.publicationLaunches()).toEqual([{ identity: first, operation: "one", proof: DIGEST }]);
    const second = captureProcessIdentity(live().pid);
    queue.recordPublicationLaunch(second, "two", DIGEST);
    // Recording the same process again replaces its row.
    queue.recordPublicationLaunch(first, "one", DIGEST);
    expect(queue.publicationLaunches()).toEqual([{ identity: second, operation: "two", proof: DIGEST }, { identity: first, operation: "one", proof: DIGEST }]);
    queue.forgetPublicationLaunch(first);
    expect(queue.publicationLaunches()).toEqual([{ identity: second, operation: "two", proof: DIGEST }]);
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
      queue.recordPublicationLaunch({ ...owner, bootEpoch: `${owner.bootEpoch}#${index}` }, `operation-${index}`, DIGEST);
    }
    const kept = queue.publicationLaunches().map(launch => launch.operation);
    expect(kept).toHaveLength(64);
    expect(kept[0]).toBe("operation-6");
    expect(kept.at(-1)).toBe("operation-69");
    const db = new Database(file);
    try {
      db.query("DELETE FROM publication_launch_proofs").run();
      for (const identity of ["not json", "null", JSON.stringify({ pid: "1", startIdentity: "1:2", bootEpoch: "b" }), JSON.stringify({ pid: 1, startIdentity: null, bootEpoch: "b" })]) {
        db.query("INSERT INTO publication_launch_proofs VALUES (?, 'forged', ?, 1)").run(identity, DIGEST);
      }
      // A readable identity whose proof is no digest is not a launch either.
      db.query("INSERT INTO publication_launch_proofs VALUES (?, 'forged', ?, 1)").run(JSON.stringify(owner), PROOF);
    } finally { db.close(); }
    expect(queue.publicationLaunches()).toEqual([]);
    // The next record prunes rows whose identity cannot be read and replaces
    // the one for the same process.
    queue.recordPublicationLaunch(owner, "current", DIGEST);
    expect(rows(file)).toEqual([{ identity: JSON.stringify(owner), operation: "current", proof: DIGEST }]);
  } finally { queue.close(); }
});

test.skipIf(process.platform !== "linux")("the Viewer stamps the spawned preparer in the queue its gates open and releases it", async () => {
  const { dir, file } = lockDir();
  const child = live();
  const stamp = stampPublicationPreparer(child.pid, "operation-one", launchEnv(dir), dir);
  await stamp.recorded;
  // The row carries the digest of the secret, never the secret itself.
  expect(rows(file)).toEqual([row(child.pid, "operation-one")]);
  expect(JSON.stringify(rows(file))).not.toContain(PROOF);
  await stamp.release();
  expect(rows(file)).toEqual([]);
  // A second release finds nothing left to remove.
  await stamp.release();
  expect(rows(file)).toEqual([]);
});

test.skipIf(process.platform !== "linux")("no operation, no launch secret, or a child that already ended leaves no launch record", async () => {
  const { dir, file } = lockDir();
  const child = live();
  const unnamed = stampPublicationPreparer(child.pid, undefined, launchEnv(dir), dir);
  await unnamed.recorded; await unnamed.release();
  const unproved = stampPublicationPreparer(child.pid, "operation-one", { LLV_GATE_LOCK_DIR: dir }, dir);
  await unproved.recorded; await unproved.release();
  const gone = await ended();
  const late = stampPublicationPreparer(gone.pid, "operation-one", launchEnv(dir), dir);
  await late.recorded; await late.release();
  expect(fs.existsSync(file) ? rows(file) : []).toEqual([]);
});

test.skipIf(process.platform !== "linux")("a relative lock directory names the queue the preparer's gates open from its own directory", async () => {
  const { dir } = lockDir();
  const preparerDir = path.join(dir, "worktree");
  fs.mkdirSync(path.join(preparerDir, "locks"), { recursive: true });
  const linked = path.join(dir, "linked");
  fs.symlinkSync(preparerDir, linked);
  // The gate helpers resolve LLV_GATE_LOCK_DIR against their working
  // directory (scripts/cpu-admission.ts), which is the preparer's.
  const relative = `locks-${path.basename(dir)}`;
  directories.push(path.resolve(relative));
  fs.mkdirSync(path.join(preparerDir, relative));
  expect(publicationLaunchQueueFile({ LLV_GATE_LOCK_DIR: relative }, linked)).toBe(path.join(fs.realpathSync(preparerDir), relative, "admission.sqlite"));
  const child = live();
  const stamp = stampPublicationPreparer(child.pid, "operation-one", launchEnv(relative), linked);
  await stamp.recorded;
  expect(rows(path.join(preparerDir, relative, "admission.sqlite"))).toEqual([row(child.pid, "operation-one")]);
  // Nothing was written relative to the Viewer's own directory.
  expect(fs.existsSync(path.resolve(relative))).toBe(false);
  await stamp.release();
  expect(rows(path.join(preparerDir, relative, "admission.sqlite"))).toEqual([]);
});

test.skipIf(process.platform !== "linux")("a held queue writer delays the stamp asynchronously and an exhausted deadline records nothing", async () => {
  const { dir, file } = lockDir();
  new CpuAdmissionQueue(file).close();
  const holder = new Database(file);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    holder.exec("BEGIN IMMEDIATE");
    const child = live();
    const stamp = stampPublicationPreparer(child.pid, "operation-one", launchEnv(dir), dir);
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
    expect(rows(file)).toEqual([row(child.pid, "operation-one")]);

    holder.exec("BEGIN IMMEDIATE");
    const other = live();
    const refused = stampPublicationPreparer(other.pid, "operation-two", launchEnv(dir), dir, 100);
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

// The cases below fail by the test timeout when the stamp keeps waiting for
// the held writer: each awaits the stamp while this thread still holds it.
test.skipIf(process.platform !== "linux")("a preparer that exits while the writer is held stops the stamp and records nothing", async () => {
  const { dir, file } = lockDir();
  new CpuAdmissionQueue(file).close();
  const holder = new Database(file);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    holder.exec("BEGIN IMMEDIATE");
    const child = live();
    const stamp = stampPublicationPreparer(child.pid, "operation-one", launchEnv(dir), dir);
    child.kill();
    await child.exited;
    await stamp.recorded;
    expect(holder.inTransaction).toBe(true);
    holder.exec("COMMIT");
    expect(rows(file)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    await stamp.release();
    expect(rows(file)).toEqual([]);
  } finally {
    warn.mockRestore();
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
}, 5_000);

test.skipIf(process.platform !== "linux")("releasing while the writer is held returns without waiting and leaves no record", async () => {
  const { dir, file } = lockDir();
  new CpuAdmissionQueue(file).close();
  const holder = new Database(file);
  try {
    holder.exec("BEGIN IMMEDIATE");
    const child = live();
    const stamp = stampPublicationPreparer(child.pid, "operation-one", launchEnv(dir), dir);
    // The Viewer releases once the preparer's command has returned.
    await stamp.release();
    await stamp.recorded;
    expect(holder.inTransaction).toBe(true);
    holder.exec("COMMIT");
    expect(rows(file)).toEqual([]);

    // A written record whose removal meets a held writer is left for the next
    // record to prune; the release does not wait for the writer either.
    const written = stampPublicationPreparer(child.pid, "operation-two", launchEnv(dir), dir);
    await written.recorded;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      holder.exec("BEGIN IMMEDIATE");
      await written.release();
      expect(holder.inTransaction).toBe(true);
      holder.exec("COMMIT");
      expect(warn.mock.calls.map(call => call[0])).toEqual(["[publication-launch] the preparer launch record was kept (SQLITE_BUSY)"]);
    } finally { warn.mockRestore(); }
    expect(rows(file)).toEqual([row(child.pid, "operation-two")]);
    child.kill();
    await child.exited;
    const next = live();
    const pruning = stampPublicationPreparer(next.pid, "operation-three", launchEnv(dir), dir);
    await pruning.recorded;
    expect(rows(file)).toEqual([row(next.pid, "operation-three")]);
    await pruning.release();
  } finally {
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
}, 5_000);

test.skipIf(process.platform !== "linux")("a wall clock that moves backwards does not extend the writer deadline", async () => {
  const { dir, file } = lockDir();
  new CpuAdmissionQueue(file).close();
  const holder = new Database(file);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let wall = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => (wall -= 60_000));
  try {
    holder.exec("BEGIN IMMEDIATE");
    const child = live();
    const stamp = stampPublicationPreparer(child.pid, "operation-one", launchEnv(dir), dir, 100);
    await stamp.recorded;
    clock.mockRestore();
    expect(warn.mock.calls.map(call => call[0])).toEqual(["[publication-launch] the preparer launch was not recorded (SQLITE_BUSY)"]);
    holder.exec("COMMIT");
    expect(rows(file)).toEqual([]);
  } finally {
    clock.mockRestore();
    warn.mockRestore();
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
}, 5_000);

test("realExec reports the spawned child once, and a failing observer neither fails nor orphans it", async () => {
  const seen: number[] = [];
  const observed = await realExec("bash", ["-c", "echo $$"], process.cwd(), {}, { onSpawn: pid => seen.push(pid) });
  expect(observed.code).toBe(0);
  expect(seen).toEqual([Number(observed.stdout.trim())]);
  const failing = await realExec("bash", ["-c", "echo done"], process.cwd(), {}, { onSpawn: () => { throw new Error("observer failure"); } });
  expect(failing).toMatchObject({ code: 0, stdout: "done\n" });
});
