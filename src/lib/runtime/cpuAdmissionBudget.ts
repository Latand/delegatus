import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cpuAdmissionFile } from "./cpuAdmission";

const ROOTS = "LLV_CPU_WAIT_ROOTS";
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
  return {
    env: { ...env, [ROOTS]: JSON.stringify([...roots(env), dir]) },
    elapsed: () => cpuWaitElapsed(dir),
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
export function cpuWaitElapsed(dir: string, now = Date.now()): number {
  const intervals: [number, number][] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { start: number; end: number };
      if (Number.isFinite(row.start) && Number.isFinite(row.end)) intervals.push([row.start, Math.min(now, row.end)]);
    } catch { /* An atomic marker may have been removed during cancellation. */ }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, end = 0;
  for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return total;
}
/** The nearest plan owns this deadline; older sibling waits are not credited
 * to a fresh invocation. Every ancestor receives its own interval markers. */
export function cpuInheritedWaitMs(env = process.env): number {
  const directories = roots(env);
  return directories.length ? cpuWaitElapsed(directories.at(-1)!) : 0;
}
/** Heartbeats end stale intervals even if a waiting process is hard-killed. */
export function reportCpuWait(env = process.env) {
  const files = roots(env).map(dir => path.join(dir, `${randomUUID()}.json`));
  const start = Date.now();
  const write = (end: number) => {
    for (const file of files) {
      try { fs.writeFileSync(`${file}.next`, JSON.stringify({ start, end }), { mode: 0o600 }); fs.renameSync(`${file}.next`, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  };
  write(start);
  const timer = setInterval(() => write(Date.now()), 25);
  return () => { clearInterval(timer); write(Date.now()); };
}

/** Execution time excludes queue waits, without disabling finite deadlines. */
export function cpuBudgetTimer(timeoutMs: number, waited: () => number, expire: () => void): () => void {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const remaining = timeoutMs - (Date.now() - start - waited());
    if (remaining <= 0) expire();
    else timer = setTimeout(check, Math.min(100, remaining));
  };
  timer = setTimeout(check, Math.min(100, timeoutMs));
  return () => clearTimeout(timer);
}
