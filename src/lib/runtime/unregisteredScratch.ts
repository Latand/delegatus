import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { statePath } from "@/lib/configDir";
import { assertRetentionTestPath } from "@/lib/retentionTestSafety";
import { ordinaryCleanerJournal, ordinaryJournalFile, type OrdinaryJournal } from "@/lib/cleaner/ordinaryJournal";
import { recordedRootHeld, readRecorded } from "@/lib/recordedChecks/store";
import { FileTransactionBusyError, withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { stateDatabaseBusy } from "@/lib/state/lockWait";
import { mountPointsUnder, type ProcessScan } from "@/lib/tempSweep";
import { attemptTempRemaining, checkAttemptTempDeadline, sweepMonotonicNow, withAttemptTempDeadline, ATTEMPT_TEMP_REPLY_MARGIN_MS } from "./attemptTempDeadline";
import { AttemptTempBudgetDeferred, attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { attemptProcessReferencesClear, attemptReferencesClear, attemptTreeHold, containerSubtreeClear, ledgerLinkedEvidence, measureAttemptAllocation,
  readContainerMountSources, RepositoryLinkInventory, warmCheckoutInventory, type RetainedCheckoutReads } from "./attemptTempFilesystem";
import { removeTreeWithinAttemptBudget } from "./attemptTempRemoval";
import { attemptTempRootWindow, type AttemptTempStore } from "./attemptTempRetention";
import { openLaneUseCheck } from "./attemptScratchLanes";
import { UnregisteredScratchLedger, type UnregisteredPassSummary } from "./unregisteredScratchLedger";

/** A root nothing has written to for this long is expired: the operator's "older than a day". */
export const UNREGISTERED_SCRATCH_EXPIRY_MS = 24 * 3_600_000;
/** Decimal gigabytes, as in the requirement. */
export const UNREGISTERED_LOW_FREE_BYTES = 50e9;
export const UNREGISTERED_LOSS_BYTES = 10e9;
export const UNREGISTERED_LOSS_WINDOW_MS = 20 * 60_000;
/** The tombstone name `removeTreeWithinAttemptBudget` gives a tree it claims.
 * The attempt ledger's own claims carry it too, so this pass finishes only
 * tombstones whose identity it recorded before it began the removal. */
export const UNREGISTERED_CLAIM_PREFIX = ".delegatus-trash-claim";
const ROOT_NAME = /^llv-(?:read-only-stage|stage)-[A-Za-z0-9]{6,}$/;
const TRASH_NAME = /^\.delegatus-trash-claim-(\d+)-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One tree walk stops at this many entries; the root is then kept as unproven. */
const WALK_ENTRY_LIMIT = 2_000_000;

export type UnregisteredLimits = { examine: number; remove: number; budgetMs: number; rootMs: number };
/** The ordinary tick: a bounded rate, a small share of the helper's minute. */
export const UNREGISTERED_ORDINARY_LIMITS: UnregisteredLimits = { examine: 48, remove: 16, budgetMs: 15_000, rootMs: 6_000 };
/** Low free space: at once, oldest first, with most of the minute. */
export const UNREGISTERED_PRESSURE_LIMITS: UnregisteredLimits = { examine: 256, remove: 128, budgetMs: 35_000, rootMs: 12_000 };

export type UnregisteredTrigger = "free-space" | "loss-rate" | null;
/** The free-space trigger: free bytes below 50 GB, or more than 10 GB lost
 * since the highest reading of the last twenty minutes. */
export function unregisteredScratchTrigger(samples: readonly { at: number; freeBytes: number }[], now: number, freeBytes: number | null) {
  if (freeBytes === null) return { trigger: null as UnregisteredTrigger, lossBytes: 0 };
  const peak = Math.max(freeBytes, ...samples.filter(sample => sample.at >= now - UNREGISTERED_LOSS_WINDOW_MS && sample.at <= now).map(sample => sample.freeBytes));
  const lossBytes = Math.max(0, peak - freeBytes);
  const trigger: UnregisteredTrigger = freeBytes < UNREGISTERED_LOW_FREE_BYTES ? "free-space" : lossBytes > UNREGISTERED_LOSS_BYTES ? "loss-rate" : null;
  return { trigger, lossBytes };
}

export type UnregisteredScratchPorts = {
  mode: "on" | "dry-run";
  scan: (directories: readonly string[]) => ProcessScan;
  /** The same reference observer the ledger sweep uses. */
  references?: (original: string, current: string, scan: ProcessScan) => Promise<boolean>;
  containers?: (roots: readonly string[]) => Promise<boolean>;
  /** Mount sources of the running containers, `null` when unreadable; read once per pass. */
  containerMounts?: () => Promise<string[] | null>;
  availableBytes?: (scratch: string) => number;
  now?: () => number;
  /** Milliseconds on a monotonic clock, for the pass's time budget. */
  monotonic?: () => number;
  checkoutReads?: RetainedCheckoutReads;
  journal?: OrdinaryJournal;
  /** Directories an open lane or live conversation uses; read once per pass. */
  lanes?: () => (directory: string) => boolean;
  /** Whether recorded custody names this root, which makes the ledger its owner. */
  attributable?: (directory: string, identity: string) => boolean;
  remove?: typeof removeTreeWithinAttemptBudget;
  accountCpuSeconds?: (seconds: number) => void;
};

type Verdict =
  | { kind: "remove"; bytes: number; ageMs: number; identity: string; newestMs: number }
  | { kind: "keep"; code: string; reason: string; retryAt: number; bytes: number }
  | { kind: "stop"; reason: string };

const MINUTE = 60_000, HOUR = 3_600_000;
/** How long a kept root waits before the next look. Without a wait, the oldest
 * roots that cannot be removed would fill every pass. */
function retryAfter(code: string): number {
  if (code === "live_reference" || code.startsWith("reference_") || code === "checkout_unreadable") return 10 * MINUTE;
  if (code === "keep_marker" || code.startsWith("tree_") || code === "unreadable_subtree" || code === "unremovable_permissions") return 6 * HOUR;
  return HOUR;
}

function describeHold(code: string): string {
  return ({
    live_reference: "a live process references the root (cwd, open file, command line, environment or socket)",
    keep_marker: "a .delegatus-keep marker protects the root", open_lane: "an open lane or live conversation works inside it",
    attributable_owner: "recorded custody names the owner; the attempt ledger decides", recorded_check_hold: "recorded-check custody holds the root",
    linked_evidence: "a report picture links into the root", evidence_unreadable: "the report picture index could not be read",
    mount_boundary: "a mount lies inside the root or the root is on another device", path_not_admitted: "the real path differs from the path under the scratch root",
    not_directory: "the entry is not a real directory", foreign_owner: "another user owns the root",
    activity_unproven: "the tree walk reached its bound before proving 24 h of inactivity", unreadable_subtree: "part of the tree cannot be read",
    unremovable_permissions: "part of the tree cannot be removed by this user", journal_unavailable: "the intent could not be journaled",
    changed_before_removal: "the root changed between proof and removal", failed: "removal failed",
  } as Record<string, string>)[code] ?? code.replaceAll("_", " ");
}

/** Newest modification time and allocated blocks of one tree, in one bounded,
 * symlink-safe walk that stops as soon as anything is newer than `cutoff`.
 * Hardlinked files count once. It reads timestamps; it grants nothing. */
async function walkTree(root: string, stat: fs.Stats, cutoff: number, deadline: number, clock: () => number) {
  const seen = new Set<string>();
  let newestMs = stat.mtimeMs, bytes = stat.blocks * 512, entries = 0, unreadable = false;
  if (newestMs > cutoff) return { state: "young" as const, newestMs, bytes, entries };
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let names: string[];
    try { names = fs.readdirSync(directory); } catch { unreadable = true; continue; }
    for (const name of names) {
      if (++entries > WALK_ENTRY_LIMIT) return { state: "unproven" as const, newestMs, bytes, entries };
      if (entries % 2048 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
        checkAttemptTempDeadline();
        if (clock() >= deadline) return { state: "unproven" as const, newestMs, bytes, entries };
      }
      const file = path.join(directory, name);
      let entry: fs.Stats;
      try { entry = fs.lstatSync(file); } catch { continue; }
      if (entry.dev !== stat.dev) return { state: "mount" as const, newestMs, bytes, entries };
      newestMs = Math.max(newestMs, entry.mtimeMs);
      if (newestMs > cutoff) return { state: "young" as const, newestMs, bytes, entries };
      if (entry.isDirectory()) pending.push(file);
      else if (entry.nlink > 1) {
        const key = `${entry.dev}:${entry.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      bytes += entry.blocks * 512;
    }
  }
  return { state: unreadable ? "unreadable" as const : "idle" as const, newestMs, bytes, entries };
}

const execFileAsync = promisify(execFile);
/** Directories of the tree this user owns that cannot be written (a read-only
 * module cache, for example) block `rm`. Granting the owner write access
 * inside the quarantined tree changes no data. */
async function repairOwnerWriteAccess(tombstone: string) {
  const budget = Math.max(1, Math.floor(attemptTempRemaining(15_000)));
  try { await execFileAsync("find", [tombstone, "-xdev", "-type", "d", "!", "-perm", "-u+rwx", "-exec", "chmod", "u+rwx", "{}", "+"], { timeout: budget, killSignal: "SIGKILL" }); }
  catch { /* A tree that still cannot be removed is kept and reported. */ }
}

export type UnregisteredScratchReport = Awaited<ReturnType<typeof sweepUnregisteredScratch>>;

/** The sentence the attempt-temp report carries: the roots nothing owns, this
 * pass, why it ran with the larger bound, what stays and the running totals. */
export function unregisteredScratchSummary(u: UnregisteredScratchReport, mode: "on" | "dry-run", gb: (bytes: number) => string): string {
  if (u.scratch === "refused") return `Unregistered scratch: pass refused (${u.refusal}). `;
  const kept = u.keptByReason.map(row => `${row.count} ${row.code.replaceAll("_", " ")} (${gb(row.bytes)})`).join(", ") || "none";
  const removed = mode === "dry-run" ? `would remove ${u.wouldRemove} (${gb(u.wouldRemoveBytes)})`
    : `removed ${u.removed + u.finishedInterrupted} (${gb(u.removedBytes)}${u.observedFreedBytes ? `; free space grew ${gb(u.observedFreedBytes)}` : ""})`;
  const why = !u.trigger ? "" : `; ${u.trigger === "free-space" ? "free space is below 50 GB" : "more than 10 GB was lost in 20 minutes"} (${gb(u.freeBytes ?? 0)} free), so this pass ran with the larger bound`;
  const last = u.last ? `Last working pass ${new Date(u.last.at).toISOString()}: ${u.last.removed} removed (${gb(u.last.removedBytes)}), ${u.last.kept} kept${u.last.trigger ? `, trigger ${u.last.trigger}` : ""}. ` : "";
  return `Unregistered scratch: ${u.found} roots without an owner, ${u.registered} owned by the ledger; this pass examined ${u.examined} and ${removed}${why}`
    + `${u.deferred ? `; ${u.deferred}` : ""}. Kept: ${kept}. Removed in total ${u.totals.removedRoots} roots (${gb(u.totals.removedBytes)}). ${last}`
    + `${u.journal ? `Journal: ${u.journal}. ` : ""}`;
}

/** Deletes expired stage scratch the attempt ledger holds no owner for.
 *
 * A root qualifies when (1) it is a real directory directly under the state
 * scratch root, whose real path equals its lexical path (never reached through
 * a link, never under backups or evidence), (2) the ledger names no owner for
 * it, (3) nothing in its tree was modified for 24 hours, and (4) no live
 * process references it and no evidence, keep marker, Git checkout or mount
 * holds it. Qualifying roots are renamed to a tombstone beside them before the
 * recursive delete, so a crash leaves a recorded leftover the next pass
 * finishes. Every deletion is journaled with the allocation measured during
 * the same visit; every kept root records its reason once. */
export async function sweepUnregisteredScratch(store: AttemptTempStore, ports: UnregisteredScratchPorts) {
  const ledger = UnregisteredScratchLedger.open(store.filename);
  try { return await passOverScratch(store, ledger, ports); }
  finally { ledger.close(); }
}

async function passOverScratch(store: AttemptTempStore, ledger: UnregisteredScratchLedger, ports: UnregisteredScratchPorts) {
  const now = ports.now ?? Date.now;
  /** The pass's own measure of time spent; a test advances it. */
  const monotonic = ports.monotonic ?? sweepMonotonicNow;
  const started = now(), startedMono = monotonic();
  const scratch = statePath("scratch");
  const protectedTrees = [statePath("evidence"), statePath("backups")].map(tree => path.resolve(tree));
  const inProtected = (target: string) => protectedTrees.some(tree => target === tree || target.startsWith(tree + path.sep));
  /** Canonical-path admission: a directory directly under the scratch root
   * whose real path is its lexical path, so no link carried it here, and never
   * inside backups or evidence. */
  const admitted = (directory: string) => {
    try { return path.dirname(directory) === scratch && fs.realpathSync(directory) === directory && !inProtected(directory); }
    catch { return false; }
  };
  const dry = ports.mode === "dry-run";
  const journal = ports.journal ?? ordinaryCleanerJournal("attempt-temp", now);
  const report = {
    mode: ports.mode, scratch: "present" as "present" | "absent" | "refused", refusal: null as string | null,
    trigger: null as UnregisteredTrigger, freeBytes: null as number | null, lossBytes: 0, spaceError: null as string | null,
    limits: UNREGISTERED_ORDINARY_LIMITS as UnregisteredLimits,
    found: 0, registered: 0, waiting: 0, examined: 0, removed: 0, removedBytes: 0, wouldRemove: 0, wouldRemoveBytes: 0,
    observedFreedBytes: 0, finishedInterrupted: 0, kept: {} as Record<string, number>, errors: 0, deferred: null as string | null, elapsedMs: 0,
    journal: null as string | null,
    totals: { removedRoots: 0, removedBytes: 0 }, last: null as UnregisteredPassSummary | null,
    keptByReason: [] as Array<{ code: string; count: number; bytes: number }>,
  };
  const free = () => {
    const read = ports.availableBytes ?? ((directory: string) => { const stat = fs.statfsSync(directory); return stat.bavail * stat.bsize; });
    const bytes = read(scratch);
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error("invalid scratch free-space observation");
    return bytes;
  };
  const finish = () => {
    report.elapsedMs = Math.max(0, Math.round(monotonic() - startedMono));
    try {
      const summary: UnregisteredPassSummary = { at: started, trigger: report.trigger, mode: ports.mode, freeBytes: report.freeBytes, lossBytes: report.lossBytes,
        found: report.found, examined: report.examined, removed: dry ? report.wouldRemove : report.removed, removedBytes: dry ? report.wouldRemoveBytes : report.removedBytes,
        observedFreedBytes: report.observedFreedBytes, finishedInterrupted: report.finishedInterrupted,
        kept: Object.values(report.kept).reduce((sum, count) => sum + count, 0), errors: report.errors, deferred: report.deferred, elapsedMs: report.elapsedMs };
      if (!dry && (summary.examined || summary.removed || summary.finishedInterrupted || summary.errors)) ledger.recordPass(summary);
      const totals = ledger.totals();
      report.totals = { removedRoots: totals.removedRoots, removedBytes: totals.removedBytes };
      report.last = totals.last;
      report.keptByReason = ledger.skipSummary();
    } catch (error) { if (!stateDatabaseBusy(error)) throw error; }
    return report;
  };

  // The parent must be the real scratch directory: not a link, not moved, not
  // inside backups or evidence. Anything else refuses the whole pass.
  assertRetentionTestPath(scratch);
  const parent = fs.lstatSync(scratch, { throwIfNoEntry: false });
  if (!parent) { report.scratch = "absent"; return finish(); }
  try {
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(scratch) !== path.resolve(scratch)
      || inProtected(scratch) || process.getuid && parent.uid !== process.getuid()) throw new Error("scratch parent is redirected, protected or not ours");
  } catch (error) {
    report.scratch = "refused"; report.refusal = attemptTempFailureDetail(error); report.errors++;
    return finish();
  }

  try {
    const samples = ledger.samples();
    try {
      report.freeBytes = free();
      const decision = unregisteredScratchTrigger(samples, started, report.freeBytes);
      report.trigger = decision.trigger; report.lossBytes = decision.lossBytes;
      ledger.recordSample({ at: started, freeBytes: report.freeBytes }, UNREGISTERED_LOSS_WINDOW_MS);
    } catch (error) { report.spaceError = attemptTempFailureDetail(error); }
    const limits = report.limits = report.trigger ? UNREGISTERED_PRESSURE_LIMITS : UNREGISTERED_ORDINARY_LIMITS;
    const deadline = monotonic() + attemptTempRemaining(limits.budgetMs);
    const remainingMs = () => deadline - monotonic();
    const freeBefore = report.spaceError ? null : report.freeBytes;
    if (!dry) report.journal = path.relative(statePath(), ordinaryJournalFile(new Date(started).toISOString().slice(0, 10)));

    // Names and cheap metadata of everything directly under scratch. Oldest
    // first, so the roots longest idle go before newer ones.
    type Entry = { name: string; directory: string; stat: fs.Stats };
    const roots: Entry[] = [], leftovers: Entry[] = [];
    const begun = new Set(ledger.removals().map(row => row.identity));
    for (const name of fs.readdirSync(scratch)) {
      // A claim tombstone is this pass's only when it recorded that identity first.
      const claim = TRASH_NAME.exec(name);
      const kind = ROOT_NAME.test(name) ? roots : claim && begun.has(`${claim[1]}:${claim[2]}`) ? leftovers : null;
      if (!kind) continue;
      const directory = path.join(scratch, name);
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (stat) kind.push({ name, directory, stat });
    }
    const byAge = (a: Entry, b: Entry) => a.stat.mtimeMs - b.stat.mtimeMs || (a.name < b.name ? -1 : 1);
    roots.sort(byAge); leftovers.sort(byAge);
    // An intent whose tombstone is gone finished, or never began: nothing is left to finish.
    if (!dry) {
      const tombstones = new Set(leftovers.map(entry => TRASH_NAME.exec(entry.name)!).map(match => `${match[1]}:${match[2]}`));
      for (const identity of begun) if (!tombstones.has(identity)) ledger.endRemoval(identity);
    }
    if (!dry) ledger.retainSkips(new Set([...roots, ...leftovers].map(entry => entry.name)));
    const waiting = ledger.waiting(started);
    const inventory = new RepositoryLinkInventory({ now, budgetMs: Math.min(30_000, Math.max(1, remainingMs())), retained: ports.checkoutReads,
      validationReuseMs: ports.checkoutReads ? 5_000 : 0, trustFreshReads: true });
    // One read of every lane, taken only when a root reaches that proof.
    let laneCheck: ((directory: string) => boolean) | undefined;
    const lanes = (directory: string) => (laneCheck ??= ports.lanes ? ports.lanes() : openLaneUseCheck())(directory);
    const attributable = ports.attributable ?? ((directory: string, identity: string) => {
      const found = readRecorded(recorded => recorded.rootBindings(directory, identity), { bindings: [], read: 0, overflow: false });
      return found.read > 0 || found.overflow;
    });
    const remove = ports.remove ?? removeTreeWithinAttemptBudget;
    const keep = (entry: Entry, code: string, reason: string, bytes: number, retryAt = started + retryAfter(code)) => {
      report.kept[code] = (report.kept[code] ?? 0) + 1;
      if (dry) return;
      if (ledger.skip({ name: entry.name, reason, code, retryAt: Math.max(retryAt, started + MINUTE), at: started, bytes }))
        try { journal("skipped", entry.directory, bytes, reason, { code, kind: "scratch", scope: "unregistered", trigger: report.trigger }); }
        catch { /* A kept root changes nothing on disk; its row in the ledger still reports it. */ }
    };

    // The process scan reads every process once. Roots share one for the proof
    // and the scan before a removal is renewed when it is older than a second,
    // so a pass costs a scan per removal window, not two per root.
    let scanned: { at: number; scan: ProcessScan } | null = null;
    const scanWithin = (maxAgeMs: number) => {
      if (!scanned || monotonic() - scanned.at > maxAgeMs) scanned = { at: monotonic(), scan: ports.scan([scratch]) };
      return scanned.scan;
    };
    // The container inventory is read once per pass. Only a container that
    // mounts a root or a subtree of it holds the root; a mount of an ancestor
    // such as the whole home directory does not.
    let mounts: Promise<string[] | null> | undefined;
    const containers = ports.containers ?? (async (roots: readonly string[]) => containerSubtreeClear(roots, await (mounts ??= (ports.containerMounts ?? readContainerMountSources)())));
    // Every live checkout's link inventory is read before the first root, so a
    // checkout that needs more than one tick is finished across ticks.
    let warmed: Promise<{ checkouts: number; incomplete: number }> | undefined;

    const unreferenced = (directory: string, scan: ProcessScan, hold: { code: string }) => ports.references
      ? ports.references(directory, directory, scan)
      : attemptReferencesClear(directory, directory, scan, containers, inventory, code => { hold.code = code; });

    /** Removal of a root already proven expired, or of a tombstone left by an
     * interrupted removal. Returns whether the tree is gone; otherwise it
     * journals the refusal and records when to look again. */
    const retire = async (entry: Entry, identity: string, bytes: number, why: string) => {
      const window = Math.min(attemptTempRootWindow(bytes), Math.max(1, remainingMs()));
      const attempt = (target: string) => withAttemptTempDeadline(sweepMonotonicNow() + window + ATTEMPT_TEMP_REPLY_MARGIN_MS,
        () => remove(target, () => undefined, undefined, identity, ports.accountCpuSeconds));
      let current = entry.directory;
      try {
        try { await attempt(current); }
        catch (error) {
          const claimed = (error as { claimedDirectory?: unknown }).claimedDirectory;
          if (typeof claimed !== "string" || !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          // The tombstone holds the tree now: grant the owner write access in it and delete again.
          current = claimed;
          await repairOwnerWriteAccess(claimed);
          await attempt(claimed);
        }
        ledger.endRemoval(identity);
        return true;
      } catch (error) {
        const claimed = (error as { claimedDirectory?: unknown }).claimedDirectory;
        const tombstone = typeof claimed === "string" ? claimed : current !== entry.directory ? current : null;
        const found = tombstone ?? (fs.lstatSync(entry.directory, { throwIfNoEntry: false }) ? entry.directory
          : fs.readdirSync(scratch).map(name => path.join(scratch, name)).find(name => path.basename(name).startsWith(`${UNREGISTERED_CLAIM_PREFIX}-${identity.replace(":", "-")}-`)) ?? null);
        // No tombstone means the removal never began, so there is nothing for a later pass to finish.
        if (!found || found === entry.directory) ledger.endRemoval(identity);
        const deferred = error instanceof AttemptTempBudgetDeferred;
        const code = deferred ? "removal_interrupted" : ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") ? "unremovable_permissions" : "failed";
        if (!deferred) report.errors++;
        else report.deferred ??= "removal exceeded its window; the tombstone is finished by the next pass";
        const reason = `${describeHold(code)}: ${attemptTempFailureDetail(error)}`.slice(0, 512);
        if (!dry) {
          try { journal("refused", entry.directory, bytes, reason, { code, reason: why, kind: "scratch", scope: "unregistered", trigger: report.trigger, identity }); } catch { /* The intent stays visible as uncertain. */ }
          if (found) ledger.skip({ name: path.basename(found), reason, code, retryAt: started + (deferred ? MINUTE : retryAfter(code)), at: started, bytes });
        }
        report.kept[code] = (report.kept[code] ?? 0) + 1;
        return false;
      }
    };

    /** Finishes the removals an earlier pass began: a tombstone is a quarantined
     * tree whose original name is gone. */
    for (const entry of leftovers) {
      if (remainingMs() <= 0 || dry) break;
      if (waiting.has(entry.name)) { report.waiting++; continue; }
      const match = TRASH_NAME.exec(entry.name)!;
      const stat = fs.lstatSync(entry.directory, { throwIfNoEntry: false });
      if (!stat?.isDirectory() || stat.isSymbolicLink() || `${stat.dev}-${stat.ino}` !== `${match[1]}-${match[2]}`
        || process.getuid && stat.uid !== process.getuid() || stat.dev !== parent.dev) {
        keep(entry, "path_not_admitted", "the tombstone is not the directory its name records", 0); continue;
      }
      if (!attemptProcessReferencesClear(entry.directory, entry.directory, scanWithin(1_000))) { keep(entry, "live_reference", describeHold("live_reference"), 0); continue; }
      if (mountPointsUnder(entry.directory).length) { keep(entry, "mount_boundary", describeHold("mount_boundary"), 0); continue; }
      let bytes = 0;
      try { bytes = (await measureAttemptAllocation(entry.directory, { budgetMs: Math.min(remainingMs(), limits.rootMs) })).bytes; } catch { bytes = 0; }
      const ageMs = Math.max(0, started - stat.ctimeMs);
      ledger.beginRemoval(`${stat.dev}:${stat.ino}`, entry.name, started);
      try { journal("intent", entry.directory, bytes, "tombstone of an interrupted removal; identity matches its name", { reason: "interrupted-removal-finished", ageMs, kind: "scratch", scope: "unregistered", trigger: report.trigger, identity: `${stat.dev}:${stat.ino}` }); }
      catch (error) { report.errors++; keep(entry, "journal_unavailable", `${describeHold("journal_unavailable")}: ${attemptTempFailureDetail(error)}`, bytes); continue; }
      if (await retire(entry, `${stat.dev}:${stat.ino}`, bytes, "interrupted-removal-finished")) {
        report.finishedInterrupted++; report.removedBytes += bytes;
        ledger.clearSkip(entry.name);
        journal("removed", entry.directory, bytes, "interrupted removal finished", { reason: "interrupted-removal-finished", ageMs, kind: "scratch", scope: "unregistered", trigger: report.trigger, identity: `${stat.dev}:${stat.ino}` });
      }
    }

    /** One root's whole proof, cheapest check first. */
    const judge = async (entry: Entry, hold: { code: string }): Promise<Verdict> => {
      const { directory, stat } = entry;
      const miss = (code: string, bytes = 0, reason = describeHold(code), retryAt?: number): Verdict =>
        ({ kind: "keep", code, reason, bytes, retryAt: retryAt ?? started + retryAfter(code) });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return miss("not_directory");
      if (process.getuid && stat.uid !== process.getuid()) return miss("foreign_owner");
      if (stat.dev !== parent.dev) return miss("mount_boundary");
      if (!admitted(directory)) return miss("path_not_admitted");
      if (fs.existsSync(path.join(directory, ".delegatus-keep"))) return miss("keep_marker");
      if (lanes(directory)) return miss("open_lane");
      const identity = `${stat.dev}:${stat.ino}`;
      try { if (attributable(directory, identity)) return miss("attributable_owner"); }
      catch (error) { return miss("evidence_unreadable", 0, `recorded custody could not be read: ${attemptTempFailureDetail(error)}`); }
      if (recordedRootHeld(directory)) return miss("recorded_check_hold");
      const window = Math.min(limits.rootMs, Math.max(1, remainingMs()));
      const cutoff = started - UNREGISTERED_SCRATCH_EXPIRY_MS;
      const walk = await withAttemptTempDeadline(sweepMonotonicNow() + window + ATTEMPT_TEMP_REPLY_MARGIN_MS,
        () => walkTree(directory, stat, cutoff, monotonic() + window, monotonic));
      if (walk.state === "young") return miss("young", 0, `modified ${new Date(walk.newestMs).toISOString()}, inside the 24 h window`, walk.newestMs + UNREGISTERED_SCRATCH_EXPIRY_MS + 1);
      if (walk.state === "mount") return miss("mount_boundary", walk.bytes);
      if (walk.state === "unproven") return miss("activity_unproven", walk.bytes);
      if (walk.state === "unreadable") return miss("unreadable_subtree", walk.bytes);
      const treeHold = await attemptTreeHold(directory, directory, { budgetMs: window, bytes: walk.bytes });
      if (treeHold) return miss(`tree_${treeHold}`, walk.bytes, `tree evidence: ${treeHold.replaceAll("_", " ")}`);
      if (mountPointsUnder(directory).length) return miss("mount_boundary", walk.bytes);
      try { if (ledgerLinkedEvidence(directory).length) return miss("linked_evidence", walk.bytes); }
      catch (error) { return miss("evidence_unreadable", walk.bytes, `${describeHold("evidence_unreadable")}: ${attemptTempFailureDetail(error)}`); }
      const scan = scanWithin(10_000);
      let clear: boolean;
      try {
        if (!ports.references) {
          const warm = await (warmed ??= warmCheckoutInventory(scan, inventory));
          if (warm.incomplete) return { kind: "stop", reason: `checkout link inventory is incomplete (${warm.incomplete} of ${warm.checkouts} checkouts still unread); the reads that finished are kept for the next pass` };
        }
        clear = await unreferenced(directory, scan, hold);
      } catch (error) {
        // One checkout that changed while it was read defers this root only;
        // the pass goes on while its time lasts.
        if (error instanceof AttemptTempBudgetDeferred) {
          if (attemptTempRemaining() <= 0 || remainingMs() <= 0) return { kind: "stop", reason: attemptTempFailureDetail(error) };
          return miss("inventory_deferred", walk.bytes, `a checkout's link inventory was not finished: ${attemptTempFailureDetail(error)}`, started + MINUTE);
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return miss("checkout_unreadable", walk.bytes, `a process's checkout could not be read: ${attemptTempFailureDetail(error)}`);
        throw error;
      }
      if (!clear) return miss(hold.code === "process_reference" ? "live_reference" : `reference_${hold.code}`, walk.bytes, describeHold("live_reference"));
      return { kind: "remove", bytes: walk.bytes, ageMs: Math.max(0, started - walk.newestMs), identity, newestMs: walk.newestMs };
    };

    for (const entry of roots) {
      if (remainingMs() <= 0) { report.deferred ??= "pass time budget spent; the rest waits for the next pass"; break; }
      let owner: ReturnType<AttemptTempStore["owner"]>;
      try { owner = store.owner(entry.directory); }
      catch (error) { if (stateDatabaseBusy(error)) { report.deferred ??= "ledger database is busy"; break; } throw error; }
      // The ledger decides every root that has a proven owner. A root adopted
      // without one is unattributed, which is what this pass is for.
      if (owner && !(owner.pipelineId === null && owner.launchId === "adopted")) { report.registered++; continue; }
      report.found++;
      if (waiting.has(entry.name)) { report.waiting++; continue; }
      if (report.examined >= limits.examine || report.removed + report.wouldRemove >= limits.remove) { report.deferred ??= "per-pass bound reached; the rest waits for the next pass"; continue; }
      report.examined++;
      const hold = { code: "process_reference" };
      let verdict: Verdict;
      try { verdict = await judge(entry, hold); }
      catch (error) {
        if (error instanceof AttemptTempBudgetDeferred) { report.deferred ??= attemptTempFailureDetail(error); break; }
        report.errors++;
        keep(entry, "failed", `examination failed: ${attemptTempFailureDetail(error)}`.slice(0, 512), 0);
        continue;
      }
      if (verdict.kind === "stop") { report.deferred ??= verdict.reason; break; }
      if (verdict.kind === "keep") { keep(entry, verdict.code, verdict.reason, verdict.bytes, verdict.retryAt); continue; }
      if (dry) { report.wouldRemove++; report.wouldRemoveBytes += verdict.bytes; continue; }
      // The last synchronous proofs before the first mutation: the same inode,
      // the same admission, and a fresh process scan.
      const recheck = fs.lstatSync(entry.directory, { throwIfNoEntry: false });
      if (!recheck?.isDirectory() || recheck.isSymbolicLink() || `${recheck.dev}:${recheck.ino}` !== verdict.identity || !admitted(entry.directory)
        || fs.existsSync(path.join(entry.directory, ".delegatus-keep")) || !attemptProcessReferencesClear(entry.directory, entry.directory, scanWithin(1_000))) {
        keep(entry, "changed_before_removal", describeHold("changed_before_removal"), verdict.bytes); continue;
      }
      ledger.beginRemoval(verdict.identity, entry.name, started);
      const proof = `unregistered root: real path equals its path under the scratch root, no tree entry modified since ${new Date(verdict.newestMs).toISOString()} (24 h or more), no live process reference, no evidence, keep, Git or mount hold`;
      try { journal("intent", entry.directory, verdict.bytes, proof, { reason: "expired-24h-unreferenced", ageMs: verdict.ageMs, kind: "scratch", scope: "unregistered", trigger: report.trigger, identity: verdict.identity }); }
      catch (error) { report.errors++; keep(entry, "journal_unavailable", `${describeHold("journal_unavailable")}: ${attemptTempFailureDetail(error)}`.slice(0, 512), verdict.bytes); continue; }
      if (await retire(entry, verdict.identity, verdict.bytes, "expired-24h-unreferenced")) {
        report.removed++; report.removedBytes += verdict.bytes;
        try { journal("removed", entry.directory, verdict.bytes, proof, { reason: report.trigger ? `expired-24h-unreferenced; low free space (${report.trigger})` : "expired-24h-unreferenced", ageMs: verdict.ageMs, kind: "scratch", scope: "unregistered", trigger: report.trigger, identity: verdict.identity }); }
        catch { /* The tree is gone; the intent row stays and the ledger counts the removal. */ }
        ledger.clearSkip(entry.name);
        try { if (store.owner(entry.directory)) store.forget(entry.directory); }
        catch (error) { if (!stateDatabaseBusy(error)) throw error; /* The ledger forgets a missing path on its own. */ }
      }
    }
    if (freeBefore !== null && !dry && (report.removed || report.finishedInterrupted)) {
      try { report.observedFreedBytes = Math.max(0, free() - freeBefore); } catch { /* The per-root allocations stand. */ }
    }
  } catch (error) {
    if (error instanceof FileTransactionBusyError || stateDatabaseBusy(error)) report.deferred ??= "ledger database is busy";
    else if (error instanceof AttemptTempBudgetDeferred) report.deferred ??= attemptTempFailureDetail(error);
    else throw error;
  }
  return finish();
}

/** One pass under the ledger sweep's own admission lock, so overlapping
 * serving generations never delete at once. A busy lock defers the tick. */
export async function runUnregisteredScratchPass(store: AttemptTempStore, ports: UnregisteredScratchPorts): Promise<UnregisteredScratchReport | null> {
  try {
    return await withFileTransactionAsync(store.filename + ".sweep", "attempt-temp unregistered scratch", () => sweepUnregisteredScratch(store, ports),
      { waitMs: Math.min(2_000, attemptTempRemaining(2_000)) });
  } catch (error) {
    if (error instanceof FileTransactionBusyError || stateDatabaseBusy(error)) return null;
    throw error;
  }
}
