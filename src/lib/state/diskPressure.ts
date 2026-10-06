import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";

import { stateDir, statePath } from "@/lib/configDir";
import { isOwnedTempConsumerName, ownTempRoots, scanProcesses, sweepRoots, type TempSweepRoot } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { agentConfigSandboxRoot } from "@/lib/runtime/agentConfigSandbox";
import { systemBootEpoch } from "@/lib/processIdentity";

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

export type DiskVolume = { volume?: string; views?: string[]; roles: string[]; freeBytes: number | null; totalBytes?: number; provisioning?: boolean; level: "ok" | "warning" | "critical" | "unknown" };
export type DiskConsumer = { kind: "state" | "worktrees" | "temp"; bytes: number; measuredAt: string };
export type DiskPressure = { at: string; episode: string | null; kernelBoot?: string | null; volumes: DiskVolume[]; consumers: DiskConsumer[]; warningBytes: number; criticalBytes: number };
export type DiskRoot = { role: string; directory: string; provisioning?: boolean; view?: TempSweepRoot };
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

function tempViewAvailable(root: TempSweepRoot): boolean {
  if (!root.via) return true;
  if (!root.anchor) return false;
  try { return fs.readlinkSync(path.join(path.dirname(root.via), "ns/mnt")) === root.anchor.namespace; }
  catch { return false; }
}

/** Docker's CLI shims target PID 1. An unrelated agent namespace cannot
    establish a required stage write volume. The image's setuid nsenter can
    read that namespace when direct proc access is denied, as the shims do. */
function stageHostNamespace(): string | null {
  try { return fs.readlinkSync("/proc/1/ns/mnt"); }
  catch { /* PID 1 can belong to another user. */ }
  try {
    const result = childProcess.spawnSync("nsenter", ["-t", "1", "-m", "-p", "--", "/usr/bin/setpriv",
      `--reuid=${process.getuid?.() ?? 0}`, `--regid=${process.getgid?.() ?? 0}`,
      `--groups=${process.getgroups?.().join(",") ?? ""}`, "--", "/bin/readlink", "/proc/self/ns/mnt"],
    { encoding: "utf8", timeout: 2_000 });
    const namespace = result.stdout?.trim();
    return result.status === 0 && /^mnt:\[\d+\]$/.test(namespace) ? namespace : null;
  } catch { return null; }
}

/** One row per volume; available bytes are those this user can allocate. */
export function diskVolumes(roots: readonly DiskRoot[], probe: DiskProbe = probeDisk): DiskVolume[] {
  const volumes = new Map<string, DiskVolume>();
  for (const root of roots) {
    let observation = !root.view || tempViewAvailable(root.view) ? probe(root.directory) : null;
    if (root.view && !tempViewAvailable(root.view)) observation = null;
    const key = observation?.volume ?? `unknown:${root.role}`;
    const free = observation?.freeBytes ?? null;
    // A view identifies one monitored host temp root without exposing paths.
    const view = root.view?.via && root.view.anchor ? `${root.view.anchor.namespace}:${createHash("sha256").update(root.view.path).digest("hex").slice(0, 16)}` : null;
    const row = volumes.get(key);
    if (row) {
      if (!row.roles.includes(root.role)) row.roles.push(root.role);
      if (view && !row.views?.includes(view)) (row.views ??= []).push(view);
      if (root.provisioning) row.provisioning = true;
      if (free !== null) row.freeBytes = Math.min(row.freeBytes ?? free, free);
    } else volumes.set(key, { ...(observation ? { volume: observation.volume } : {}), ...(view ? { views: [view] } : {}), roles: [root.role], freeBytes: free,
      ...(root.provisioning ? { provisioning: true } : {}),
      ...(observation?.totalBytes === undefined ? {} : { totalBytes: observation.totalBytes }), level: "unknown" });
  }
  return [...volumes.values()].map(row => ({ ...row, level: row.freeBytes === null ? "unknown"
    : row.freeBytes < threshold(DISK_CRITICAL_BYTES, row.totalBytes) ? "critical" : row.freeBytes < threshold(DISK_WARNING_BYTES, row.totalBytes) ? "warning" : "ok" }));
}

/** Every stage writes scratch and agent config. Full-access Claude also
    keeps background-task output on its pre-stage temp destination. Resolve
    config with the same scratch environment the spawn boundary hands it. */
function stageDiskRoots(source: NodeJS.ProcessEnv, tempRoots: readonly TempSweepRoot[] = []): DiskRoot[] {
  const scratch = statePath("scratch");
  const roots: DiskRoot[] = [{ role: "state", directory: scratch, provisioning: true },
    { role: "state", directory: agentConfigSandboxRoot({ ...source, TMPDIR: path.join(scratch, "tmp") }), provisioning: true },
    { role: "temp", directory: source.CLAUDE_CODE_TMPDIR || source.TMPDIR || os.tmpdir(), provisioning: true }];
  // The image's CLI shims enter the host namespace. Their canonical temp
  // paths can name another volume there; use the same validated views as
  // cleanup, and include only actual stage destinations in admission.
  const namespaces = new Set<string>();
  const hostNamespace = source.LLV_DOCKER_NSENTER_SHIMS === "1" && tempRoots.some(root => root.via) ? stageHostNamespace() : null;
  if (source.LLV_DOCKER_NSENTER_SHIMS === "1") for (const temp of tempRoots) {
    if (!temp.via || !temp.anchor) continue;
    if (temp.anchor.namespace !== hostNamespace) continue;
    if (namespaces.has(temp.anchor.namespace)) continue;
    if (!tempViewAvailable(temp)) continue;
    namespaces.add(temp.anchor.namespace);
    for (const root of roots.slice(0, 3)) roots.push({ ...root, directory: temp.via + root.directory, view: temp });
  }
  return roots;
}

function rootsForProvision(repoDir: string, worktreeDir: string, source: NodeJS.ProcessEnv, tempRoots?: readonly TempSweepRoot[]): DiskRoot[] {
  const views = tempRoots ?? (source.LLV_DOCKER_NSENTER_SHIMS === "1" ? sweepRoots(scanProcesses(), ownTempRoots(source)) : []);
  return [{ role: "state", directory: stateDir() }, { role: "worktrees", directory: worktreeDir },
    { role: "repository", directory: repoDir }, ...stageDiskRoots(source, views)];
}

/** Admission only. A low volume never changes an existing agent's lifecycle. */
export function worktreeDiskWait(repoDir: string, worktreeDir: string, probe: DiskProbe = probeDisk, source: NodeJS.ProcessEnv = process.env, tempRoots?: readonly TempSweepRoot[]): string | null {
  const low = diskVolumes(rootsForProvision(repoDir, worktreeDir, source, tempRoots), probe).filter(row => row.level === "critical");
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
export function observeDiskPressure(volumes: DiskVolume[], prior: DiskPressure | null, at: string,
  // Docker succession changes the PID namespace while the kernel boot stays.
  kernelBoot = systemBootEpoch()?.split(":pidns:")[0] ?? null): DiskPressure {
  // Losing a namespace view cannot prove its pressured volume recovered.
  // Persist physical volume identities so a restart keeps that uncertainty.
  const observed = new Set(volumes.map(row => row.volume).filter(Boolean));
  const observedViews = new Set(volumes.filter(row => row.level !== "unknown").flatMap(row => row.views ?? []));
  const missing = prior?.episode && prior.kernelBoot === kernelBoot ? prior.volumes.filter(row => row.volume && row.views?.length
    && !observed.has(row.volume) && !row.views.every(view => observedViews.has(view))
    && (row.level === "unknown" || (row.freeBytes !== null && row.freeBytes < threshold(DISK_RECOVERY_BYTES, row.totalBytes)))) : [];
  volumes = [...volumes, ...missing.map(row => ({ ...row, freeBytes: null, level: "unknown" as const }))];
  const low = volumes.some(row => row.level === "warning" || row.level === "critical");
  const unknown = volumes.some(row => row.level === "unknown");
  const recovering = volumes.some(row => row.freeBytes !== null && row.freeBytes < threshold(DISK_RECOVERY_BYTES, row.totalBytes));
  const episode = low ? prior?.episode ?? at : unknown || recovering ? prior?.episode ?? null : null;
  return { at, kernelBoot, volumes, consumers: episode && episode === prior?.episode ? prior.consumers : [], warningBytes: DISK_WARNING_BYTES, criticalBytes: DISK_CRITICAL_BYTES, episode };
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
  const pipelines = ports.roots || ports.worktrees ? [] : loadPipelinesForList();
  const sweep = ports.roots || ports.worktrees ? null : readWorktreeSweepReport();
  const worktrees = ports.worktrees ?? [...new Set([...pipelines.map(row => row.worktreeDir), ...(sweep?.kept ?? []).map(row => row.path)].filter(Boolean))];
  const tempRoots = ports.tempRoots ?? (ports.roots ? [] : sweepRoots(scanProcesses(), [...ownTempRoots(), statePath("scratch")]));
  const accessible = hostTempWorktreeAccess(tempRoots).accessiblePath;
  const worktreeView = (directory: string) => tempRoots.find(root => root.via && root.anchor
    && (directory === root.path || directory.startsWith(root.path + path.sep)));
  const roots: DiskRoot[] = ports.roots ?? [{ role: "state", directory }, ...stageDiskRoots(process.env, tempRoots),
    ...worktrees.map(directory => ({ role: "worktrees", directory: accessible(directory), view: worktreeView(directory) })),
    ...tempRoots.map(root => ({ role: "temp", directory: root.via + root.path, view: root }))];
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
      const worktreePaths = worktrees.map(accessible);
      const seenDirectories = new Set<string>();
      const stateBytes = await exclusiveBytes(directory, worktreePaths, seenDirectories);
      let worktreeBytes = 0;
      // Nested linked checkouts must be measured once, through the outer one.
      for (const worktree of worktrees.filter(candidate => !worktrees.some(other => other !== candidate && candidate.startsWith(other + path.sep)))) {
        const view = worktreeView(worktree);
        if (view && !tempViewAvailable(view)) continue;
        const bytes = await exclusiveBytes(accessible(worktree), [directory], seenDirectories);
        if (!view || tempViewAvailable(view)) worktreeBytes += bytes;
      }
      let tempBytes = 0;
      for (const root of tempRoots) {
        if (!tempViewAvailable(root)) continue;
        const base = root.via + root.path;
        try {
          for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory() || !isOwnedTempConsumerName(entry.name)) continue;
            const child = path.join(base, entry.name);
            const canonicalChild = path.join(root.path, entry.name);
            // Scratch is part of state. Other owned roots can contain both a
            // checkout and independent role files; exclude only the checkout.
            if (canonicalChild === directory || canonicalChild.startsWith(directory + path.sep)) continue;
            if (!tempViewAvailable(root)) break;
            const bytes = await exclusiveBytes(child, [directory, ...worktreePaths], seenDirectories);
            if (tempViewAvailable(root)) tempBytes += bytes;
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
