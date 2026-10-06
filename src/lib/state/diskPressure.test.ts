import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exclusiveBytes } from "@/lib/pipelines/worktreeSweep";
import { agentConfigSandboxRoot } from "@/lib/runtime/agentConfigSandbox";

import {
  DISK_CRITICAL_BYTES,
  DISK_RECOVERY_BYTES,
  DISK_SPACE_WAIT_PREFIX,
  DISK_WARNING_BYTES,
  diskPressureLabel,
  diskPressureWakeReady,
  diskVolumes,
  observeDiskPressure,
  observeDiskPressureReport,
  probeDisk,
  readDiskPressure,
  worktreeDiskWait,
  type DiskProbe,
} from "./diskPressure";

/* Every volume here is a fake probe answer: nothing reads a real disk. */
const GiB = 1024 ** 3;
const probe = (free: Record<string, number>): DiskProbe => (directory) => {
  const volume = Object.keys(free).find((prefix) => directory.startsWith(prefix));
  return volume ? { volume, freeBytes: free[volume]! } : null;
};

test("roots on one volume are one row at the lowest free space, with a level per threshold", () => {
  const volumes = diskVolumes([
    { role: "state", directory: "/srv/state" },
    { role: "worktrees", directory: "/srv/lanes/a" },
    { role: "temp", directory: "/tmp/x" },
    { role: "temp", directory: "/elsewhere" },
  ], probe({ "/srv": DISK_WARNING_BYTES - 1, "/tmp": DISK_CRITICAL_BYTES - 1 }));
  expect(volumes).toEqual([
    { roles: ["state", "worktrees"], freeBytes: DISK_WARNING_BYTES - 1, level: "warning" },
    { roles: ["temp"], freeBytes: DISK_CRITICAL_BYTES - 1, level: "critical" },
    { roles: ["temp"], freeBytes: null, level: "unknown" },
  ]);
});

test("an empty small temp volume opens no episode, and nearly full still warns", () => {
  const roots = [{ role: "temp", directory: "/tmp" }];
  const volumes = (freeBytes: number) => diskVolumes(roots, () => ({ volume: "tmpfs", freeBytes, totalBytes: 4 * GiB }));
  const healthy = volumes(3.9 * GiB);
  expect(healthy[0]!.level).toBe("ok");
  expect(observeDiskPressure(healthy, null, "2026-10-06T10:00:00Z").episode).toBeNull();
  const warning = observeDiskPressure(volumes(0.2 * GiB), null, "2026-10-06T10:01:00Z");
  expect(warning.volumes[0]!.level).toBe("warning");
  expect(warning.episode).not.toBeNull();
  expect(volumes(0.01 * GiB)[0]!.level).toBe("critical");
  expect(observeDiskPressure(volumes(0.45 * GiB), warning, "2026-10-06T10:02:00Z").episode).toBe(warning.episode);
  expect(observeDiskPressure(healthy, warning, "2026-10-06T10:03:00Z").episode).toBeNull();
});

test("provisioning checks its write destinations and ignores unrelated temp volumes", () => {
  const visited: string[] = [];
  const stub: DiskProbe = directory => {
    visited.push(directory);
    return directory === "/tmp" || directory === "/var/tmp"
      ? { volume: "tmpfs", freeBytes: 1.8 * GiB, totalBytes: 2 * GiB }
      : { volume: "disk", freeBytes: 500 * GiB, totalBytes: 1000 * GiB };
  };
  expect(worktreeDiskWait("/srv/repo", "/srv/repo-pipeline-a", stub)).toBeNull();
  expect(visited).not.toContain("/tmp");
  expect(visited).not.toContain("/var/tmp");
  expect(visited.some(directory => path.basename(directory) === "scratch")).toBe(true);
});

test("stage config and Claude temp destinations wait when critical and resume after recovery", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = "/srv/delegatus-config/agent-log-viewer/state";
  const source = { XDG_CONFIG_HOME: "/srv/delegatus-config", TMPDIR: "/srv/agent-temp", CLAUDE_CODE_TMPDIR: "/srv/claude-temp" };
  process.env.LLV_STATE_DIR = state;
  try {
    const config = agentConfigSandboxRoot({ ...source, TMPDIR: path.join(state, "scratch/tmp") });
    expect(config.startsWith(path.join(state, "scratch") + path.sep)).toBe(false);
    for (const low of [config, source.CLAUDE_CODE_TMPDIR]) {
      let freeBytes = GiB;
      const visited: string[] = [];
      const stub: DiskProbe = directory => {
        visited.push(directory);
        return { volume: directory === low ? "stage-temp" : "disk", freeBytes: directory === low ? freeBytes : 500 * GiB, totalBytes: 1000 * GiB };
      };
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source)).toContain("1.00 GiB free");
      expect(visited).toContain(low);
      freeBytes = 20 * GiB;
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source)).toBeNull();
    }
    const small: DiskProbe = directory => directory === config
      ? { volume: "small-temp", freeBytes: 3.9 * GiB, totalBytes: 4 * GiB }
      : { volume: "disk", freeBytes: 500 * GiB, totalBytes: 1000 * GiB };
    expect(worktreeDiskWait("/srv/repo", "/srv/lane", small, source)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test.skipIf(process.platform !== "linux")("a vanished namespace anchor is unknown and never falls back onto procfs", () => {
  expect(probeDisk("/proc/2147483647/root/tmp/checkout")).toBeNull();
});

test("independent readers with a pre-episode cache join the persisted episode across restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-readers-"));
  const file = path.join(directory, "disk-pressure-report.json");
  const volume = (freeBytes: number) => diskVolumes([{ role: "state", directory: directory }], () => ({ volume: "disk", freeBytes }));
  try {
    const readerA = observeDiskPressureReport(file, () => volume(20 * GiB), "2026-10-06T10:00:00Z");
    const readerB = structuredClone(readerA);
    expect(readerB.episode).toBeNull();
    const first = observeDiskPressureReport(file, () => volume(GiB), "2026-10-06T10:20:00Z");
    const second = observeDiskPressureReport(file, () => volume(0.8 * GiB), "2026-10-06T10:40:00Z");
    expect(second.episode).toBe(first.episode);
    const restarted = observeDiskPressureReport(file, () => volume(0.7 * GiB), "2026-10-06T11:00:00Z");
    expect(restarted.episode).toBe(first.episode);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).episode).toBe(first.episode);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("resources readers with independent stale caches and a restart preserve one episode", async () => {
  // The preload supplies an isolated state root; no production roots are read.
  const roots = [{ role: "state", directory: process.env.LLV_STATE_DIR! }];
  const cachesA = new Map();
  const cachesB = new Map();
  let clock = Date.parse("2026-10-06T10:00:00Z");
  let freeBytes = 20 * GiB;
  const shared = { roots, now: () => clock, probe: () => ({ volume: "fixture", freeBytes }) };
  const healthy = await readDiskPressure({ ...shared, caches: cachesA });
  expect(healthy.episode).toBeNull();
  freeBytes = GiB;
  clock += 20 * 60_000;
  const first = await readDiskPressure({ ...shared, caches: cachesB });
  clock += 20 * 60_000;
  const stale = await readDiskPressure({ ...shared, caches: cachesA });
  expect(stale.episode).toBe(first.episode);
  clock += 20 * 60_000;
  const restartCache = new Map();
  const restarted = await readDiskPressure({ ...shared, caches: restartCache });
  expect(restarted.episode).toBe(first.episode);
  // Let only these readers' background measurements settle before cleanup.
  await Promise.all([...cachesA.values(), ...cachesB.values(), ...restartCache.values()].map(row => row.measuring));
});

test("MCP reads cannot close a Viewer episode based on a narrower filesystem view", async () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "disk-pressure-report.json");
  const first = observeDiskPressureReport(file, () => [{ roles: ["temp"], freeBytes: GiB, level: "critical" }], "2026-10-06T10:00:00Z");
  let probed = false;
  const read = await readDiskPressure({ readOnly: true, roots: [], probe: () => {
    probed = true; return { volume: "host", freeBytes: 100 * GiB };
  } });
  expect(read.episode).toBe(first.episode);
  expect(read.volumes).toEqual(first.volumes);
  expect(probed).toBe(false);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).episode).toBe(first.episode);
});

test("a new worktree waits only below the critical threshold, naming the volume", () => {
  expect(worktreeDiskWait("/srv/repo", "/srv/repo-pipeline-a", probe({ "/": DISK_WARNING_BYTES - 1 }))).toBeNull();
  const wait = worktreeDiskWait("/srv/repo", "/srv/repo-pipeline-a", probe({ "/": GiB / 2 }));
  expect(wait).toStartWith(DISK_SPACE_WAIT_PREFIX);
  expect(wait).toContain("0.50 GiB free");
  expect(wait).toContain("retries automatically");
});

test("one episode lasts while free space moves below the recovery level, and a later crossing opens another", () => {
  const low = (free: number) => [{ roles: ["worktrees"], freeBytes: free, level: free < DISK_CRITICAL_BYTES ? "critical" as const : free < DISK_WARNING_BYTES ? "warning" as const : "ok" as const }];
  const first = observeDiskPressure(low(5 * GiB), null, "2026-10-06T10:00:00.000Z");
  expect(first.episode).toBe("2026-10-06T10:00:00.000Z");
  const measured = { ...first, consumers: [{ kind: "worktrees" as const, bytes: 40 * GiB, measuredAt: first.at }] };
  const lower = observeDiskPressure(low(GiB), measured, "2026-10-06T10:05:00.000Z");
  expect(lower.episode).toBe(first.episode);
  expect(lower.consumers).toEqual(measured.consumers);
  /* Back above the warning threshold but under the recovery level: the same episode. */
  const wobble = observeDiskPressure(low(DISK_WARNING_BYTES + 1), lower, "2026-10-06T10:10:00.000Z");
  expect(wobble.episode).toBe(first.episode);
  expect(observeDiskPressure(low(DISK_WARNING_BYTES - 1), wobble, "2026-10-06T10:15:00.000Z").episode).toBe(first.episode);
  const recovered = observeDiskPressure(low(DISK_RECOVERY_BYTES), wobble, "2026-10-06T11:00:00.000Z");
  expect(recovered.episode).toBeNull();
  expect(recovered.consumers).toEqual([]);
  expect(observeDiskPressure(low(5 * GiB), recovered, "2026-10-06T12:00:00.000Z").episode).toBe("2026-10-06T12:00:00.000Z");
});

test("the wake waits for the consumer sizes, then names them with the free space", () => {
  const pressure = observeDiskPressure([{ roles: ["state", "worktrees"], freeBytes: 3 * GiB, level: "warning" }], null, "2026-10-06T10:00:00.000Z");
  expect(diskPressureWakeReady(pressure, Date.parse("2026-10-06T10:01:00.000Z"))).toBe(false);
  expect(diskPressureWakeReady(pressure, Date.parse("2026-10-06T10:15:00.000Z"))).toBe(true);
  expect(diskPressureLabel(pressure)).toContain("consumer measurement pending");
  const measured = { ...pressure, consumers: [
    { kind: "state" as const, bytes: 2 * GiB, measuredAt: pressure.at },
    { kind: "worktrees" as const, bytes: 90 * GiB, measuredAt: pressure.at },
    { kind: "temp" as const, bytes: 12 * GiB, measuredAt: pressure.at },
  ] };
  expect(diskPressureWakeReady(measured, Date.parse("2026-10-06T10:01:00.000Z"))).toBe(true);
  expect(diskPressureLabel(measured)).toBe("Disk space low: state/worktrees 3.00 GiB free; largest Delegatus consumers (allocated lower bounds): worktrees 90.00 GiB, temp 12.00 GiB, state 2.00 GiB");
  expect(diskPressureWakeReady({ ...measured, episode: null })).toBe(false);
});

test("a pending episode wake still names free space in the recovery band", () => {
  const opening = "2026-10-06T10:00:00Z";
  const first = observeDiskPressure([{ roles: ["state"], freeBytes: 5 * GiB, level: "warning" }], null, opening);
  const recovering = observeDiskPressure([{ roles: ["state"], freeBytes: 11 * GiB, level: "ok" }], first, "2026-10-06T10:15:00Z");
  expect(recovering.episode).toBe(first.episode);
  expect(diskPressureWakeReady(recovering, Date.parse(recovering.at))).toBe(true);
  expect(diskPressureLabel(recovering)).toContain("state 11.00 GiB free");
  expect(diskPressureLabel(recovering)).toContain("consumer measurement pending");
});

test.skipIf(process.platform !== "linux")("host temp worktrees are probed and measured through their namespace, once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-namespace-"));
  const via = path.join(directory, "proc/123456/root");
  const namespace = "mnt:[123456]";
  const worktree = "/tmp/llv-host-role/checkout";
  const reached = via + worktree;
  const other = path.join(via, "tmp/llv-other-role");
  fs.mkdirSync(path.join(directory, "proc/123456/ns"), { recursive: true });
  fs.symlinkSync(namespace, path.join(directory, "proc/123456/ns/mnt"));
  fs.mkdirSync(reached, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(reached, "bulk"), Buffer.alloc(128 * 1024, 1));
  fs.writeFileSync(path.join(other, "bulk"), Buffer.alloc(64 * 1024, 1));
  const caches = new Map();
  const visited: string[] = [];
  const temp = { path: "/tmp", via, anchor: { pid: 123456, namespace } };
  const options = { caches, worktrees: [worktree], tempRoots: [temp, temp],
    now: () => Date.parse("2026-10-06T12:00:00Z"), probe: (target: string) => {
      visited.push(target);
      return { volume: target.startsWith(via) ? "host-temp" : "state", freeBytes: target.startsWith(via) ? GiB : 20 * GiB };
    } };
  try {
    const pressure = await readDiskPressure(options);
    expect(visited).toContain(reached);
    expect(visited).not.toContain(worktree);
    expect(pressure.volumes).toContainEqual({ roles: ["worktrees", "temp"], freeBytes: GiB, level: "critical" });
    await Promise.all([...caches.values()].map(row => row.measuring));
    const measured = await readDiskPressure(options);
    expect(measured.consumers.find(row => row.kind === "worktrees")?.bytes).toBe(await exclusiveBytes(reached));
    expect(measured.consumers.find(row => row.kind === "temp")?.bytes).toBe(await exclusiveBytes(other));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
