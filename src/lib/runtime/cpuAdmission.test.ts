import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrePollCpuAdmissionQueue } from "./cpuAdmission.prePoll.fixture";
import { CpuAdmissionQueue, cpuAdmissionFile, CPU_QUEUE_ABANDONED_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS, CPU_QUEUE_STALE_GRACE_MS, CPU_QUEUE_UNPOLLED_MS } from "./cpuAdmission";
import { cpuQueueDetail, ordinal, parseCpuQueueDetail } from "./cpuQueueText";
import { captureProcessIdentity } from "../processIdentity";
import { CPU_TASK_PRIORITY_SQL, cpuPriorityEnv, cpuPriorityFromEnv, readCpuPriority } from "./cpuPriority";

const directories: string[] = [];
const queues: { close(): void }[] = [];
afterEach(() => { for (const q of queues.splice(0)) q.close(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
/* The ordering cases below move a fake clock across minutes between checks, so
   their tickets stand for waiters that poll throughout: `unpolledMs` is
   unbounded there. The cases that name polling pass the production bound. */
function fixture(unpolledMs = Number.POSITIVE_INFINITY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-admission-")); directories.push(dir);
  const file = path.join(dir, "queue.sqlite");
  let now = 0;
  const open = () => { const q = new CpuAdmissionQueue(file, () => now, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, unpolledMs); queues.push(q); return q; };
  return { open, file, at: (value: number) => { now = value; } };
}
const FOREIGN = `stage:${"b".repeat(64)}:895e3de4:plan:1`, LIVE = `stage:${"0".repeat(64)}:762633d8:build:1`;

test("priority orders levels strictly and preserves FIFO within each level despite reverse polling", () => {
  const f = fixture(), q = f.open(), tasks = priorityTasks(f.file);
  const entries = [["low-first", "low"], ["normal-first", "normal"], ["high-first", "high"], ["low-second", "low"], ["normal-second", "normal"], ["high-second", "high"]] as const;
  for (const [key, priority] of entries) { tasks.set(key, priority); q.check(key, false, undefined, true, tasks.source([key])); }
  const order = ["high-first", "high-second", "normal-first", "normal-second", "low-first", "low-second"];
  for (const key of [...order].reverse()) expect(q.check(key, false)?.position).toBe(order.indexOf(key) + 1);
  for (const [index, key] of order.entries()) {
    f.at(index * CPU_QUEUE_SPACING_MS);
    expect(q.check(key, true)).toBeNull();
  }
  tasks.close();
});

function priorityTasks(file: string) {
  const database = `${file}.tasks`;
  const db = new Database(database, { create: true });
  let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  queues.push({ close });
  db.exec("CREATE TABLE state_rows (collection TEXT, row_key TEXT, value_json TEXT, PRIMARY KEY(collection, row_key))");
  const set = (id: string, priority: string) => db.query("INSERT OR REPLACE INTO state_rows VALUES ('tasks', ?, ?)").run(`t:${id}`, JSON.stringify({ priority }));
  set("first", "normal"); set("raised", "low");
  return { database, db, set, close, source: (taskIds: string[]) => ({ database, taskIds }) };
}

test("a waiting task raised by another writer moves ahead before its own next poll, retaining FIFO age", () => {
  const f = fixture(), q = f.open(), tasks = priorityTasks(f.file);
  try {
    q.check("stage:first", false, undefined, true, tasks.source(["first"]));
    f.at(10);
    q.check("stage:raised", false, undefined, true, tasks.source(["raised"]));
    tasks.set("raised", "high");
    expect(q.check("stage:first", true)).toMatchObject({ position: 2 });
    expect(q.check("stage:raised", false)).toMatchObject({ position: 1, priority: "high", since: 10 });
    tasks.set("raised", "low");
    expect(q.check("stage:raised", false)).toMatchObject({ position: 2, priority: "low", since: 10 });
  } finally { tasks.close(); }
});

test("a pre-upgrade gate cannot admit normal work ahead of an observed high-priority stage", () => {
  const m = mixed(), older = m.older(), q = m.open(), tasks = priorityTasks(m.file);
  tasks.set("first", "high");
  q.check("stage:high", false, undefined, true, tasks.source(["first"]));

  // This is the pinned older helper: its SQL knows only seq and ignores the
  // priority/source columns introduced by the upgraded release.
  expect(older.check("command:normal", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 2 });
  expect(older.check("command:normal-second", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 3 });
  expect(q.check("stage:high", false)?.position).toBe(1);
  expect(q.check("command:normal", false, captureProcessIdentity(process.pid))?.position).toBe(2);
  expect(q.check("command:normal-second", false, captureProcessIdentity(process.pid))?.position).toBe(3);
  tasks.close();
});

test("legacy inserts restore priority and FIFO seq order even when the new normal rank is unchanged", () => {
  const m = mixed(), older = m.older(), q = m.open(), tasks = priorityTasks(m.file);
  try {
    tasks.set("first", "low");
    q.check("stage:low-first", false, undefined, true, tasks.source(["first"]));
    // The older helper inserts normal rows without knowing about priority or
    // fifo_seq. That insertion must still repair the fixed seq view.
    expect(older.check("command:normal-first", false, captureProcessIdentity(process.pid))).toMatchObject({ position: 1 });
    expect(older.check("command:normal-second", false, captureProcessIdentity(process.pid))).toMatchObject({ position: 2 });
    expect(m.read<{ key: string; seq: number; priority: number }>("SELECT key, seq, priority FROM tickets ORDER BY seq")).toEqual([
      { key: "command:normal-first", seq: 1, priority: 1 },
      { key: "command:normal-second", seq: 2, priority: 1 },
      { key: "stage:low-first", seq: 3, priority: 2 },
    ]);
    expect(older.check("command:normal-first", true, captureProcessIdentity(process.pid))).toBeNull();

    m.at(CPU_QUEUE_SPACING_MS);
    tasks.set("raised", "normal");
    expect(q.check("stage:normal-first", false, undefined, true, tasks.source(["raised"]))).toMatchObject({ position: 2 });
    m.at(CPU_QUEUE_SPACING_MS + 1);
    expect(older.check("command:normal-second", false, captureProcessIdentity(process.pid))).toMatchObject({ position: 1 });

    q.close(); queues.splice(queues.indexOf(q), 1);
    const reopened = m.open();
    expect(reopened.check("command:normal-second", false, captureProcessIdentity(process.pid))).toMatchObject({ position: 1 });
    tasks.set("first", "high");
    expect(reopened.check("stage:low-first", false, undefined, false, tasks.source(["first"]))).toMatchObject({ position: 1, priority: "high" });
    expect(reopened.check("command:normal-second", false, captureProcessIdentity(process.pid))).toMatchObject({ position: 2 });
    expect(reopened.check("stage:normal-first", false, undefined, false, tasks.source(["raised"]))).toMatchObject({ position: 3 });
    expect(older.check("command:normal-second", false, captureProcessIdentity(process.pid))).toMatchObject({ position: 2 });
  } finally { tasks.close(); }
});

test("opening a queue repairs the legacy sequence order left by an earlier checker", () => {
  const f = fixture(), q = f.open(), tasks = priorityTasks(f.file);
  try {
    tasks.set("first", "low");
    q.check("stage:low", false, undefined, true, tasks.source(["first"]));
    q.close(); queues.splice(queues.indexOf(q), 1);
    const older = new PrePollCpuAdmissionQueue(f.file); queues.push(older);
    expect(older.check("command:normal", false, captureProcessIdentity(process.pid))).toMatchObject({ position: 1 });
    older.close(); queues.splice(queues.indexOf(older), 1);
    const legacyDb = new Database(f.file);
    legacyDb.exec("UPDATE tickets SET seq = seq + 10");
    legacyDb.query("UPDATE tickets SET seq = 1 WHERE key = ?").run("stage:low");
    legacyDb.query("UPDATE tickets SET seq = 2 WHERE key = ?").run("command:normal");
    legacyDb.close();

    const reopened = f.open();
    expect(reopened.check("command:normal", true, captureProcessIdentity(process.pid))).toBeNull();
    expect(reopened.check("stage:low", false, undefined, false, tasks.source(["first"]))).toMatchObject({ position: 1 });
  } finally { tasks.close(); }
});

test("task priority reads only primary-key priorities, with normal defaults and the highest linked task", () => {
  const f = fixture(), tasks = priorityTasks(f.file);
  try {
    // Invalid unrelated payloads prove this lookup never decodes task history.
    tasks.db.transaction(() => { for (let i = 0; i < 5000; i++) tasks.db.query("INSERT INTO state_rows VALUES ('tasks', ?, 'unreadable')").run(`t:history-${i}`); })();
    expect(readCpuPriority(tasks.source([]))).toBe("normal");
    expect(readCpuPriority(tasks.source(["missing"]))).toBe("normal");
    expect(readCpuPriority(tasks.source(["raised", "missing"]))).toBe("low");
    expect(readCpuPriority(tasks.source(["raised", "first", "raised"]))).toBe("normal");
    tasks.set("first", "high");
    expect(readCpuPriority(tasks.source(["raised", "first"]))).toBe("high");
    const plan = tasks.db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${CPU_TASK_PRIORITY_SQL}`).all("t:first");
    expect(plan.map(row => row.detail).join(" ")).toContain("SEARCH state_rows USING INDEX sqlite_autoindex_state_rows_1 (collection=? AND row_key=?)");
    expect(cpuPriorityFromEnv(cpuPriorityEnv(tasks.source(["first"])))).toEqual(tasks.source(["first"]));
    expect(cpuPriorityFromEnv({})).toEqual({ database: "", taskIds: [] });
    expect(() => cpuPriorityFromEnv({ LLV_GATE_CPU_PRIORITY_SOURCE: '{"priority":"urgent"}' })).toThrow("Invalid CPU task priority binding");
  } finally { tasks.close(); }
});

test("unavailable task priority refuses admission and recovers without replacing the ticket", () => {
  const f = fixture(), q = f.open(), tasks = priorityTasks(f.file);
  q.check("stage:one", false, undefined, true, tasks.source(["first"]));
  tasks.db.exec("BEGIN EXCLUSIVE");
  try { expect(() => q.check("stage:one", true)).toThrow(); }
  finally { tasks.db.exec("ROLLBACK"); }
  expect(q.check("stage:one", false)).toMatchObject({ since: 0, position: 1 });
  tasks.close();
});

test("a real checker restart and pending-stage recovery preserve priority, sequence and age", async () => {
  const f = fixture(), q = f.open(), tasks = priorityTasks(f.file);
  q.check("stage:normal", false);
  q.check("stage:high-first", false, undefined, true, tasks.source(["first"]));
  tasks.set("raised", "high");
  q.check("stage:high-second", false, undefined, true, tasks.source(["raised"]));
  tasks.set("first", "high");
  tasks.close();
  const script = `const { CpuAdmissionQueue } = await import(process.argv[1]); const q = new CpuAdmissionQueue(process.argv[2], () => 1); q.reconcile('stage:', new Set(['stage:normal', 'stage:high-first', 'stage:high-second'])); console.log(JSON.stringify(['stage:normal', 'stage:high-second', 'stage:high-first'].map(key => q.check(key, false)))); q.close();`;
  const child = Bun.spawn([process.execPath, "-e", script, path.join(import.meta.dir, "cpuAdmission.ts"), f.file], { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe(""); expect(code).toBe(0);
  expect(JSON.parse(out).map((wait: { position: number; since: number }) => [wait.position, wait.since])).toEqual([[3, 0], [2, 0], [1, 0]]);
});

test("the gate helper inherits a publication's task binding through wait and fresh claim processes", async () => {
  const f = fixture(), tasks = priorityTasks(f.file), directory = path.dirname(f.file);
  let observerTime = 0;
  const q = new CpuAdmissionQueue(path.join(directory, "admission.sqlite"), () => observerTime); queues.push(q);
  const owner = captureProcessIdentity(process.pid);
  const env = { ...process.env, ...cpuPriorityEnv(tasks.source(["first"])), LLV_GATE_LOCK_DIR: directory,
    LLV_GATE_SLOTS: "1", LLV_GATE_SLOT_LEASE: "", DELEGATUS_CPU_PRESSURE: "off" };
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../../../scripts/cpu-admission.ts"), mode, "command:publication-gate", String(process.pid)], { env, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(out).toBe(""); expect(error).toBe(""); return code;
  };
  try {
    q.check("command:normal", false, owner);
    tasks.set("first", "high");
    expect(await run("--wait")).toBe(0);
    observerTime = CPU_QUEUE_SPACING_MS + 1;
    // Read the durable wait state without attempting admission: that check
    // would legitimately admit this entry after the spacing window elapsed.
    expect(q.check("command:normal", false, owner)?.position).toBe(2);
    tasks.set("first", "low");
    expect(await run("--claim")).toBe(75);
    tasks.set("first", "high");
    expect(await run("--claim")).toBe(0);
    expect(q.check("command:normal", false, owner)?.position).toBe(1);
  } finally { tasks.close(); }
});

test("a direct test invocation resolves its default queue inside its chosen state", () => {
  const environment = { ...process.env }, directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-test-routing-"));
  directories.push(directory);
  try {
    delete process.env.LLV_GATE_LOCK_DIR;
    process.env.LLV_STATE_DIR = directory;
    expect(cpuAdmissionFile()).toBe(path.join(directory, "cpu-gate", "admission.sqlite"));
    process.env.LLV_GATE_LOCK_DIR = path.join(directory, "explicit");
    expect(cpuAdmissionFile()).toBe(path.join(directory, "explicit", "admission.sqlite"));
  } finally { process.env = environment; }
});

test("persistent high pressure admits the ten-minute head, then one at a time in FIFO order", () => {
  const f = fixture(), q = f.open();
  expect(q.check("stage:one", false)).toEqual({ since: 0, position: 1, remainingMs: CPU_QUEUE_MAX_WAIT_MS });
  expect(q.check("stage:two", false)?.position).toBe(2);
  expect(q.check("stage:three", false)?.position).toBe(3);
  f.at(CPU_QUEUE_MAX_WAIT_MS - 1);
  expect(q.check("stage:one", false)).not.toBeNull();
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  expect(q.check("stage:three", false)?.position).toBe(3); // reverse tick order cannot overtake
  expect(q.check("stage:one", false)).toBeNull();
  expect(q.check("stage:two", false)?.remainingMs).toBe(CPU_QUEUE_SPACING_MS);
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS);
  expect(q.check("stage:three", false)?.position).toBe(2);
  expect(q.check("stage:two", false)).toBeNull();
  expect(q.check("stage:three", false)).not.toBeNull();
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS * 2);
  expect(q.check("stage:three", false)).toBeNull();
});

test("a restarted Viewer preserves timestamps and order alongside command tickets", () => {
  const f = fixture(), q = f.open();
  q.check("stage:one", false);
  f.at(10_000); q.check("command:two", false, captureProcessIdentity(process.pid));
  q.close(); queues.splice(queues.indexOf(q), 1);
  const restarted = f.open();
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  expect(restarted.check("command:two", false)).toMatchObject({ since: 10_000, position: 2 });
  expect(restarted.check("stage:one", false)).toBeNull();
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS);
  expect(restarted.check("command:two", true)).toBeNull();
  expect(f.open().check("stage:three", true)).not.toBeNull(); // spacing survives reopening too
});

test.each(["stage", "workflow"])("a %s admission survives a restart before the stage checkpoint", prefix => {
  const f = fixture(), q = f.open(), one = `${prefix}:one`, two = `${prefix}:two`;
  q.check(one, false); f.at(10); q.check(two, false);
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  expect(q.check(one, false)).toBeNull();
  // CPU admission committed, but the controller's durable row is still pending.
  q.close(); queues.splice(queues.indexOf(q), 1);
  const restarted = f.open();
  restarted.reconcile(`${prefix}:`, new Set([one, two]));
  expect(restarted.check(one, false)).toMatchObject({ since: 0, position: 1, remainingMs: CPU_QUEUE_SPACING_MS });
  expect(restarted.check(two, false)?.position).toBe(2);
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS);
  expect(restarted.check(one, false)).toBeNull();
  // The start checkpoint now owns the reservation, so the queue can settle it.
  restarted.reconcile(`${prefix}:`, new Set([two]));
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS * 2);
  expect(restarted.check(two, false)).toBeNull();
});

test("a stage and a heavy check share FIFO, even when pressure is low or sampling failed", () => {
  const f = fixture(), q = f.open();
  q.check("stage:one", false); q.check("command:two", false);
  expect(q.check("command:two", true)?.position).toBe(2);
  expect(q.check("stage:one", true)).toBeNull();
  f.at(CPU_QUEUE_SPACING_MS);
  expect(q.check("command:two", true)).toBeNull();
});

test("a permissive sample cannot understate the bound if pressure rises again before admission", () => {
  const f = fixture(), q = f.open();
  q.check("stage:one", false);
  f.at(300_000);
  expect(q.check("command:two", true)).toEqual({
    since: 300_000, position: 2, remainingMs: CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS,
  });
  f.at(301_000);
  expect(q.check("command:two", false)?.remainingMs).toBe(CPU_QUEUE_MAX_WAIT_MS - 1_000 + CPU_QUEUE_SPACING_MS);
  f.at(302_000);
  expect(q.check("command:two", true)?.remainingMs).toBe(CPU_QUEUE_MAX_WAIT_MS - 2_000 + CPU_QUEUE_SPACING_MS);
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  expect(q.check("stage:one", false)).toBeNull();
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS);
  expect(q.check("command:two", true)).toBeNull();
});

test("slot readiness leaves the head durable until claim; cancellation frees only its namespace", () => {
  const f = fixture(), q = f.open();
  expect(q.check("stage:one", true, undefined, false)).toBeNull();
  expect(q.check("other:one", true)?.position).toBe(2);
  q.reconcile("stage:", new Set());
  expect(q.check("other:one", true)).toBeNull();
});

test("queue details carry remaining whole minutes and English ordinals", () => {
  expect(cpuQueueDetail(2, 61_000)).toBe("Waiting for the CPU queue · 2nd · up to 2 min · normal priority");
  expect(parseCpuQueueDetail(cpuQueueDetail(12, 0))).toEqual({ position: 12, minutes: 0, priority: "normal" });
  expect(parseCpuQueueDetail(`${cpuQueueDetail(2, 61_000)} · Viewer publication: owner; owner viewer, epoch 1`)).toEqual({ position: 2, minutes: 2, priority: "normal" });
  expect(parseCpuQueueDetail(`${cpuQueueDetail(2, 61_000)} · unknown detail`)).toBeNull();
  expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st"]);
});

test("a proven stale command owner loses its ticket without discarding active stages", () => {
  const f = fixture(), q = f.open();
  q.check("command:gone", false, { ...captureProcessIdentity(process.pid), startIdentity: "gone" });
  q.check("stage:one", false);
  q.check("stage:two", false);
  q.reconcile("stage:", new Set(["stage:two"]));
  expect(q.check("stage:two", false)?.position).toBe(1);
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  expect(q.check("stage:two", false)).toBeNull();
});

test("an update-held stage keeps its order and age across restart without starving heavy checks", () => {
  const f = fixture(), q = f.open();
  q.check("stage:one", false); q.check("stage:two", false);
  q.reconcile("stage:", new Set(["stage:one", "stage:two"]), new Set());
  q.close(); queues.splice(queues.indexOf(q), 1);
  const restarted = f.open();
  expect(restarted.check("command:check", true)).toBeNull();
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  restarted.reconcile("stage:", new Set(["stage:one", "stage:two"]));
  expect(restarted.check("command:later", true)?.position).toBe(3);
  expect(restarted.check("stage:two", false)).toMatchObject({ since: 0, position: 2 });
  expect(restarted.check("stage:one", false)).toBeNull();
  expect(restarted.check("stage:two", false)?.remainingMs).toBe(CPU_QUEUE_SPACING_MS);
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS);
  expect(restarted.check("stage:two", false)).toBeNull();
});

test("a foreign ownerless stage ticket nobody polls stops holding the head within the bound", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS), q = f.open();
  // The incident: an isolated instance queued a stage start and went away.
  expect(q.check(FOREIGN, true, undefined, false)).toBeNull();
  f.at(1_000);
  const command = captureProcessIdentity(process.pid);
  expect(q.check(LIVE, true)).toMatchObject({ position: 2 });
  expect(q.check("command:push", true, command)).toMatchObject({ position: 3 });
  f.at(CPU_QUEUE_UNPOLLED_MS);
  expect(q.check(LIVE, true)).toMatchObject({ position: 2 }); // within the bound the orphan still counts
  f.at(CPU_QUEUE_UNPOLLED_MS + 1);
  expect(q.check("command:push", true, command)).toMatchObject({ position: 2 }); // FIFO behind the live stage holds
  expect(q.check(LIVE, true)).toBeNull();
  // Skipping the orphan admits one start at a time: the spacing still applies.
  expect(q.check("command:push", true, command)).toMatchObject({ since: 1_000, position: 1 });
  f.at(CPU_QUEUE_UNPOLLED_MS + CPU_QUEUE_SPACING_MS);
  expect(q.check("command:push", true, command)).not.toBeNull();
  f.at(CPU_QUEUE_UNPOLLED_MS + 1 + CPU_QUEUE_SPACING_MS);
  expect(q.check("command:push", true, command)).toBeNull();
});

test("a polled live stage keeps its sequence and age across the bound, and a skipped one returns to its place", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS), q = f.open();
  const row = (key: string) => {
    const db = new Database(f.file, { readonly: true });
    try { return db.query<{ seq: number; since: number }, [string]>("SELECT seq, since FROM tickets WHERE key = ?").get(key); } finally { db.close(); }
  };
  expect(q.check(LIVE, false)).toMatchObject({ since: 0, position: 1 });
  expect(q.check("stage:later", false)).toMatchObject({ position: 2 });
  const first = row(LIVE)!;
  for (let at = 5_000; at <= CPU_QUEUE_UNPOLLED_MS * 3; at += 5_000) {
    f.at(at);
    expect(q.check(LIVE, false)).toMatchObject({ since: 0, position: 1 });
    expect(q.check("stage:later", false)).toMatchObject({ position: 2 });
  }
  expect(row(LIVE)).toEqual(first);
  // Its Viewer stops for longer than the bound: later work passes, the ticket stays.
  const stopped = CPU_QUEUE_UNPOLLED_MS * 3;
  f.at(stopped + CPU_QUEUE_UNPOLLED_MS + 1);
  expect(q.check("stage:later", false)).toMatchObject({ position: 1 });
  expect(row(LIVE)).toEqual(first);
  // Back again, it is ahead of everything queued after it, with its original age.
  expect(q.check(LIVE, false)).toMatchObject({ since: 0, position: 1 });
  expect(q.check("stage:later", false)).toMatchObject({ position: 2 });
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  expect(q.check(LIVE, false)).toBeNull();
  expect(q.check("stage:later", false)).toMatchObject({ position: 1, remainingMs: CPU_QUEUE_SPACING_MS });
});

test("a stage released from a long hold is ahead of later work before its own next check", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS), q = f.open(), held = new Set(["stage:one", "stage:two"]);
  q.check("stage:one", false); q.check("stage:two", false);
  q.reconcile("stage:", held, new Set());
  f.at(CPU_QUEUE_MAX_WAIT_MS - 1);
  q.reconcile("stage:", held); // the hold ends; neither stage has ticked yet
  expect(q.check("command:later", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 3 });
  expect(q.check("stage:two", false)).toMatchObject({ since: 0, position: 2 });
  f.at(CPU_QUEUE_MAX_WAIT_MS);
  expect(q.check("stage:one", false)).toBeNull();
});

/* A release that predates polls shares the file with the current one for as
   long as it serves. These cases run its own queue class beside the current
   one, on one file and one clock. */
function mixed() {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS);
  let now = 0;
  const older = () => { const q = new PrePollCpuAdmissionQueue(f.file, () => now); queues.push(q); return q; };
  const read = <T>(sql: string) => { const db = new Database(f.file, { readonly: true }); try { return db.query<T, []>(sql).all(); } finally { db.close(); } };
  const row = (key: string) => read<{ key: string; seq: number; since: number }>("SELECT key, seq, since FROM tickets").find(ticket => ticket.key === key) ?? null;
  return { ...f, older, read, row, clock: () => now, at: (value: number) => { now = value; f.at(value); } };
}

test("a stage an older release keeps polling holds its place against a current checker", () => {
  const m = mixed(), older = m.older(), q = m.open();
  // An orphan at the head, then the older release's stage under pressure.
  q.check(FOREIGN, false);
  expect(older.check(LIVE, false)).toMatchObject({ position: 2 });
  const first = m.row(LIVE)!;
  for (let tick = 5_000; tick <= CPU_QUEUE_UNPOLLED_MS + 5_000; tick += 5_000) { m.at(tick); older.check(LIVE, false); }
  // The orphan is passed over; the polled stage is not, so later work waits behind it.
  expect(q.check("stage:later", true)).toMatchObject({ since: CPU_QUEUE_UNPOLLED_MS + 5_000, position: 2 });
  expect(q.check("command:push", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 3 });
  expect(m.row(LIVE)).toEqual(first);
  // Its release stops: within the bound of its last poll it is passed over too.
  m.at(m.clock() + CPU_QUEUE_UNPOLLED_MS + 1);
  expect(q.check("stage:later", true)).toBeNull();
  expect(q.check("command:push", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 1 }); // spacing still separates the two starts
  expect(m.row(LIVE)).toEqual(first);
  // Back again, the older release finds its stage where it left it, ahead of the command.
  expect(older.check(LIVE, false)).toMatchObject({ since: 0, position: 1 });
  expect(q.check("command:push", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 2 });
});

test("a stage an older release polls for more than a day behind a live command keeps its row", () => {
  const m = mixed(), older = m.older(), q = m.open(), owner = captureProcessIdentity(process.pid);
  expect(older.check("command:long", true, owner, false)).toBeNull();
  expect(older.check(LIVE, true)).toMatchObject({ position: 2 });
  const first = m.row(LIVE)!;
  for (const tick of [5_000, CPU_QUEUE_UNPOLLED_MS, CPU_QUEUE_ABANDONED_MS - 5_000, CPU_QUEUE_ABANDONED_MS + 5_000]) { m.at(tick); older.check(LIVE, true); }
  m.at(CPU_QUEUE_ABANDONED_MS + 10_000);
  expect(q.check("stage:later", true)).toMatchObject({ position: 3 });
  expect(m.row(LIVE)).toEqual(first);
  expect(older.check(LIVE, true)).toMatchObject({ since: 0, position: 2 });
});

test("an orphan at the head stops holding an older release's live stage and a later command", () => {
  const m = mixed(), older = m.older(), q = m.open(), owner = captureProcessIdentity(process.pid);
  // The incident with two releases serving: the orphan, the older release's
  // stage, a command of the current one. Each waiter checks every five seconds.
  older.check(FOREIGN, false);
  const orphan = m.row(FOREIGN)!;
  const admitted: Record<string, number> = {};
  for (let tick = 0; tick <= CPU_QUEUE_UNPOLLED_MS + 20_000; tick += 5_000) {
    m.at(tick);
    if (!(LIVE in admitted)) {
      const wait = older.check(LIVE, true);
      if (!wait) admitted[LIVE] = tick;
      else if (tick <= CPU_QUEUE_UNPOLLED_MS) expect(wait).toMatchObject({ since: 0, position: 2 }); // within the bound the orphan counts
    }
    if (!("command" in admitted)) {
      const wait = q.check("command:later", true, owner);
      if (!wait) admitted.command = tick;
      else if (!(LIVE in admitted)) expect(wait).toMatchObject({ position: tick <= CPU_QUEUE_UNPOLLED_MS ? 3 : 2 }); // never ahead of the live stage
    }
  }
  // The first current check past the bound passes the orphan over for both
  // releases; the stage starts at its next tick and the command one tick later.
  expect(admitted).toEqual({ [LIVE]: CPU_QUEUE_UNPOLLED_MS + 10_000, command: CPU_QUEUE_UNPOLLED_MS + 15_000 });
  expect(m.row(FOREIGN)).toEqual(orphan);
  // Its instance was only restarting: its own check returns it to its place and age.
  expect(older.check(FOREIGN, false)).toMatchObject({ since: 0, position: 1 });
  expect(m.read("SELECT key FROM unpolled")).toEqual([]);
});

test("an older release's reconcile cannot return a passed-over ticket to the head, and removes it whole", () => {
  const m = mixed(), older = m.older(), q = m.open(), owner = captureProcessIdentity(process.pid);
  const orphan = "stage:orphan";
  older.check(orphan, false);
  m.at(CPU_QUEUE_UNPOLLED_MS + 1);
  expect(q.check("command:first", true, owner)).toBeNull();
  // Reconciling the ticket as eligible polls nothing, so it stays passed over.
  for (const tick of [70_000, 75_000, 80_000]) { m.at(tick); older.reconcile("stage:", new Set([orphan])); }
  expect(older.check(LIVE, true)).toBeNull();
  // A fence's hold replaces the passing over, and the release ends it once.
  older.reconcile("stage:", new Set([orphan]), new Set());
  expect(m.read("SELECT key FROM unpolled")).toEqual([]);
  expect(m.read("SELECT key FROM suspended")).toEqual([{ key: orphan }]);
  m.at(CPU_QUEUE_UNPOLLED_MS * 3);
  expect(q.check("command:second", true, owner)).toBeNull(); // held: it does not count
  older.reconcile("stage:", new Set([orphan]));
  m.at(CPU_QUEUE_UNPOLLED_MS * 3 + CPU_QUEUE_SPACING_MS);
  expect(q.check("command:third", true, owner)).toMatchObject({ position: 2 });
  m.at(CPU_QUEUE_UNPOLLED_MS * 4 + CPU_QUEUE_SPACING_MS + 1);
  expect(q.check("command:third", true, owner)).toBeNull();
  expect(m.read("SELECT key FROM unpolled")).toEqual([{ key: orphan }]);
  // The stage is gone for its release: nothing of the ticket stays behind.
  older.reconcile("stage:", new Set());
  expect(m.read("SELECT key FROM tickets UNION ALL SELECT key FROM suspended UNION ALL SELECT key FROM unpolled")).toEqual([]);
});

test("a stage an older release releases from a hold is ahead of later work before its next check", () => {
  const m = mixed(), older = m.older(), q = m.open(), active = new Set([LIVE]);
  older.check(LIVE, false);
  const first = m.row(LIVE)!;
  m.at(5_000);
  older.check(LIVE, false);
  older.reconcile("stage:", active, new Set()); // another fence holds it
  m.at(CPU_QUEUE_UNPOLLED_MS + 5_001);
  older.reconcile("stage:", active); // the hold ends; the stage has not ticked yet
  expect(q.check("command:later", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 2 });
  expect(older.check(LIVE, false)).toMatchObject({ since: 0, position: 1 });
  expect(m.row(LIVE)).toEqual(first);
});

test("a stage an older release held for more than a day keeps its row and its place at the release", () => {
  const m = mixed(), older = m.older(), q = m.open(), active = new Set([LIVE]), owner = captureProcessIdentity(process.pid);
  older.check(LIVE, false);
  const first = m.row(LIVE)!;
  m.at(5_000);
  older.reconcile("stage:", active, new Set());
  m.at(CPU_QUEUE_ABANDONED_MS + 10_000);
  expect(q.check("command:probe", true, owner)).toBeNull(); // held: passed, and kept
  expect(m.row(LIVE)).toEqual(first);
  m.at(CPU_QUEUE_ABANDONED_MS + 15_000);
  older.reconcile("stage:", active);
  expect(q.check("command:later", true, owner)).toMatchObject({ position: 2 });
  expect(m.row(LIVE)).toEqual(first);
  expect(older.check(LIVE, false)).toBeNull(); // first in line and long past its own bound
  expect(q.check("command:later", true, owner)).toMatchObject({ position: 1 }); // spacing behind the stage
});

/* A second process that opens the file and checks at the moment the first one
   reads its clock, which the first cut of this change did between adding the
   column and giving the queued tickets their bound. */
function checkInAnotherProcess(file: string, clock: number, key: string, owner: ReturnType<typeof captureProcessIdentity>) {
  const script = `const { CpuAdmissionQueue } = await import(process.argv[1]); const q = new CpuAdmissionQueue(process.argv[2], () => Number(process.argv[3])); process.stdout.write(JSON.stringify(q.check(process.argv[4], true, JSON.parse(process.argv[5])))); q.close();`;
  const child = spawnSync(process.execPath, ["-e", script, path.join(import.meta.dir, "cpuAdmission.ts"), file, String(clock), key, JSON.stringify(owner)], { encoding: "utf8", timeout: 30_000 });
  if (child.status !== 0) throw new Error(`second checker failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as { position: number } | null;
}

test("two releases opening an older queue at once never remove a live, just-polled stage", () => {
  const m = mixed(), older = m.older(), owner = captureProcessIdentity(process.pid);
  expect(older.check("command:long", true, owner, false)).toBeNull();
  expect(older.check(LIVE, true)).toMatchObject({ since: 0, position: 2 });
  const first = m.row(LIVE)!, day = 2 * CPU_QUEUE_ABANDONED_MS;
  m.at(day);
  older.check(LIVE, true);
  let other: ReturnType<typeof checkInAnotherProcess> | undefined;
  const q = new CpuAdmissionQueue(m.file, () => {
    if (other === undefined) other = checkInAnotherProcess(m.file, day, "command:later", owner);
    return m.clock();
  }, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS);
  queues.push(q);
  expect(other).toMatchObject({ position: 3 });
  expect(m.row(LIVE)).toEqual(first);
  expect(q.check("command:later", true, owner)).toMatchObject({ position: 3 });
  expect(older.check(LIVE, true)).toMatchObject({ since: 0, position: 2 });
});

test("releases racing to open an older queue describe it once and keep its live stage", async () => {
  const m = mixed(), older = m.older(), owner = captureProcessIdentity(process.pid);
  expect(older.check("command:long", true, owner, false)).toBeNull();
  older.check(LIVE, true);
  const first = m.row(LIVE)!, day = 2 * CPU_QUEUE_ABANDONED_MS;
  m.at(day);
  older.check(LIVE, true);
  const script = `const { CpuAdmissionQueue } = await import(process.argv[1]); const q = new CpuAdmissionQueue(process.argv[2], () => Number(process.argv[3])); process.stdout.write(JSON.stringify(q.check(process.argv[4], true, JSON.parse(process.argv[5])))); q.close();`;
  const children = Array.from({ length: 6 }, (_, index) => Bun.spawn([process.execPath, "-e", script, path.join(import.meta.dir, "cpuAdmission.ts"), m.file, String(day), `command:racer-${index}`, JSON.stringify(owner)], { stdout: "pipe", stderr: "pipe" }));
  const waits = await Promise.all(children.map(async child => {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`racing checker failed: ${error}`);
    return (JSON.parse(out) as { position: number }).position;
  }));
  // Every racer queued behind the command and the live stage, none in its place.
  expect(waits.sort()).toEqual([3, 4, 5, 6, 7, 8]);
  expect(m.row(LIVE)).toEqual(first);
  expect(m.read<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")).toEqual([{ n: 7 }]);
  expect(older.check(LIVE, true)).toMatchObject({ since: 0, position: 2 });
});

test("a queue the first cut of this change left half-described keeps its live tickets", () => {
  const m = mixed(), older = m.older();
  older.check(LIVE, false);
  const first = m.row(LIVE)!;
  // The column and the single trigger of that cut, and no bound on the ticket.
  const cut = new Database(m.file);
  cut.exec("ALTER TABLE tickets ADD COLUMN polled INTEGER");
  cut.exec("CREATE TRIGGER tickets_polled BEFORE INSERT ON tickets BEGIN UPDATE tickets SET polled = NEW.since WHERE key = NEW.key; END");
  cut.close();
  m.at(2 * CPU_QUEUE_ABANDONED_MS);
  const q = m.open();
  expect(q.check("stage:later", true)).toMatchObject({ position: 2 });
  expect(m.row(LIVE)).toEqual(first);
  expect(m.read("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).toEqual(
    ["suspended_hold", "suspended_keep", "suspended_release", "tickets_fifo", "tickets_gone", "tickets_poll", "tickets_queued"].map(name => ({ name })));
  m.at(2 * CPU_QUEUE_ABANDONED_MS + CPU_QUEUE_UNPOLLED_MS + 1);
  expect(q.check("stage:later", true)).toBeNull();
});

test("a queue written before polls were recorded gives its tickets one bound from the first current open", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS);
  const legacy = new Database(f.file, { create: true });
  legacy.exec("CREATE TABLE tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, since INTEGER NOT NULL, owner TEXT)");
  legacy.query("INSERT INTO tickets (key, since, owner) VALUES (?, 0, NULL)").run(FOREIGN);
  legacy.close();
  // An hour-old ticket may belong to a release still polling it every five seconds.
  f.at(3_600_000);
  const q = f.open(), again = f.open(); // two releases opening the same file both migrate it
  expect(q.check(LIVE, true)).toMatchObject({ position: 2 });
  f.at(3_600_000 + CPU_QUEUE_UNPOLLED_MS);
  expect(q.check(LIVE, true)).toMatchObject({ position: 2 });
  f.at(3_600_000 + CPU_QUEUE_UNPOLLED_MS + 1);
  expect(q.check(LIVE, true)).toBeNull();
  expect(again.check(FOREIGN, true)).toMatchObject({ since: 0, position: 1 });
});

test("an ownerless ticket nobody has polled for a day is removed; a held one stays", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS), q = f.open();
  const keys = () => {
    const db = new Database(f.file, { readonly: true });
    try { return db.query<{ key: string }, []>("SELECT key FROM tickets ORDER BY seq").all().map(row => row.key); } finally { db.close(); }
  };
  q.check(FOREIGN, false); q.check("stage:held", false); q.suspend("stage:held");
  f.at(CPU_QUEUE_ABANDONED_MS);
  expect(q.check("command:probe", true)).toBeNull();
  expect(keys()).toEqual([FOREIGN, "stage:held"]);
  f.at(CPU_QUEUE_ABANDONED_MS + CPU_QUEUE_SPACING_MS);
  expect(q.check("command:probe", true)).toBeNull();
  expect(keys()).toEqual(["stage:held"]);
});

test("a head past its bound while nothing is admitted reads as a stalled queue", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS), q = f.open();
  // A polled head that never claims, such as a command waiting for a slot.
  const holder = captureProcessIdentity(process.pid);
  expect(q.check("command:holder", true, holder, false)).toBeNull();
  expect(q.check(LIVE, true)).toEqual({ since: 0, position: 2, remainingMs: CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_SPACING_MS });
  f.at(CPU_QUEUE_MAX_WAIT_MS + CPU_QUEUE_STALE_GRACE_MS);
  q.check("command:holder", true, holder, false);
  expect(q.check(LIVE, true)?.stalledMs).toBeUndefined();
  f.at(CPU_QUEUE_MAX_WAIT_MS + 62 * 60_000);
  q.check("command:holder", true, holder, false);
  const wait = q.check(LIVE, true)!;
  expect(wait).toMatchObject({ position: 2, stalledMs: 62 * 60_000 });
  expect(cpuQueueDetail(wait.position, wait.remainingMs, wait.stalledMs)).toBe("Waiting for the CPU queue · 2nd · stalled for 62 min · normal priority");
  // Admission moving again clears the reading at once.
  expect(q.check("command:holder", true, holder)).toBeNull();
  expect(q.check(LIVE, true)).toEqual({ since: 0, position: 1, remainingMs: CPU_QUEUE_SPACING_MS });
});

test("the stalled wait detail parses beside the bounded one", () => {
  expect(parseCpuQueueDetail("Waiting for the CPU queue · 2nd · up to 7 min")).toEqual({ position: 2, minutes: 7 });
  expect(parseCpuQueueDetail(cpuQueueDetail(7, 1, 62 * 60_000))).toEqual({ position: 7, minutes: 62, priority: "normal", stalled: true });
  expect(parseCpuQueueDetail(`${cpuQueueDetail(7, 1, 90_000)} · Viewer publication: owner; owner viewer, epoch 1`)).toEqual({ position: 7, minutes: 1, priority: "normal", stalled: true });
  expect(parseCpuQueueDetail("Waiting for the CPU queue · 2nd · stalled for 3 min · unknown detail")).toBeNull();
});

 test.each(["high", "normal", "low"] as const)("new %s queue text round-trips beside legacy text", priority => {
  expect(parseCpuQueueDetail(cpuQueueDetail(3, 120_000, undefined, priority))).toEqual({ position: 3, minutes: 2, priority });
  expect(parseCpuQueueDetail(cpuQueueDetail(3, 0, 180_000, priority))).toEqual({ position: 3, minutes: 3, priority, stalled: true });
 });
