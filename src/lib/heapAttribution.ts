/** Process-local, bounded weak registries. Metadata never owns its target. */
export const HEAP_TRACKED_PROCESSES = 16_384;
export const HEAP_TRACKED_HOSTS = 2048;
export const HEAP_ATTRIBUTION_SITES = 256;

export function createWeakRegistry<T extends object, M>(limit: number) {
  const rows = new Map<number, { ref: WeakRef<T>; meta: M }>();
  const seen = new WeakSet<T>();
  const finalizer = new FinalizationRegistry<number>(id => rows.delete(id));
  let sequence = 0, dropped = 0;
  return {
    has: (target: T) => seen.has(target),
    add(target: T, meta: M) {
      if (seen.has(target)) return false;
      seen.add(target);
      if (rows.size >= limit) {
        for (const [id, row] of rows) if (!row.ref.deref()) { rows.delete(id); finalizer.unregister(row); }
      }
      if (rows.size >= limit) { dropped++; return false; }
      const id = ++sequence, row = { ref: new WeakRef(target), meta };
      rows.set(id, row);
      finalizer.register(target, id, row);
      return true;
    },
    visit(work: (target: T, meta: M, id: number) => void) {
      for (const [id, row] of rows) {
        const target = row.ref.deref();
        if (target) work(target, row.meta, id);
        else { rows.delete(id); finalizer.unregister(row); }
      }
    },
    dropped: () => dropped,
  };
}

export interface ProcessMetadata {
  api: string; site: string; command: string; pid: number | null;
  startedAt: number; exitedAt: number | null; exitCode: number | null; signal: string | null;
}
export interface HeapHost {
  heapAttribution(): { engine: string; events: number; eventSubscribers: number; stateSubscribers: number; queuedEvents: number };
}

export function createHeapAttribution() {
  const processes = createWeakRegistry<object, ProcessMetadata>(HEAP_TRACKED_PROCESSES);
  const hosts = createWeakRegistry<HeapHost, null>(HEAP_TRACKED_HOSTS);
  const sites = new Map<string, string>();
  let siteOverflow = 0;
  return {
    processes, hosts,
    site(stack: string) {
      // Keep only a repository location. Raw stacks can carry home paths.
      // Bun production source maps resolve to src; keep a compiled chunk
      // location when a deployment has no source maps.
      const location = stack.split("\n").find(line =>
        !/[\\/](?:heapAttribution|processAttribution)\.ts:/.test(line) && !line.includes("node_modules") && /(?:[/\\]src[/\\]|[/\\]\.next[/\\]server[/\\]|[/\\]bin[/\\])/.test(line));
      const match = location?.match(/(?:[/\\])((?:src|bin|\.next[/\\]server)[/\\][^\s)]+:\d+:\d+)/);
      const site = match?.[1]?.replaceAll("\\", "/").slice(0, 240) ?? "unknown";
      const cached = sites.get(site);
      if (cached) return cached;
      if (sites.size >= HEAP_ATTRIBUTION_SITES) { siteOverflow++; return "other-sites"; }
      sites.set(site, site);
      return site;
    },
    snapshot(now = Date.now(), details = true) {
      const groups = new Map<string, { api: string; site: string; running: number; exited: number; oldestExitedAgeMs: number; commands: string[] }>();
      const oldest: ProcessMetadata[] = [];
      let running = 0, exited = 0;
      processes.visit((target, meta) => {
        const signal = (target as { signalCode?: string | null }).signalCode;
        if (signal) meta.signal = signal;
        const key = `${meta.api}:${meta.site}`;
        let row = groups.get(key);
        if (!row) { row = { api: meta.api, site: meta.site, running: 0, exited: 0, oldestExitedAgeMs: 0, commands: [] }; groups.set(key, row); }
        if (details && row.commands.length < 8 && !row.commands.includes(meta.command)) row.commands.push(meta.command);
        if (meta.exitedAt === null) { row.running++; running++; }
        else { row.exited++; exited++; row.oldestExitedAgeMs = Math.max(row.oldestExitedAgeMs, now - meta.exitedAt); }
        if (details) {
          oldest.push({ ...meta });
          oldest.sort((a, b) => a.startedAt - b.startedAt);
          if (oldest.length > 32) oldest.pop();
        }
      });
      const byEngine: Record<string, { hosts: number; events: number; eventSubscribers: number; stateSubscribers: number; queuedEvents: number }> = {};
      const hostRows: { id: number; engine: string; events: number; eventSubscribers: number; stateSubscribers: number; queuedEvents: number }[] = [];
      let hostCount = 0;
      hosts.visit((host, _meta, id) => {
        const counts = host.heapAttribution();
        const row = byEngine[counts.engine] ??= { hosts: 0, events: 0, eventSubscribers: 0, stateSubscribers: 0, queuedEvents: 0 };
        row.hosts++; hostCount++;
        row.events += counts.events; row.eventSubscribers += counts.eventSubscribers; row.stateSubscribers += counts.stateSubscribers; row.queuedEvents += counts.queuedEvents;
        if (details) hostRows.push({ id, ...counts });
      });
      hostRows.sort((a, b) => b.events + b.queuedEvents - a.events - a.queuedEvents);
      return {
        processes: { running, exited, groups: [...groups.values()].sort((a, b) => b.running + b.exited - a.running - a.exited).slice(0, details ? Infinity : 64), omittedGroups: details ? 0 : Math.max(0, groups.size - 64), oldest, dropped: processes.dropped(), siteOverflow, limit: HEAP_TRACKED_PROCESSES },
        hosts: { count: hostCount, byEngine, largest: hostRows.slice(0, 256), omittedDetails: details ? Math.max(0, hostCount - 256) : hostCount, dropped: hosts.dropped(), limit: HEAP_TRACKED_HOSTS },
      };
    },
  };
}

// Next's instrumentation and route bundles can live in separate global realms.
const shared = process as typeof process & { __delegatusHeapAttribution?: ReturnType<typeof createHeapAttribution> };
export const heapAttribution = shared.__delegatusHeapAttribution ??= createHeapAttribution();
