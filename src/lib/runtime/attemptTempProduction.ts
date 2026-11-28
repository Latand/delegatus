import { attemptTempRemaining, sweepMonotonicNow } from "./attemptTempDeadline";
import { reclaimOverCapScratch, type OverCapReport } from "./attemptTempOverCap";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { statePath } from "@/lib/configDir";
import { attemptTempEffectiveCapBytes, AttemptTempStore, sweepAttemptTemps,
  type AttemptTempAuthority, type AttemptTempOwner, type AttemptTempState, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { pipelineChangeSource, pipelineRecordReader } from "@/lib/pipelines/store";
import { laneFinish, FINISHED_LANE_RETENTION_MS } from "@/lib/pipelines/laneFinish";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { attemptTempJournalPath, tempSweepMode } from "@/lib/tempSweep";
import { attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { runUnregisteredScratchPass, unregisteredScratchSummary, type UnregisteredScratchReport } from "./unregisteredScratch";
import { writeJsonDurably } from "@/lib/state/durableJson";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { RepositoryLinkInventory, type RetainedCheckoutReads } from "./attemptTempFilesystem";
import { attributeCopyBeforeRootRetirement, sweepEvidenceCopies } from "./attemptEvidenceCopies";
import { measureAttemptAllocations } from "./attemptTempFilesystem";
import { agentRegistry } from "@/lib/agent/registry";
import { finishedAgent } from "./temporaryDataProduction";
import { stateDatabaseBusy } from "@/lib/state/lockWait";
import { ATTEMPT_SCRATCH_AUDIT_INTERVAL_MS, ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS, ATTEMPT_SCRATCH_RETENTION_MS,
  attemptScratchAuditDue, attemptScratchExpiry } from "./attemptScratchPolicy";

/** The sweep helper serves every minute tick from one process. */
const checkoutReads: RetainedCheckoutReads = new Map();
const ALLOCATION_WINDOW_MS = 5_000;
/** Root work of one tick, shared by the expiry page and over-cap reclaim. */
const ROOT_BUDGET_MS = 40_000;

export async function attemptTempAuthority(owner: AttemptTempOwner, _inventory = new RepositoryLinkInventory(), now = Date.now,
  retentionMs = FINISHED_LANE_RETENTION_MS, policy: "lane" | "attempt" | "scratch" = "lane"): Promise<AttemptTempAuthority> {
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
  if (policy === "attempt" && !attempt) return observed("unknown");
  if (attempt?.launchId === owner.launchId && attempt.state === "running") return observed("live");
  if (policy === "scratch") {
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
  return attemptTempAuthority(owner, inventory, now, ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS, "scratch");
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
  if (options.audit && !page.length) store.completeRetentionAudit(Date.now() + ATTEMPT_SCRATCH_AUDIT_INTERVAL_MS);
  return { checked, updated, ...(errors ? { errors } : {}), ...(deferred ? { deferred } : {}) };
}

/** A committed terminal transition has the creation records it needs by lane
 * id. The feed is durable, so a helper that dies can replay the same deadlines.
 * The independent legacy audit covers missing or truncated change history. */
export function scheduleAttemptTempChanges(store: AttemptTempStore, remaining: () => number) {
  const source = pipelineChangeSource();
  let cursor = store.schedulePosition();
  const limit = 8;
  let page = source.changesAfter(cursor.revision, cursor.rowKey, limit);
  const historyGap = () => cursor.revision > page.revision || cursor.revision < page.changeFloor
    || cursor.revision === page.changeFloor && cursor.rowKey !== "";
  if (historyGap()) {
    store.scheduleCheckpoint(page.changeFloor, "", true);
    if (remaining() <= 0) return;
    cursor = store.schedulePosition();
    // Bounded pruning can leave physical rows below the advertised floor.
    // Read again from that floor so their keys cannot rewind the checkpoint.
    page = source.changesAfter(cursor.revision, cursor.rowKey, limit);
    if (historyGap()) return;
  }
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
function recordedReport(file: string, mode: TickCondition["mode"]): { condition: TickCondition; retention?: unknown;
  /** The cap of a tick whose over-cap reclaim had no time to visit anything. */
  starvedCap?: number } {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8")), condition = report?.condition;
    return { condition: condition && typeof condition.overCap === "boolean" && typeof condition.failing === "boolean"
      ? condition : quiet(mode), retention: report?.retention,
      ...(report?.overCap?.checked === 0 && report.overCap.ended === "budget" && Number.isFinite(report.overCap.capBytes)
        ? { starvedCap: report.overCap.capBytes } : {}) };
  } catch { /* A missing or unreadable report counts as the quiet condition. */ }
  return { condition: quiet(mode) };
}

/** Every minute tick writes fresh cleanup counters; console output remains
 * limited to removals, holds, failures and changed forecasts. */
export async function runAttemptTempSweep(ports: Pick<AttemptTempSweepOptions, "scan" | "references" | "availableBytes">, env: NodeJS.ProcessEnv = process.env) {
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
    let cleanupChildCpuSeconds = 0;
    let sourceAttributedBeforeRetirement = 0;
    // Roots nothing owns are removed by age and liveness, ahead of the ledger
    // page, so a ledger that is under its cap cannot leave them on the disk.
    let unregistered: UnregisteredScratchReport | null = null;
    try {
      unregistered = await runUnregisteredScratchPass(store, { mode, scan: ports.scan, references: ports.references, availableBytes: ports.availableBytes,
        checkoutReads, accountCpuSeconds: seconds => { if (Number.isFinite(seconds) && seconds > 0) cleanupChildCpuSeconds += seconds; } });
    } catch (error) { console.error("[attempt temp] unregistered scratch pass failed", attemptTempFailureDetail(error)); }
    const file = statePath("attempt-temp-report.json");
    const previous = recordedReport(file, mode);
    const configuredCapBytes = setting(env.LLV_ATTEMPT_TEMP_CAP_BYTES, 100 * 1024 ** 3);
    const rootsStarted = sweepMonotonicNow();
    const options: AttemptTempSweepOptions = {
      runBudgetMs: attemptTempRemaining(ROOT_BUDGET_MS),
      state: recordingAttemptTempState(store), authority: attemptScratchAuthority, evidenceAuthority: attemptTempAuthority,
      requireExpired: true, scheduledOnly: true, mode, ...ports, checkoutReads,
      accountCpuSeconds: seconds => { if (Number.isFinite(seconds) && seconds > 0) cleanupChildCpuSeconds += seconds; },
      prepare: async rootRemaining => {
        store.upgradeScratchRetention();
        const end = sweepMonotonicNow() + Math.min(ALLOCATION_WINDOW_MS, rootRemaining());
        const feedEnd = Math.min(end, sweepMonotonicNow() + 250);
        scheduleAttemptTempChanges(store, () => feedEnd - sweepMonotonicNow());
        if (attemptScratchAuditDue(store.schedulePosition().auditAfter, Date.now())) {
          const auditEnd = Math.min(end, sweepMonotonicNow() + 350);
          backfill = await backfillAttemptTempRetention(store, { audit: true, remaining: () => auditEnd - sweepMonotonicNow() });
        }
        const remaining = () => end - sweepMonotonicNow();
        const due = store.allocationDue(Date.now(), 64), measurable: typeof due = [];
        for (const [index, owner] of due.entries()) {
          if (remaining() <= 0) break;
          if (mode === "on" && store.rebindRenumberedRoot(owner)) continue;
          try {
            const before = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
            if (!before && !store.recoveredTrash(owner.directory)
              && !fs.lstatSync(attemptTempJournalPath(owner.directory), { throwIfNoEntry: false })) {
              store.recordAllocation(owner, 0, Date.now() + index);
            } else if (before?.isDirectory() && `${before.dev}:${before.ino}` === owner.identity) measurable.push(owner);
            else store.recordAllocation(owner, null, Date.now() + index, false);
          } catch { store.recordAllocation(owner, null, Date.now() + index, false); }
        }
        if (measurable.length && remaining() > 0) {
          const attemptedAt = Date.now();
          try {
            const observations = await measureAttemptAllocations(measurable.map(owner => owner.directory), { budgetMs: Math.max(1, remaining()) });
            for (const [index, owner] of measurable.entries()) {
              const after = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
              const stable = after?.isDirectory() && `${after.dev}:${after.ino}` === owner.identity;
              store.recordAllocation(owner, stable ? observations.get(owner.directory)! : null, attemptedAt + index, !!stable);
            }
          } catch {
            // The attempt time is separate from the last successful sample.
            // Stagger equal-time failures so one oversized root cannot pin the
            // head of the next page indefinitely.
            for (const [index, owner] of measurable.entries())
              store.recordAllocation(owner, null, attemptedAt + (index === 0 ? 60_000 : index), false);
          }
        }
      },
      beforeRootRetirement: (directory, identity) => {
        sourceAttributedBeforeRetirement += attributeCopyBeforeRootRetirement(store, directory, identity);
      },
      onRetired: (count, bytes) => console.log(`[attempt temp] retired ${count} directories, ${bytes} attributed bytes`),
      capBytes: configuredCapBytes,
      maxAgeMs: setting(env.LLV_ATTEMPT_TEMP_MAX_AGE_DAYS, 1) * 86400000,
      retentionMs: FINISHED_LANE_RETENTION_MS,
    };
    // Over its cap, the ledger reclaims finished scratch whatever the free
    // space is. This worker owns that: it already holds the measure, runs every
    // minute under a bounded budget and covers every project, while the Cleaner
    // starts on low free space and retires one project's roots.
    const rootTimeLeft = () => attemptTempRemaining(Math.max(0, ROOT_BUDGET_MS - (sweepMonotonicNow() - rootsStarted)));
    const reclaim = async (capBytes: number, leads: boolean): Promise<OverCapReport | null> => {
      try {
        return await reclaimOverCapScratch(store, { mode, scan: ports.scan, references: ports.references, checkoutReads,
          availableBytes: ports.availableBytes, capBytes, configuredCapBytes, runBudgetMs: rootTimeLeft(), leads,
          scratchAuthority: attemptScratchAuthority,
          laneAuthority: (owner, inventory) => attemptTempAuthority(owner, inventory, Date.now, 0, "attempt"),
          beforeRootRetirement: options.beforeRootRetirement, accountCpuSeconds: options.accountCpuSeconds,
          onRetired: (count, bytes) => console.log(`[attempt temp] over-cap reclaim retired ${count} directories, ${bytes} attributed bytes`) });
      } catch (error) {
        if (!(error instanceof FileTransactionBusyError) && !stateDatabaseBusy(error)) throw error;
        console.error("[attempt temp] over-cap reclaim deferred: shared retention ledger is busy; durable position retained");
        return null;
      }
    };
    // The expiry page goes first. After a tick in which it left reclaim no time
    // at all, reclaim goes first once, so neither can starve the other.
    const leading = previous.starvedCap !== undefined && store.bytes() > previous.starvedCap;
    // The previous report controls scheduling only. Deletion authority uses
    // the current disk-adjusted cap, as does the ordinary expiry page.
    const led = leading ? await reclaim((() => {
      const scratch = statePath("scratch");
      let freeBytes: number | null = null;
      try {
        const available = ports.availableBytes ? ports.availableBytes(scratch)
          : (() => { const stat = fs.statfsSync(fs.existsSync(scratch) ? scratch : path.dirname(store.filename)); return stat.bavail * stat.bsize; })();
        if (!Number.isFinite(available) || available < 0) throw new Error("invalid scratch free-space observation");
        freeBytes = available;
      } catch { /* Match the regular sweep: unavailable space uses the configured cap. */ }
      return attemptTempEffectiveCapBytes(configuredCapBytes, store.bytes(), freeBytes);
    })(), true) : null;
    const roots = await sweepAttemptTemps(store, { ...options, runBudgetMs: rootTimeLeft() });
    // A tick that ran the ledger's own pressure pass has already served the cap.
    const followed = !leading && !roots.pressure && roots.bytes > roots.capBytes ? await reclaim(roots.capBytes, false) : null;
    if (roots.bytes <= roots.capBytes) store.resetOverCap();
    const overCap = led ?? followed;
    const copies = await sweepEvidenceCopies(store, { ...options, authority: attemptTempAuthority }, { agentCopiesManagedSeparately: true });
    copies.sourceAttributed += sourceAttributedBeforeRetirement;
    const cpu = process.cpuUsage(cpuStarted);
    const cleanup = store.cleanupMetrics(Date.now(), roots.reclaimedBytes + (overCap?.reclaimedBytes ?? 0),
      (cpu.user + cpu.system) / 1e6 + cleanupChildCpuSeconds);
    // The tick's totals cover both paths; `overCap` keeps its own share.
    const bytes = store.bytes();
    const classified = new Map([...roots.outcomes, ...overCap?.outcomes ?? []].map(row => [row.directory, row]));
    const accounted = [...classified.values()].filter(row => mode === "dry-run" || row.disposition !== "removed").reduce((sum, row) => sum + row.bytes, 0);
    const report = { ...roots, errors: roots.errors + (overCap?.errors ?? 0) + (backfill.errors ?? 0) + (unregistered?.errors ?? 0), copies, backfill,
      removed: roots.removed + (overCap?.removed ?? 0), removedBytes: roots.removedBytes + (overCap?.removedBytes ?? 0),
      reclaimedBytes: roots.reclaimedBytes + (overCap?.reclaimedBytes ?? 0), rebound: roots.rebound + (overCap?.rebound ?? 0),
      bytes, overCapBytes: Math.max(0, bytes - roots.capBytes), unexaminedBytes: Math.max(0, bytes - accounted),
      expiryPage: { checked: roots.checked, removed: roots.removed, removedBytes: roots.removedBytes },
      overCap, cleanup, unregistered,
      retention: { ...store.retention(Date.now(), options.retentionMs), scratchPeriodDays: ATTEMPT_SCRATCH_RETENTION_MS / 86400000,
        evidencePeriodDays: FINISHED_LANE_RETENTION_MS / 86400000 } };
    const condition: TickCondition = { mode, overCap: report.overCapBytes > 0, ...(report.lowSpace ? { lowSpace: true } : {}),
      failing: report.errors > 0 || copies.errors > 0 || report.spaceError !== null };
    const changed = JSON.stringify(previous.condition) !== JSON.stringify(condition);
    const forecastChanged = previous.retention !== undefined && JSON.stringify(previous.retention) !== JSON.stringify(report.retention);
    const noteworthy = overCap || report.rebound || unregistered?.removed || unregistered?.finishedInterrupted || unregistered?.errors || unregistered?.trigger || unregistered?.deferred
      || report.pass || report.adopted || report.operatorHeld || report.removed || copies.removed || copies.sourceAttributed || report.errors || copies.errors
      || report.spaceError || report.lowSpace || report.deferred || report.overCapBytes || changed || forecastChanged
      || report.retention.dueBytes || report.retention.upcomingBytes;
    {
      const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
      const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
      const pass = report.pass, last = report.lastPass, full = report.lastFullPass;
      // A recorded pass that ended when pressure cleared is history. While the
      // ledger is over its cap, the report says what is happening to it now.
      const history = last && !(report.overCapBytes && last.ended === "pressure-cleared") ? last : null;
      const passText = (pass ? `Pressure pass at ${pass.position} of ${pass.total} roots${pass.ended === "complete" ? " (complete)" : pass.ended ? " (ended: pressure cleared)" : ""} `
        + `after ${pass.ticks} ticks and ${minutes(pass.elapsedMs)}; ${mode === "dry-run" ? "would remove" : "removed"} ${pass.removed} roots (${gb(pass.removedBytes)}) in this pass. ` : "")
        + (history ? `Last pass ${history.ended === "complete" ? "completed" : "ended when pressure cleared"} in ${minutes(history.durationMs)} over ${history.ticks} ticks, `
          + `${history.visited} visits, ${history.removed} roots removed (${gb(history.removedBytes)}), on ${new Date(history.endedAt).toISOString()}. ` : "")
        + (full && last?.ended !== "complete" ? `Last full pass completed in ${minutes(full.durationMs)} over ${full.ticks} ticks. ` : "");
      const kept = Object.entries(overCap?.held ?? {}).sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
        .map(([code, row]) => `${row.count} ${code} (${gb(row.bytes)})`).join(", ");
      const overCapState = !overCap ? "" : overCap.ended === "cleared" ? "the ledger is back under its cap"
        : overCap.ended === "budget" ? "the next tick continues from here" : "every finished root has been visited";
      const overCapText = !overCap ? "" : `Over-cap reclaim started ${gb(overCap.startBytes)} against a cap of ${gb(overCap.capBytes)}, visited ${overCap.checked} roots oldest finish first and `
        + `${mode === "dry-run" ? "would remove" : "removed"} ${overCap.removed} (${gb(overCap.removedBytes)}); ${overCapState}`
        + `${report.overCapBytes ? `; still over by ${gb(report.overCapBytes)}` : ""}`
        + `${overCap.absent ? `; ${overCap.absent} directories already gone no longer count` : ""}`
        + `${kept ? `. Kept: ${kept}` : ""}. `;
      const pathText = `expiry page ${roots.removed} roots (${gb(roots.removedBytes)}), over-cap reclaim ${overCap?.removed ?? 0} roots (${gb(overCap?.removedBytes ?? 0)})`;
      const u = report.unregistered;
      const unregisteredText = u ? unregisteredScratchSummary(u, mode, gb) : "";
      const summary = passText + overCapText + unregisteredText + `${report.lowSpace ? "Scratch free space is below the working reserve. " : ""}`
        + `${report.spaceError ? `Scratch free-space observation failed: ${report.spaceError}. ` : ""}`
        + `Recorded allocation ${gb(report.bytes)}; cap ${gb(report.capBytes)}; ${mode === "dry-run" ? "would reclaim" : "reclaimed"} ${gb(report.removedBytes)} attributed (${pathText}); `
        + `budget deferred ${gb(report.deferredBytes)}; held live ${gb(report.liveHeldBytes)}; held by evidence ${gb(report.evidenceHeldBytes)}; `
        + `held for the operator ${gb(report.operatorHeldBytes)}; other holds ${gb(report.otherHeldBytes)}; failed ${gb(report.failedBytes)}; outside this page ${gb(report.unexaminedBytes)}. `
        + `${report.blocked.roots} roots in the ledger (${gb(report.blocked.bytes)}) hold directories this user cannot remove; they are listed under "blocked". `
        + `automatic copies reclaimed ${gb(copies.removedBytes)}; unattributed copies retained ${gb(copies.unattributed.bytes)}; `
        + `${copies.sourceAttributed} legacy copies matched registered scratch this tick. `
        + "Hold categories describe this page; unexamined allocation still needs classification.";
      writeJsonDurably(file, { at: new Date().toISOString(), condition, summary, ...report });
      if (noteworthy) console.log(`[attempt temp] ${mode === "dry-run" ? "would remove" : "removed"} ${report.removed} directories, ${report.removedBytes} bytes `
        + `(expiry page ${roots.removed} directories, ${roots.removedBytes} bytes; over-cap reclaim ${overCap?.removed ?? 0} directories, ${overCap?.removedBytes ?? 0} bytes${overCap ? `, ${overCap.checked} visited, ${overCap.ended}${kept ? `, kept ${kept}` : ""}` : ""}); `
        + (report.rebound ? `${report.rebound} roots bound again after a device renumber; ` : "")
        + `${report.deferred} budget deferred (${report.deferredBytes} bytes); ${report.liveHeld} held live (${report.liveHeldBytes} bytes); `
        + `${report.evidenceHeld} held by evidence (${report.evidenceHeldBytes} bytes); ${report.operatorHeld} held for the operator (${report.operatorHeldBytes} bytes); `
        + `${report.held - report.liveHeld - report.evidenceHeld - report.operatorHeld} other holds (${report.otherHeldBytes} bytes); `
        + `${report.errors + copies.errors} errors (${report.failedBytes} root bytes); ${report.unexaminedBytes} bytes outside this page; ${report.overCapBytes} measured bytes over cap; `
        + `${copies.removed} automatic copies removed, ${copies.unattributed.count} unattributed copies retained`
        + (pass ? `; pass ${pass.position}/${pass.total} roots, ${pass.ticks} ticks, ${pass.removed} roots (${pass.removedBytes} bytes) removed this pass${pass.ended ? `, ${pass.ended}` : ""}` : "")
        + (history ? `; last pass ${history.ended} in ${history.durationMs} ms over ${history.ticks} ticks, ${history.removed} roots (${history.removedBytes} bytes) removed` : "")
        + (full ? `; last full pass ${full.durationMs} ms` : "")
        + (u ? `; unregistered scratch ${u.found} roots, ${u.examined} examined, ${u.removed + u.finishedInterrupted} removed (${u.removedBytes} bytes), ${u.errors} errors${u.trigger ? `, trigger ${u.trigger}` : ""}${u.deferred ? `, ${u.deferred}` : ""}` : ""));
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
