import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { ordinaryCleanerJournal } from "@/lib/cleaner/ordinaryJournal";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { attemptTempRemaining, sweepMonotonicNow } from "./attemptTempDeadline";
import { attemptTempConfigParent } from "./attemptTempPaths";
import { AttemptProtectionInventory } from "./attemptProtectionInventory";
import { scratchRootUseCheck, scratchSelectionRefusal, type SelectedScratch } from "./attemptScratchLanes";
import { ATTEMPT_TEMP_LARGE_ROOT_BUDGET_MS, attemptTempRootWindow, sweepAttemptTemps,
  type AttemptTempStore, type AttemptTempSweepOptions } from "./attemptTempRetention";

/** The Cleaner's pressure rule for a finished lane: its tree is idle this long. */
export const ATTEMPT_TEMP_OVER_CAP_IDLE_MS = 3 * 60 * 60_000;

export type OverCapPorts = Pick<AttemptTempSweepOptions, "scan" | "references" | "checkoutReads" | "beforeRootRetirement" | "accountCpuSeconds" | "onRetired"> & {
  mode: "on" | "dry-run";
  /** The effective cap of this tick's expiry page. */
  capBytes: number;
  /** The configured cap, from which each visit derives the effective one again. */
  configuredCapBytes: number;
  availableBytes?: (scratch: string) => number;
  runBudgetMs: number;
  /** Reclaim holds the tick's whole budget, so its first root may start in a
   * partial window. Otherwise every root waits for a complete one. */
  leads: boolean;
  /** Finished and expired exactly as the expiry page reads it. */
  scratchAuthority: NonNullable<AttemptTempSweepOptions["authority"]>;
  /** The Cleaner's reading: a closed or completed, settled lane has ended. */
  laneAuthority: NonNullable<AttemptTempSweepOptions["authority"]>;
  now?: () => number;
};

type Report = Awaited<ReturnType<typeof sweepAttemptTemps>>;
export type OverCapReport = {
  startBytes: number; capBytes: number; checked: number; removed: number; removedBytes: number; reclaimedBytes: number;
  rebound: number; absent: number; errors: number; deferred: number;
  /** Roots this tick kept, by the reason each one named. */
  held: Record<string, { count: number; bytes: number }>;
  outcomes: Report["outcomes"];
  /** `cleared`: allocation is at or under the cap. `budget`: the position is
   * kept for the next tick. `exhausted`: every finished root was visited. */
  ended: "cleared" | "budget" | "exhausted";
};

/** A ledger over its cap, whatever the free space: retire finished stage
 * scratch, oldest finish first, until the recorded allocation is back under it.
 * The ledger's own sweep does the removal as a bounded exact selection, so
 * every proof of the Cleaner's pressure pass applies: an expired attempt, or a
 * closed and settled lane; a tree idle three hours; no process, socket,
 * checkout or container reference; no keep marker, Git checkout, mount, linked
 * report or recorded-check custody; no open lane or live conversation inside;
 * the lane's retirement claim; canonical admission; and the tombstone journal.
 * A root the ledger is waiting to retry is left to that retry, and no visit
 * here moves one. */
export async function reclaimOverCapScratch(store: AttemptTempStore, ports: OverCapPorts): Promise<OverCapReport> {
  const now = ports.now ?? Date.now;
  const deadline = sweepMonotonicNow() + attemptTempRemaining(ports.runBudgetMs);
  const remaining = () => attemptTempRemaining(deadline - sweepMonotonicNow());
  const report: OverCapReport = { startBytes: store.bytes(), capBytes: ports.capBytes, checked: 0, removed: 0, removedBytes: 0, reclaimedBytes: 0,
    rebound: 0, absent: 0, errors: 0, deferred: 0, held: {}, outcomes: [], ended: "budget" };
  /** A preview removes nothing, so it discounts what it would have removed. */
  const over = (pending = 0) => store.bytes() - (ports.mode === "dry-run" ? report.removedBytes + pending : 0) > report.capBytes;
  const journal = ordinaryCleanerJournal("attempt-temp", now);
  const authority: NonNullable<AttemptTempSweepOptions["authority"]> = async (owner, inventory) => {
    const scratch = await ports.scratchAuthority(owner, inventory);
    // Expired roots keep the expiry page's authority, its checkout dependency
    // included. A finish still inside its 24 hours is taken early only when the
    // whole lane has ended; an open lane keeps it.
    return scratch.state === "closed" ? ports.laneAuthority(owner, inventory) : scratch;
  };
  /** The expiry page's rule: a root's window follows its recorded size, and a
   * root with no measurement or a saved traversal may take the largest. */
  const window = (owner: { directory: string; bytes: number }) => !owner.bytes || AttemptProtectionInventory.exists(owner.directory)
    ? ATTEMPT_TEMP_LARGE_ROOT_BUDGET_MS : attemptTempRootWindow(owner.bytes);
  const inUse = scratchRootUseCheck();
  const visited = new Set<string>();
  let wrapped = false, started = 0;
  while (over() && remaining() > 0) {
    const page = store.overCapPage(now());
    if (!page.length) {
      if (wrapped || !store.resetOverCap()) { report.ended = "exhausted"; break; }
      wrapped = true;
      continue;
    }
    if (page.every(row => visited.has(row.directory))) { report.ended = "exhausted"; break; }
    const selected = new Map<string, SelectedScratch & { expiresAt: number }>();
    let last: (typeof page)[number] | undefined;
    for (const row of page) {
      if (visited.has(row.directory)) continue;
      last = row;
      if (!fs.lstatSync(row.directory, { throwIfNoEntry: false })
        && !fs.lstatSync(attemptTempJournalPath(row.directory), { throwIfNoEntry: false }) && !store.recoveredTrash(row.directory)) {
        // A directory removed by someone else occupies nothing. Say so before
        // deleting anything on its account; the expiry page settles its row.
        if (row.bytes) { store.measure(row.directory, 0, now()); report.absent++; }
        visited.add(row.directory);
        continue;
      }
      const rebound = ports.mode === "on" ? store.rebindRenumberedRoot(row) : null;
      if (rebound) report.rebound++;
      selected.set(row.directory, { ...row, ...rebound });
    }
    if (!over()) break;
    if (!selected.size) { store.checkpointOverCap(last!); continue; }
    const refusal = (owner: SelectedScratch) => scratchSelectionRefusal(selected.get(owner.directory), owner, inUse);
    let stopped = false;
    const result = await sweepAttemptTemps(store, {
      now: ports.now, mode: ports.mode, scan: ports.scan, references: ports.references, checkoutReads: ports.checkoutReads,
      beforeRootRetirement: ports.beforeRootRetirement, accountCpuSeconds: ports.accountCpuSeconds, onRetired: ports.onRetired,
      availableBytes: ports.availableBytes, capBytes: ports.configuredCapBytes, runBudgetMs: remaining(),
      authority, state: async (owner, inventory) => (await authority(owner, inventory)).state,
      selection: {
        directories: [...selected.keys()],
        current: owner => refusal(owner) === null,
        refusal,
        next: (owner, left, removedBytes) => {
          if (!over(removedBytes)) { stopped = true; return false; }
          // A root the tick could only start goes first next tick, with a full window.
          if (left <= 0 || (started || !ports.leads) && left < window(owner)) { stopped = true; return false; }
          started++;
          visited.add(owner.directory);
          store.checkpointOverCap(selected.get(owner.directory)!);
          return true;
        },
        window,
        watches: [statePath("viewer-release.json"), statePath("scratch"), attemptTempConfigParent()].filter(file => fs.existsSync(file)),
      },
      cleaner: {
        idleMs: ATTEMPT_TEMP_OVER_CAP_IDLE_MS, allowed: () => true, overCap: true,
        journal: (phase, directory, bytes, proof) => journal(phase, directory, bytes, proof,
          { reason: "over-cap", kind: "scratch", scope: "registered", trigger: "over-cap" }),
      },
    });
    report.checked += result.checked;
    report.removed += result.removed;
    report.removedBytes += result.removedBytes;
    report.reclaimedBytes += result.reclaimedBytes;
    report.errors += result.errors;
    report.deferred += result.deferred;
    for (const row of result.outcomes) {
      report.outcomes.push(row);
      if (row.disposition === "removed") continue;
      const kept = report.held[row.reasonCode] ??= { count: 0, bytes: 0 };
      kept.count++; kept.bytes += row.bytes;
    }
    if (stopped || !result.checked) break;
    // Absent rows past the last visit were handled while the page was read.
    if (last && !selected.has(last.directory)) store.checkpointOverCap(last);
  }
  if (!over()) {
    report.ended = "cleared";
    // The next time the cap is exceeded starts at the oldest finish again.
    store.resetOverCap();
  }
  return report;
}
