import { readFileSync } from "node:fs";
import path from "node:path";
import { procBackend } from "../src/lib/proc";
import { parseMeminfo } from "../src/lib/proc/memory";

const MIB = 1024 * 1024;
const HEADROOM_MIB = 2048;
const MEMORY_WAIT_MS = 60_000;

export function publicationMemoryBytes(nodeOptions = ""): number {
  // Keep the default 11 GiB even when the caller selects a smaller heap.
  // A larger explicit old-space limit also needs room for native allocations.
  const limits = nodeOptions.matchAll(/(?:^|\s)"?--max[-_]old[-_]space[-_]size(?:=|\s+)"?(\d+)"?(?=\s|$)/g);
  const heapMiB = Math.max(11_264, ...[...limits].map(match => Number(match[1])));
  return (heapMiB + HEADROOM_MIB) * MIB;
}

type Headroom = { available: number; capacity: number };

function read(file: string): string | undefined {
  try { return readFileSync(file, "utf8").trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function publicationHeadroom(env = process.env): Headroom | null {
  try {
    const proc = env.LLV_GATE_PROC_ROOT ?? "/proc";
    const host = parseMeminfo(read(path.join(proc, "meminfo")) ?? "");
    let capacity = host?.ramTotal ?? Infinity;
    let available = host?.ramAvailable ?? Infinity;
    const root = path.resolve(env.LLV_GATE_CGROUP_ROOT ?? "/sys/fs/cgroup");
    const member = /^0::(\/[^\n]*)$/m.exec(read(env.LLV_GATE_CGROUP_FILE ?? path.join(proc, "self/cgroup")) ?? "")?.[1] ?? "/";
    // A leaf may be unlimited while an ancestor has the effective limit.
    for (let group = path.join(root, path.posix.resolve(member)); ; group = path.dirname(group)) {
      const max = read(path.join(group, "memory.max"));
      if (max !== undefined && max !== "max") {
        const current = read(path.join(group, "memory.current"));
        if (!/^\d+$/.test(max) || current === undefined || !/^\d+$/.test(current)
          || !Number.isSafeInteger(Number(max)) || !Number.isSafeInteger(Number(current))) return null;
        capacity = Math.min(capacity, Number(max));
        available = Math.min(available, Math.max(0, Number(max) - Number(current)));
      }
      if (group === root) break;
    }
    return Number.isFinite(available) ? { available, capacity } : null;
  } catch { return null; }
}

export async function waitForPublicationMemory(required: number, say: (line: string) => void,
  probe = publicationHeadroom, now = () => performance.now(), pause = Bun.sleep): Promise<boolean> {
  const until = now() + MEMORY_WAIT_MS;
  let waiting = false;
  for (;;) {
    const memory = probe();
    if (memory && memory.available >= required) return now() <= until;
    const remaining = until - now();
    if (remaining <= 0 || (memory && memory.capacity < required)) return false;
    if (!waiting) {
      say(`pre-push: waiting for publication memory (${required / MIB} MiB required)`);
      waiting = true;
    }
    await pause(Math.min(remaining, 1_000));
  }
}

/** Track the concurrent RSS of the portable preparation and its descendants.
 * Sampled RSS can miss short peaks and counts shared pages per process. */
export function samplePublicationRss() {
  let peak = 0;
  const sample = () => {
    const children = new Map<number, number[]>();
    for (const [pid, parent] of procBackend.ppidMap()) {
      const siblings = children.get(parent);
      if (siblings) siblings.push(pid);
      else children.set(parent, [pid]);
    }
    const owned = [process.pid];
    for (const pid of owned) for (const child of children.get(pid) ?? []) owned.push(child);
    let rss = 0;
    for (const usage of procBackend.processMemory(owned).values()) rss += usage.rssBytes;
    peak = Math.max(peak, rss);
    return peak || undefined;
  };
  const timer = setInterval(sample, 250);
  timer.unref();
  return { sample, close: () => clearInterval(timer) };
}
