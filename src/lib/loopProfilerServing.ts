import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "./configDir";
import { withFileTransaction } from "./state/fileTransaction";
import { createLoopProfiler, LOOP_PROFILE_ARM_MS } from "./loopProfiler";
import type { createViewerLoopMonitor } from "./viewerLoopMonitor";

/** Tiny diagnostic settings/ledger reads cannot materialize arbitrary files. */
async function readSmall(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(513);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 512) throw new Error("oversized profiler configuration");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

/** Armed by default: only a settings file that explicitly holds
 * {"enabled": false} switches the profiler off. An absent or unreadable file
 * leaves it on. */
export async function loopProfilerEnabled(directory: string) {
  try { return (await readSmall(path.join(directory, "loop-profiler.json")))?.enabled !== false; }
  catch { return true; }
}

/** Read the duration once per deploy; later file reads only check the kill switch. */
export async function loopProfilerSettings(directory: string, report = (message: string) => console.warn(message)) {
  let settings;
  try { settings = await readSmall(path.join(directory, "loop-profiler.json")); }
  catch { return { enabled: true, armMs: LOOP_PROFILE_ARM_MS }; }
  const minutes = settings?.armMinutes;
  let armMs = LOOP_PROFILE_ARM_MS;
  if (minutes !== undefined) {
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 30 && minutes <= 120) armMs = minutes * 60_000;
    else report("[loop-profiler] invalid armMinutes; expected a number from 30 to 120; using 30 minutes");
  }
  return { enabled: settings?.enabled !== false, armMs };
}

/** Native compiled fixture target; kept beside the serving recorder so the
 * verification can sample a callable emitted into the production bundle. */
export function syntheticThreeSecondBlockForProfilerFixture() {
  const until = performance.now() + 3000;
  let value = 0;
  while (performance.now() < until) value += Math.sqrt(value + 1) % 123;
  return value;
}

/** First start of a deployed revision consumes its opportunity even if the
 * kill switch is set.
 * Same-revision restarts cannot renew the in-memory arm budget. */
export async function claimLoopProfilerDeploy(directory: string, revision: string, at: number) {
  if (!/^[a-f0-9]{7,40}$/.test(revision)) return false;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const ledger = path.join(directory, "loop-profiler-deploy.json");
  return withFileTransaction(ledger, "profiler deploy ledger busy", async () => {
    try { if ((await readSmall(ledger)).revision === revision) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    // A fixed sibling under the transaction lock, atomic across a crash.
    const temporary = `${ledger}.next`;
    await fs.writeFile(temporary, JSON.stringify({ revision, startedAt: at }), { mode: 0o600 });
    await fs.rename(temporary, ledger);
    return true;
  });
}

export async function startServingLoopProfiler(monitor: ReturnType<typeof createViewerLoopMonitor>, env = process.env) {
  if (env.LLV_STATE_OWNER !== "viewer" || env.NODE_ENV !== "production" || !process.versions.bun || env.NEXT_PHASE?.includes("build")) return;
  const revision = [env.LLV_DIAGNOSTIC_REVISION, env.LLV_HOT_STATE_RELEASE_REVISION].find(value => value && /^[a-f0-9]{7,40}$/.test(value)) ?? "";
  if (!/^[a-f0-9]{7,40}$/.test(revision)) return;
  const startedAt = performance.now();
  const directory = path.dirname(statePath("loop-profiler.json"));
  // Diagnostic refusal must never stop serving. No raw errors or paths log.
  try {
    const claimed = await monitor.run("loop-profiler.settings", () => claimLoopProfilerDeploy(directory, revision, Date.now()));
    if (!claimed) return;
    const settings = await monitor.run("loop-profiler.settings", () => loopProfilerSettings(directory));
    if (!settings.enabled) return;
    const expires = startedAt + settings.armMs;
    // Next leaves the Bun builtin to the serving interpreter. No other process
    // imports the profiler, and a disabled startup never loads it.
    const { profile } = await monitor.run("loop-profiler.settings", () => import(/* webpackIgnore: true */ "bun:jsc"));
    const recorder = createLoopProfiler({ now: () => performance.now(),
      enabled: () => loopProfilerEnabled(directory), collect: (work, interval) => profile(work, interval),
      sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); }),
      flushTick: () => monitor.tick(), root: process.cwd(),
      phase: (phase, work) => monitor.run(`loop-profiler.${phase}`, work),
    }, expires);
    monitor.setProfiler(recorder);
    await recorder.start();
  } catch { /* Fail closed: serving and the existing monitor remain available. */ }
}
