import { readAttribution, startReadAttributionSampler } from "./readAttribution";
import { performanceSpans, performanceSites, performanceProcess } from "./performanceSpans";
import { startLoopWatchdog } from "./loopWatchdog";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLoopHeapSignals } from "./loopHeapSignals";
import type { createLoopProfiler, LoopGapProfile } from "./loopProfiler";

export type ViewerOperation = "state.index-repair" | "temp.sweep" | "resources.read" | "worktrees.sweep" | "history.prepare" | "history.read" | "history.project-row" | "memory.curation-admission" | "pipelines.repository-initialization" | "memory.curation-panel" | "tasks.note" | "mcp.receipts" | "mcp.tasks.executor" | "memory.engine-start" | "memory.curation-status" | "runtime.startup-row" | "controller.account-migration" | "orchestrator.deputy" | "voice.orchestrator-read" | "telegram.review-polls" | "accounts.migration-target" | "pipelines.startup-admission" | "pipelines.mutation" | "pipelines.controller-mutation" | "runtime.delivery.deputy-authority"
  | "loop-profiler.collect" | "loop-profiler.trim" | "loop-profiler.settings"
  | "voice-tools.catalog"
  | "transcript.index" | "catalog.search" | "memory.discovery" | "memory.refresh" | "scanner.worker"
  | "memory.privacy.compile" | "memory.privacy.match" | "memory.privacy.worker"
  | "memory.source-read" | "memory.source-write" | "memory.select"
  | "memory.import.status" | "memory.import.advance" | "memory.import.curation" | "memory.import" | "memory.import.backup" | "memory.import.candidates" | "memory.import.retention"
  | "tasks.seat-recovery-cleanup" | "tasks.system-run" | "telegram.report-task-settle" | "memory.curation-cleanup"
  | "delivery.inbox-batch" | "composer.upload"
  | "http.render" | "links.task-export" | "role-memory.view"
  | "registry.delivery-key" | "orchestrator.relay-recovery" | "orchestrator.authority" | "memory.delivery-evidence"
  | "registry.read" | "registry.write" | "registry.prepare" | "runtime.startup" | "runtime.spawn-recovery" | "agent.deferred-spawn" | "state.rollback-checkpoint"
  | "pipelines.controller-read" | "pipelines.controller-decode" | "pipelines.controller-materialize"
  | "pipelines.controller-checkpoint" | "pipelines.controller-select" | "pipelines.delivery-liveness"
  | "memory.curation-authority"
  | "pipelines.retirement-evidence" | "pipelines.retirement-check" | "pipelines.evidence" | "pipelines.get" | "files.get" | "files.health" | "controller.scan" | "controller.pipelines" | "controller.flows" | "activity.ingest" | "controller.account-credit-guard" | "account-credit-guard.store"
  | "runtime-journal.maintenance"
  | "orchestrator.deploy-attribution" | "orchestrator.deploy-attribution.write"
  | "runtime.rpc" | "runtime.delivery-list" | "runtime.delivery-wake"
  | "claude.headless-json" | "agent.stdin-file" | "relay.media-input" | "relay.attachments" | "relay.attachments.read" | "relay.attachments.upload"
  | "external-relay.owner-history" | "mcp.project-prefix" | "issue-report.resolve" | "self-update.revision-prefix"
  | "relay.owner-continuation.send" | "relay.owner-turn.observe" | "external-relay.chains" | "relay.service-tools" | "relay.tool-index"
  | "prototype.publish" | "prototype.copy" | "prototype.state" | "prototype.delivery" | "prototype.telegram"
  | "attention.finished-cleanup" | "attention.finished-cleanup.archive" | "attention.reconcile" | "temp.sweep" | "forge.auto-merge" | "forge.sweep" | "asks.sweep"
  | "hosts.retirement" | "self-update.retention" | "spawn-notice.prune" | "delivery-progress.prune"
  | "resources.read" | "seat.panel" | "attention.read" | "pipelines.revalidate" | "runtime-journal.receipt-sweep"
  | "done.sweep" | "done.media" | "done.frame-source"
  | "seat-tick.prepare" | "seat-tick.liveness" | "seat-tick.children" | "seat-tick.reports" | "seat-tick.worker-asks" | "seat-tick.rule-reports" | "seat-tick.check" | "seat-tick.payload" | "seat-tick.audit"
  | "state.document" | "tasks.proactive.admission"
  | "memory.search" | "memory.open"
  | "codex.protocol-admission" | "mcp.page-cursors"
  | "pipelines.controller-job" | "pipelines.controller-lane" | "pipelines.controller-schedule" | "pipelines.publication-recovery"
  | "pipelines.controller-artifacts"
  | "telegram.membership-check" | "telegram.outbound-state" | "telegram.outbound-publication" | "links.telegram-publication" | "orchestrator.recipient-authority" | "orchestrator.seat-channel"
  | "seat-tick.pause-conditions" | "structured-user.publish" | "structured-user.provenance" | "structured-user.retention"
  | "turbo.sweep" | "turbo.sweep.read" | "turbo.sweep.apply" | "turbo.sweep.settle";
type Operation = { name: ViewerOperation; start: number; end?: number };
const shared = globalThis as typeof globalThis & { __delegatusLoopMonitor?: ReturnType<typeof createViewerLoopMonitor> };

/** Stall evidence stays visible even in a quiet terminal. A slow journal must
 * not grow the heap or block the loop that it measures. */
export function createLoopLogSink(write = (line: string, done: () => void) => {
  process.stderr.write(`${line}\n`, done);
}) {
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
export function createViewerLoopMonitor(log?: (line: string) => void, now = () => performance.now(), spans = performanceSpans, heapSignals = createLoopHeapSignals(undefined, undefined, now),
  watchdogFactory: () => ReturnType<typeof startLoopWatchdog> = () => startLoopWatchdog()) {
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
  let profiler: ReturnType<typeof createLoopProfiler> | undefined;
  const tick = () => {
    const at = now();
    // The launcher pins each child to its own release, including checkout
    // installs with no container identity or hot-state activation record.
    const revision = performanceProcess.revision ?? [process.env.LLV_DIAGNOSTIC_REVISION, process.env.LLV_HOT_STATE_RELEASE_REVISION]
      .find(value => value && /^[a-f0-9]{7,40}$/.test(value)) ?? null;
    watchdog?.heartbeat();
    const gapMs = Math.max(0, at - last - 10);
    const memory = heapSignals.sample(last, at, gapMs);
    if (gapMs > (process.env.LLV_STATE_OWNER === "runtime-host" ? 250 : 500)) {
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
      const reads = readAttribution.snapshot(at - last);
      const operations = [...named.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 16).map(op => ({ ...op,
        readBytes: reads.operations.find(row => row.name === op.name)?.readBytes ?? 0,
        decodedJsonBytes: reads.operations.find(row => row.name === op.name)?.decodedJsonBytes ?? 0 }));
      const attribution = spans.snapshot(last);
      // Keep measured synchronous blockers when long awaited spans fill the
      // report. Remaining slots retain awaits/events in duration order.
      const longest = attribution.records.sort((a, b) =>
        Number(b.kind === "sync") - Number(a.kind === "sync") || b.maxMs - a.maxMs).slice(0, 64);
      const scheduler = watchdog?.snapshot();
      const window = scheduler?.samples.filter(row => row.utcMs >= Date.now() - (at - last) - 200) ?? [];
      const first = window[0], final = window.at(-1);
      const rss = window.filter(row => row.rssBytes >= 0 && row.rssUtcMs >= 0);
      const rssFirst = rss[0], rssFinal = rss.at(-1);
      const report = { gapMs: Math.round(gapMs), operations, ...memory,
        role: process.env.LLV_STATE_OWNER === "runtime-host" ? "runtime-host" : "viewer",
        ...performanceProcess, revision, sequence: ++sequence, lastTick: last, tick: at, utc: new Date().toISOString(),
        pendingOperations: active.size, activeDropped, completedDropped, logDropped: sink.dropped(),
        requests: spans.requests(),
        reads,
        attribution: { pending: attribution.pending, dropped: attribution.dropped, droppedMs: attribution.droppedMs,
          omitted: Math.max(0, attribution.records.length - longest.length),
          slices: longest.map(row => ({ ...row, site: performanceSites[row.site],
            overlapMs: Math.max(0, Math.min(row.end, at) - Math.max(row.start, last)) })),
          coverage: "partial", unresolved: "unknown-runtime-or-native" },
        scheduler: { available: scheduler?.available ?? false, samples: window.length,
          rss: { source: rssFirst ? "proc-status-worker" : "unavailable",
            beforeBytes: rssFirst?.rssBytes ?? null, afterBytes: rssFinal?.rssBytes ?? null,
            deltaBytes: rssFirst && rssFinal ? rssFinal.rssBytes - rssFirst.rssBytes : null,
            peakBytes: rss.length ? Math.max(...rss.map(row => row.rssBytes)) : null,
            sampleFromUtcMs: rssFirst?.rssUtcMs ?? null, sampleToUtcMs: rssFinal?.rssUtcMs ?? null },
          // The worker records this while the main loop is still stale. Its
          // timestamp is not the recovery callback's timestamp. Sequence can
          // repeat across reports until a later stall replaces this record.
          stall: scheduler?.stall ? { ...scheduler.stall,
            site: performanceSites[scheduler.stall.site] ?? "unknown-runtime-or-native" } : null,
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
      };
      const emit = (jsProfile?: LoopGapProfile) => writeLog(`[viewer loop-gap] ${JSON.stringify({ ...report, ...(jsProfile ? { jsProfile } : {}) })}`);
      if (!profiler?.correlate(last, at, report.gapMs, emit)) {
        emit(report.gapMs >= 2000 ? { status: "not-armed", reason: "profiler-not-started" } : undefined);
      }
    }
    completed = [];
    if (at - lastSummary >= 60_000) {
      writeLog(`[performance summary] ${JSON.stringify({ ...performanceProcess, revision, role: process.env.LLV_STATE_OWNER === "runtime-host" ? "runtime-host" : "viewer",
        monotonic: at, utc: new Date().toISOString(), requests: spans.requests(), logDropped: sink.dropped() })}`);
      lastSummary = at;
    }
    readAttribution.clear();
    spans.clear();
    activeDropped = completedDropped = 0;
    last = at;
  };
  return {
    current: () => context.getStore(),
    setProfiler(next: ReturnType<typeof createLoopProfiler>) { profiler?.stop(); profiler = next; },
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
      return readAttribution.run(name, () => context.run(name, () => {
        try {
          const result = work();
          if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
            return Promise.resolve(result).finally(finish) as T;
          }
          finish();
          return result;
        } catch (error) { finish(); throw error; }
      }));
    },
    tick,
    start() {
      if (timer) return watchdog?.ready;
      last = now();
      startReadAttributionSampler();
      heapSignals.start();
      watchdog = watchdogFactory();
      spans.observeSite(watchdog.site);
      const poll = () => { tick(); timer = setTimeout(poll, 10); timer.unref(); };
      timer = setTimeout(poll, 10); timer.unref();
      return watchdog.ready;
    },
    stop() { profiler?.stop(); profiler = undefined; if (timer) clearTimeout(timer); timer = undefined; heapSignals.stop(); completed = []; spans.observeSite(); void watchdog?.stop().catch(() => {}); watchdog = undefined; },
  };
}
export const viewerLoopMonitor = shared.__delegatusLoopMonitor ??= createViewerLoopMonitor();
export const withViewerOperation = <T>(name: ViewerOperation, work: () => T): T => viewerLoopMonitor.run(name, work);
