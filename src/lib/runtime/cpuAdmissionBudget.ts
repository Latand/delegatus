import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cpuAdmissionFile } from "./cpuAdmission";

const ROOTS = "LLV_CPU_WAIT_ROOTS";
export const CPU_WAIT_MAX_ENTRIES = 256;
export const CPU_WAIT_MAX_FILE_BYTES = 64 * 1024;
export const CPU_WAIT_MAX_TOTAL_BYTES = 1024 * 1024;
/** Finite recovery allowance when a legacy or damaged ledger cannot be trusted. */
export const CPU_WAIT_UNKNOWN_RECOVERY_MS = 10 * 60_000;
function roots(env: NodeJS.ProcessEnv): string[] {
  return JSON.parse(env[ROOTS] ?? "[]") as string[];
}
/** Each bounded ancestor owns a private wait ledger; nested gates report to
 * all of them. Concurrent intervals count once, and cancellation stays live. */
export function cpuWaitBudget(env: NodeJS.ProcessEnv) {
  const root = path.dirname(cpuAdmissionFile());
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(root, "budget-"));
  fs.chmodSync(dir, 0o700);
  const childEnv: NodeJS.ProcessEnv = { ...env, [ROOTS]: JSON.stringify([...roots(env), dir]) };
  return {
    directory: dir,
    env: childEnv,
    // Other callers use this to report or schedule their own command budget.
    // Unknown accounting must not escape those process entry points; the
    // publication watchdog calls the strict reader directly and applies its
    // finite unknown-accounting recovery window.
    elapsed: () => {
      try { return cpuWaitElapsed(dir); }
      catch { return 0; }
    },
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
export function cpuWaitElapsed(
  dir: string,
  now = Date.now(),
  maxEntries = CPU_WAIT_MAX_ENTRIES,
  maxTotalBytes = CPU_WAIT_MAX_TOTAL_BYTES,
): number {
  const intervals: [number, number][] = [];
  const directory = fs.opendirSync(dir);
  let entries = 0, totalBytes = 0;
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      if (++entries > maxEntries) throw new Error("CPU wait accounting exceeds the observation bound");
      const name = entry.name;
      if (!name.endsWith(".json")) continue;
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(path.join(dir, name), "r");
        const size = fs.fstatSync(descriptor).size;
        if (size > CPU_WAIT_MAX_FILE_BYTES || totalBytes + size > maxTotalBytes) {
          throw new Error("CPU wait accounting exceeds the byte observation bound");
        }
        const buffer = Buffer.alloc(Math.min(size + 1, CPU_WAIT_MAX_FILE_BYTES + 1));
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        if (bytesRead > CPU_WAIT_MAX_FILE_BYTES || totalBytes + bytesRead > maxTotalBytes) {
          throw new Error("CPU wait accounting exceeds the byte observation bound");
        }
        totalBytes += bytesRead;
        const contents = buffer.toString("utf8", 0, bytesRead);
        const row = JSON.parse(contents) as { start: number; end: number };
        if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.end < row.start) {
          throw new Error("CPU wait accounting contains an invalid interval");
        }
        intervals.push([row.start, Math.min(now, row.end)]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Atomic cancellation cleanup.
        throw error;
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
  } finally { directory.closeSync(); }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, end = 0;
  for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return total;
}
/** The nearest plan owns this deadline; older sibling waits are not credited
 * to a fresh invocation. Every ancestor receives its own interval markers. */
export function cpuInheritedWaitMs(env = process.env): number {
  const directories = roots(env);
  if (!directories.length) return 0;
  try { return cpuWaitElapsed(directories.at(-1)!); }
  catch { return 0; } // Unknown accounting cannot extend an owned command's deadline.
}
/** Heartbeats end stale intervals even if a waiting process is hard-killed. */
export function reportCpuWait(env = process.env) {
  const requiredRoots = roots(env);
  const directories = [...new Set([...requiredRoots, ...(env.LLV_RECORDED_CHECK_WAIT_ROOT ? [env.LLV_RECORDED_CHECK_WAIT_ROOT] : [])])];
  const files = directories.map(dir => path.join(dir, `${randomUUID()}.json`));
  const start = Date.now();
  const write = (end: number, closed = false) => {
    for (const file of files) {
      try { fs.writeFileSync(`${file}.next`, JSON.stringify({ start, end, closed }), { mode: 0o600 }); fs.renameSync(`${file}.next`, file); }
      catch (error) {
        const optionalAccounting = path.dirname(file) === env.LLV_RECORDED_CHECK_WAIT_ROOT && !requiredRoots.includes(path.dirname(file));
        if (!optionalAccounting && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  write(start);
  const timer = setInterval(() => write(Date.now()), 25);
  return () => { clearInterval(timer); write(Date.now(), true); };
}

/** Execution time excludes queue waits, without disabling finite deadlines. */
export function cpuBudgetTimer(timeoutMs: number, waited: () => number, expire: () => void): () => void {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    let waitedMs = 0;
    try { waitedMs = waited(); } catch { /* Fail closed to wall-clock execution time. */ }
    const remaining = timeoutMs - (Date.now() - start - waitedMs);
    if (remaining <= 0) expire();
    else timer = setTimeout(check, Math.min(100, remaining));
  };
  timer = setTimeout(check, Math.min(100, timeoutMs));
  return () => clearTimeout(timer);
}
