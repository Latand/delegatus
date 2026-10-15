import { performanceSpans, performanceSites, performanceProcess } from "./performanceSpans";
import { startLoopWatchdog } from "./loopWatchdog";
import { AsyncLocalStorage } from "node:async_hooks";

export type ViewerOperation = "voice.orchestrator-read" | "telegram.review-polls" | "accounts.migration-target" | "pipelines.startup-admission" | "pipelines.mutation" | "pipelines.controller-mutation"
  | "registry.prepare" | "runtime.spawn-recovery" | "state.rollback-checkpoint"
  | "pipelines.controller-read" | "pipelines.controller-decode" | "pipelines.controller-materialize"
  | "pipelines.controller-checkpoint" | "pipelines.controller-select" | "pipelines.delivery-liveness"
  | "pipelines.evidence" | "pipelines.get" | "files.get" | "files.health" | "controller.scan" | "controller.pipelines" | "controller.flows" | "activity.ingest" | "controller.account-credit-guard"
  | "prototype.publish" | "prototype.copy" | "prototype.state" | "prototype.telegram";
type Operation = { name: ViewerOperation; start: number; end?: number };
const shared = globalThis as typeof globalThis & { __delegatusLoopMonitor?: ReturnType<typeof createViewerLoopMonitor> };

/** A slow journal must not grow the heap or block the loop that it measures. */
export function createLoopLogSink(write = (line: string, done: () => void) => { process.stderr.write(`${line}\n`, done); }) {
  const queue: string[] = [];
  let writing = false, dropped = 0;
  const drain = () => {
    const line = queue.shift();
    if (line === undefined) { writing = false; return; }
    try { write(line, () => { const next = setImmediate(drain); next.unref(); }); }
    catch { dropped++; const next = setImmediate(drain); next.unref(); }
  };
  return {
    dropped: () => dropped,
    enqueue(line: string) {
      if (queue.length >= 2 || Buffer.byteLength(line) > 64 * 1024) { dropped++; return; }
      queue.push(line);
      if (!writing) { writing = true; const next = setImmediate(drain); next.unref(); }
    },
  };
}

/** Completed operations survive until the next timer: their synchronous work
    can have returned before that timer is allowed to run. */
export function createViewerLoopMonitor(log?: (line: string) => void, now = () => performance.now(), spans = performanceSpans) {
  const sink = createLoopLogSink();
  let writeLog = log ?? sink.enqueue;
  const context = new AsyncLocalStorage<ViewerOperation>();
  const active = new Set<Operation>();
  let completed: Operation[] = [];
  let last = now();
  let lastSummary = last;
  let sequence = 0, activeDropped = 0, completedDropped = 0;
  let watchdog: ReturnType<typeof startLoopWatchdog> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const at = now();
    const gapMs = Math.max(0, at - last - 10);
    if (gapMs > 500) {
      const named = new Map<ViewerOperation, { name: ViewerOperation; durationMs: number; completed: boolean; count: number }>();
      for (const op of [...completed, ...active]) {
        if ((op.end ?? at) < last) continue;
        const durationMs = Math.round((op.end ?? at) - op.start);
        const entry = named.get(op.name);
        if (entry) {
          entry.durationMs = Math.max(entry.durationMs, durationMs);
          entry.completed ||= op.end !== undefined;
          entry.count++;
        } else named.set(op.name, { name: op.name, durationMs, completed: op.end !== undefined, count: 1 });
      }
      const operations = [...named.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 16);
      const attribution = spans.snapshot(last);
      // Keep measured synchronous blockers when long awaited spans fill the
      // report. Remaining slots retain awaits/events in duration order.
      const longest = attribution.records.sort((a, b) =>
        Number(b.kind === "sync") - Number(a.kind === "sync") || b.maxMs - a.maxMs).slice(0, 64);
      const scheduler = watchdog?.snapshot();
      const window = scheduler?.samples.filter(row => row.utcMs >= Date.now() - (at - last) - 200) ?? [];
      const first = window[0], final = window.at(-1);
      const revision = process.env.LLV_HOT_STATE_RELEASE_REVISION;
      writeLog(`[viewer loop-gap] ${JSON.stringify({ gapMs: Math.round(gapMs), operations,
        role: process.env.LLV_STATE_OWNER === "runtime-host" ? "runtime-host" : "viewer",
        ...performanceProcess, revision: performanceProcess.revision ?? (revision && /^[a-f0-9]{7,40}$/.test(revision) ? revision : null), sequence: ++sequence, lastTick: last, tick: at, utc: new Date().toISOString(),
        pendingOperations: active.size, activeDropped, completedDropped, logDropped: sink.dropped(),
        requests: spans.requests(),
        attribution: { pending: attribution.pending, dropped: attribution.dropped, droppedMs: attribution.droppedMs,
          omitted: Math.max(0, attribution.records.length - longest.length),
          slices: longest.map(row => ({ ...row, site: performanceSites[row.site],
            overlapMs: Math.max(0, Math.min(row.end, at) - Math.max(row.start, last)) })),
          coverage: "partial", unresolved: "unknown-runtime-or-native" },
        scheduler: { available: scheduler?.available ?? false, samples: window.length,
          runMs: first && final && first.runNs >= 0 && final.runNs >= 0 ? (final.runNs - first.runNs) / 1e6 : null,
          queueMs: first && final && first.queueNs >= 0 && final.queueNs >= 0 ? (final.queueNs - first.queueNs) / 1e6 : null,
          throttleMs: first && final && first.throttleUs >= 0 && final.throttleUs >= 0 ? (final.throttleUs - first.throttleUs) / 1000 : null,
          readBytes: first && final && first.readBytes >= 0 && final.readBytes >= 0 ? final.readBytes - first.readBytes : null,
          readCalls: first && final && first.readCalls >= 0 && final.readCalls >= 0 ? final.readCalls - first.readCalls : null,
          maxSamplingGapMs: window.length > 1 ? Math.max(...window.slice(1).map((row, index) => (row.monotonicUs - window[index]!.monotonicUs) / 1000)) : null,
          lastSampleAgeMs: final ? Date.now() - final.utcMs : null,
          // Sample counts describe the observed synchronous site. They do not
          // divide CPU time among nested spans or infer a native/GC stack.
          sites: [...new Set(window.map(row => row.site))].map(site => ({
            site: performanceSites[site] ?? "unknown-runtime-or-native",
            samples: window.filter(row => row.site === site).length,
          })),
        },
      })}`);
    }
    completed = [];
    if (at - lastSummary >= 60_000) {
      writeLog(`[performance summary] ${JSON.stringify({ ...performanceProcess, role: process.env.LLV_STATE_OWNER === "runtime-host" ? "runtime-host" : "viewer",
        monotonic: at, utc: new Date().toISOString(), requests: spans.requests(), logDropped: sink.dropped() })}`);
      lastSummary = at;
    }
    spans.clear();
    activeDropped = completedDropped = 0;
    last = at;
  };
  return {
    current: () => context.getStore(),
    setLogSink(sink: (line: string) => void) {
      const previous = writeLog;
      writeLog = sink;
      return () => { writeLog = previous; };
    },
    run<T>(name: ViewerOperation, work: () => T): T {
      const op: Operation = { name, start: now() };
      if (active.size < 128) active.add(op); else activeDropped++;
      const finish = () => {
        active.delete(op);
        op.end = now();
        completed.push(op);
        if (completed.length <= 128) return;
        let shortest = 0;
        for (let i = 1; i < completed.length; i++) {
          if (completed[i]!.end! - completed[i]!.start < completed[shortest]!.end! - completed[shortest]!.start) shortest = i;
        }
        completed.splice(shortest, 1);
        completedDropped++;
      };
      return context.run(name, () => {
        try {
          const result = work();
          if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
            return Promise.resolve(result).finally(finish) as T;
          }
          finish();
          return result;
        } catch (error) { finish(); throw error; }
      });
    },
    tick,
    start() {
      if (timer) return;
      last = now();
      watchdog = startLoopWatchdog();
      spans.observeSite(watchdog.site);
      const poll = () => { tick(); timer = setTimeout(poll, 10); timer.unref(); };
      timer = setTimeout(poll, 10); timer.unref();
    },
    stop() { if (timer) clearTimeout(timer); timer = undefined; completed = []; spans.observeSite(); void watchdog?.stop().catch(() => {}); watchdog = undefined; },
  };
}
export const viewerLoopMonitor = shared.__delegatusLoopMonitor ??= createViewerLoopMonitor();
export const withViewerOperation = <T>(name: ViewerOperation, work: () => T): T => viewerLoopMonitor.run(name, work);
