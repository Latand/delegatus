import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_ATTEMPT_TMP_BYTES = 8 * 1024 ** 3;
const JOURNAL = "attempt-tmp-sandboxes.ndjson";
const MAX_JOURNAL_BYTES = 1024 ** 2;
type Allocation = { directory: string; dev: number; ino: number };

function attemptRoot(env: NodeJS.ProcessEnv): string | null {
  const root = env.LLV_ATTEMPT_TIMING_ROOT;
  if (!root) return null;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== env.LLV_ATTEMPT_TIMING_ROOT_IDENTITY)
    throw new Error("attempt tmp: root identity changed; refusing admission");
  return fs.realpathSync(root);
}

function journalStat(file: string) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_JOURNAL_BYTES))
    throw new Error("attempt tmp: invalid sandbox allocation journal; refusing admission");
  return stat;
}

/** Gate isolation can allocate outside attempt/tmp to stay outside live state.
 * Persist those allocations under the attempt, across runners and restarts.
 * Missing directories have been removed by their existing cleanup owner. */
export function recordAttemptTmpAllocation(directory: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = attemptRoot(env);
  if (!root) return directory;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attempt tmp: invalid sandbox allocation");
  const allocation: Allocation = { directory: fs.realpathSync(directory), dev: stat.dev, ino: stat.ino };
  const tmp = path.join(root, "tmp");
  if (allocation.directory === tmp || allocation.directory.startsWith(tmp + path.sep)) return directory;
  const file = path.join(root, JOURNAL);
  journalStat(file);
  fs.appendFileSync(file, JSON.stringify(allocation) + "\n", { mode: 0o600 });
  return directory;
}

/** Admission limit for the entire attempt, even after HOME/TMPDIR isolation.
 * Count allocated blocks once per inode and never follow dependency symlinks.
 * Re-read disk on every call so a restarted gate cannot reset the allowance. */
export function checkAttemptTmpBudget(env: NodeJS.ProcessEnv = process.env, warn = console.error): number | null {
  const root = attemptRoot(env);
  if (!root) return null; // Commands outside a stage have no attempt budget.
  const cap = env.LLV_ATTEMPT_TMP_MAX_BYTES === undefined ? DEFAULT_ATTEMPT_TMP_BYTES : Number(env.LLV_ATTEMPT_TMP_MAX_BYTES);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("attempt tmp: LLV_ATTEMPT_TMP_MAX_BYTES must be a positive integer");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== env.LLV_ATTEMPT_TIMING_ROOT_IDENTITY)
    throw new Error("attempt tmp: root identity changed; refusing admission");
  const tmp = path.join(root, "tmp"), tmpStat = fs.lstatSync(tmp);
  if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) throw new Error("attempt tmp: temporary directory is not an owned directory");
  const allocations = new Map<string, Allocation>();
  const journal = path.join(root, JOURNAL);
  if (journalStat(journal)) {
    for (const line of fs.readFileSync(journal, "utf8").split("\n").filter(Boolean)) {
      let row: Allocation;
      try { row = JSON.parse(line) as Allocation; }
      catch { throw new Error("attempt tmp: invalid sandbox allocation journal; refusing admission"); }
      if (!row || typeof row.directory !== "string" || !path.isAbsolute(row.directory)
        || !Number.isSafeInteger(row.dev) || !Number.isSafeInteger(row.ino))
        throw new Error("attempt tmp: invalid sandbox allocation journal; refusing admission");
      allocations.set(row.directory, row);
    }
  }
  const observed = [...allocations.values()].filter(row => {
    const current = fs.lstatSync(row.directory, { throwIfNoEntry: false });
    if (!current) return false;
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== row.dev || current.ino !== row.ino
      || fs.realpathSync(row.directory) !== row.directory)
      throw new Error("attempt tmp: sandbox identity changed; refusing admission");
    return true;
  });
  const roots = [tmp, ...observed.map(row => row.directory)];
  // Count nested sandboxes only through their parent; du deduplicates hardlinks
  // across the remaining roots in this single traversal.
  const measured = [...new Set(roots)].filter(directory => !roots.some(parent => parent !== directory && directory.startsWith(parent + path.sep)));
  const result = spawnSync("du", ["-P", "-x", "-skc", "--", ...measured], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0 || !/^\d+\s/.test(result.stdout ?? "")) throw new Error("attempt tmp: allocation could not be measured; refusing admission");
  const bytes = Number(result.stdout.trim().split("\n").at(-1)!.split(/\s/)[0]) * 1024;
  const currentRoot = fs.lstatSync(root), currentTmp = fs.lstatSync(tmp);
  if (currentRoot.dev !== stat.dev || currentRoot.ino !== stat.ino || currentTmp.dev !== tmpStat.dev || currentTmp.ino !== tmpStat.ino)
    throw new Error("attempt tmp: directory identity changed during measurement");
  for (const row of observed) {
    const current = fs.lstatSync(row.directory, { throwIfNoEntry: false });
    if (!current || current.dev !== row.dev || current.ino !== row.ino || !current.isDirectory() || current.isSymbolicLink()
      || fs.realpathSync(row.directory) !== row.directory)
      throw new Error("attempt tmp: sandbox identity changed during measurement");
  }
  if (!Number.isSafeInteger(bytes)) throw new Error("attempt tmp: invalid allocation measurement");
  const message = `attempt tmp: ${bytes} allocated bytes; per-attempt limit ${cap} bytes. Reuse a shared checkout and retain only needed evidence.`;
  if (bytes > cap) throw new Error(`${message} Refusing another check/export.`);
  if (bytes >= cap * 0.9) warn(`${message} Warning: at least 90% used.`);
  return bytes;
}

if (import.meta.main) {
  try { checkAttemptTmpBudget(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 73; }
}
