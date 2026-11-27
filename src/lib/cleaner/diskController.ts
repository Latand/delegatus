import fs from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { attemptTempConfigParent } from "@/lib/runtime/attemptTempPaths";
import { assertRetentionTestPath } from "@/lib/retentionTestSafety";
import { diskVolumes, type DiskPressure, type DiskRoot } from "@/lib/state/diskPressure";
import { ownTempRoots } from "@/lib/tempSweep";
import { includeIdleHostViews, tempViewAvailable } from "@/lib/state/hostTempViews";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { FileTransactionBusyError, withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { STATE_LOCK_WAIT_MS } from "@/lib/state/lockWait";
import { tempSweepMode } from "@/lib/tempSweep";
import {
  cleanerJournalFile, createCleanerJournal, DISK_CLEANER_CLASSES, diskCleanerStateFile, type CleanerHold, type CleanerSlice, type DiskCleanerClass,
} from "./diskJournal";
import { readDiskCleanerPass, type CleanerSpace, type DiskCleanerPass } from "./diskState";
import { recordDiskCleanerReport } from "./diskReport";
import type { CleanerSweepRequest, CleanerSweepResult } from "./diskSweep";
import { SweepWalkDeferred } from "@/lib/pipelines/sweepWalkAdmission";

const DEFAULT_FREE_GB = 150;
export const DISK_CLEANER_COOLDOWN_MS = 15 * 60_000;
const UNCHANGED_RETRY_MS = 60 * 60_000;
const PASS_BUDGET_MS = 20 * 60_000;
const EVIDENCE_SLICES = 16;

export function diskCleanerThreshold(env: Readonly<Record<string, string | undefined>> = process.env) {
  const raw = env.LLV_CLEANER_FREE_GB?.trim();
  const value = raw ? Number(raw) : DEFAULT_FREE_GB;
  return Number.isFinite(value * 1e9) && value >= 0 ? value * 1e9 : DEFAULT_FREE_GB * 1e9;
}

function needsCleaning(pressure: DiskPressure, threshold: number, readings: CleanerSpace[]) {
  return pressure.volumes.some(row => row.level === "warning" || row.level === "critical")
    || [...pressure.volumes, ...readings].some(row => row.freeBytes !== null && row.freeBytes < threshold);
}

/** A bounded hint for scheduling only. Descendant-only changes that cannot
 * reach these timestamps still get a full audit on the next retry. */
function retainedStamp(kept: CleanerHold[]): string {
  const hash = createHash("sha256");
  for (const file of [statePath("scratch"), attemptTempConfigParent(), statePath("evidence"),
    statePath("self-update", "releases"), ...kept.slice(0, 5).map(row => row.path)]) {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      hash.update(`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}\n`);
    } catch (error) { hash.update(`${(error as NodeJS.ErrnoException).code ?? "unreadable"}\n`); }
  }
  return hash.digest("hex");
}

export function measureCleanerSpace(pressure?: DiskPressure, preserveTrigger = false): CleanerSpace[] {
  const roots: DiskRoot[] = [{ role: "root", directory: "/" }, { role: "state", directory: statePath() },
    { role: "attempt config", directory: attemptTempConfigParent() }, { role: "checkout", directory: process.cwd() }];
  if (pressure?.volumes.some(row => row.views?.length)) {
    const views = includeIdleHostViews(ownTempRoots().map(path => ({ path, via: "" })));
    for (const observed of pressure.volumes) for (const view of views) {
      if (!observed.volume || !view.via || !view.anchor || !tempViewAvailable(view)) continue;
      const key = `${view.anchor.namespace}:${createHash("sha256").update(view.path).digest("hex").slice(0, 16)}`;
      if (observed.views?.includes(key)) roots.push({ role: observed.roles.join("/"), directory: view.via + view.path, view });
    }
  }
  if (pressure?.volumes.length && process.platform === "linux") {
    const wanted = new Map(pressure.volumes.filter(row => row.volume).map(row => [row.volume!, row.roles.join("/")]));
    const present = new Set(diskVolumes(roots).map(row => row.volume).filter((volume): volume is string => !!volume));
    try {
      for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
        const fields = line.split(" ");
        const mount = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
        if (!mount) continue;
        let volume: string;
        try { volume = String(fs.statSync(mount).dev); } catch { continue; }
        const role = wanted.get(volume);
        if (role && !present.has(volume)) {
          roots.push({ role, directory: mount }); present.add(volume);
        }
      }
    } catch { /* Fixed path readings remain useful when mount inventory is unavailable. */ }
  }
  const measured = diskVolumes(roots)
    .map(row => ({ volume: row.volume ?? `unknown:${row.roles.join("/")}`, roles: row.roles, freeBytes: row.freeBytes }));
  if (pressure) for (const observed of pressure.volumes) {
    const volume = observed.volume ?? `unknown:${observed.roles.join("/")}`;
    if (!measured.some(row => row.volume === volume)) measured.push({ volume, roles: observed.roles,
      // The trigger was sampled through disk-pressure's validated host view.
      // Use that reading for admission; if it cannot be sampled after cleanup,
      // retain the volume as explicitly unknown.
      freeBytes: preserveTrigger ? observed.freeBytes : null });
  }
  return measured;
}

async function readJournal(id: string) {
  const removed: Record<DiskCleanerClass, number> = { "attempt-temp": 0, release: 0, evidence: 0 };
  const pending = new Set<string>();
  let errors = 0;
  const lines = createInterface({ input: fs.createReadStream(cleanerJournalFile(id)), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const row = JSON.parse(line);
        const kind = row.class as DiskCleanerClass;
        if (!DISK_CLEANER_CLASSES.includes(kind) || typeof row.path !== "string"
          || !Number.isFinite(row.bytes) || row.bytes < 0 || typeof row.proof !== "string") throw new Error("invalid removal record");
        const key = JSON.stringify([kind, row.path]);
        if (row.phase === "intent") pending.add(key);
        else if (row.phase === "removed" && pending.delete(key)) removed[kind] += row.bytes;
        else if (row.phase === "refused" && pending.delete(key)) continue;
        else throw new Error("unbound removal record");
      } catch { errors++; }
    }
  } catch { errors++; }
  return { removed, uncertain: pending.size, errors };
}

type Ports = {
  active: () => boolean;
  project: () => Promise<string | null>;
  card: (pass: DiskCleanerPass) => Promise<boolean>;
  sweep: (request: CleanerSweepRequest) => Promise<CleanerSweepResult>;
  releases: (id: string) => Promise<CleanerSlice>;
  now?: () => number;
  measure?: (pressure: DiskPressure) => CleanerSpace[];
  env?: Readonly<NodeJS.ProcessEnv>;
};

/** One host-wide pass. The async file lease covers Viewers that overlap
 * during succession, and the durable finish time owns the cooldown. */
export async function reconcileAutomaticDiskCleaner(pressure: DiskPressure, ports: Ports) {
  const env = ports.env ?? process.env, now = ports.now ?? Date.now;
  const mode = env.LLV_CLEANER === "dry-run" ? "dry-run" : tempSweepMode(env);
  const active = () => !!mode && env.LLV_CLEANER !== "off" && ports.active();
  if (!active()) return;
  const file = diskCleanerStateFile();
  assertRetentionTestPath(file);
  const readSpace = (after = false) => {
    if (ports.measure) return ports.measure(pressure);
    return measureCleanerSpace(pressure, !after);
  };
  const threshold = diskCleanerThreshold(env);
  const cooling = (pass: DiskCleanerPass | null) => {
    if (!pass?.finished) return false;
    const { finished } = pass;
    if (now() < finished.at + DISK_CLEANER_COOLDOWN_MS) return true;
    const retained = finished.retained;
    return pass.mode === mode && pass.episode === pressure.episode && retained && now() < retained.retryAt
      && retained.retryAt <= finished.at + UNCHANGED_RETRY_MS && retained.stamp === retainedStamp(finished.kept)
      && !pressure.volumes.some(row => row.freeBytes !== null && finished.after.some(prior => prior.volume === row.volume
        && prior.freeBytes !== null && prior.freeBytes - row.freeBytes! >= 1024 ** 3));
  };
  const existing = readDiskCleanerPass();
  if (existing?.card && cooling(existing)) return;
  const before = readSpace();
  if ((!existing || existing.finished && existing.card) && !needsCleaning(pressure, threshold, before)) return;
  try {
    await withFileTransactionAsync(file, "automatic disk cleaner", async () => {
      if (!active()) return;
      let pass = readDiskCleanerPass();
      const finish = async (run: DiskCleanerPass, kept: CleanerHold[], errors: number, incomplete: boolean, fingerprint?: string) => {
        const journal = await readJournal(run.id);
        const at = now();
        const unchanged = !!pass && pass.project === run.project && pass.mode === run.mode && pass.episode === run.episode
          && pass.finished?.retained?.fingerprint === fingerprint;
        const retained = fingerprint && !incomplete && journal.uncertain === 0 && Object.values(journal.removed).every(bytes => bytes === 0)
          ? { fingerprint, stamp: retainedStamp(kept), retryAt: at + (unchanged ? UNCHANGED_RETRY_MS : DISK_CLEANER_COOLDOWN_MS) }
          : undefined;
        const result = { ...run, finished: { ...journal, errors: errors + journal.errors, incomplete, kept, at, after: readSpace(true), retained } };
        writeJsonDurably(file, result);
        return result;
      };
      if (pass && !pass.finished) pass = await finish(pass, [], 0, true);
      if (pass?.finished && !pass.card && active()) {
        pass = await recordDiskCleanerReport(pass);
        if (await ports.card(pass)) {
          pass = { ...pass, card: true };
          writeJsonDurably(file, pass);
        }
      }
      if (!active() || pass?.finished && (!pass.card || cooling(pass))) return;
      const before = readSpace();
      if (!needsCleaning(pressure, threshold, before)) return;
      const project = await ports.project();
      if (!active() || !project) return;
      const run: DiskCleanerPass = { id: randomUUID(), project, mode: mode!, episode: pressure.episode, startedAt: now(),
        before, scratchCursor: pass?.scratchCursor ?? "" };
      createCleanerJournal(run.id);
      writeJsonDurably(file, run);
      let kept: CleanerHold[] = [];
      let errors = 0, incomplete = false;
      let deferred = false;
      const retained = createHash("sha256");
      const next = (slice: CleanerSlice) => {
        errors += slice.errors;
        for (const row of slice.kept) retained.update(JSON.stringify([row.path, row.reason, row.bytes]) + "\n");
        kept = [...kept, ...slice.kept].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 5);
      };
      const attempt = async <T extends CleanerSlice>(operation: () => Promise<T>) => {
        try { const slice = await operation(); next(slice); return slice; }
        catch (error) {
          if (error instanceof SweepWalkDeferred) { deferred = true; return null; }
          errors++; incomplete = true;
          console.error("[disk cleaner] sweep failed", error instanceof Error ? error.message : String(error));
          return null;
        }
      };
      const started = performance.now();
      const mayContinue = () => !deferred && active() && performance.now() - started < PASS_BUDGET_MS;
      if (mayContinue()) await attempt(() => ports.releases(run.id));
      let evidenceMore = true;
      for (let page = 0; page < EVIDENCE_SLICES && evidenceMore && mayContinue(); page++) {
        const slice = await attempt(() => ports.sweep({ id: run.id, class: "evidence" }));
        evidenceMore = !!slice?.more;
      }
      while (mayContinue()) {
        const cursor = run.scratchCursor!;
        const slice = await attempt(() => ports.sweep({ id: run.id, class: "attempt-temp", after: cursor }));
        if (!slice) break;
        if (slice.more && (!slice.next || slice.next <= cursor)) { incomplete = true; break; }
        run.scratchCursor = slice.next ?? "";
        if (!slice.more) break;
        writeJsonDurably(file, run);
      }
      pass = await finish(run, kept, errors, incomplete || evidenceMore || !mayContinue() || !!run.scratchCursor, retained.digest("hex"));
      if (active()) {
        await recordDiskCleanerReport(pass);
        if (await ports.card(pass)) writeJsonDurably(file, { ...pass, card: true });
      }
    }, { waitMs: STATE_LOCK_WAIT_MS });
  } catch (error) {
    if (!(error instanceof FileTransactionBusyError)) throw error;
  }
}
