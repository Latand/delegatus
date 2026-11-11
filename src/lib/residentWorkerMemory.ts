/*
 * One memory ceiling for resident workers: helper processes that stay alive
 * between requests and keep caches in their heap. A worker whose resident set
 * passed its limit goes through its ordinary retirement between two requests,
 * and the next request starts a fresh process. The decision lives here so
 * every worker shares one override, one guard against spawn loops and one
 * journal line.
 *
 * This module imports nothing from the application: a worker entry and the
 * Viewer side of a worker can both use it.
 *
 *   Worker side (the worker knows when it is between requests):
 *     if (residentWorkerOverLimit("my-worker", { defaultLimitBytes, served })) retireNormally();
 *
 *   Viewer side (the worker reports `rssBytes` with each reply):
 *     if (residentWorkerOverLimit("my-worker", { defaultLimitBytes, served, rssBytes, pid })) retire(worker);
 */

const MIB = 1024 * 1024;

/** One override for every resident worker, in MiB. `0` turns the ceiling off. */
export const RESIDENT_WORKER_RSS_LIMIT_ENV = "LLV_RESIDENT_WORKER_RSS_LIMIT_MB";

/** The limit in bytes: the override when it is a valid number, else the
    worker's own default. Null means no ceiling. */
export function residentWorkerRssLimitBytes(
  defaultLimitBytes: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  const raw = env[RESIDENT_WORKER_RSS_LIMIT_ENV]?.trim();
  if (!raw) return defaultLimitBytes;
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes < 0) return defaultLimitBytes;
  return megabytes === 0 ? null : Math.floor(megabytes * MIB);
}

/** This process's resident set in bytes, or 0 where the runtime cannot tell. */
export function residentWorkerRssBytes(): number {
  try { return process.memoryUsage().rss; } catch { return 0; }
}

export type ResidentWorkerMemoryCheck = {
  /** The worker's own limit, chosen from its measured steady state. */
  defaultLimitBytes: number;
  /** Requests this worker process has completed. A process that served none
      is never retired for memory, so a limit below the start size of the
      worker still lets every process answer a request. */
  served: number;
  /** The worker's resident set. Defaults to this process: pass the reported
      value when the Viewer decides for a child. */
  rssBytes?: number;
  /** The worker's pid for the journal line. Defaults to this process. */
  pid?: number;
  env?: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
};

/**
 * True when the worker must retire now. Call it only between requests, and
 * retire through the worker's ordinary path when it answers true. Each true
 * answer writes one journal line.
 */
export function residentWorkerOverLimit(name: string, check: ResidentWorkerMemoryCheck): boolean {
  if (check.served < 1) return false;
  const limitBytes = residentWorkerRssLimitBytes(check.defaultLimitBytes, check.env);
  if (limitBytes === null) return false;
  const rssBytes = check.rssBytes ?? residentWorkerRssBytes();
  if (!Number.isFinite(rssBytes) || rssBytes <= limitBytes) return false;
  (check.log ?? console.warn)(`[resident worker] retired: memory limit ${JSON.stringify({
    name, pid: check.pid ?? process.pid, rssBytes, limitBytes, served: check.served,
  })}`);
  return true;
}
