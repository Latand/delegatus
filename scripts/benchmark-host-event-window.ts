/** One process per sample; supply a read-only journal copy and isolated state. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeEvent } from "../src/lib/runtime/engineHost";

const [journal, mode] = process.argv.slice(2);
if (!journal || !["base", "stream"].includes(mode ?? "") || !process.env.LLV_STATE_DIR) {
  throw new Error("usage: LLV_STATE_DIR=<private state> bun scripts/benchmark-host-event-window.ts <journal copy> <base|stream>");
}
const { FileRuntimeEventStore } = await import("../src/lib/runtime/eventStore");
const { HostEventWindow } = await import("../src/lib/runtime/hostEventWindow");
const before = fs.statSync(journal);
const store = new FileRuntimeEventStore(path.dirname(journal));
const window = new HostEventWindow();
const thread = decodeURIComponent(path.basename(journal, ".jsonl"));
let rows = 0;
let tail = 0;
let maxTimerDelayMs = 0;
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  maxTimerDelayMs = Math.max(maxTimerDelayMs, now - last - 10);
  last = now;
}, 10);
let elapsedMs: number;
try {
  await Bun.sleep(30);
  const started = performance.now();
  if (mode === "base") {
    const events = store.load(thread);
    window.restore(events);
    rows = events.length;
    tail = events.at(-1)?.seq ?? 0;
  } else {
    const scan = store.scan.bind(store);
    store.scan = (id, visit) => scan(id, event => { rows++; tail = event.seq; visit(event); });
    await window.refill(store, thread);
  }
  elapsedMs = performance.now() - started;
  await Bun.sleep(30);
} finally { clearInterval(timer); }
const after = fs.statSync(journal);
if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
  throw new Error("measurement input changed");
}
const hash = createHash("sha256");
for (const event of window.events) hash.update(JSON.stringify(event));
const seqHash = createHash("sha256").update(JSON.stringify(window.events.map((event: RuntimeEvent) => event.seq))).digest("hex");
// Retain effective limits without printing machine or cgroup identities.
const limits: { cpu: string; memory: string }[] = [];
try {
  let group = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
  while (group) {
    const root = path.join("/sys/fs/cgroup", group);
    limits.push({ cpu: fs.readFileSync(path.join(root, "cpu.max"), "utf8").trim(),
      memory: fs.readFileSync(path.join(root, "memory.max"), "utf8").trim() });
    group = group.slice(0, group.lastIndexOf("/"));
  }
} catch { /* Non-Linux measurements have no cgroup limits. */ }
console.log(JSON.stringify({ mode, bytes: after.size, rows, tail, retained: window.events.length,
  windowBytes: window.heapAttribution().windowBytes, seqHash, hash: hash.digest("hex"), elapsedMs,
  maxTimerDelayMs, peakRssMiB: process.resourceUsage().maxRSS / 1024, runtime: Bun.version,
  platform: process.platform, arch: process.arch, limits }));
