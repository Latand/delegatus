import { statePath } from "@/lib/configDir";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempOwner, type AttemptTempState, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { pipelineRecordReader } from "@/lib/pipelines/store";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { tempSweepMode, isGateTempName, type TempSweepRoot } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import path from "node:path";
import fs from "node:fs";
import { repositoryReferencesAttemptTemp } from "./attemptTempFilesystem";

export async function attemptTempState(owner: AttemptTempOwner): Promise<AttemptTempState> {
  if (!owner.pipelineId) return "orphan";
  const reader = pipelineRecordReader(owner.pipelineId), version = reader.version();
  const pipeline = reader.read();
  if (!pipeline) return "orphan";
  if (pipeline.state === "closed") return "closed";
  const matches = (attempt: PipelineStageAttempt) => attempt.launchId === owner.launchId
    || attempt.retiredLaunches?.some(retired => retired.launchId === owner.launchId);
  const run = pipeline.runs.find(run => run.attempts.some(matches));
  const attempt = run?.attempts.find(matches);
  if (!attempt) return "unknown";
  const stage = pipeline.stages.find(stage => stage.id === run!.stageId);
  if (!path.basename(owner.directory).startsWith("llv-stage-config-")
    && (attempt.definition?.outputs?.length || stage?.outputs?.length || stage?.effectiveRole.roleId === "visual-critic")) return "live";
  if (attempt.retiredLaunches?.some(retired => retired.launchId === owner.launchId)
    || ["passed", "failed", "skipped", "needs_decision"].includes(attempt.state)) {
    if (pipeline.worktreeDir && fs.existsSync(pipeline.worktreeDir)) {
      const referenced = await repositoryReferencesAttemptTemp(pipeline.worktreeDir, owner.directory);
      if (reader.version() !== version) return "unknown";
      if (referenced) return "live";
    }
    return "settled";
  }
  return "live";
}
/** Hourly discovery borrows the existing root inventory. Only known gate
 * producers are adopted, at most 32 per pass; stage roots need lane ownership.
 * Namespace-reader aliases cannot outlive their lease and stay with the legacy
 * sweep. Each admitted root then uses indexed, point-read minute ticks. */
export async function adoptOrphanGateTemps(store: AttemptTempStore, roots: readonly TempSweepRoot[], limit = 32) {
  let adopted = 0;
  for (const root of roots) {
    if (root.via) continue;
    let names: string[];
    try { names = await fs.promises.readdir(root.path); } catch { continue; }
    const candidates = names.filter(isGateTempName).flatMap(name => {
      const directory = path.join(root.path, name);
      let stat: fs.Stats | undefined;
      try { stat = fs.lstatSync(directory, { throwIfNoEntry: false }); } catch { return []; }
      return stat?.isDirectory() && !stat.isSymbolicLink() && (process.getuid?.() === undefined || stat.uid === process.getuid())
        ? [{ directory, createdAt: stat.mtimeMs }] : [];
    }).sort((a, b) => a.createdAt - b.createdAt || a.directory.localeCompare(b.directory));
    for (const candidate of candidates) {
      if (adopted >= limit) return adopted;
      if (store.has(candidate.directory) || fs.existsSync(path.join(candidate.directory, ".delegatus-attempt-owner"))) continue;
      try {
        store.register({ ...candidate, launchId: "orphan-gate", pipelineId: null, retainUntilClose: false });
        adopted++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return adopted;
}

function setting(raw: string | undefined, fallback: number) {
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
export async function runAttemptTempSweep(ports: Pick<AttemptTempSweepOptions, "scan">, env: NodeJS.ProcessEnv = process.env) {
  const mode = tempSweepMode(env);
  if (!mode) return null;
  const store = new AttemptTempStore();
  try {
    const report = await sweepAttemptTemps(store, {
      state: attemptTempState, mode, scan: ports.scan,
      onRetired: (count, bytes) => console.log(`[attempt temp] retired ${count} directories, ${bytes} attributed bytes`),
      capBytes: setting(env.LLV_ATTEMPT_TEMP_CAP_BYTES, 100 * 1024 ** 3),
      maxAgeMs: setting(env.LLV_ATTEMPT_TEMP_MAX_AGE_DAYS, 1) * 86400000,
    });
    writeJsonDurably(statePath("attempt-temp-report.json"), { at: new Date().toISOString(), ...report });
    console.log(`[attempt temp] ${mode === "dry-run" ? "would remove" : "removed"} ${report.removed} directories, ${report.removedBytes} bytes; ${report.held} held; ${report.errors} errors; ${report.overCapBytes} measured bytes over cap`);
    return report;
  } finally { store.close(); }
}
