import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOOP_PROFILE_WINDOW_MS = 5000;
export const LOOP_PROFILE_ARM_MS = 30 * 60_000;
export const LOOP_PROFILE_COOLDOWN_MS = 60_000;
export const LOOP_PROFILE_BYTES = 8192;
const intervalUs = 10_000, sampleCap = 4096, depthCap = 32, frameCap = 128, topN = 16;
type Frame = { name: string; sourceURL?: string; line: number };
export type LoopProfile = { traces: { frames: Frame[] }[] };
type Summary = ReturnType<typeof trimLoopProfile>;
export type LoopGapProfile = { status: "captured"; from: number; to: number; intervalUs: number; frames: Summary } | { status: "unavailable" };
type Emit = (profile: LoopGapProfile) => void;

/** Reject external paths, URL payloads and dynamic names. Only repository code
 * locations and identifier-shaped symbols may cross the logging boundary. */
function location(frame: Frame, root: string) {
  if (!frame.sourceURL || frame.sourceURL.length > 1024 || !/^[A-Za-z_$][\w$]{0,95}$/.test(frame.name)
    || !Number.isSafeInteger(frame.line) || frame.line < 1) return null;
  let source = frame.sourceURL;
  if (source.startsWith("file:")) {
    try { const url = new URL(source); if (url.search || url.hash || url.host) return null; source = fileURLToPath(url); }
    catch { return null; }
  }
  if (!path.isAbsolute(source)) return null;
  const file = path.relative(root, source).split(path.sep).join("/");
  if (!/^(?:src|scripts|\.next\/server)\/[\w./-]+\.[cm]?[jt]sx?$/.test(file)
    || file.split("/").some(part => part === ".." || part === "node_modules")) return null;
  return { function: frame.name, file, line: frame.line };
}

/** Conversion has a fixed visit/allocation budget even when native collection
 * was unbounded. Even spacing covers the whole window; weights use visited
 * samples, including samples whose frames privacy filtering omitted. */
export function trimLoopProfile(raw: LoopProfile, root: string) {
  const frames = new Map<string, { function: string; file: string; line: number; self: number; total: number }>();
  const count = Math.min(sampleCap, raw.traces.length);
  // Misra-Gries candidates let a hot function arriving late displace earlier
  // one-off frames. Decrements consume prior increments, bounding total work.
  const candidates = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const trace = raw.traces[Math.floor(i * raw.traces.length / count)]!;
    const seen = new Set<string>();
    for (let depth = 0; depth < Math.min(depthCap, trace.frames.length); depth++) {
      const frame = location(trace.frames[depth]!, root);
      if (!frame) continue;
      const key = `${frame.file}:${frame.line}:${frame.function}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (candidates.has(key)) candidates.set(key, candidates.get(key)! + 1);
      else if (candidates.size < frameCap) candidates.set(key, 1);
      else for (const [candidate, weight] of candidates) {
        if (weight === 1) candidates.delete(candidate); else candidates.set(candidate, weight - 1);
      }
    }
  }
  // Count exact self/total weights for the surviving candidates in a second
  // bounded pass. Candidate elimination itself never fabricates weights.
  for (let i = 0; i < count; i++) {
    const trace = raw.traces[Math.floor(i * raw.traces.length / count)]!;
    const seen = new Set<string>();
    for (let depth = 0; depth < Math.min(depthCap, trace.frames.length); depth++) {
      const frame = location(trace.frames[depth]!, root);
      if (!frame) continue;
      const key = `${frame.file}:${frame.line}:${frame.function}`;
      if (!candidates.has(key)) continue;
      let row = frames.get(key);
      if (!row && frames.size < frameCap) { row = { ...frame, self: 0, total: 0 }; frames.set(key, row); }
      if (!row) continue;
      if (depth === 0) row.self++;
      if (!seen.has(key)) row.total++;
      seen.add(key);
    }
  }
  const rank = (a: { self: number; total: number; file: string; line: number; function: string }, b: typeof a) =>
    b.self - a.self || b.total - a.total || a.file.localeCompare(b.file) || a.line - b.line || a.function.localeCompare(b.function);
  const rows = [...frames.values()].sort(rank).slice(0, topN).map(row => ({ ...row,
    selfWeight: row.self / (count || 1), totalWeight: row.total / (count || 1) }));
  const result = { samples: raw.traces.length, inspectedSamples: count, sampleCap, depthCap, frameCap, topN, rows };
  // Reserve space for the enclosing window metadata too. Count UTF-8 bytes.
  while (Buffer.byteLength(JSON.stringify(result)) > LOOP_PROFILE_BYTES - 512 && rows.length) rows.pop();
  return result;
}

export interface LoopProfilerPorts {
  now(): number;
  enabled(): Promise<boolean>;
  collect(work: () => Promise<void>, intervalUs: number): Promise<{ stackTraces: unknown }>;
  sleep(ms: number): Promise<void>;
  flushTick(): void;
  phase<T>(phase: "collect" | "trim" | "settings", work: () => T): T;
  root: string;
}

/** One owner per Viewer monitor; no runtime-host start path calls this. */
export function createLoopProfiler(ports: LoopProfilerPorts, expires: number) {
  let stopped = false, started = false;
  let window: { from: number; pending: Emit[] } | undefined;
  const enabled = async () => !stopped && ports.now() < expires && await ports.phase("settings", ports.enabled)
    && !stopped && ports.now() < expires;
  const capture = async () => {
    if (!await enabled()) return null;
    const current = window = { from: ports.now(), pending: [] as Emit[] };
    let long = false;
    try {
      const raw = await ports.phase("collect", () => ports.collect(() => ports.sleep(Math.min(LOOP_PROFILE_WINDOW_MS, expires - ports.now())), intervalUs));
      // A profile timer can recover before the monitor's timer. Observe that
      // recovery while this window still owns its pending gap records.
      ports.flushTick();
      const to = ports.now();
      long = to - current.from > LOOP_PROFILE_WINDOW_MS + 250 || current.pending.length > 0;
      // No qualifying gap: do not access, walk or retain stackTraces.
      if (current.pending.length) {
        const frames = ports.phase("trim", () => trimLoopProfile(raw.stackTraces as LoopProfile, ports.root));
        for (const emit of current.pending) emit({ status: "captured", from: current.from, to, intervalUs, frames });
      }
    } catch {
      stopped = true;
      for (const emit of current.pending) emit({ status: "unavailable" });
    } finally { window = undefined; }
    return long;
  };
  return {
    correlate(from: number, to: number, gapMs: number, emit: Emit) {
      if (!window || gapMs < 2000 || to < window.from || from > ports.now() || window.pending.length >= 4) return false;
      window.pending.push(emit);
      return true;
    },
    async start() {
      if (started) return;
      started = true;
      while (!stopped && ports.now() < expires) {
        const long = await capture();
        if (long === null || stopped) break;
        // The kill switch is read again after this wait, before any collection.
        if (long) {
          if (!await enabled()) break;
          await ports.sleep(Math.min(LOOP_PROFILE_COOLDOWN_MS, Math.max(0, expires - ports.now())));
        }
      }
    },
    stop() { stopped = true; },
  };
}
