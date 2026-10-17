import { readAttribution } from "./readAttribution";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Static site names are the source map for a serving revision. Never pass
 * row identities, SQL text, paths or request arguments to this recorder. */
export const performanceSites = [
  "state.write-wait", "state.sql-next", "state.json", "pipeline.validate", "pipeline.revive", "pipeline.identity",
  "pipeline.copy", "pipeline.yield", "pipeline.evidence", "pipeline.shared", "pipeline.refused",
  "registry.snapshot", "registry.headers", "registry.claims", "registry.row", "registry.keyed", "registry.prepare.slice", "registry.prepare.index",
  "runtime.collect", "runtime.stringify", "runtime.parse", "runtime.handler", "runtime.commit",
  "rpc.dispatch", "rpc.connect", "rpc.send", "rpc.receive", "rpc.first-byte", "rpc.frame", "rpc.finish", "rpc.deadline",
  "files.scan", "files.key", "files.queue", "files.worker", "files.clone", "files.delta", "files.encode",
  "controller.admission", "controller.reconcile", "controller.lane", "controller.ownership", "controller.task-note", "controller.job-wait", "state.checkpoint", "state.lease-commit", "state.lease-release",
  "controller.port-start", "controller.git-wait", "controller.runtime-wait", "controller.store-wait", "controller.other-wait",
  "http.dispatch", "http.response-ready",
  "pipeline.git-guard-prepare", "pipeline.attempt-push-proof", "pipeline.pull-request",
  "orchestrator.seat-stat", "orchestrator.seat-read", "orchestrator.seat-parse", "orchestrator.seat-index",
  "registry.writer-snapshot",
  "scanner.ipc-frame", "scanner.ipc-decode", "scanner.publication", "scanner.cache-encode", "scanner.cache-persist",
  "transcript.feed", "transcript.index", "memory.discovery", "memory.refresh",
  "http.render",
] as const;
export type PerformanceSite = typeof performanceSites[number];
type Slice = { sequence: number; span: number; parent: number; site: number; kind: "sync" | "await" | "event";
  start: number; end: number; count: number; totalMs: number; maxMs: number; rows: number; bytes: number; failed: boolean; correlation?: string };
const siteIds = new Map(performanceSites.map((site, index) => [site, index]));
const capacity = 1024;
const requestCapacity = 256;
const monotonicNow = performance.now.bind(performance);

export function createPerformanceSpans(now = monotonicNow) {
  const context = new AsyncLocalStorage<number>();
  const correlations = new AsyncLocalStorage<string>();
  const records: Slice[] = [];
  const longest: Slice[] = [];
  let cursor = 0;
  let sequence = 0, spans = 0, dropped = 0, droppedMs = 0, pending = 0;
  let enabled = true;
  let currentSite = -1, currentSpan = 0;
  let observeSite: ((site: number) => void) | undefined;
  const requests = new Map<string, { id: string; method: "snapshot" | "append" | "wait" | "files" | "health" | "other";
    start: number; deadline: number | null; events: Array<{ site: number; at: number; bytes: number; failed: boolean }> }>();
  let requestsDropped = 0;
  const add = (record: Slice) => {
    const previous = records.length === capacity ? records[(cursor + capacity - 1) % capacity] : records.at(-1);
    // Aggregate only adjacent tiny slices. Preserve their occupied duration
    // separately from the enclosing interval, which can include a suspension.
    if (previous && record.kind === "sync" && previous.kind === "sync" && record.maxMs < 1 && previous.maxMs < 1
      && previous.site === record.site && previous.parent === record.parent && previous.correlation === record.correlation
      && record.start - previous.end < 0.1) {
      previous.end = record.end; previous.count++; previous.totalMs += record.totalMs;
      previous.maxMs = Math.max(previous.maxMs, record.maxMs); previous.rows += record.rows; previous.bytes += record.bytes;
      previous.failed ||= record.failed;
      return;
    }
    if (records.length === capacity) {
      // Preserve the longest synchronous slices. Overflow is explicit even
      // when the discarded record was only a boundary or an awaited span.
      const removed = records[cursor]!;
      dropped += removed.count; droppedMs += removed.totalMs;
      if (removed.kind === "sync" && (longest.length < 16 || removed.maxMs > longest.at(-1)!.maxMs)) {
        longest.push(removed); longest.sort((a, b) => b.maxMs - a.maxMs); longest.length = Math.min(16, longest.length);
      }
      records[cursor] = record; cursor = (cursor + 1) % capacity;
      return;
    }
    records.push(record);
  };
  const begin = (site: PerformanceSite, kind: Slice["kind"], rows = 0, bytes = 0): Slice => ({
    sequence: ++sequence, span: ++spans, parent: currentSpan || context.getStore() || 0, site: siteIds.get(site)!, kind,
    start: now(), end: 0, count: 1, totalMs: 0, maxMs: 0, rows, bytes, failed: false,
    ...(correlations.getStore() ? { correlation: correlations.getStore() } : {}),
  });
  const finish = (record: Slice) => { record.end = now(); record.totalMs = record.maxMs = record.end - record.start; add(record); };
  return {
    setEnabled(value: boolean) { enabled = value; },
    observeSite(observer?: (site: number) => void) { observeSite = observer; },
    request(id: string, method: string, timeoutMs?: number) {
      if (!enabled || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
      if (requests.size >= requestCapacity) { requests.delete(requests.keys().next().value!); requestsDropped++; }
      requests.set(id, { id, method: method === "snapshot" || method === "append" || method === "wait" || method === "files" || method === "health" ? method : "other",
        start: now(), deadline: timeoutMs === undefined ? null : now() + timeoutMs, events: [] });
    },
    sync<T>(site: PerformanceSite, work: () => T, rows = 0, bytes = 0): T {
      if (!enabled) return work();
      const record = begin(site, "sync", rows, bytes);
      const parentSite = currentSite, parentSpan = currentSpan;
      currentSpan = record.span;
      currentSite = record.site; observeSite?.(currentSite);
      // A synchronous stack has no async context allocation per row.
      try { return readAttribution.sync(site, work, 0, site === "runtime.parse" ? bytes : 0, site !== "state.json" && site !== "runtime.parse"); } catch (error) { record.failed = true; throw error; }
      finally { finish(record); currentSpan = parentSpan; currentSite = parentSite; observeSite?.(currentSite); }
    },
    async wait<T>(site: PerformanceSite, work: () => Promise<T>): Promise<T> {
      if (!enabled) return work();
      const record = begin(site, "await"); pending++;
      try { return await context.run(record.span, work); }
      catch (error) { record.failed = true; throw error; }
      finally { pending--; finish(record); }
    },
    event(site: PerformanceSite, correlation?: string, bytes = 0, failed = false) {
      if (!enabled) return;
      const record = begin(site, "event", 0, bytes);
      // Only locally generated random request ids may cross the journal boundary.
      if (correlation && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(correlation)) record.correlation = correlation;
      record.failed = failed; finish(record);
      const request = correlation ? requests.get(correlation) : undefined;
      if (request) {
        if (request.events.length === 16) { request.events.shift(); requestsDropped++; }
        request.events.push({ site: record.site, at: record.end, bytes, failed });
      }
    },
    correlate<T>(id: string, work: () => T): T {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? correlations.run(id, work) : work();
    },
    snapshot(since = -Infinity) {
      return { records: [...longest, ...records].filter(row => row.end >= since).map(row => ({ ...row })), pending, dropped, droppedMs };
    },
    requests() {
      const cutoff = now() - 60_000;
      for (const [id, request] of requests) if (request.start < cutoff) { requests.delete(id); requestsDropped++; }
      const rows = [...requests.values()];
      return { dropped: requestsDropped, omitted: Math.max(0, rows.length - 16), records: rows.slice(-16) };
    },
    clear() { records.length = 0; longest.length = 0; cursor = 0; dropped = 0; droppedMs = 0; },
  };
}

type ProcessIdentity = { pid: number; start: string; timeOrigin: number; revision: string | null };
const shared = globalThis as typeof globalThis & { __delegatusPerformanceSpans?: ReturnType<typeof createPerformanceSpans>; __delegatusPerformanceProcess?: ProcessIdentity };
export const performanceSpans = shared.__delegatusPerformanceSpans ??= createPerformanceSpans();
export const performanceProcess = shared.__delegatusPerformanceProcess ??= { pid: process.pid, start: randomUUID(), timeOrigin: performance.timeOrigin, revision: null as string | null };
