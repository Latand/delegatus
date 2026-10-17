import { Worker } from "node:worker_threads";

// Independently scheduled sampler. The shared ring holds 60 seconds at 100 ms;
// it never sends a message per sample or logs filesystem contents. Each slot's
// sequence is published last, so the main thread can reject a torn sample.
const slots = 600, fields = 11;
// One retained trigger, overwritten only after a new stale heartbeat and a
// minute of cooldown. No messages, stacks or object graphs accumulate during
// a stall. Controls follow the existing site cell; sequence is published last.
export const loopWatchdogLayout = { slots, fields, site: slots * fields + 1,
  heartbeat: slots * fields + 2, trigger: slots * fields + 3, cells: slots * fields + 13 } as const;
const { heartbeat, trigger } = loopWatchdogLayout;
const source = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const cells = new BigInt64Array(workerData.buffer);
let sequence = 0;
let lastTriggeredHeartbeat = -1n, lastTriggeredAt = -60000;
let rssBytes = -1n, rssUtcMs = -1n, rssBefore = -1n, rssBeforeUtcMs = -1n;
let observedHeartbeat = -1n, rssPending = false, lastRssAt = -1000;
let paths = [];
const throttles = new Map();
let throttleTotal = 0n;
let schedulerWaitAvailable = false;
let rssReady = false, readinessSent = false;
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
  const monotonicMs = performance.timeOrigin + performance.now() - workerData.timeOrigin;
  const at = BigInt(Math.round(monotonicMs * 1000));
  const heartbeat = Atomics.load(cells, ${heartbeat});
  const ageUs = at - heartbeat;
  if (heartbeat !== observedHeartbeat) {
    rssBefore = rssBytes; rssBeforeUtcMs = rssUtcMs; observedHeartbeat = heartbeat;
  }
  // One asynchronous read in flight, at most once a second while healthy.
  // During a stale heartbeat the independent worker keeps observing growth.
  // Never ask the stalled VM to walk its heap or collect its RSS.
  if (!rssPending && monotonicMs - lastRssAt >= (ageUs > 1000000n ? 100 : 1000)) {
    rssPending = true; lastRssAt = monotonicMs;
    fs.promises.readFile('/proc/' + workerData.pid + '/status', 'utf8').then(status => {
      const match = /^VmRSS:\\s+(\\d+) kB$/m.exec(status);
      rssBytes = match ? BigInt(match[1]) * 1024n : -1n; rssUtcMs = BigInt(Date.now()); rssReady = true;
    }, () => { rssBytes = -1n; rssUtcMs = -1n; rssReady = true; }).finally(() => { rssPending = false; });
  }
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
  Atomics.store(cells, index + 9, rssBytes);
  Atomics.store(cells, index + 10, rssUtcMs);
  Atomics.store(cells, index, BigInt(sequence));
  Atomics.store(cells, 0, BigInt(sequence));
  if (ageUs > 1000000n && heartbeat !== lastTriggeredHeartbeat && monotonicMs - lastTriggeredAt >= 60000) {
    const next = Atomics.load(cells, ${trigger}) + 1n;
    Atomics.store(cells, ${trigger}, 0n);
    Atomics.store(cells, ${trigger + 1}, at);
    Atomics.store(cells, ${trigger + 2}, heartbeat);
    Atomics.store(cells, ${trigger + 3}, BigInt(Date.now()));
    Atomics.store(cells, ${trigger + 4}, Atomics.load(cells, ${slots * fields + 1}));
    Atomics.store(cells, ${trigger + 5}, ageUs);
    Atomics.store(cells, ${trigger + 6}, rssBefore);
    Atomics.store(cells, ${trigger + 7}, rssBytes);
    Atomics.store(cells, ${trigger + 8}, rssBeforeUtcMs);
    Atomics.store(cells, ${trigger + 9}, rssUtcMs);
    Atomics.store(cells, ${trigger}, next);
    lastTriggeredHeartbeat = heartbeat; lastTriggeredAt = monotonicMs;
  }
  if (rssReady && !readinessSent) { readinessSent = true; parentPort.postMessage('ready'); }
}
if (workerData.startupDelayMs > 0) setTimeout(() => { sample(); setInterval(sample, 100); }, workerData.startupDelayMs);
else { sample(); setInterval(sample, 100); }
`;

export function startLoopWatchdog(options: { startupDelayMs?: number } = {}) {
  const buffer = new SharedArrayBuffer(loopWatchdogLayout.cells * 8);
  const cells = new BigInt64Array(buffer);
  const beat = () => Atomics.store(cells, heartbeat, BigInt(Math.round(performance.now() * 1000)));
  beat();
  Atomics.store(cells, slots * fields + 1, BigInt(-1));
  let failed = false;
  let worker: Worker | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  try {
    worker = new Worker(source, { eval: true, workerData: { buffer, pid: process.pid, timeOrigin: performance.timeOrigin,
      startupDelayMs: Math.max(0, options.startupDelayMs ?? 0) } });
    worker.on("message", () => resolveReady());
    worker.on("error", () => { failed = true; resolveReady(); });
    worker.on("exit", () => { failed = true; resolveReady(); });
    worker.unref();
  } catch { failed = true; resolveReady(); }
  return {
    ready,
    heartbeat: beat,
    site(site: number) { Atomics.store(cells, slots * fields + 1, BigInt(site)); },
    snapshot() {
      const last = Number(Atomics.load(cells, 0));
      const samples: Array<{ sequence: number; monotonicUs: number; runNs: number; queueNs: number; throttleUs: number; utcMs: number; site: number; readBytes: number; readCalls: number; rssBytes: number; rssUtcMs: number }> = [];
      for (let sequence = Math.max(1, last - slots + 1); sequence <= last; sequence++) {
        const index = (sequence % slots) * fields + 1;
        if (Number(Atomics.load(cells, index)) !== sequence) continue;
        const row = { sequence, monotonicUs: Number(Atomics.load(cells, index + 1)), runNs: Number(Atomics.load(cells, index + 2)),
          queueNs: Number(Atomics.load(cells, index + 3)), throttleUs: Number(Atomics.load(cells, index + 4)),
          utcMs: Number(Atomics.load(cells, index + 5)), site: Number(Atomics.load(cells, index + 6)), readBytes: Number(Atomics.load(cells, index + 7)), readCalls: Number(Atomics.load(cells, index + 8)),
          rssBytes: Number(Atomics.load(cells, index + 9)), rssUtcMs: Number(Atomics.load(cells, index + 10)) };
        if (Number(Atomics.load(cells, index)) === sequence) samples.push(row);
      }
      return { available: !failed && samples.length > 0, samples, stall: readLoopStall(cells) };
    },
    async stop() { await worker?.terminate(); },
  };
}

/** Reject torn trigger reads just like torn ring slots. */
export function readLoopStall(cells: BigInt64Array) {
  const sequence = Number(Atomics.load(cells, trigger));
  if (!sequence) return null;
  const row = { sequence, monotonicUs: Number(Atomics.load(cells, trigger + 1)),
    heartbeatUs: Number(Atomics.load(cells, trigger + 2)), utcMs: Number(Atomics.load(cells, trigger + 3)),
    site: Number(Atomics.load(cells, trigger + 4)), ageMs: Number(Atomics.load(cells, trigger + 5)) / 1000,
    rssBeforeBytes: Number(Atomics.load(cells, trigger + 6)), rssBytes: Number(Atomics.load(cells, trigger + 7)),
    rssBeforeUtcMs: Number(Atomics.load(cells, trigger + 8)), rssUtcMs: Number(Atomics.load(cells, trigger + 9)) };
  return Number(Atomics.load(cells, trigger)) === sequence ? row : null;
}
