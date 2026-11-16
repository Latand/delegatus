import { attemptTempRemaining } from "./attemptTempDeadline";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { statePath } from "@/lib/configDir";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempAuthority, type AttemptTempOwner, type AttemptTempState, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { pipelineRecordReader } from "@/lib/pipelines/store";
import { laneFinish, FINISHED_LANE_RETENTION_MS } from "@/lib/pipelines/laneFinish";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { tempSweepMode } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { RepositoryLinkInventory, type RetainedCheckoutReads } from "./attemptTempFilesystem";
import { sweepEvidenceCopies } from "./attemptEvidenceCopies";
import { agentRegistry } from "@/lib/agent/registry";
import { finishedAgent } from "./temporaryDataProduction";

/** The sweep helper serves every minute tick from one process. */
const checkoutReads: RetainedCheckoutReads = new Map();

export async function attemptTempAuthority(owner: AttemptTempOwner, _inventory = new RepositoryLinkInventory(), now = Date.now, retentionMs = FINISHED_LANE_RETENTION_MS): Promise<AttemptTempAuthority> {
  if (!owner.pipelineId) {
    // A missing process snapshot cannot end a standalone host: reconnect and
    // resume keep its durable launch alive. Pin the keyed facts through dispatch.
    const registry = agentRegistry(), input = { launchId: owner.launchId };
    const read = () => {
      const receipt = registry.spawnReceipt(input.launchId);
      return { receipt, entry: receipt?.key ? registry.hostEntry(receipt.key) : null, pipelines: [] };
    };
    const fingerprint = (facts: ReturnType<typeof read>) => createHash("sha256").update(JSON.stringify(facts)).digest("hex");
    const facts = read(), revision = fingerprint(facts);
    const ended = facts.receipt ? finishedAgent(facts) : null;
    const expiresAt = ended === null ? null : ended + retentionMs;
    const state = !facts.receipt ? "orphan" : ended === null ? "live"
      : now() >= expiresAt! ? "expired" : "closed";
    return { state, expiresAt, revision,
      isCurrent: () => fingerprint(read()) === revision
        && (state !== "expired" || now() >= expiresAt!) };
  }
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

/** Metadata repair must not depend on a root's size, permissions or continued
 * existence. Every tick advances a durable bounded page, including open lanes
 * whose eventual finish will need a deadline. It grants no removal authority. */
export async function backfillAttemptTempRetention(store: AttemptTempStore, options: {
  authority?: (owner: AttemptTempOwner) => Promise<AttemptTempAuthority>;
  remaining?: () => number;
  limit?: number;
} = {}) {
  let checked = 0, updated = 0, errors = 0;
  for (const owner of store.retentionPage(options.limit)) {
    if ((options.remaining?.() ?? 1) <= 0) break;
    try {
      if (owner.released && owner.pipelineId) {
        const observed = await (options.authority ?? attemptTempAuthority)(owner);
        // The owner or its ledger binding may have changed while awaiting a read.
        const current = store.owner(owner.directory);
        if (observed.isCurrent() && current?.identity === owner.identity && current.released
          && current.pipelineId === owner.pipelineId && current.launchId === owner.launchId
          && current.createdAt === owner.createdAt && current.retainUntilClose === owner.retainUntilClose) {
          if (observed.state === "closed" || observed.state === "expired") {
            const before = store.retentionExpiry(owner.directory);
            store.noteRetentionEnd(owner.directory, observed);
            if (before !== store.retentionExpiry(owner.directory)) updated++;
          } else if (observed.state === "live") store.retainRoot(owner.directory, null);
          else {
            const pipeline = pipelineRecordReader(owner.pipelineId).read();
            if (pipeline && pipeline.state !== "closed" && pipeline.state !== "completed" && observed.isCurrent()) {
              const before = store.retentionExpiry(owner.directory);
              store.retainRoot(owner.directory, null);
              if (before !== null) updated++;
            }
          }
        }
      }
    } catch (error) {
      errors++;
      store.rootFailure(owner.directory, `retention backfill: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512));
    }
    store.checkpointRetention(owner.directory);
    checked++;
  }
  return { checked, updated, ...(errors ? { errors } : {}) };
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
    const backfill = await backfillAttemptTempRetention(store, { remaining: () => attemptTempRemaining() });
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
    const report = { ...roots, errors: roots.errors + (backfill.errors ?? 0), copies, backfill, retention: store.retention(Date.now(), options.retentionMs) };
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
