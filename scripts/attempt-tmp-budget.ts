import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_ATTEMPT_TMP_BYTES = 8 * 1024 ** 3;

/** Admission limit for the entire attempt, even after HOME/TMPDIR isolation.
 * Count allocated blocks once per inode and never follow dependency symlinks.
 * Re-read disk on every call so a restarted gate cannot reset the allowance. */
export function checkAttemptTmpBudget(env: NodeJS.ProcessEnv = process.env, warn = console.error): number | null {
  const root = env.LLV_ATTEMPT_TIMING_ROOT;
  if (!root) return null; // Commands outside a stage have no attempt budget.
  const cap = env.LLV_ATTEMPT_TMP_MAX_BYTES === undefined ? DEFAULT_ATTEMPT_TMP_BYTES : Number(env.LLV_ATTEMPT_TMP_MAX_BYTES);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("attempt tmp: LLV_ATTEMPT_TMP_MAX_BYTES must be a positive integer");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== env.LLV_ATTEMPT_TIMING_ROOT_IDENTITY)
    throw new Error("attempt tmp: root identity changed; refusing admission");
  const tmp = path.join(root, "tmp"), tmpStat = fs.lstatSync(tmp);
  if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) throw new Error("attempt tmp: temporary directory is not an owned directory");
  const result = spawnSync("du", ["-P", "-x", "-sk", tmp], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0 || !/^\d+\s/.test(result.stdout ?? "")) throw new Error("attempt tmp: allocation could not be measured; refusing admission");
  const bytes = Number(result.stdout.trim().split(/\s/)[0]) * 1024;
  const currentRoot = fs.lstatSync(root), currentTmp = fs.lstatSync(tmp);
  if (currentRoot.dev !== stat.dev || currentRoot.ino !== stat.ino || currentTmp.dev !== tmpStat.dev || currentTmp.ino !== tmpStat.ino)
    throw new Error("attempt tmp: directory identity changed during measurement");
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
