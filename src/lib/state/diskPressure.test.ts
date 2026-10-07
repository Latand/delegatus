import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
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
    { volume: "/srv", roles: ["state", "worktrees"], freeBytes: DISK_WARNING_BYTES - 1, level: "warning" },
    { volume: "/tmp", roles: ["temp"], freeBytes: DISK_CRITICAL_BYTES - 1, level: "critical" },
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
  const source = { NODE_ENV: "test" as const, XDG_CONFIG_HOME: "/srv/delegatus-config", TMPDIR: "/srv/agent-temp", CLAUDE_CODE_TMPDIR: "/srv/claude-temp" };
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

test("a lane without Claude stages ignores Claude-only temp pressure while retaining config admission", () => {
  const source = { NODE_ENV: "test" as const, TMPDIR: "/srv/agent-temp", CLAUDE_CODE_TMPDIR: "/srv/claude-temp" };
  const config = agentConfigSandboxRoot({ ...source, TMPDIR: path.join(process.env.LLV_STATE_DIR!, "scratch/tmp") });
  const visited: string[] = [];
  const stub: DiskProbe = directory => {
    visited.push(directory);
    return { volume: directory === source.CLAUDE_CODE_TMPDIR ? "claude" : "writer",
      freeBytes: directory === source.CLAUDE_CODE_TMPDIR ? GiB : 500 * GiB, totalBytes: 1000 * GiB };
  };
  expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source, [], false)).toBeNull();
  expect(visited).not.toContain(source.CLAUDE_CODE_TMPDIR);
  expect(visited).toContain(config);
  expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source, [], true)).toContain("1.00 GiB free");
  expect(worktreeDiskWait("/srv/repo", "/srv/lane", directory => ({ volume: directory === config ? "config" : "writer",
    freeBytes: directory === config ? GiB : 500 * GiB, totalBytes: 1000 * GiB }), source, [], false)).toContain("1.00 GiB free");
});

test("the System pressure observation omits an unused Claude-only write destination", async () => {
  const previous = process.env.CLAUDE_CODE_TMPDIR;
  const destination = "/srv/unused-claude-temp";
  process.env.CLAUDE_CODE_TMPDIR = destination;
  const visited: string[] = [];
  try {
    const pressure = await readDiskPressure({ caches: new Map(), worktrees: [], tempRoots: [],
      now: () => Date.parse("2026-10-06T12:00:00Z"), probe: directory => {
        visited.push(directory);
        return { volume: directory === destination ? "unused" : "writer", freeBytes: directory === destination ? GiB : 500 * GiB };
      } });
    expect(pressure.episode).toBeNull();
    expect(visited).not.toContain(destination);
    expect(pressure.volumes.every(row => row.level === "ok")).toBeTrue();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = previous;
  }
});

test.skipIf(process.platform !== "linux")("a vanished namespace anchor is unknown and never falls back onto procfs", () => {
  expect(probeDisk("/proc/2147483647/root/tmp/checkout")).toBeNull();
});

test.skipIf(process.platform !== "linux")("Docker admission checks actual host config and Claude temp volumes", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = "/srv/delegatus-config/agent-log-viewer/state";
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-host-admission-"));
  const via = path.join(fixture, "proc/42/root");
  const namespace = "mnt:[12345]";
  fs.mkdirSync(path.join(fixture, "proc/42/ns"), { recursive: true });
  fs.symlinkSync(namespace, path.join(fixture, "proc/42/ns/mnt"));
  const source = { NODE_ENV: "test" as const, XDG_CONFIG_HOME: "/srv/delegatus-config", TMPDIR: os.tmpdir(), CLAUDE_CODE_TMPDIR: "/srv/claude-temp", LLV_DOCKER_NSENTER_SHIMS: "1" };
  const temp = { path: os.tmpdir(), via, anchor: { pid: 42, namespace } };
  const readlink = fs.readlinkSync;
  const hostNamespace = spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, options?: unknown) =>
    String(file) === "/proc/1/ns/mnt" ? namespace : readlink(file, options as undefined)) as typeof fs.readlinkSync);
  process.env.LLV_STATE_DIR = state;
  try {
    const config = agentConfigSandboxRoot({ ...source, TMPDIR: path.join(state, "scratch/tmp") });
    for (const destination of [config, source.CLAUDE_CODE_TMPDIR]) {
      const visited: string[] = [];
      let freeBytes = GiB;
      const stub: DiskProbe = directory => {
        visited.push(directory);
        return { volume: directory === via + destination ? "host" : "container", freeBytes: directory === via + destination ? freeBytes : 500 * GiB, totalBytes: 1000 * GiB };
      };
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source, [temp])).toContain("1.00 GiB free");
      expect(visited).toContain(via + destination);
      freeBytes = 20 * GiB;
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source, [temp])).toBeNull();
    }
    const unrelatedVia = path.join(fixture, "proc/43/root");
    const unrelatedNamespace = "mnt:[private-agent]";
    fs.mkdirSync(path.join(fixture, "proc/43/ns"), { recursive: true });
    fs.symlinkSync(unrelatedNamespace, path.join(fixture, "proc/43/ns/mnt"));
    const unrelated = { path: os.tmpdir(), via: unrelatedVia, anchor: { pid: 43, namespace: unrelatedNamespace } };
    const visited: string[] = [];
    expect(worktreeDiskWait("/srv/repo", "/srv/lane", directory => {
      visited.push(directory);
      return { volume: directory.startsWith(unrelatedVia) ? "private" : "writer", freeBytes: directory.startsWith(unrelatedVia) ? GiB : 500 * GiB, totalBytes: 1000 * GiB };
    }, source, [unrelated, temp])).toBeNull();
    expect(visited.some(directory => directory.startsWith(unrelatedVia))).toBeFalse();
    hostNamespace.mockImplementation(((file: fs.PathLike, options?: unknown) => {
      if (String(file) === "/proc/1/ns/mnt") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return readlink(file, options as undefined);
    }) as typeof fs.readlinkSync);
    const enter = spyOn(childProcess, "spawnSync").mockReturnValue({ status: 0, stdout: namespace + "\n", stderr: "" } as ReturnType<typeof childProcess.spawnSync>);
    try {
      const hostLow: DiskProbe = directory => ({ volume: directory.startsWith(via) ? "host" : "container",
        freeBytes: directory.startsWith(via) ? GiB : 500 * GiB, totalBytes: 1000 * GiB });
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", hostLow, source, [temp])).toContain("1.00 GiB free");
      expect(enter.mock.calls[0]?.[0]).toBe("nsenter");
      expect(enter.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-t", "1", "/usr/bin/setpriv", "/bin/readlink", "/proc/self/ns/mnt"]));
      enter.mockReturnValue({ status: 1, stdout: "", stderr: "permission denied" } as ReturnType<typeof childProcess.spawnSync>);
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", hostLow, source, [temp])).toBeNull();
    } finally { enter.mockRestore(); }
    fs.unlinkSync(path.join(fixture, "proc/42/ns/mnt"));
    fs.symlinkSync("mnt:[recycled]", path.join(fixture, "proc/42/ns/mnt"));
    let hostProbe = false;
    worktreeDiskWait("/srv/repo", "/srv/lane", directory => {
      if (directory.startsWith(via)) hostProbe = true;
      return { volume: "healthy", freeBytes: 500 * GiB };
    }, source, [temp]);
    expect(hostProbe).toBe(false);
  } finally {
    hostNamespace.mockRestore();
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

for (const unrelated of [false, true]) test.skipIf(process.platform !== "linux")(`Docker admission checks idle host destinations with an unrelated agent: ${unrelated}`, () => {
  const previous = process.env.LLV_STATE_DIR;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-idle-host-"));
  const state = path.join(fixture, "state");
  const namespace = "mnt:[12345]";
  const source = { NODE_ENV: "test" as const, TMPDIR: os.tmpdir(), CLAUDE_CODE_TMPDIR: "/srv/claude-temp", LLV_DOCKER_NSENTER_SHIMS: "1" };
  process.env.LLV_STATE_DIR = state;
  const readlink = fs.readlinkSync;
  const hostNamespace = spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, options?: unknown) =>
    String(file) === "/proc/1/ns/mnt" ? namespace : readlink(file, options as undefined)) as typeof fs.readlinkSync);
  const via = path.join(fixture, "proc/43/root");
  fs.mkdirSync(path.join(fixture, "proc/43/ns"), { recursive: true });
  fs.symlinkSync("mnt:[67890]", path.join(fixture, "proc/43/ns/mnt"));
  const views = unrelated ? [{ path: os.tmpdir(), via, anchor: { pid: 43, namespace: "mnt:[67890]" } }] : [];
  try {
    const config = agentConfigSandboxRoot({ ...source, TMPDIR: path.join(state, "scratch/tmp") });
    for (const usesClaude of [false, true]) {
      let freeBytes = GiB;
      const visited: string[] = [];
      const stub: DiskProbe = directory => {
        visited.push(directory);
        const hostConfig = directory === "/proc/1/root" + config;
        return { volume: hostConfig ? "host-temp" : "healthy", freeBytes: hostConfig ? freeBytes : 500 * GiB, totalBytes: 1000 * GiB };
      };
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source, views, usesClaude)).toContain("1.00 GiB free");
      expect(visited).toContain("/proc/1/root" + config);
      expect(visited.some(directory => directory.startsWith(via))).toBe(false);
      freeBytes = 20 * GiB;
      expect(worktreeDiskWait("/srv/repo", "/srv/lane", stub, source, views, usesClaude)).toBeNull();
    }
    const claudeLow: DiskProbe = directory => ({ volume: directory.endsWith(source.CLAUDE_CODE_TMPDIR) ? "claude" : "healthy",
      freeBytes: directory.endsWith(source.CLAUDE_CODE_TMPDIR) ? GiB : 500 * GiB, totalBytes: 1000 * GiB });
    expect(worktreeDiskWait("/srv/repo", "/srv/lane", claudeLow, source, views, false)).toBeNull();
    expect(worktreeDiskWait("/srv/repo", "/srv/lane", claudeLow, source, views, true)).toContain("1.00 GiB free");
  } finally {
    hostNamespace.mockRestore();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("System warns on idle host config pressure and clears after recovery", async () => {
  const previousState = process.env.LLV_STATE_DIR, previousShim = process.env.LLV_DOCKER_NSENTER_SHIMS;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-idle-observation-"));
  process.env.LLV_STATE_DIR = path.join(fixture, "state");
  process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  const readlink = fs.readlinkSync;
  const hostNamespace = spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, options?: unknown) =>
    String(file) === "/proc/1/ns/mnt" ? "mnt:[12345]" : readlink(file, options as undefined)) as typeof fs.readlinkSync);
  const config = agentConfigSandboxRoot({ ...process.env, TMPDIR: path.join(process.env.LLV_STATE_DIR, "scratch/tmp") });
  const caches = new Map();
  let freeBytes = GiB, time = Date.parse("2026-10-07T00:00:00Z");
  const options = { caches, worktrees: [], tempRoots: [], now: () => time,
    probe: (directory: string) => ({ volume: directory === "/proc/1/root" + config ? "host-temp" : "healthy",
      freeBytes: directory === "/proc/1/root" + config ? freeBytes : 500 * GiB, totalBytes: 1000 * GiB }) };
  try {
    const low = await readDiskPressure(options);
    expect(low.episode).not.toBeNull();
    expect(low.volumes).toContainEqual(expect.objectContaining({ volume: "host-temp", level: "critical", provisioning: true }));
    expect(diskPressureLabel(low)).toContain("1.00 GiB free");
    await Promise.all([...caches.values()].map(row => row.measuring));
    freeBytes = 20 * GiB; time += 60_000;
    expect((await readDiskPressure(options)).episode).toBeNull();
  } finally {
    await Promise.all([...caches.values()].map(row => row.measuring));
    hostNamespace.mockRestore();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    if (previousShim === undefined) delete process.env.LLV_DOCKER_NSENTER_SHIMS; else process.env.LLV_DOCKER_NSENTER_SHIMS = previousShim;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

for (const emptyGroups of [false, true]) test.skipIf(process.platform !== "linux")(`an idle host probe restores credentials with empty groups ${emptyGroups} and measures a missing destination`, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-host-probe-"));
  const requested = path.join(fixture, "new/config");
  const namespace = fs.readlinkSync("/proc/self/ns/mnt");
  const stat = fs.statSync(fixture), disk = fs.statfsSync(fixture);
  const readlink = fs.readlinkSync, readStat = fs.statSync, spawn = childProcess.spawnSync;
  const groupList = emptyGroups ? spyOn(process, "getgroups").mockReturnValue([]) : null;
  const hostLink = spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    if (String(file) === "/proc/1/ns/mnt") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return readlink(file, options as undefined);
  }) as typeof fs.readlinkSync);
  const hostStat = spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    if (String(file).startsWith("/proc/1/root")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return readStat(file, options as undefined);
  }) as typeof fs.statSync);
  const enter = spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[], options: object) => {
    expect(command).toBe("nsenter");
    expect(args).toEqual(expect.arrayContaining(["-t", "1", "-m", "-p", "/usr/bin/setpriv",
      `--reuid=${process.getuid!()}`, `--regid=${process.getgid!()}`]));
    const groups = args.find(arg => arg.startsWith("--groups="))!.slice(9).split(",").map(Number);
    expect(new Set(groups)).toEqual(new Set([process.getgid!(), ...process.getgroups!()]));
    if (args.includes("/bin/readlink")) return { status: 0, stdout: namespace + "\n", stderr: "" };
    expect(args).toContain(path.join(os.homedir(), ".bun/bin/bun"));
    // Run the actual probe program in a child, against this test's own tree.
    return spawn(process.execPath, ["-e", args.at(-2)!, args.at(-1)!], options);
  }) as typeof childProcess.spawnSync);
  try {
    const observed = probeDisk("/proc/1/root" + requested);
    expect(observed?.volume).toBe(String(stat.dev));
    expect(observed?.totalBytes).toBe(disk.blocks * disk.bsize);
    expect(observed?.freeBytes).toBeGreaterThan(0);
    expect(observed?.freeBytes).toBeLessThanOrEqual(observed!.totalBytes!);
  } finally {
    enter.mockRestore(); hostStat.mockRestore(); hostLink.mockRestore(); groupList?.mockRestore();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

for (const failure of ["command", "malformed", "namespace", "negative", "capacity", "changed"] as const)
test.skipIf(process.platform !== "linux")(`an idle host probe rejects ${failure} observations`, () => {
  let namespace = "mnt:[12345]";
  const readlink = fs.readlinkSync, readStat = fs.statSync;
  const hostLink = spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, options?: unknown) =>
    String(file) === "/proc/1/ns/mnt" ? namespace : readlink(file, options as undefined)) as typeof fs.readlinkSync);
  const hostStat = spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    if (String(file).startsWith("/proc/1/root")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return readStat(file, options as undefined);
  }) as typeof fs.statSync);
  const enter = spyOn(childProcess, "spawnSync").mockImplementation((() => {
    const observed = { namespace: failure === "namespace" ? "mnt:[67890]" : namespace, volume: "host",
      freeBytes: failure === "negative" ? -1 : GiB, totalBytes: failure === "capacity" ? 0 : 1000 * GiB };
    if (failure === "changed") namespace = "mnt:[67890]";
    return { status: failure === "command" ? 1 : 0, stdout: failure === "malformed" ? "incomplete" : JSON.stringify(observed), stderr: "" } as ReturnType<typeof childProcess.spawnSync>;
  }) as typeof childProcess.spawnSync);
  try { expect(probeDisk("/proc/1/root/tmp/llv-config")).toBeNull(); }
  finally { enter.mockRestore(); hostStat.mockRestore(); hostLink.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("idle host consumers are discovered without agents and count aliases and hard links once", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-idle-consumers-"));
  const previous = { TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_DOCKER_NSENTER_SHIMS: process.env.LLV_DOCKER_NSENTER_SHIMS };
  const temp = path.join(fixture, "temp"), host = path.join(fixture, "host");
  const owned = path.join(host, temp, "llv-spawn-sandbox/config");
  fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, "bulk"), Buffer.alloc(1024 * 1024, 1));
  fs.linkSync(path.join(owned, "bulk"), path.join(owned, "alias"));
  const worktree = path.join(temp, "llv-review-role/checkout"), reached = host + worktree;
  fs.mkdirSync(reached, { recursive: true });
  fs.writeFileSync(path.join(reached, "source"), Buffer.alloc(128 * 1024, 1));
  fs.writeFileSync(path.join(path.dirname(reached), "role-log"), Buffer.alloc(64 * 1024, 1));
  process.env.TMPDIR = temp; process.env.LLV_STATE_DIR = path.join(fixture, "state"); process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  const map = (file: fs.PathLike) => typeof file === "string" && file.startsWith("/proc/1/root/") ? host + file.slice("/proc/1/root".length) : file;
  const readlink = fs.readlinkSync;
  const patches: { mockRestore(): void }[] = [spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, options?: unknown) =>
    String(file) === "/proc/1/ns/mnt" ? "mnt:[12345]" : readlink(file, options as undefined)) as typeof fs.readlinkSync)];
  for (const method of ["statSync", "lstatSync", "realpathSync", "readdirSync"] as const) {
    const original = fs[method];
    patches.push(spyOn(fs, method).mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
      Reflect.apply(original, fs, [map(file), ...args])) as typeof original));
  }
  for (const method of ["readdir", "lstat"] as const) {
    const original = fs.promises[method];
    patches.push(spyOn(fs.promises, method).mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
      Reflect.apply(original, fs.promises, [map(file), ...args])) as typeof original));
  }
  const caches = new Map();
  const visited: string[] = [];
  const stale = { path: temp, via: path.join(fixture, "proc/42/root"), anchor: { pid: 42, namespace: "mnt:[67890]" } };
  const options = { caches, worktrees: [worktree], tempRoots: [{ path: temp, via: "" }, stale, { path: temp, via: "" }],
    now: () => Date.parse("2026-10-07T00:00:00Z"), probe: (directory: string) => {
      visited.push(directory);
      return { volume: directory.startsWith("/proc/1/root") ? "host-temp" : "container",
        freeBytes: directory.startsWith("/proc/1/root") ? GiB : 500 * GiB, totalBytes: 1000 * GiB };
    } };
  try {
    expect((await readDiskPressure(options)).episode).not.toBeNull();
    await Promise.all([...caches.values()].map(row => row.measuring));
    const measured = await readDiskPressure(options);
    const bytes = measured.consumers.find(row => row.kind === "temp")!.bytes;
    expect(bytes).toBeGreaterThanOrEqual(1024 * 1024 + 64 * 1024);
    expect(bytes).toBeLessThan(1024 * 1024 + 128 * 1024);
    const worktreeBytes = measured.consumers.find(row => row.kind === "worktrees")!.bytes;
    expect(worktreeBytes).toBeGreaterThanOrEqual(128 * 1024);
    expect(worktreeBytes).toBeLessThan(256 * 1024);
    expect(visited).toContain("/proc/1/root" + worktree);
    expect(visited).not.toContain(worktree);
    expect(fs.existsSync(path.join(owned, "bulk"))).toBe(true);
  } finally {
    await Promise.all([...caches.values()].map(row => row.measuring));
    for (const patch of patches.reverse()) patch.mockRestore();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

for (const phase of ["healthy", "failed", "malformed", "stalled", "wrong-namespace", "expired"] as const)
test.skipIf(process.platform !== "linux")(`an idle host consumer reader with denied procfs ${phase} is bounded and reaped`, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-reader-"));
  const previous = { TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_DOCKER_NSENTER_SHIMS: process.env.LLV_DOCKER_NSENTER_SHIMS };
  const temp = path.join(fixture, "temp"), host = path.join(fixture, "host"), state = path.join(fixture, "state");
  const owned = path.join(host, temp, "llv-spawn-sandbox/config");
  fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, "bulk"), Buffer.alloc(1024 * 1024, 1));
  fs.linkSync(path.join(owned, "bulk"), path.join(owned, "alias"));
  process.env.TMPDIR = temp; process.env.LLV_STATE_DIR = state; process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  const namespace = phase === "wrong-namespace" ? "mnt:[12345]" : fs.readlinkSync("/proc/self/ns/mnt");
  let reader: ReturnType<typeof childProcess.spawn> | undefined, exited: Promise<unknown> | undefined;
  const spawn = childProcess.spawn;
  const launch = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: object) => {
    expect(command).toBe("nsenter");
    expect(args).toEqual(expect.arrayContaining(["-t", "1", "-m", "-p", "/usr/bin/setpriv", `--reuid=${process.getuid!()}`, `--regid=${process.getgid!()}`]));
    const program = phase === "failed" ? "process.exit(1)" : phase === "malformed" || phase === "stalled"
      ? `${phase === "malformed" ? 'console.log("malformed");' : ""} process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`
      : args.at(-1)!;
    reader = spawn(process.execPath, ["-e", program], options);
    exited = new Promise(resolve => reader!.once("close", resolve));
    return reader;
  }) as typeof childProcess.spawn);
  const map = (file: fs.PathLike) => {
    const value = String(file);
    if (value.startsWith("/proc/1/root")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    const via = `/proc/${reader?.pid}/root`;
    return typeof file === "string" && value.startsWith(via + "/") ? host + value.slice(via.length) : file;
  };
  const readlink = fs.readlinkSync;
  const patches: { mockRestore(): void }[] = [spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, options?: unknown) =>
    String(file) === "/proc/1/ns/mnt" ? namespace : readlink(file, options as undefined)) as typeof fs.readlinkSync)];
  for (const method of ["statSync", "lstatSync", "realpathSync", "readdirSync"] as const) {
    const original = fs[method];
    patches.push(spyOn(fs, method).mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
      Reflect.apply(original, fs, [map(file), ...args])) as typeof original));
  }
  for (const method of ["readdir", "lstat"] as const) {
    const original = fs.promises[method];
    patches.push(spyOn(fs.promises, method).mockImplementation((async (file: fs.PathLike, ...args: unknown[]) => {
      if (phase === "expired" && String(file) === state && reader) { reader.stdin!.end(); await exited; }
      return Reflect.apply(original, fs.promises, [map(file), ...args]);
    }) as typeof original));
  }
  const caches = new Map();
  const options = { caches, worktrees: [], tempRoots: [{ path: temp, via: "" }, { path: temp, via: "" }],
    now: () => Date.parse("2026-10-07T00:00:00Z"), probe: (directory: string) => ({ volume: directory.startsWith("/proc/1/root") ? "host-temp" : "container",
      freeBytes: directory.startsWith("/proc/1/root") ? GiB : 500 * GiB, totalBytes: 1000 * GiB }) };
  try {
    const low = await readDiskPressure(options);
    await Promise.all([...caches.values()].map(row => row.measuring));
    const measured = await readDiskPressure(options);
    const bytes = measured.consumers.find(row => row.kind === "temp")!.bytes;
    expect(measured.episode).toBe(low.episode);
    if (phase === "healthy") { expect(bytes).toBeGreaterThanOrEqual(1024 * 1024); expect(bytes).toBeLessThan(2 * 1024 * 1024); }
    else expect(bytes).toBe(0);
    if (phase === "stalled") expect(reader?.exitCode === 0 || reader?.signalCode === "SIGTERM").toBe(true);
    else expect(reader?.exitCode).toBe(phase === "failed" ? 1 : 0);
    expect(fs.existsSync(path.join(owned, "bulk"))).toBe(true);
  } finally {
    await Promise.all([...caches.values()].map(row => row.measuring));
    reader?.stdin?.end(); await exited;
    for (const patch of patches.reverse()) patch.mockRestore(); launch.mockRestore();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("shared agent sandboxes and tmux state count once across temp-root aliases and remain protected", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-shared-consumers-"));
  const state = path.join(fixture, "state");
  const temp = path.join(fixture, "temp");
  const alias = path.join(fixture, "temp-alias");
  fs.mkdirSync(state); fs.mkdirSync(temp);
  fs.symlinkSync(temp, alias);
  const via = path.join(fixture, "proc/42/root");
  const namespace = "mnt:[12346]";
  fs.mkdirSync(path.join(fixture, "proc/42/ns"), { recursive: true });
  fs.symlinkSync(namespace, path.join(fixture, "proc/42/ns/mnt"));
  fs.symlinkSync("/", via);
  process.env.LLV_STATE_DIR = state;
  const config = agentConfigSandboxRoot({ NODE_ENV: "test", TMPDIR: temp }, "/repo/account-a");
  const sandbox = path.dirname(config);
  const tmux = path.join(temp, "llv-tmux-cwd");
  const manual = path.join(temp, "manual-output");
  for (const directory of [config, tmux, manual]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(config, "cache.bin"), Buffer.alloc(512 * 1024, 1));
  fs.writeFileSync(path.join(tmux, "state"), Buffer.alloc(64 * 1024, 1));
  fs.writeFileSync(path.join(manual, "bulk"), Buffer.alloc(256 * 1024, 1));
  const caches = new Map();
  const options = { caches, worktrees: [], roots: [{ role: "state", directory: state }, { role: "temp", directory: temp }],
    tempRoots: [{ path: temp, via: "" }, { path: alias, via: "" }, { path: temp, via, anchor: { pid: 42, namespace } }], now: () => Date.parse("2026-10-06T12:00:00Z"),
    probe: () => ({ volume: "fixture", freeBytes: GiB }) };
  try {
    await readDiskPressure(options);
    await Promise.all([...caches.values()].map(row => row.measuring));
    const measured = await readDiskPressure(options);
    expect(measured.consumers.find(row => row.kind === "temp")?.bytes).toBe(await exclusiveBytes(sandbox) + await exclusiveBytes(tmux));
    expect(fs.existsSync(path.join(config, "cache.bin"))).toBeTrue();
    expect(fs.existsSync(path.join(tmux, "state"))).toBeTrue();
  } finally {
    await Promise.all([...caches.values()].map(row => row.measuring));
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
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

test("concurrent process observers persist one disk pressure episode", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-processes-"));
  const file = path.join(directory, "report.json");
  const program = `
    import fs from "node:fs";
    import { observeDiskPressureReport } from ${JSON.stringify(path.join(import.meta.dir, "diskPressure.ts"))};
    const [file, ready, at] = process.argv.slice(1);
    fs.writeFileSync(ready, "ready");
    await Bun.stdin.text();
    const pressure = observeDiskPressureReport(file, () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      return [{ volume: "fixture", roles: ["state"], freeBytes: 1024 ** 3, level: "critical" }];
    }, at);
    console.log(pressure.episode);
  `;
  const ready = [0, 1, 2].map(index => path.join(directory, `ready-${index}`));
  const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
  try {
    for (let index = 0; index < ready.length; index++) children.push(Bun.spawn({
      cmd: [process.execPath, "--eval", program, file, ready[index]!, `2026-10-06T10:${20 + index}:00Z`],
      env: { ...process.env, LLV_STATE_DIR: path.join(directory, "state") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    }));
    const deadline = Date.now() + 5_000;
    while (!ready.every(marker => fs.existsSync(marker)) && Date.now() < deadline) await Bun.sleep(10);
    expect(ready.every(marker => fs.existsSync(marker))).toBeTrue();
    for (const child of children) child.stdin.end();
    const results = await Promise.all(children.map(async child => ({
      stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), code: await child.exited,
    })));
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const episodes = results.map(result => result.stdout.trim());
    expect(episodes[0]).toMatch(/^2026-10-06T10:2[0-2]:00Z$/);
    expect(new Set(episodes).size).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).episode).toBe(episodes[0]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test.skipIf(process.platform !== "linux")("a disappeared pressured volume preserves its episode across restart until that volume recovers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-lost-volume-"));
  const file = path.join(directory, "report.json");
  const roots = [{ role: "state", directory: "/srv/state" }, { role: "temp", directory: "/var/tmp" }];
  const via = path.join(directory, "proc/42/root");
  const namespace = "mnt:[lost-volume]";
  fs.mkdirSync(path.join(directory, "proc/42/ns"), { recursive: true });
  fs.symlinkSync(namespace, path.join(directory, "proc/42/ns/mnt"));
  const host = { role: "temp", directory: via + "/tmp", view: { path: "/tmp", via, anchor: { pid: 42, namespace } } };
  const volumes = (includeHost: boolean, freeBytes = GiB) => diskVolumes(includeHost ? [...roots, host] : roots,
    directory => ({ volume: directory === host.directory ? "host-temp" : "container", freeBytes: directory === host.directory ? freeBytes : 50 * GiB }));
  try {
    const first = observeDiskPressureReport(file, () => volumes(true), "2026-10-06T10:00:00Z");
    const absent = observeDiskPressureReport(file, () => volumes(false), "2026-10-06T10:20:00Z");
    expect(absent.episode).toBe(first.episode);
    expect(absent.volumes).toContainEqual(expect.objectContaining({ volume: "host-temp", roles: ["temp"], freeBytes: null, level: "unknown" }));
    const restarted = observeDiskPressureReport(file, () => volumes(false), "2026-10-06T10:40:00Z");
    expect(restarted.episode).toBe(first.episode);
    const returned = observeDiskPressureReport(file, () => volumes(true), "2026-10-06T11:00:00Z");
    expect(returned.episode).toBe(first.episode);
    const recovered = observeDiskPressureReport(file, () => volumes(true, 20 * GiB), "2026-10-06T11:20:00Z");
    expect(recovered.episode).toBeNull();
    expect(recovered.volumes.every(row => row.level === "ok")).toBeTrue();
    expect(observeDiskPressureReport(file, () => volumes(true), "2026-10-06T11:40:00Z").episode).not.toBe(first.episode);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("healthy replacement volumes clear pressure while missing foreign views remain uncertain until a kernel reboot", () => {
  const low = { volume: "old-temp", roles: ["temp"], freeBytes: GiB, level: "critical" as const };
  const healthy = { volume: "new-temp", roles: ["temp"], freeBytes: 20 * GiB, level: "ok" as const };
  const first = observeDiskPressure([low], null, "2026-10-06T10:00:00Z", "boot-A");
  expect(observeDiskPressure([healthy], first, "2026-10-06T10:20:00Z", "boot-A").episode).toBeNull();
  const host = observeDiskPressure([{ ...low, views: ["host-temp-view"] }], null, "2026-10-06T10:00:00Z", "boot-A");
  const uncertain = observeDiskPressure([healthy], host, "2026-10-06T10:20:00Z", "boot-A");
  expect(uncertain.episode).toBe(host.episode);
  expect(observeDiskPressure([{ ...healthy, views: ["host-temp-view"] }], uncertain,
    "2026-10-06T10:40:00Z", "boot-A").episode).toBeNull();
  expect(observeDiskPressure([healthy], uncertain, "2026-10-06T10:40:00Z", "boot-B").episode).toBeNull();
  expect(observeDiskPressure([low], uncertain, "2026-10-06T10:40:00Z", "boot-B").episode).toBe(host.episode);
});

test("a previously healthy volume disappearing does not prevent confirmed pressure recovery", () => {
  const first = observeDiskPressure([
    { volume: "state", roles: ["state"], freeBytes: GiB, level: "critical" },
    { volume: "temp", roles: ["temp"], freeBytes: 50 * GiB, level: "ok" },
  ], null, "2026-10-06T10:00:00Z");
  expect(observeDiskPressure([{ volume: "state", roles: ["state"], freeBytes: 20 * GiB, level: "ok" }], first,
    "2026-10-06T10:20:00Z").episode).toBeNull();
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
    expect(pressure.volumes).toContainEqual(expect.objectContaining({ volume: "host-temp", roles: ["worktrees", "temp"], freeBytes: GiB, level: "critical" }));
    await Promise.all([...caches.values()].map(row => row.measuring));
    const measured = await readDiskPressure(options);
    expect(measured.consumers.find(row => row.kind === "worktrees")?.bytes).toBe(await exclusiveBytes(reached));
    expect(measured.consumers.find(row => row.kind === "temp")?.bytes).toBe(await exclusiveBytes(other));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each(["recycled", "gone", "during-probe", "during-measurement"])("a namespace anchor changed %s supplies no unrelated disk observation or consumers", async phase => {
  const previous = process.env.LLV_STATE_DIR;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-stale-view-"));
  const state = path.join(fixture, "state");
  const via = path.join(fixture, "proc/42/root");
  const anchor = path.join(fixture, "proc/42/ns/mnt");
  const namespace = "mnt:[fixture-original]";
  fs.mkdirSync(path.dirname(anchor), { recursive: true });
  fs.symlinkSync(namespace, anchor);
  fs.mkdirSync(state);
  const owned = path.join(via, "tmp/llv-other-role");
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, "bulk"), Buffer.alloc(128 * 1024, 1));
  process.env.LLV_STATE_DIR = state;
  const changeAnchor = () => {
    fs.unlinkSync(anchor);
    if (phase !== "gone") fs.symlinkSync("mnt:[fixture-recycled]", anchor);
  };
  if (phase === "recycled" || phase === "gone") changeAnchor();
  const caches = new Map();
  const visited: string[] = [];
  const original = fs.promises.readdir;
  let injected = false;
  const read = spyOn(fs.promises, "readdir").mockImplementation((async (...args: Parameters<typeof fs.promises.readdir>) => {
    const result = await original(...args);
    if (phase === "during-measurement" && String(args[0]) === state && !injected) {
      injected = true;
      changeAnchor();
    }
    return result;
  }) as typeof fs.promises.readdir);
  try {
    const pressure = await readDiskPressure({ caches, worktrees: [], tempRoots: [{ path: "/tmp", via, anchor: { pid: 42, namespace } }],
      now: () => Date.parse("2026-10-06T12:00:00Z"), probe: directory => {
        visited.push(directory);
        if (directory.startsWith(via) && phase === "during-probe") changeAnchor();
        return { volume: directory.startsWith(via) ? "host" : "state", freeBytes: phase === "during-measurement"
          ? directory.startsWith(via) ? 50 * GiB : GiB : directory.startsWith(via) ? GiB : 50 * GiB };
      } });
    await Promise.all([...caches.values()].map(row => row.measuring));
    if (phase === "during-measurement") {
      expect(injected).toBeTrue();
      const measured = await readDiskPressure({ caches, now: () => Date.parse("2026-10-06T12:00:00Z") });
      expect(measured.consumers.find(row => row.kind === "temp")?.bytes).toBe(0);
    } else {
      expect(pressure.volumes).toContainEqual(expect.objectContaining({ roles: ["temp"], level: "unknown" }));
      expect(pressure.episode).toBeNull();
      if (phase !== "during-probe") expect(visited).not.toContain(via + "/tmp");
    }
  } finally {
    read.mockRestore();
    await Promise.all([...caches.values()].map(row => row.measuring));
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("scratch, nested worktrees and other role files belong to one consumer category each", async () => {
  const original = process.env.LLV_STATE_DIR;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-accounting-"));
  const state = path.join(fixture, "state");
  const scratch = path.join(state, "scratch");
  const worktree = path.join(scratch, "llv-export/checkout");
  const temp = path.join(fixture, "temp");
  const other = path.join(temp, "llv-other");
  const tempWorktree = path.join(other, "checkout");
  for (const directory of [worktree, tempWorktree]) fs.mkdirSync(directory, { recursive: true });
  const nested = path.join(worktree, "nested");
  const alias = path.join(fixture, "checkout-alias");
  fs.mkdirSync(nested);
  fs.symlinkSync(worktree, alias);
  fs.writeFileSync(path.join(nested, "bulk"), Buffer.alloc(16 * 1024, 1));
  fs.writeFileSync(path.join(scratch, "bulk"), Buffer.alloc(256 * 1024, 1));
  fs.writeFileSync(path.join(worktree, "bulk"), Buffer.alloc(128 * 1024, 1));
  fs.writeFileSync(path.join(tempWorktree, "bulk"), Buffer.alloc(64 * 1024, 1));
  fs.writeFileSync(path.join(other, "role.log"), Buffer.alloc(32 * 1024, 1));
  process.env.LLV_STATE_DIR = state;
  const caches = new Map();
  const worktrees = [worktree, tempWorktree, nested, alias, path.join(alias, "nested")];
  const options = { caches, worktrees, tempRoots: [{ path: scratch, via: "" }, { path: temp, via: "" }],
    roots: [{ role: "state", directory: state }], now: () => Date.parse("2026-10-06T12:00:00Z"),
    probe: () => ({ volume: "fixture", freeBytes: GiB }) };
  try {
    await readDiskPressure(options);
    await Promise.all([...caches.values()].map(row => row.measuring));
    const measured = await readDiskPressure(options);
    expect(measured.consumers.find(row => row.kind === "worktrees")?.bytes)
      .toBe(await exclusiveBytes(worktree) + await exclusiveBytes(tempWorktree));
    expect(measured.consumers.find(row => row.kind === "temp")?.bytes)
      .toBe(fs.statSync(path.join(other, "role.log")).blocks * 512);
    // The durable report itself is written during measurement. Its small
    // allocation does not affect the distinct 256 KiB scratch-file assertion.
    const stateBytes = measured.consumers.find(row => row.kind === "state")!.bytes;
    expect(stateBytes).toBeGreaterThanOrEqual(256 * 1024);
    expect(stateBytes).toBeLessThan(320 * 1024);
  } finally {
    await Promise.all([...caches.values()].map(row => row.measuring));
    if (original === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = original;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});


test.skipIf(process.platform === "win32")("hard-linked allocations contribute once across state, checkout and temp consumers", async () => {
  const original = process.env.LLV_STATE_DIR;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-hardlinks-"));
  const state = path.join(fixture, "state");
  const worktree = path.join(fixture, "checkout");
  const temp = path.join(fixture, "temp");
  const role = path.join(temp, "llv-role");
  for (const directory of [state, worktree, role]) fs.mkdirSync(directory, { recursive: true });
  const shared = path.join(state, "shared.bin");
  fs.writeFileSync(shared, Buffer.alloc(1024 * 1024, 1));
  fs.linkSync(shared, path.join(worktree, "shared.bin"));
  fs.linkSync(shared, path.join(role, "shared.bin"));
  fs.writeFileSync(path.join(role, "independent.bin"), Buffer.alloc(256 * 1024, 1));
  const alias = path.join(fixture, "checkout-alias");
  fs.symlinkSync(worktree, alias);
  process.env.LLV_STATE_DIR = state;
  const caches = new Map();
  const options = { caches, worktrees: [worktree, alias], tempRoots: [{ path: temp, via: "" }], roots: [{ role: "state", directory: state }],
    now: () => Date.parse("2026-10-06T12:00:00Z"), probe: () => ({ volume: "fixture", freeBytes: GiB }) };
  try {
    await readDiskPressure(options);
    await Promise.all([...caches.values()].map(row => row.measuring));
    const measured = await readDiskPressure(options);
    const bytes = fs.statSync(shared).blocks * 512;
    expect(measured.consumers.find(row => row.kind === "state")!.bytes).toBeGreaterThanOrEqual(bytes);
    expect(measured.consumers.find(row => row.kind === "worktrees")!.bytes).toBe(0);
    expect(measured.consumers.find(row => row.kind === "temp")!.bytes).toBe(256 * 1024);
    const total = measured.consumers.reduce((sum, row) => sum + row.bytes, 0);
    expect(total).toBeGreaterThanOrEqual(bytes + 256 * 1024);
    expect(total).toBeLessThan(bytes + 320 * 1024);
  } finally {
    await Promise.all([...caches.values()].map(row => row.measuring));
    if (original === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = original;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
