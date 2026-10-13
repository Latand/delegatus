import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CpuAdmissionQueue, cpuAdmissionFile, CPU_QUEUE_ABANDONED_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS, CPU_QUEUE_STALE_GRACE_MS, CPU_QUEUE_UNPOLLED_MS } from "./cpuAdmission";
import { cpuQueueDetail, ordinal, parseCpuQueueDetail } from "./cpuQueueText";
import { captureProcessIdentity } from "../processIdentity";

const directories: string[] = [];
const queues: CpuAdmissionQueue[] = [];
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
  expect(cpuQueueDetail(2, 61_000)).toBe("Waiting for the CPU queue · 2nd · up to 2 min");
  expect(parseCpuQueueDetail(cpuQueueDetail(12, 0))).toEqual({ position: 12, minutes: 0 });
  expect(parseCpuQueueDetail(`${cpuQueueDetail(2, 61_000)} · Viewer publication: owner; owner viewer, epoch 1`)).toEqual({ position: 2, minutes: 2 });
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

/* The checker of a release that predates polls, statement for statement: it
   shares the file with the current one for as long as that release serves. */
function olderRelease(file: string, clock: () => number) {
  const db = new Database(file, { create: true });
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, since INTEGER NOT NULL, owner TEXT); CREATE TABLE IF NOT EXISTS suspended (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY, last INTEGER); INSERT OR IGNORE INTO admission VALUES (1, NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS stage_admissions (key TEXT PRIMARY KEY);");
  const check = (key: string, owner?: ReturnType<typeof captureProcessIdentity>) => db.transaction(() => {
    db.query("INSERT OR IGNORE INTO tickets (key, since, owner) VALUES (?, ?, ?)").run(key, clock(), owner ? JSON.stringify(owner) : null);
    db.query("DELETE FROM suspended WHERE key = ?").run(key);
    db.query("DELETE FROM stage_admissions WHERE key = ?").run(key);
    const ticket = db.query<{ seq: number }, [string]>("SELECT * FROM tickets WHERE key = ?").get(key)!;
    return db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM tickets WHERE seq <= ? AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)").get(ticket.seq)!.n;
  }).immediate();
  const row = (key: string) => db.query<{ seq: number; since: number }, [string]>("SELECT seq, since FROM tickets WHERE key = ?").get(key);
  return { check, row, close: () => db.close() };
}

test("a stage an older release keeps polling holds its place against a current checker", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS);
  let now = 0;
  const older = olderRelease(f.file, () => now), q = f.open();
  const at = (value: number) => { now = value; f.at(value); };
  try {
    // An orphan at the head, then the older release's stage under pressure.
    q.check(FOREIGN, false);
    expect(older.check(LIVE)).toBe(2);
    const first = older.row(LIVE)!;
    for (let tick = 5_000; tick <= CPU_QUEUE_UNPOLLED_MS + 5_000; tick += 5_000) { at(tick); older.check(LIVE); }
    // The orphan is passed over; the polled stage is not, so later work waits behind it.
    expect(q.check("stage:later", true)).toMatchObject({ since: CPU_QUEUE_UNPOLLED_MS + 5_000, position: 2 });
    expect(q.check("command:push", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 3 });
    expect(older.row(LIVE)).toEqual(first);
    // Its release stops: within the bound of its last poll it is passed over too.
    at(now + CPU_QUEUE_UNPOLLED_MS + 1);
    expect(q.check("stage:later", true)).toBeNull();
    expect(q.check("command:push", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 1 }); // spacing still separates the two starts
    expect(older.row(LIVE)).toEqual(first);
    // Back again, the older release finds its stage where it left it.
    expect(older.check(LIVE)).toBe(2);
    expect(q.check("command:push", true, captureProcessIdentity(process.pid))).toMatchObject({ position: 2 });
  } finally { older.close(); }
});

test("a stage an older release polls for more than a day behind a live command keeps its row", () => {
  const f = fixture(CPU_QUEUE_UNPOLLED_MS);
  let now = 0;
  const older = olderRelease(f.file, () => now), q = f.open(), owner = captureProcessIdentity(process.pid);
  const at = (value: number) => { now = value; f.at(value); };
  try {
    expect(older.check("command:long", owner)).toBe(1);
    expect(older.check(LIVE)).toBe(2);
    const first = older.row(LIVE)!;
    for (const tick of [5_000, CPU_QUEUE_UNPOLLED_MS, CPU_QUEUE_ABANDONED_MS - 5_000, CPU_QUEUE_ABANDONED_MS + 5_000]) { at(tick); older.check(LIVE); }
    at(CPU_QUEUE_ABANDONED_MS + 10_000);
    expect(q.check("stage:later", true)).toMatchObject({ position: 3 });
    expect(older.row(LIVE)).toEqual(first);
    expect(older.check(LIVE)).toBe(2);
  } finally { older.close(); }
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
  expect(cpuQueueDetail(wait.position, wait.remainingMs, wait.stalledMs)).toBe("Waiting for the CPU queue · 2nd · stalled for 62 min");
  // Admission moving again clears the reading at once.
  expect(q.check("command:holder", true, holder)).toBeNull();
  expect(q.check(LIVE, true)).toEqual({ since: 0, position: 1, remainingMs: CPU_QUEUE_SPACING_MS });
});

test("the stalled wait detail parses beside the bounded one", () => {
  expect(parseCpuQueueDetail("Waiting for the CPU queue · 2nd · up to 7 min")).toEqual({ position: 2, minutes: 7 });
  expect(parseCpuQueueDetail(cpuQueueDetail(7, 1, 62 * 60_000))).toEqual({ position: 7, minutes: 62, stalled: true });
  expect(parseCpuQueueDetail(`${cpuQueueDetail(7, 1, 90_000)} · Viewer publication: owner; owner viewer, epoch 1`)).toEqual({ position: 7, minutes: 1, stalled: true });
  expect(parseCpuQueueDetail("Waiting for the CPU queue · 2nd · stalled for 3 min · unknown detail")).toBeNull();
});
