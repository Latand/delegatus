import { statePath } from "@/lib/configDir";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempOwner, type AttemptTempState, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { pipelineRecordReader } from "@/lib/pipelines/store";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { tempSweepMode } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import path from "node:path";
import fs from "node:fs";
import { repositoryReferencesAttemptTemp, RepositoryLinkInventory } from "./attemptTempFilesystem";

export async function attemptTempState(owner: AttemptTempOwner, inventory = new RepositoryLinkInventory()): Promise<AttemptTempState> {
  if (!owner.pipelineId) return "orphan";
  const reader = pipelineRecordReader(owner.pipelineId), version = reader.version();
  const pipeline = reader.read();
  if (!pipeline) return "orphan";
  if (pipeline.state === "closed" || pipeline.state === "completed") return "closed";
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
    if (pipeline.worktreeDir) {
      const checkout = fs.lstatSync(pipeline.worktreeDir, { throwIfNoEntry: false });
      const present = fs.existsSync(pipeline.worktreeDir);
      if (!!checkout !== present || checkout && (!checkout.isDirectory() || checkout.isSymbolicLink())) return "unknown";
      if (present && checkout) {
        const referenced = await repositoryReferencesAttemptTemp(pipeline.worktreeDir, owner.directory, owner.directory, inventory);
        const after = fs.lstatSync(pipeline.worktreeDir, { throwIfNoEntry: false });
        // A checkout that disappears or changes while its links are being
        // inventoried cannot authorize retirement. Its restored tree may now
        // contain a link omitted from the inventory snapshot.
        if (!after?.isDirectory() || after.isSymbolicLink()
          || `${after.dev}:${after.ino}` !== `${checkout.dev}:${checkout.ino}`
          || after.mtimeMs !== checkout.mtimeMs || after.ctimeMs !== checkout.ctimeMs) return "unknown";
        if (reader.version() !== version) return "unknown";
        if (referenced) return "live";
      }
    }
    return "settled";
  }
  return "live";
}
function setting(raw: string | undefined, fallback: number) {
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
type TickCondition = { mode: "on" | "dry-run"; overCap: boolean; failing: boolean };
const quiet = (mode: TickCondition["mode"]): TickCondition => ({ mode, overCap: false, failing: false });
function recordedCondition(file: string, mode: TickCondition["mode"]): TickCondition {
  try {
    const condition = JSON.parse(fs.readFileSync(file, "utf8"))?.condition;
    if (condition && typeof condition.overCap === "boolean" && typeof condition.failing === "boolean") return condition;
  } catch { /* A missing or unreadable report counts as the quiet condition. */ }
  return quiet(mode);
}

/** A minute tick reports only when it removed, held over the cap or failed,
 * or when its condition changed from the recorded report. The recorded
 * condition is on disk, so a restarted helper does not repeat itself. */
export async function runAttemptTempSweep(ports: Pick<AttemptTempSweepOptions, "scan">, env: NodeJS.ProcessEnv = process.env) {
  const mode = tempSweepMode(env);
  if (!mode) return null;
  const store = new AttemptTempStore();
  try {
    const report = await sweepAttemptTemps(store, {
      state: attemptTempState, mode, scan: ports.scan,
      maxRoots: (() => {
        try { return JSON.parse(fs.readFileSync(statePath("disk-pressure-report.json"), "utf8")).episode ? 32 : undefined; }
        catch { return undefined; }
      })(),
      onRetired: (count, bytes) => console.log(`[attempt temp] retired ${count} directories, ${bytes} attributed bytes`),
      capBytes: setting(env.LLV_ATTEMPT_TEMP_CAP_BYTES, 100 * 1024 ** 3),
      maxAgeMs: setting(env.LLV_ATTEMPT_TEMP_MAX_AGE_DAYS, 1) * 86400000,
    });
    const file = statePath("attempt-temp-report.json");
    const condition: TickCondition = { mode, overCap: report.overCapBytes > 0, failing: report.errors > 0 };
    const changed = JSON.stringify(recordedCondition(file, mode)) !== JSON.stringify(condition);
    if (report.removed || report.errors || report.deferred || report.overCapBytes || changed) {
      const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
      const summary = `Measured ${gb(report.bytes)}; cap ${gb(report.capBytes)}; ${mode === "dry-run" ? "would reclaim" : "reclaimed"} ${gb(report.removedBytes)}; `
        + `budget deferred ${gb(report.deferredBytes)}; held live ${gb(report.liveHeldBytes)}; held by evidence ${gb(report.evidenceHeldBytes)}; `
        + `other holds ${gb(report.otherHeldBytes)}; failed ${gb(report.failedBytes)}; outside this page ${gb(report.unexaminedBytes)}. `
        + "Hold categories describe this page; unexamined allocation still needs classification.";
      writeJsonDurably(file, { at: new Date().toISOString(), condition, summary, ...report });
      console.log(`[attempt temp] ${mode === "dry-run" ? "would remove" : "removed"} ${report.removed} directories, ${report.removedBytes} bytes; `
        + `${report.deferred} budget deferred (${report.deferredBytes} bytes); ${report.liveHeld} held live (${report.liveHeldBytes} bytes); `
        + `${report.evidenceHeld} held by evidence (${report.evidenceHeldBytes} bytes); ${report.held - report.liveHeld - report.evidenceHeld} other holds (${report.otherHeldBytes} bytes); `
        + `${report.errors} errors (${report.failedBytes} bytes); ${report.unexaminedBytes} bytes outside this page; ${report.overCapBytes} measured bytes over cap`);
    }
    return report;
  } finally { store.close(); }
}
