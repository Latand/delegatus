import { attemptTempRemaining } from "./attemptTempDeadline";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { statePath } from "@/lib/configDir";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempAuthority, type AttemptTempOwner, type AttemptTempState, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { pipelineRecordReader } from "@/lib/pipelines/store";
import { laneFinish, FINISHED_LANE_RETENTION_MS } from "@/lib/pipelines/laneFinish";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { tempSweepMode } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import path from "node:path";
import fs from "node:fs";
import { repositoryReferencesAttemptTemp, RepositoryLinkInventory, type RetainedCheckoutReads } from "./attemptTempFilesystem";
import { sweepEvidenceCopies } from "./attemptEvidenceCopies";

/** The sweep helper serves every minute tick from one process. */
const checkoutReads: RetainedCheckoutReads = new Map();

export async function attemptTempAuthority(owner: AttemptTempOwner, inventory = new RepositoryLinkInventory(), now = Date.now, retentionMs = FINISHED_LANE_RETENTION_MS): Promise<AttemptTempAuthority> {
  if (!owner.pipelineId) return { state: "orphan", revision: "", isCurrent: () => true };
  const reader = pipelineRecordReader(owner.pipelineId), version = reader.version();
  const observed = (state: AttemptTempState, expiresAt: number | null = null): AttemptTempAuthority => ({ state, expiresAt, revision: version,
    isCurrent: () => reader.version() === version && (state !== "expired" || expiresAt !== null && now() >= expiresAt) });
  const pipeline = reader.read();
  if (!pipeline) return observed("orphan");
  const matches = (attempt: PipelineStageAttempt) => attempt.launchId === owner.launchId
    || attempt.retiredLaunches?.some(retired => retired.launchId === owner.launchId);
  const run = pipeline.runs.find(run => run.attempts.some(matches));
  const attempt = run?.attempts.find(matches);
  if (attempt?.launchId === owner.launchId && attempt.state === "running") return observed("live");
  if (pipeline.state === "closed" || pipeline.state === "completed") {
    const finish = laneFinish(pipeline, retentionMs);
    if (!finish.finished) return observed("live");
    return observed(now() >= finish.expiresAt ? "expired" : "closed", finish.expiresAt);
  }
  if (!attempt) return observed("unknown");
  const stage = pipeline.stages.find(stage => stage.id === run!.stageId);
  if (!path.basename(owner.directory).startsWith("llv-stage-config-")
    && (attempt.definition?.outputs?.length || stage?.outputs?.length || stage?.effectiveRole.roleId === "visual-critic")) return observed("live");
  if (attempt.retiredLaunches?.some(retired => retired.launchId === owner.launchId)
    || ["passed", "failed", "skipped", "needs_decision"].includes(attempt.state)) {
    if (pipeline.worktreeDir) {
      const checkout = fs.lstatSync(pipeline.worktreeDir, { throwIfNoEntry: false });
      const present = fs.existsSync(pipeline.worktreeDir);
      if (!present || !checkout?.isDirectory() || checkout.isSymbolicLink()) return observed("unknown");
      const referenced = await repositoryReferencesAttemptTemp(pipeline.worktreeDir, owner.directory, owner.directory, inventory);
      const after = fs.lstatSync(pipeline.worktreeDir, { throwIfNoEntry: false });
      // A checkout that disappears or changes while its links are being
      // inventoried cannot authorize retirement. Its restored tree may now
      // contain a link omitted from the inventory snapshot.
      if (!after?.isDirectory() || after.isSymbolicLink()
        || `${after.dev}:${after.ino}` !== `${checkout.dev}:${checkout.ino}`
        || after.mtimeMs !== checkout.mtimeMs || after.ctimeMs !== checkout.ctimeMs) return observed("unknown");
      if (reader.version() !== version) return observed("unknown");
      if (referenced) return observed("live");
    }
    return observed("settled");
  }
  return observed("live");
}
export async function attemptTempState(owner: AttemptTempOwner, inventory = new RepositoryLinkInventory()): Promise<AttemptTempState> {
  return (await attemptTempAuthority(owner, inventory)).state;
}
/** The sweep's state port. Every read that finds the lane finished also
 * records when its retention ends, including for a root that a later
 * observation holds, so the ledger can order expired roots across pages. */
export function recordingAttemptTempState(store: AttemptTempStore,
  authority: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempAuthority> = attemptTempAuthority) {
  return async (owner: AttemptTempOwner, inventory = new RepositoryLinkInventory()): Promise<AttemptTempState> => {
    const observed = await authority(owner, inventory);
    store.noteRetentionEnd(owner.directory, observed);
    return observed.state;
  };
}
function setting(raw: string | undefined, fallback: number) {
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
type TickCondition = { mode: "on" | "dry-run"; overCap: boolean; failing: boolean; lowSpace?: boolean };
const quiet = (mode: TickCondition["mode"]): TickCondition => ({ mode, overCap: false, failing: false });
function recordedReport(file: string, mode: TickCondition["mode"]): { condition: TickCondition; retention?: unknown } {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8")), condition = report?.condition;
    return { condition: condition && typeof condition.overCap === "boolean" && typeof condition.failing === "boolean"
      ? condition : quiet(mode), retention: report?.retention };
  } catch { /* A missing or unreadable report counts as the quiet condition. */ }
  return { condition: quiet(mode) };
}

/** A minute tick reports only when it removed, held over the cap or failed,
 * or when its condition or recorded forecast changed. The recorded
 * condition is on disk, so a restarted helper does not repeat itself. */
export async function runAttemptTempSweep(ports: Pick<AttemptTempSweepOptions, "scan">, env: NodeJS.ProcessEnv = process.env) {
  const mode = tempSweepMode(env);
  if (!mode || attemptTempRemaining() <= 0) return null;
  const store = new AttemptTempStore();
  try {
    const options: AttemptTempSweepOptions = {
      runBudgetMs: attemptTempRemaining(40_000),
      state: recordingAttemptTempState(store), authority: attemptTempAuthority, mode, scan: ports.scan, checkoutReads,
      onRetired: (count, bytes) => console.log(`[attempt temp] retired ${count} directories, ${bytes} attributed bytes`),
      capBytes: setting(env.LLV_ATTEMPT_TEMP_CAP_BYTES, 100 * 1024 ** 3),
      maxAgeMs: setting(env.LLV_ATTEMPT_TEMP_MAX_AGE_DAYS, 1) * 86400000,
      retentionMs: FINISHED_LANE_RETENTION_MS,
    };
    const roots = await sweepAttemptTemps(store, options);
    const copies = await sweepEvidenceCopies(store, options, { agentCopiesManagedSeparately: true });
    const report = { ...roots, copies, retention: store.retention(Date.now(), options.retentionMs) };
    const file = statePath("attempt-temp-report.json");
    const condition: TickCondition = { mode, overCap: report.overCapBytes > 0, ...(report.lowSpace ? { lowSpace: true } : {}),
      failing: report.errors > 0 || copies.errors > 0 || report.spaceError !== null };
    const previous = recordedReport(file, mode);
    const changed = JSON.stringify(previous.condition) !== JSON.stringify(condition);
    const forecastChanged = previous.retention !== undefined && JSON.stringify(previous.retention) !== JSON.stringify(report.retention);
    if (report.removed || copies.removed || report.errors || copies.errors || report.spaceError || report.lowSpace || report.deferred || report.overCapBytes || changed || forecastChanged || report.retention.dueBytes || report.retention.upcomingBytes) {
      const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
      const summary = `${report.lowSpace ? "Low free space: reclaim ended attempt temp regardless of cap or retention. " : ""}`
        + `${report.spaceError ? `Scratch free-space observation failed: ${report.spaceError}. ` : ""}`
        + `Measured ${gb(report.bytes)}; cap ${gb(report.capBytes)}; ${mode === "dry-run" ? "would reclaim" : "reclaimed"} ${gb(report.removedBytes)}; `
        + `budget deferred ${gb(report.deferredBytes)}; held live ${gb(report.liveHeldBytes)}; held by evidence ${gb(report.evidenceHeldBytes)}; `
        + `held for the operator ${gb(report.operatorHeldBytes)}; other holds ${gb(report.otherHeldBytes)}; failed ${gb(report.failedBytes)}; outside this page ${gb(report.unexaminedBytes)}. `
        + `${report.blocked.roots} roots in the ledger (${gb(report.blocked.bytes)}) hold directories this user cannot remove; they are listed under "blocked". `
        + `automatic copies reclaimed ${gb(copies.removedBytes)}; unattributed copies retained ${gb(copies.unattributed.bytes)}. `
        + "Hold categories describe this page; unexamined allocation still needs classification.";
      writeJsonDurably(file, { at: new Date().toISOString(), condition, summary, ...report });
      console.log(`[attempt temp] ${mode === "dry-run" ? "would remove" : "removed"} ${report.removed} directories, ${report.removedBytes} bytes; `
        + `${report.deferred} budget deferred (${report.deferredBytes} bytes); ${report.liveHeld} held live (${report.liveHeldBytes} bytes); `
        + `${report.evidenceHeld} held by evidence (${report.evidenceHeldBytes} bytes); ${report.operatorHeld} held for the operator (${report.operatorHeldBytes} bytes); `
        + `${report.held - report.liveHeld - report.evidenceHeld - report.operatorHeld} other holds (${report.otherHeldBytes} bytes); `
        + `${report.errors + copies.errors} errors (${report.failedBytes} root bytes); ${report.unexaminedBytes} bytes outside this page; ${report.overCapBytes} measured bytes over cap; `
        + `${copies.removed} automatic copies removed, ${copies.unattributed.count} unattributed copies retained`);
    }
    return report;
  } catch (error) {
    // Admission can consume the last of the tick before a root was visited.
    if (error instanceof FileTransactionBusyError && attemptTempRemaining() <= 0) return null;
    throw error;
  } finally { store.close(); }
}
