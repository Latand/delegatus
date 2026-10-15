import { Worker } from "node:worker_threads";

// Independently scheduled sampler. The shared ring holds 60 seconds at 100 ms;
// it never sends a message per sample or logs filesystem contents. Each slot's
// sequence is published last, so the main thread can reject a torn sample.
const slots = 600, fields = 9;
const source = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const cells = new BigInt64Array(workerData.buffer);
let sequence = 0;
let paths = [];
const throttles = new Map();
let throttleTotal = 0n;
let schedulerWaitAvailable = false;
try { schedulerWaitAvailable = fs.readFileSync("/proc/sys/kernel/sched_schedstats", "utf8").trim() === "1"; } catch {}
try {
  const group = fs.readFileSync('/proc/' + workerData.pid + '/cgroup', 'utf8').split('0::')[1].trim();
  let path = '/sys/fs/cgroup' + group;
  while (path.startsWith('/sys/fs/cgroup')) {
    paths.push(path + '/cpu.stat');
    if (path === '/sys/fs/cgroup') break;
    path = path.slice(0, path.lastIndexOf('/'));
  }
} catch {}
function sample() {
  const at = BigInt(Math.round(performance.now() * 1000));
  let running = -1n, waiting = -1n, throttle = -1n, readBytes = -1n, readCalls = -1n;
  try {
    const values = fs.readFileSync('/proc/' + workerData.pid + '/task/' + workerData.pid + '/schedstat', 'utf8').trim().split(/\\s+/);
    running = BigInt(values[0]); waiting = schedulerWaitAvailable ? BigInt(values[1]) : -1n;
  } catch {}
  try {
    // Ancestors can overlap; sum each interval's largest observed delta.
    // This is a throttle indicator, not exclusive off-CPU time.
    let delta = 0n;
    for (const path of paths) {
      const value = /throttled_usec (\\d+)/.exec(fs.readFileSync(path, 'utf8'));
      if (!value) continue;
      const current = BigInt(value[1]), previous = throttles.get(path);
      if (previous !== undefined && current - previous > delta) delta = current - previous;
      throttles.set(path, current);
    }
    throttleTotal += delta; throttle = throttleTotal;
  } catch { throttle = -1n; }
  try {
    const io = fs.readFileSync('/proc/' + workerData.pid + '/task/' + workerData.pid + '/io', 'utf8');
    readBytes = BigInt(/rchar: (\\d+)/.exec(io)[1]); readCalls = BigInt(/syscr: (\\d+)/.exec(io)[1]);
  } catch {}
  const index = (++sequence % ${slots}) * ${fields} + 1;
  Atomics.store(cells, index, 0n);
  Atomics.store(cells, index + 1, at);
  Atomics.store(cells, index + 2, running);
  Atomics.store(cells, index + 3, waiting);
  Atomics.store(cells, index + 4, throttle);
  Atomics.store(cells, index + 5, BigInt(Date.now()));
  Atomics.store(cells, index + 6, Atomics.load(cells, ${slots * fields + 1}));
  Atomics.store(cells, index + 7, readBytes);
  Atomics.store(cells, index + 8, readCalls);
  Atomics.store(cells, index, BigInt(sequence));
  Atomics.store(cells, 0, BigInt(sequence));
}
sample(); setInterval(sample, 100);
`;

export function startLoopWatchdog() {
  const buffer = new SharedArrayBuffer((slots * fields + 2) * 8);
  const cells = new BigInt64Array(buffer);
  Atomics.store(cells, slots * fields + 1, BigInt(-1));
  let failed = false;
  let worker: Worker | undefined;
  try {
    worker = new Worker(source, { eval: true, workerData: { buffer, pid: process.pid } });
    worker.on("error", () => { failed = true; });
    worker.on("exit", () => { failed = true; });
    worker.unref();
  } catch { failed = true; }
  return {
    site(site: number) { Atomics.store(cells, slots * fields + 1, BigInt(site)); },
    snapshot() {
      const last = Number(Atomics.load(cells, 0));
      const samples: Array<{ sequence: number; monotonicUs: number; runNs: number; queueNs: number; throttleUs: number; utcMs: number; site: number; readBytes: number; readCalls: number }> = [];
      for (let sequence = Math.max(1, last - slots + 1); sequence <= last; sequence++) {
        const index = (sequence % slots) * fields + 1;
        if (Number(Atomics.load(cells, index)) !== sequence) continue;
        const row = { sequence, monotonicUs: Number(Atomics.load(cells, index + 1)), runNs: Number(Atomics.load(cells, index + 2)),
          queueNs: Number(Atomics.load(cells, index + 3)), throttleUs: Number(Atomics.load(cells, index + 4)),
          utcMs: Number(Atomics.load(cells, index + 5)), site: Number(Atomics.load(cells, index + 6)), readBytes: Number(Atomics.load(cells, index + 7)), readCalls: Number(Atomics.load(cells, index + 8)) };
        if (Number(Atomics.load(cells, index)) === sequence) samples.push(row);
      }
      return { available: !failed && samples.length > 0, samples };
    },
    async stop() { await worker?.terminate(); },
  };
}
