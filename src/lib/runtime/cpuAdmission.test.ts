import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS } from "./cpuAdmission";
import { cpuQueueDetail, ordinal, parseCpuQueueDetail } from "./cpuQueueText";
import { captureProcessIdentity } from "../processIdentity";

const directories: string[] = [];
const queues: CpuAdmissionQueue[] = [];
afterEach(() => { for (const q of queues.splice(0)) q.close(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-admission-")); directories.push(dir);
  const file = path.join(dir, "queue.sqlite");
  let now = 0;
  const open = () => { const q = new CpuAdmissionQueue(file, () => now); queues.push(q); return q; };
  return { open, at: (value: number) => { now = value; } };
}

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
