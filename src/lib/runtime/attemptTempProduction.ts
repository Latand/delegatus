import { attemptTempRemaining, sweepMonotonicNow } from "./attemptTempDeadline";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { statePath } from "@/lib/configDir";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempAuthority, type AttemptTempOwner, type AttemptTempState, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { pipelineChangeSource, pipelineRecordReader } from "@/lib/pipelines/store";
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
import { stateDatabaseBusy } from "@/lib/state/lockWait";
import { ATTEMPT_SCRATCH_AUDIT_INTERVAL_MS, ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS, ATTEMPT_SCRATCH_RETENTION_MS,
  attemptScratchAuditDue, attemptScratchExpiry } from "./attemptScratchPolicy";

/** The sweep helper serves every minute tick from one process. */
const checkoutReads: RetainedCheckoutReads = new Map();

export async function attemptTempAuthority(owner: AttemptTempOwner, _inventory = new RepositoryLinkInventory(), now = Date.now,
  retentionMs = FINISHED_LANE_RETENTION_MS, scratch = false): Promise<AttemptTempAuthority> {
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
  if (scratch) {
    const expiry = attemptScratchExpiry(pipeline, owner);
    if (expiry !== null) return { ...observed(now() >= expiry ? "expired" : "closed", expiry),
      ...(pipeline.state === "closed" || pipeline.state === "completed" ? {} : { checkout: pipeline.worktreeDir ?? pipeline.repoDir }) };
    return observed(attempt || pipeline.state === "closed" || pipeline.state === "completed" ? "live" : "unknown");
  }
  if (pipeline.state === "closed" || pipeline.state === "completed") {
    const finish = laneFinish(pipeline, retentionMs);
    if (!finish.finished) return observed("live");
    return observed(now() >= finish.expiresAt ? "expired" : "closed", finish.expiresAt);
  }
  if (!attempt) return observed("unknown");
  return observed("live");
}
export async function attemptTempState(owner: AttemptTempOwner, inventory = new RepositoryLinkInventory()): Promise<AttemptTempState> {
  return (await attemptScratchAuthority(owner, inventory)).state;
}
/** The common authority above retains the evidence clock. Ordinary scratch
 * and approved scratch lists use this separate, strict completion-age clock. */
export function attemptScratchAuthority(owner: AttemptTempOwner, inventory = new RepositoryLinkInventory(), now = Date.now) {
  return attemptTempAuthority(owner, inventory, now, ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS, true);
}
/** The sweep's state port. Every read that finds the lane finished also
 * records when its retention ends, including for a root that a later
 * observation holds, so the ledger can order expired roots across pages. */
export function recordingAttemptTempState(store: AttemptTempStore,
  authority: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempAuthority> = attemptScratchAuthority) {
  return async (owner: AttemptTempOwner, inventory = new RepositoryLinkInventory()): Promise<AttemptTempState> => {
    const observed = await authority(owner, inventory);
    const current = store.owner(owner.directory);
    if (observed.isCurrent() && current?.pipelineId === owner.pipelineId && current.launchId === owner.launchId
      && current.createdAt === owner.createdAt && !!current.retainUntilClose === !!owner.retainUntilClose) {
      if (observed.state === "closed" || observed.state === "expired") store.noteRetentionEnd(owner.directory, observed);
      else { store.retainRoot(owner.directory, null); store.rootEligible(owner.directory, false); }
    }
    return observed.state;
  };
}

/** Metadata repair must not depend on a root's size, permissions or continued
 * existence. A bounded page advances independently, including open lanes
 * whose eventual finish will need a deadline. It grants no removal authority. */
export async function backfillAttemptTempRetention(store: AttemptTempStore, options: {
  authority?: (owner: AttemptTempOwner) => Promise<AttemptTempAuthority>;
  remaining?: () => number;
  limit?: number;
  audit?: true;
} = {}) {
  store.upgradeScratchRetention();
  let checked = 0, updated = 0, errors = 0, deferred = 0;
  const page = store.retentionPage(options.limit);
  for (const owner of page) {
    if ((options.remaining?.() ?? 1) <= 0) break;
    try {
      if (options.audit || owner.released && owner.pipelineId) {
        const observed = await (options.authority ?? attemptScratchAuthority)(owner);
        // The owner or its ledger binding may have changed while awaiting a read.
        const current = store.owner(owner.directory);
        if (observed.isCurrent() && current?.identity === owner.identity && (options.audit || current.released)
          && current.pipelineId === owner.pipelineId && current.launchId === owner.launchId
          && current.createdAt === owner.createdAt && current.retainUntilClose === owner.retainUntilClose) {
          if (observed.state === "closed" || observed.state === "expired") {
            const before = store.retentionExpiry(owner.directory);
            store.noteRetentionEnd(owner.directory, observed);
            if (before !== store.retentionExpiry(owner.directory)) updated++;
          } else { const before = store.retentionExpiry(owner.directory); store.retainRoot(owner.directory, null);
            store.rootEligible(owner.directory, false); if (before !== null) updated++; }
        }
      }
    } catch (error) {
      if (stateDatabaseBusy(error) || error instanceof FileTransactionBusyError) deferred++;
      else {
        errors++;
        try { store.rootFailure(owner.directory, `retention backfill: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512)); }
        catch (noteError) { if (!stateDatabaseBusy(noteError)) throw noteError; deferred++; }
      }
    }
    try { store.checkpointRetention(owner.directory); }
    catch (error) { if (!stateDatabaseBusy(error)) throw error; deferred++; break; }
    checked++;
  }
  if (options.audit && !page.length) store.postponeAudit("auditAfter", Date.now() + ATTEMPT_SCRATCH_AUDIT_INTERVAL_MS);
  return { checked, updated, ...(errors ? { errors } : {}), ...(deferred ? { deferred } : {}) };
}

/** A committed terminal transition has the creation records it needs by lane
 * id. The feed is durable, so a helper that dies can replay the same deadlines.
 * The independent legacy audit covers missing or truncated change history. */
export function scheduleAttemptTempChanges(store: AttemptTempStore, remaining: () => number) {
  const source = pipelineChangeSource(), cursor = store.schedulePosition();
  const limit = 8;
  const page = source.changesAfter(cursor.revision, cursor.rowKey, limit);
  if (cursor.revision > page.revision) {
    store.scheduleCheckpoint(page.changeFloor, "", true);
    return;
  }
  if (cursor.revision < page.changeFloor) store.scheduleCheckpoint(page.changeFloor, "", true);
  const seen = new Set<string>();
  for (const entry of page.entries) {
    if (remaining() <= 0) return;
    if (!seen.has(entry.key) && entry.valueJson) {
      let pipeline: ReturnType<typeof source.parse> | undefined;
      try { pipeline = source.parse(entry.valueJson); }
      catch (error) { console.error("[attempt temp] terminal event left for audit", error instanceof Error ? error.message : String(error)); }
      if (pipeline) store.schedulePipeline(pipeline);
    }
    seen.add(entry.key);
    store.scheduleCheckpoint(entry.revision, entry.key);
  }
  if (page.entries.length < limit && (page.entries.length || cursor.revision !== page.revision || cursor.rowKey))
    store.scheduleCheckpoint(page.revision, "");
}
function setting(raw: string | undefined, fallback: number) {
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
type TickCondition = { mode: "on" | "dry-run"; overCap: boolean; failing: boolean; lowSpace?: boolean };
const quiet = (mode: TickCondition["mode"]): TickCondition => ({ mode, overCap: false, failing: false });
function recordedReport(file: string, mode: TickCondition["mode"]): { condition: TickCondition; retention?: unknown; cleanupActive?: boolean } {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8")), condition = report?.condition;
    return { condition: condition && typeof condition.overCap === "boolean" && typeof condition.failing === "boolean"
      ? condition : quiet(mode), retention: report?.retention,
      cleanupActive: Boolean(report?.cleanup?.oldestEligibleRootAgeSeconds || report?.cleanup?.reclaimedBytesLastHour) };
  } catch { /* A missing or unreadable report counts as the quiet condition. */ }
  return { condition: quiet(mode) };
}

/** A minute tick reports only when it removed, held over the cap or failed,
 * or when its condition or recorded forecast changed. The recorded
 * condition is on disk, so a restarted helper does not repeat itself. */
export async function runAttemptTempSweep(ports: Pick<AttemptTempSweepOptions, "scan" | "references">, env: NodeJS.ProcessEnv = process.env) {
  const mode = tempSweepMode(env);
  if (!mode || attemptTempRemaining() <= 0) return null;
  const cpuStarted = process.cpuUsage();
  let store: AttemptTempStore;
  try { store = new AttemptTempStore(); }
  catch (error) {
    if (!stateDatabaseBusy(error)) throw error;
    console.error("[attempt temp] deferred: ledger database is locked; retry next tick"); return null;
  }
  try {
    let backfill: Awaited<ReturnType<typeof backfillAttemptTempRetention>> = { checked: 0, updated: 0 };
    const options: AttemptTempSweepOptions = {
      runBudgetMs: attemptTempRemaining(40_000),
      state: recordingAttemptTempState(store), authority: attemptScratchAuthority, evidenceAuthority: attemptTempAuthority,
      requireExpired: true, scheduledOnly: true, mode, ...ports, checkoutReads,
      prepare: async () => {
        store.upgradeScratchRetention();
        const end = sweepMonotonicNow() + attemptTempRemaining(1_000);
        const remaining = () => end - sweepMonotonicNow();
        scheduleAttemptTempChanges(store, remaining);
        if (attemptScratchAuditDue(store.schedulePosition().auditAfter, Date.now()))
          backfill = await backfillAttemptTempRetention(store, { audit: true, remaining });
      },
      onRetired: (count, bytes) => console.log(`[attempt temp] retired ${count} directories, ${bytes} attributed bytes`),
      capBytes: setting(env.LLV_ATTEMPT_TEMP_CAP_BYTES, 100 * 1024 ** 3),
      maxAgeMs: setting(env.LLV_ATTEMPT_TEMP_MAX_AGE_DAYS, 1) * 86400000,
      retentionMs: FINISHED_LANE_RETENTION_MS,
    };
    const roots = await sweepAttemptTemps(store, options);
    const copies = await sweepEvidenceCopies(store, { ...options, authority: attemptTempAuthority }, { agentCopiesManagedSeparately: true });
    const cpu = process.cpuUsage(cpuStarted);
    const cleanup = store.cleanupMetrics(Date.now(), roots.reclaimedBytes, (cpu.user + cpu.system) / 1e6);
    const report = { ...roots, errors: roots.errors + (backfill.errors ?? 0), copies, backfill,
      cleanup,
      retention: { ...store.retention(Date.now(), options.retentionMs), scratchPeriodDays: ATTEMPT_SCRATCH_RETENTION_MS / 86400000,
        evidencePeriodDays: FINISHED_LANE_RETENTION_MS / 86400000 } };
    const file = statePath("attempt-temp-report.json");
    const condition: TickCondition = { mode, overCap: report.overCapBytes > 0, ...(report.lowSpace ? { lowSpace: true } : {}),
      failing: report.errors > 0 || copies.errors > 0 || report.spaceError !== null };
    const previous = recordedReport(file, mode);
    const changed = JSON.stringify(previous.condition) !== JSON.stringify(condition);
    const forecastChanged = previous.retention !== undefined && JSON.stringify(previous.retention) !== JSON.stringify(report.retention);
    const noteworthy = report.pass || report.adopted || report.operatorHeld || report.removed || copies.removed || report.errors || copies.errors
      || report.spaceError || report.lowSpace || report.deferred || report.overCapBytes || changed || forecastChanged
      || report.retention.dueBytes || report.retention.upcomingBytes;
    if (noteworthy || cleanup.oldestEligibleRootAgeSeconds || cleanup.reclaimedBytesLastHour || previous.cleanupActive) {
      const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
      const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
      const pass = report.pass, last = report.lastPass, full = report.lastFullPass;
      const passText = (pass ? `Pressure pass at ${pass.position} of ${pass.total} roots${pass.ended === "complete" ? " (complete)" : pass.ended ? " (ended: pressure cleared)" : ""} `
        + `after ${pass.ticks} ticks and ${minutes(pass.elapsedMs)}; ${mode === "dry-run" ? "would remove" : "removed"} ${pass.removed} roots (${gb(pass.removedBytes)}) in this pass. ` : "")
        + (last ? `Last pass ${last.ended === "complete" ? "completed" : "ended when pressure cleared"} in ${minutes(last.durationMs)} over ${last.ticks} ticks, `
          + `${last.visited} visits, ${last.removed} roots removed (${gb(last.removedBytes)}). ` : "")
        + (full && last?.ended !== "complete" ? `Last full pass completed in ${minutes(full.durationMs)} over ${full.ticks} ticks. ` : "");
      const summary = passText + `${report.lowSpace ? "Low free space: reclaim ended attempt temp regardless of cap or retention. " : ""}`
        + `${report.spaceError ? `Scratch free-space observation failed: ${report.spaceError}. ` : ""}`
        + `Recorded allocation ${gb(report.bytes)}; cap ${gb(report.capBytes)}; ${mode === "dry-run" ? "would reclaim" : "reclaimed"} ${gb(report.removedBytes)} attributed; `
        + `budget deferred ${gb(report.deferredBytes)}; held live ${gb(report.liveHeldBytes)}; held by evidence ${gb(report.evidenceHeldBytes)}; `
        + `held for the operator ${gb(report.operatorHeldBytes)}; other holds ${gb(report.otherHeldBytes)}; failed ${gb(report.failedBytes)}; outside this page ${gb(report.unexaminedBytes)}. `
        + `${report.blocked.roots} roots in the ledger (${gb(report.blocked.bytes)}) hold directories this user cannot remove; they are listed under "blocked". `
        + `automatic copies reclaimed ${gb(copies.removedBytes)}; unattributed copies retained ${gb(copies.unattributed.bytes)}. `
        + "Hold categories describe this page; unexamined allocation still needs classification.";
      writeJsonDurably(file, { at: new Date().toISOString(), condition, summary, ...report });
      if (noteworthy) console.log(`[attempt temp] ${mode === "dry-run" ? "would remove" : "removed"} ${report.removed} directories, ${report.removedBytes} bytes; `
        + `${report.deferred} budget deferred (${report.deferredBytes} bytes); ${report.liveHeld} held live (${report.liveHeldBytes} bytes); `
        + `${report.evidenceHeld} held by evidence (${report.evidenceHeldBytes} bytes); ${report.operatorHeld} held for the operator (${report.operatorHeldBytes} bytes); `
        + `${report.held - report.liveHeld - report.evidenceHeld - report.operatorHeld} other holds (${report.otherHeldBytes} bytes); `
        + `${report.errors + copies.errors} errors (${report.failedBytes} root bytes); ${report.unexaminedBytes} bytes outside this page; ${report.overCapBytes} measured bytes over cap; `
        + `${copies.removed} automatic copies removed, ${copies.unattributed.count} unattributed copies retained`
        + (pass ? `; pass ${pass.position}/${pass.total} roots, ${pass.ticks} ticks, ${pass.removed} roots (${pass.removedBytes} bytes) removed this pass${pass.ended ? `, ${pass.ended}` : ""}` : "")
        + (last ? `; last pass ${last.ended} in ${last.durationMs} ms over ${last.ticks} ticks, ${last.removed} roots (${last.removedBytes} bytes) removed` : "")
        + (full ? `; last full pass ${full.durationMs} ms` : ""));
    }
    return report;
  } catch (error) {
    // Admission can consume the last of the tick before a root was visited.
    if (error instanceof FileTransactionBusyError && attemptTempRemaining() <= 0) return null;
    if (stateDatabaseBusy(error)) {
      console.error("[attempt temp] deferred: shared retention ledger is busy; durable cursor retained"); return null;
    }
    throw error;
  } finally { store.close(); }
}
