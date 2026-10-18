import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonDurably } from "@/lib/state/durableJson";

// Diagnostic inventories only. Removal and quarantine always inspect afresh.
const DAY = 86_400_000;
export const SWEEP_CACHE_TREES = 2_048;
export const SWEEP_CACHE_ENTRIES = 200_000;
export const SWEEP_WATCH_DIRECTORIES = 32_768;
const MAX_BYTES = 24 * 1024 * 1024;
/** In walk order: inode identity, allocated bytes, parent row (-1 for root). */
export type Allocation = [string, number, number];
type Entry = { key: string; at: number; allocation?: Allocation[]; candidates?: string[]; candidateClock?: string; allocationClock?: string };
type Watch = { watchers: fs.FSWatcher[]; generation: number; identity: string; directories: number };

/** One leased worker owns the cache and every directory observer. A new owner
 * invalidates persisted observations: no filesystem change journal spans its
 * downtime. The last persisted report remains the display bootstrap.
 * Watch failures disable reuse; expiry also bounds missed/coalesced events.
 */
export class WorktreeSweepCache {
  private readonly owner = randomUUID();
  private readonly rows = new Map<string, Entry>();
  private readonly watches = new Map<string, Watch>();
  private entries = 0;
  private watchDirectories = 0;
  private generation = 0;
  readonly stats = { allocationHits: 0, allocationMisses: 0, discoveryHits: 0, discoveryMisses: 0 };
  constructor(private readonly file: string, private readonly now = Date.now,
    private readonly watch: typeof fs.watch = fs.watch,
    private readonly bounds: { trees: number; entries: number; bytes: number; directories?: number } = { trees: SWEEP_CACHE_TREES, entries: SWEEP_CACHE_ENTRIES, bytes: MAX_BYTES }) {
    try {
      if (fs.statSync(file).size > this.bounds.bytes) return;
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved?.version !== 1 || !Array.isArray(saved.rows) || saved.rows.length > this.bounds.trees) return;
      for (const [directory, row] of saved.rows as [string, Entry][]) {
        if (typeof directory !== "string" || !row || typeof row.key !== "string" || !Number.isFinite(row.at)) continue;
        if (row.allocation && (!Array.isArray(row.allocation) || row.allocation.some(item => !Array.isArray(item)
          || item.length !== 3 || typeof item[0] !== "string" || !Number.isFinite(item[1]) || item[1] < 0 || !Number.isSafeInteger(item[2])))) continue;
        const count = row.allocation?.length ?? 0;
        if (this.entries + count > this.bounds.entries) break;
        this.rows.set(directory, row);
        this.entries += count;
      }
    } catch { /* Rebuild a missing, old or corrupt diagnostic cache. */ }
  }

  private forget(directory: string) {
    this.entries -= this.rows.get(directory)?.allocation?.length ?? 0;
    this.rows.delete(directory);
    const watch = this.watches.get(directory);
    for (const watcher of watch?.watchers ?? []) watcher.close();
    this.watchDirectories -= watch?.directories ?? 0;
    this.watches.delete(directory);
  }

  private key(directory: string): string | null {
    try {
      const stat = fs.lstatSync(directory, { bigint: true });
      const target = fs.statSync(directory, { bigint: true });
      const identity = `${stat.dev}:${stat.ino}:${target.dev}:${target.ino}:${fs.realpathSync(directory)}`;
      let observer = this.watches.get(directory);
      if (observer && observer.identity !== identity) { this.forget(directory); observer = undefined; }
      if (!observer) {
        while (this.watches.size >= this.bounds.trees) this.forget(this.watches.keys().next().value!);
        const plan = directoryWatchSet(directory, (this.bounds.directories ?? SWEEP_WATCH_DIRECTORIES) - this.watchDirectories);
        if (plan === null) return null;
        observer = { watchers: [], generation: ++this.generation, identity, directories: plan.length };
        this.watchDirectories += plan.length;
        this.watches.set(directory, observer);
        const watched = observer;
        const invalidate = () => { if (this.watches.get(directory) === watched) this.forget(directory); };
        for (const item of plan) {
          const watcher = this.watch(item.directory, { recursive: false, persistent: false }, invalidate);
          observer.watchers.push(watcher);
          watcher.on("error", invalidate);
        }
        // A directory added during installation has no observer yet. Refuse
        // that partial plan; every planned parent must retain its identity.
        if (plan.some(item => watchStamp(item.directory) !== item.stamp)) { this.forget(directory); return null; }
      }
      return `${this.owner}:${observer.generation}:${identity}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch { this.forget(directory); return null; }
  }

  private current(directory: string): Entry | null {
    const observed = this.key(directory);
    if (!observed) return null;
    const key = observed;
    let row = this.rows.get(directory);
    if (!row || row.key !== key || this.now() < row.at || this.now() - row.at >= DAY) {
      this.entries -= row?.allocation?.length ?? 0;
      row = { key, at: this.now() };
    }
    // LRU: the next pass naturally retires paths no longer in its kept set.
    this.rows.delete(directory);
    this.rows.set(directory, row);
    while (this.rows.size > this.bounds.trees) this.forget(this.rows.keys().next().value!);
    return row;
  }

  candidates(directory: string, clock: string, inspect: () => string[]): string[] {
    const row = this.current(directory);
    if (row?.candidates && row.candidateClock === clock) { this.stats.discoveryHits++; return row.candidates; }
    this.stats.discoveryMisses++;
    const result = inspect();
    if (row && result.length <= 2_048 && Buffer.byteLength(JSON.stringify(result)) <= 16_384) { row.candidates = result; row.candidateClock = clock; }
    return result;
  }

  async allocation(directory: string, clock: string, excluded: readonly string[], seen: Set<string>,
    fallback: () => Promise<number>): Promise<number> {
    const row = this.current(directory);
    const allocationClock = clock + JSON.stringify(excluded);
    let allocation = row?.allocationClock === allocationClock ? row.allocation : undefined;
    if (allocation) this.stats.allocationHits++;
    else {
      this.stats.allocationMisses++;
      const before = this.key(directory);
      const captured = await captureAllocation(directory, excluded);
      if (!captured) return fallback();
      allocation = captured;
      // Let pending observer notifications run before publishing a snapshot.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (row && before === this.key(directory) && allocation.length <= this.bounds.entries) {
        while (this.entries - (row.allocation?.length ?? 0) + allocation.length > this.bounds.entries && this.rows.size > 1)
          this.forget(this.rows.keys().next().value!);
        if (this.rows.get(directory) === row) {
          this.entries -= row.allocation?.length ?? 0;
          row.allocation = allocation;
          row.allocationClock = allocationClock;
          this.entries += allocation.length;
        }
      }
    }
    const blocked = new Set<number>();
    let bytes = 0;
    for (let i = 0; i < allocation.length; i++) {
      const [id, blocks, parent] = allocation[i];
      if (blocked.has(parent) || seen.has(id)) { blocked.add(i); continue; }
      seen.add(id);
      bytes += blocks;
    }
    return bytes;
  }

  persist() {
    // Per-field entries share a directory observer, but have different clocks.
    let value = { version: 1, owner: this.owner, rows: [...this.rows] };
    while (Buffer.byteLength(JSON.stringify(value)) + 1 > this.bounds.bytes && this.rows.size) {
      this.forget(this.rows.keys().next().value!);
      value = { version: 1, owner: this.owner, rows: [...this.rows] };
    }
    writeJsonDurably(this.file, value, { space: 0 });
  }

  close() { for (const directory of [...this.watches.keys()]) this.forget(directory); }
}

/** Same allocated-block and no-follow walk as allocatedBytes. Save inode
 * contributions so warm sweeps still deduplicate shared files, namespace
 * aliases and nested roots in the report's current order. A capped walk uses
 * the original measurement rather than caching an order-dependent bound.
 */
async function captureAllocation(directory: string, excluded: readonly string[]): Promise<Allocation[] | null> {
  const exclusions = new Set<string>();
  const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;
  for (const entry of excluded) {
    try { exclusions.add(identity(await fs.promises.stat(entry))); } catch { /* absent */ }
  }
  let root: fs.Stats;
  try { root = await fs.promises.stat(directory); } catch { return []; }
  if (exclusions.has(identity(root))) return [];
  const result: Allocation[] = [[identity(root), 0, -1]];
  const visitedDirectories = new Set([identity(root)]);
  const pending = [{ directory, parent: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(current.directory, { withFileTypes: true }); }
    catch { return null; }
    for (const entry of entries) {
      if (++visited >= 400_000) return null;
      const child = path.join(current.directory, entry.name);
      let stat: fs.Stats;
      try { stat = await fs.promises.lstat(child); } catch { return null; }
      const id = identity(stat);
      if (entry.isDirectory() && (exclusions.has(id) || visitedDirectories.has(id))) continue;
      const index = result.length;
      result.push([id, stat.blocks * 512, current.parent]);
      if (entry.isDirectory()) {
        visitedDirectories.add(id);
        pending.push({ directory: child, parent: index });
      }
    }
  }
  return result;
}


/** A fixed set of nonrecursive native observers cannot silently grow beyond
 * its budget. Any event drops the whole view; the next observation installs
 * a complete bounded set again, including newly created directories.
 */
function watchStamp(directory: string): string {
  const stat = fs.statSync(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function directoryWatchSet(directory: string, limit: number): { directory: string; stamp: string }[] | null {
  const pending = [directory];
  const result: { directory: string; stamp: string }[] = [];
  let entries = 0;
  try {
    while (pending.length) {
      if (result.length >= limit) return null;
      const current = pending.pop()!;
      result.push({ directory: current, stamp: watchStamp(current) });
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (++entries > 400_000) return null;
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    }
    return result;
  } catch { return null; }
}
