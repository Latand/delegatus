import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";
import { isOwnedTempName, ownTempRoots, scanProcesses, sweepRoots, type TempSweepRoot } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { agentConfigSandboxRoot } from "@/lib/runtime/agentConfigSandbox";

/**
 * Free space on the volumes Delegatus writes to: its state directory, the
 * pipeline worktrees and the temp roots. A server once filled its disk and
 * every agent on it died mid-run; this sees it coming.
 *
 * Below `DISK_WARNING_BYTES` on any of them a pressure episode opens: the
 * project orchestrator gets one wake item naming the free space and the
 * largest Delegatus-owned consumers, and the System panel shows it. The
 * episode closes only once every volume is back above
 * `DISK_RECOVERY_BYTES`, so free space wobbling around the threshold is one
 * warning. Below `DISK_CRITICAL_BYTES` a new worktree waits before `git
 * worktree add` with the reason on its lane, and retries by itself; nothing
 * that is already running is stopped.
 * Volumes smaller than 100 GiB use 10%, 12% and 2% of their capacity for
 * warning, recovery and admission, capped by the byte thresholds above.
 */
export const DISK_WARNING_BYTES = 10 * 1024 ** 3;
export const DISK_RECOVERY_BYTES = 12 * 1024 ** 3;
export const DISK_CRITICAL_BYTES = 2 * 1024 ** 3;
export const DISK_SPACE_RETRY_MS = 60_000;
export const DISK_SPACE_WAIT_PREFIX = "waiting for disk space:";
/** The volumes are read at most this often; every resources poll asks. */
const OBSERVATION_TTL_MS = 30_000;
/** Consumer sizes walk every checkout; one walk per this long, and only in an episode. */
const CONSUMER_CACHE_MS = 30 * 60_000;
/** The wake waits this long for the consumer sizes before it goes without them. */
const CONSUMER_WAKE_WAIT_MS = 15 * 60_000;

export type DiskVolume = { roles: string[]; freeBytes: number | null; totalBytes?: number; provisioning?: boolean; level: "ok" | "warning" | "critical" | "unknown" };
export type DiskConsumer = { kind: "state" | "worktrees" | "temp"; bytes: number; measuredAt: string };
export type DiskPressure = { at: string; episode: string | null; volumes: DiskVolume[]; consumers: DiskConsumer[]; warningBytes: number; criticalBytes: number };
export type DiskRoot = { role: string; directory: string; provisioning?: boolean };
export type DiskProbe = (directory: string) => { volume: string; freeBytes: number; totalBytes?: number } | null;

/** Small volumes use 10%, 12% and 2% of their capacity respectively. */
function threshold(bytes: number, totalBytes?: number): number {
  return totalBytes === undefined ? bytes : Math.min(bytes, totalBytes * bytes / (100 * 1024 ** 3));
}

/** Provisioning may name a checkout that does not exist yet. */
export const probeDisk: DiskProbe = (directory) => {
  let current = path.resolve(directory);
  // A dead namespace anchor must never fall back onto procfs.
  const namespaceRoot = current.match(/^(\/proc\/\d+\/root)(?:\/|$)/)?.[1];
  for (;;) {
    try {
      const stat = fs.statSync(current);
      const disk = fs.statfsSync(current);
      return { volume: String(stat.dev), freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize };
    } catch {
      if (current === namespaceRoot) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
};

/** One row per volume; available bytes are those this user can allocate. */
export function diskVolumes(roots: readonly DiskRoot[], probe: DiskProbe = probeDisk): DiskVolume[] {
  const volumes = new Map<string, DiskVolume>();
  for (const root of roots) {
    const observation = probe(root.directory);
    const key = observation?.volume ?? `unknown:${root.role}`;
    const free = observation?.freeBytes ?? null;
    const row = volumes.get(key);
    if (row) {
      if (!row.roles.includes(root.role)) row.roles.push(root.role);
      if (root.provisioning) row.provisioning = true;
      if (free !== null) row.freeBytes = Math.min(row.freeBytes ?? free, free);
    } else volumes.set(key, { roles: [root.role], freeBytes: free,
      ...(root.provisioning ? { provisioning: true } : {}),
      ...(observation?.totalBytes === undefined ? {} : { totalBytes: observation.totalBytes }), level: "unknown" });
  }
  return [...volumes.values()].map(row => ({ ...row, level: row.freeBytes === null ? "unknown"
    : row.freeBytes < threshold(DISK_CRITICAL_BYTES, row.totalBytes) ? "critical" : row.freeBytes < threshold(DISK_WARNING_BYTES, row.totalBytes) ? "warning" : "ok" }));
}

/** Every stage writes scratch and agent config. Full-access Claude also
    keeps background-task output on its pre-stage temp destination. Resolve
    config with the same scratch environment the spawn boundary hands it. */
function stageDiskRoots(source: NodeJS.ProcessEnv): DiskRoot[] {
  const scratch = statePath("scratch");
  return [{ role: "state", directory: scratch, provisioning: true },
    { role: "state", directory: agentConfigSandboxRoot({ ...source, TMPDIR: path.join(scratch, "tmp") }), provisioning: true },
    { role: "temp", directory: source.CLAUDE_CODE_TMPDIR || source.TMPDIR || os.tmpdir(), provisioning: true }];
}

function rootsForProvision(repoDir: string, worktreeDir: string, source: NodeJS.ProcessEnv): DiskRoot[] {
  return [{ role: "state", directory: stateDir() }, { role: "worktrees", directory: worktreeDir },
    { role: "repository", directory: repoDir }, ...stageDiskRoots(source)];
}

/** Admission only. A low volume never changes an existing agent's lifecycle. */
export function worktreeDiskWait(repoDir: string, worktreeDir: string, probe: DiskProbe = probeDisk, source: NodeJS.ProcessEnv = process.env): string | null {
  const low = diskVolumes(rootsForProvision(repoDir, worktreeDir, source), probe).filter(row => row.level === "critical");
  return low.length ? `${DISK_SPACE_WAIT_PREFIX} ${low.map(row => `${row.roles.join("/")} has ${formatDiskBytes(row.freeBytes!)} free (needs ${formatDiskBytes(threshold(DISK_CRITICAL_BYTES, row.totalBytes))})`).join("; ")}; retries automatically` : null;
}

export function formatDiskBytes(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(2)} GiB`; }
export function diskPressureLabel(pressure: DiskPressure): string {
  const low = pressure.volumes.filter(row => row.level === "warning" || row.level === "critical");
  const consumers = [...pressure.consumers].sort((a, b) => b.bytes - a.bytes);
  const shown = low.length ? low : pressure.volumes;
  return `${low.length ? "Disk space low" : "Disk space warning"}: ${shown.map(row => `${row.roles.join("/")} ${row.freeBytes === null ? "free space unavailable" : `${formatDiskBytes(row.freeBytes)} free`}`).join("; ")}`
    + (consumers.length ? `; largest Delegatus consumers (allocated lower bounds): ${consumers.map(row => `${row.kind} ${formatDiskBytes(row.bytes)}`).join(", ")}` : "; consumer measurement pending");
}

/** A stable episode makes a changing free-space value one warning. Recovery
    creates a new episode on the next crossing, including across restarts. */
export function observeDiskPressure(volumes: DiskVolume[], prior: DiskPressure | null, at: string): DiskPressure {
  const low = volumes.some(row => row.level === "warning" || row.level === "critical");
  const unknown = volumes.some(row => row.level === "unknown");
  const recovering = volumes.some(row => row.freeBytes !== null && row.freeBytes < threshold(DISK_RECOVERY_BYTES, row.totalBytes));
  const episode = low ? prior?.episode ?? at : unknown || recovering ? prior?.episode ?? null : null;
  return { at, volumes, consumers: episode && episode === prior?.episode ? prior.consumers : [], warningBytes: DISK_WARNING_BYTES, criticalBytes: DISK_CRITICAL_BYTES, episode };
}

/** The wake item, once the consumer sizes measured in this episode are in,
    or once they have been pending too long to wait for. */
export function diskPressureWakeReady(pressure: DiskPressure, now = Date.now()): boolean {
  if (!pressure.episode) return false;
  return pressure.consumers.length > 0 || now - Date.parse(pressure.episode) >= CONSUMER_WAKE_WAIT_MS;
}

type PressureCache = { pressure: DiskPressure; observedAt: number; consumersAt: number; measuring?: Promise<void> };
const caches = new Map<string, PressureCache>();

function readReport(file: string): DiskPressure | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as DiskPressure; }
  catch { return null; }
}

/** All readers join the same episode under the shared state-file lock. The
    caller's in-memory observation cannot overwrite another process's episode.
    Probe inside the lock so a delayed observation cannot close a newer one. */
export function observeDiskPressureReport(file: string, probe: () => DiskVolume[], at: string): DiskPressure {
  try {
    return withFileTransactionSync(file, "disk pressure report is busy", () => {
      const pressure = observeDiskPressure(probe(), readReport(file), at);
      try { writeJsonDurably(file, pressure); }
      catch { /* A full disk still needs a visible warning. */ }
      return pressure;
    });
  } catch {
    // A full disk can also prevent acquiring the file lock. This read-only
    // observation preserves a persisted episode and cannot replace it.
    return observeDiskPressure(probe(), readReport(file), at);
  }
}
/** The current pressure, read from the volumes at most every 30 s. The
    consumer sizes are walked in the background and arrive on a later read. */
export async function readDiskPressure(ports: {
  /** Independent reader state and observation seams for sandbox checks. */
  caches?: Map<string, PressureCache>;
  roots?: DiskRoot[];
  worktrees?: string[];
  tempRoots?: TempSweepRoot[];
  probe?: DiskProbe;
  now?: () => number;
  readOnly?: boolean;
} = {}): Promise<DiskPressure> {
  const now = ports.now ?? Date.now;
  const readers = ports.caches ?? caches;
  const directory = stateDir();
  const file = statePath("disk-pressure-report.json");
  // MCP may run in the host namespace while the Viewer runs in Docker. Its
  // narrower volume view cannot close the Viewer's episode or repeat its
  // consumer walks. Every resources read gets the authoritative report.
  if (ports.readOnly ?? process.env.LLV_STATE_OWNER === "mcp")
    return readReport(file) ?? observeDiskPressure([], null, new Date(now()).toISOString());
  let cached = readers.get(directory);
  if (!cached) {
    const prior = readReport(file);
    cached = { pressure: prior ?? observeDiskPressure([], null, new Date(now()).toISOString()), observedAt: 0, consumersAt: 0 };
    readers.set(directory, cached);
  }
  if (now() - cached.observedAt < OBSERVATION_TTL_MS) return structuredClone(cached.pressure);
  cached.observedAt = now();
  /* Loaded here: the pipeline engine imports this module for its admission check. */
  const [{ loadPipelinesForList }, { exclusiveBytes, readWorktreeSweepReport, hostTempWorktreeAccess }] = await Promise.all([
    import("@/lib/pipelines/store"),
    import("@/lib/pipelines/worktreeSweep"),
  ]);
  const pipelines = ports.roots ? [] : loadPipelinesForList();
  const sweep = ports.roots ? null : readWorktreeSweepReport();
  const worktrees = ports.worktrees ?? [...new Set([...pipelines.map(row => row.worktreeDir), ...(sweep?.kept ?? []).map(row => row.path)].filter(Boolean))];
  const tempRoots = ports.tempRoots ?? (ports.roots ? [] : sweepRoots(scanProcesses(), [...ownTempRoots(), statePath("scratch")]));
  const accessible = hostTempWorktreeAccess(tempRoots).accessiblePath;
  const roots: DiskRoot[] = ports.roots ?? [{ role: "state", directory }, ...stageDiskRoots(process.env),
    ...worktrees.map(directory => ({ role: "worktrees", directory: accessible(directory) })),
    ...tempRoots.map(root => ({ role: "temp", directory: root.via + root.path }))];
  const previousEpisode = cached.pressure.episode;
  cached.pressure = observeDiskPressureReport(file, () => diskVolumes(roots, ports.probe), new Date(now()).toISOString());
  if (previousEpisode !== cached.pressure.episode) {
    cached.consumersAt = 0;
  }
  if (cached.pressure.episode && now() - cached.consumersAt > CONSUMER_CACHE_MS && !cached.measuring) {
    const target = cached;
    const episode = cached.pressure.episode;
    target.measuring = (async () => {
      const measuredAt = new Date(now()).toISOString();
      const stateBytes = await exclusiveBytes(directory);
      let worktreeBytes = 0;
      // Nested linked checkouts must be measured once, through the outer one.
      for (const worktree of worktrees.filter(candidate => !worktrees.some(other => other !== candidate && candidate.startsWith(other + path.sep))))
        worktreeBytes += await exclusiveBytes(accessible(worktree));
      let tempBytes = 0;
      const measuredTemp = new Set<string>();
      for (const root of tempRoots) {
        const base = root.via + root.path;
        try {
          for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory() || !isOwnedTempName(entry.name)) continue;
            const child = path.join(base, entry.name);
            const canonicalChild = path.join(root.path, entry.name);
            if (worktrees.some(worktree => worktree === canonicalChild || worktree.startsWith(canonicalChild + path.sep))) continue;
            const stat = fs.statSync(child);
            const identity = `${stat.dev}:${stat.ino}`;
            if (measuredTemp.has(identity)) continue;
            measuredTemp.add(identity);
            tempBytes += await exclusiveBytes(child);
          }
        } catch { /* An inaccessible root has no attributable consumer count. */ }
      }
      if (target.pressure.episode !== episode) return;
      target.pressure.consumers = [{ kind: "state", bytes: stateBytes, measuredAt }, { kind: "worktrees", bytes: worktreeBytes, measuredAt }, { kind: "temp", bytes: tempBytes, measuredAt }];
      target.consumersAt = now();
      withFileTransactionSync(file, "disk pressure report is busy", () => {
        const latest = readReport(file);
        if (latest?.episode !== episode) return;
        writeJsonDurably(file, { ...latest, consumers: target.pressure.consumers });
      });
    })().catch((error) => console.warn("[disk pressure] consumer measurement failed", error instanceof Error ? error.message : String(error)))
      .finally(() => { delete target.measuring; });
  }
  return structuredClone(cached.pressure);
}
