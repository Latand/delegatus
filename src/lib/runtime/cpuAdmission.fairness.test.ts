import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS as T, CPU_QUEUE_SPACING_MS as GAP } from "./cpuAdmission";
import { V2CpuAdmissionQueue } from "./cpuAdmission.v2.fixture";
import { PrePollCpuAdmissionQueue } from "./cpuAdmission.prePoll.fixture";
import { captureProcessIdentity } from "../processIdentity";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-fairness-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "queue.sqlite"), database = path.join(root, "tasks.sqlite");
  const tasks = new Database(database);
  cleanup.push(() => tasks.close());
  tasks.exec("CREATE TABLE state_rows (collection TEXT, row_key TEXT, value_json TEXT, PRIMARY KEY(collection, row_key))");
  let now = 0;
  const owner = captureProcessIdentity(process.pid);
  const source = (key: string) => ({ database, taskIds: [key] });
  const priority = (key: string, value: string) => tasks.query("INSERT OR REPLACE INTO state_rows VALUES ('tasks', ?, ?)").run(`t:${key}`, JSON.stringify({ priority: value }));
  const open = () => {
    const q = new CpuAdmissionQueue(file, () => now, GAP, T, Infinity);
    cleanup.push(() => q.close());
    return q;
  };
  let queue: CpuAdmissionQueue | undefined;
  const getQueue = () => queue ??= open();
  const db = new Database(file);
  cleanup.push(() => db.close());
  const check = (key: string, low = false, consume = false) => getQueue().check(key, low, owner, consume, source(key), true);
  const rows = () => db.query<{ key: string; since: number; owner: string | null; priority: number; fifo_seq: number }, []>("SELECT key, since, owner, priority, fifo_seq FROM tickets ORDER BY fifo_seq").all();
  return { get q() { return getQueue(); }, file, db, owner, source, priority, check, rows, open, at: (value: number) => { now = value; } };
}

test("sustained newer high arrivals cannot starve normal or low work once resources permit admissions", () => {
  const f = fixture();
  for (const rank of ["normal", "low"]) { f.priority(rank, rank); f.check(rank); }
  const pending = ["normal", "low"], admitted: string[] = [];
  for (let minute = 1; minute <= 21; minute++) {
    f.at(minute * 60_000);
    const urgent = `high-${minute}`;
    f.priority(urgent, "high"); f.check(urgent); pending.push(urgent);
    // Reverse polling proves that the calling order cannot decide admission.
    for (const key of [...pending].reverse()) {
      if (f.check(key, true, true) === null) {
        admitted.push(key); pending.splice(pending.indexOf(key), 1); break;
      }
    }
  }
  expect(admitted.slice(0, 9)).toEqual(Array.from({ length: 9 }, (_, i) => `high-${i + 1}`));
  expect(admitted[9]).toBe("normal");
  expect(admitted[19]).toBe("low");
  expect(admitted).toHaveLength(21);
});

test("urgent preference lasts until aging; earlier high tickets and FIFO ties keep their place", () => {
  const f = fixture();
  for (const [key, priority] of [["earlier", "high"], ["normal", "normal"], ["normal-two", "normal"], ["low", "low"], ["low-two", "low"]]) {
    f.priority(key!, priority!); f.check(key!);
  }
  f.at(T - 1); f.priority("urgent", "high"); f.check("urgent");
  expect(f.check("normal")?.position).toBe(3);
  f.at(T);
  expect(f.check("urgent")?.position).toBe(4);
  f.at(2 * T);
  const order = ["earlier", "normal", "normal-two", "low", "low-two", "urgent"];
  for (const key of [...order].reverse()) expect(f.check(key)?.position).toBe(order.indexOf(key) + 1);
  for (const [index, key] of order.entries()) { f.at(2 * T + index * GAP); expect(f.check(key, true, true)).toBeNull(); }
});

test("dynamic task ranks recompute classes without rewriting wait age, FIFO or stored priority", () => {
  const f = fixture();
  f.priority("changed", "normal"); f.check("changed");
  f.at(60_000); f.priority("high", "high"); f.check("high");
  const before = f.rows()[0];
  f.at(5 * 60_000); f.priority("changed", "high");
  expect(f.check("changed")?.position).toBe(1);
  f.at(12 * 60_000); f.priority("changed", "low");
  expect(f.check("changed")?.position).toBe(2);
  expect(f.rows()[0]).toEqual({ ...before, priority: 2 });
  f.at(15 * 60_000); f.priority("normal", "normal"); f.check("normal");
  expect(f.check("normal")?.position).toBe(3); // aged low ties new normal, first in FIFO
  f.at(20 * 60_000);
  expect(f.check("changed")?.position).toBe(1);
});

test("starts pass slot-waiting commands but retain their pressure bound and shared spacing", () => {
  const f = fixture();
  f.priority("heavy", "high"); expect(f.check("heavy", true)).toBeNull(); // ready, no slot, no admission
  expect(f.q.check("stage:one", false)).toMatchObject({ position: 1, heldBy: "pressure", waitedMs: 0 });
  f.at(T - 1);
  expect(f.q.check("stage:one", false)).toMatchObject({ heldBy: "pressure", waitedMs: T - 1 });
  f.at(T);
  expect(f.q.check("stage:one", false)).toBeNull(); // unchanged stage pressure escape
  expect(f.check("heavy", true, true)).toMatchObject({ position: 1, heldBy: "queue" });
  f.at(T + GAP);
  expect(f.check("heavy", false, true)).toMatchObject({ position: 1, heldBy: "pressure" });
  expect(f.check("heavy", true, true)).toBeNull();
  expect(f.q.check("workflow:two", true)).toMatchObject({ position: 1, heldBy: "queue" });
  f.at(T + 2 * GAP);
  expect(f.q.check("workflow:two", true)).toBeNull();
});

test("an owned publication at its bound still passes a pressure-held check in the command lane", () => {
  const f = fixture();
  f.priority("heavy", "high"); f.check("heavy");
  f.at(1);
  expect(f.q.check("command:publication", false, f.owner)).toMatchObject({ position: 2 });
  f.at(T);
  expect(f.q.check("command:publication", false, f.owner)).toMatchObject({ position: 2 });
  f.at(T + 1);
  expect(f.q.check("command:publication", false, f.owner)).toBeNull();
  expect(f.check("heavy", false, true)).toMatchObject({ position: 1, heldBy: "queue" });
  f.at(T + 1 + GAP);
  expect(f.check("heavy", false, true)).toMatchObject({ position: 1, heldBy: "pressure" });
});

test("cancellation resets age; suspension and an unpolled stage keep their own durable age", () => {
  const f = fixture();
  f.priority("normal", "normal"); f.check("normal");
  f.at(2 * T); f.q.cancel("normal"); f.check("normal");
  expect(f.rows()[0]).toMatchObject({ key: "normal", since: 2 * T });
  f.at(3 * T); f.q.check("stage:older", false); f.q.check("stage:held", false); f.q.suspend("stage:held");
  f.at(5 * T);
  const polling = new CpuAdmissionQueue(f.file, () => 5 * T, GAP, T);
  cleanup.push(() => polling.close());
  expect(polling.check("stage:later", false)).toMatchObject({ position: 1 }); // older is unpolled, held stays fenced
  expect(polling.check("stage:held", false)).toBeNull(); // aged class 0 precedes new later
  f.at(5 * T + GAP);
  expect(f.q.check("stage:older", false)).toBeNull(); // original FIFO precedes later
  expect(f.rows().filter((row) => row.key === "stage:older" || row.key === "stage:held").map((row) => row.since)).toEqual([3 * T, 3 * T]);
});

test("a dead aged owner is removed once without disturbing another live ticket", () => {
  const f = fixture(), lines: string[] = [];
  let dead = false;
  let now = 0;
  const q = new CpuAdmissionQueue(f.file, () => now, GAP, T, Infinity, { status: identity => dead && identity.pid === 42 ? "dead" : "alive", exited: () => false, log: line => lines.push(line) });
  cleanup.push(() => q.close());
  q.check("gone", false, { pid: 42, startIdentity: "42:1" }, false);
  q.check("live", false, f.owner, false);
  dead = true; now = 2 * T;
  expect(q.check("live", true, f.owner)).toBeNull();
  q.check("next", false, f.owner);
  expect(lines).toHaveLength(1);
  expect(f.rows().map((row) => row.key)).toEqual(["next"]);
});

test.each(["v2", "pre-poll"])("cold %s rows age on the first current check without rewriting their identities", version => {
  const f = fixture();
  const old = version === "v2" ? new V2CpuAdmissionQueue(f.file, () => 0, GAP, T, Infinity) : new PrePollCpuAdmissionQueue(f.file, () => 0);
  cleanup.push(() => old.close());
  old.check("old-normal", false, f.owner, false);
  f.at(25 * 60_000);
  const restarted = f.open();
  const before = f.rows();
  f.priority("young-high", "high"); f.check("young-high");
  expect(restarted.check("young-high", true, f.owner, false, f.source("young-high"), true)?.position).toBe(2);
  expect(f.rows()[0]).toEqual(before[0]);
  expect(restarted.check("old-normal", true, f.owner, true, undefined, true)).toBeNull();
});

test("V2 and current connections keep schema, row meaning, legacy ordering and global spacing", () => {
  const f = fixture();
  let clock = 0;
  const old = new V2CpuAdmissionQueue(f.file, () => clock, GAP, T, Infinity);
  cleanup.push(() => old.close());
  const schema = () => f.db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  const original = schema();
  f.open(); expect(schema()).toEqual(original);
  f.priority("normal", "normal"); old.check("normal", true, f.owner, false, f.source("normal"), true);
  f.at(T); clock = T;
  f.priority("urgent", "high"); f.check("urgent");
  const rows = f.rows();
  expect(f.check("normal", true)).toBeNull(); // aged normal is ready
  expect(old.check("normal", true, f.owner, false, undefined, true)?.position).toBe(2); // old policy still sees urgent first
  expect(old.check("urgent", true, f.owner, true)).toBeNull();
  expect(f.rows()).toEqual(rows.filter((row) => row.key !== "urgent"));
  expect(f.q.check("stage:current", true)).toMatchObject({ position: 1, heldBy: "queue" });
  f.at(T + GAP); clock = T + GAP;
  expect(f.q.check("stage:current", true)).toBeNull();
  expect(old.check("normal", true, f.owner, true)).toMatchObject({ position: 1 });
  f.at(T + 2 * GAP); clock = T + 2 * GAP;
  expect(old.check("normal", true, f.owner, true)).toBeNull();
  expect(schema()).toEqual(original);
});

test("fresh checker processes recover aging from durable wait timestamps and keep pressure mandatory", () => {
  const f = fixture();
  f.priority("normal", "normal"); f.check("normal");
  const script = `const { CpuAdmissionQueue } = await import(process.argv[1]);
    const q = new CpuAdmissionQueue(process.argv[2], () => Number(process.argv[3]));
    try { process.stdout.write(JSON.stringify(q.check(process.argv[4], process.argv[5] === "low", JSON.parse(process.argv[6]), process.argv[7] === "claim", JSON.parse(process.argv[8]), true))); }
    finally { q.close(); }`;
  const check = (key: string, now: number, low: boolean, consume: boolean) => {
    const result = spawnSync(process.execPath, ["-e", script, path.join(import.meta.dir, "cpuAdmission.ts"), f.file, String(now), key, low ? "low" : "high", JSON.stringify(f.owner), consume ? "claim" : "peek", JSON.stringify(f.source(key))], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  f.priority("urgent", "high");
  expect(check("urgent", T - 1, false, false)).toMatchObject({ position: 1, heldBy: "pressure" });
  expect(check("urgent", T, true, false)).toMatchObject({ position: 2 });
  expect(check("normal", T, false, true)).toMatchObject({ position: 1, since: 0, waitedMs: T, heldBy: "pressure" });
  expect(check("normal", T, true, true)).toBeNull();
  expect(check("urgent", T, true, true)).toMatchObject({ position: 1, heldBy: "queue" });
  expect(check("urgent", T + GAP, true, true)).toBeNull();
});
