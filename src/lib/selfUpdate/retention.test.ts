import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { retainReleases, type RetentionInputs, type RetentionPorts } from "./retention";
import { finishTreeTrash, removeTreeViaTrash, scanProcesses, type ProcessScan } from "@/lib/tempSweep";
import type { LauncherRecord } from "./launcher";
import { runGit } from "./git";
import { RetentionWorker } from "./retentionWorker";
import { retentionProcessScan, withSelfObservation } from "./retentionInspection";
import { quarantineTree, sealProcessLinks } from "./gatedTrash";
import { installStateOwnershipGraph, MODULE_CONSUMER_SOURCE } from "./stateOwnershipGraph.fixture";

const DAY = 86_400_000;
const LOOP_PROBE_INTERVAL_MS = 10;
const LOOP_PROBE_SOURCE = `
  const { performance } = require("node:perf_hooks");
  const startedAt = performance.now();
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", chunk => {
    input += chunk;
    for (let end; (end = input.indexOf("\\n")) !== -1;) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      const message = JSON.parse(line);
      if (message.type === "finish") {
        process.stdout.write(JSON.stringify({ type: "result", elapsedMs: performance.now() - startedAt }) + "\\n");
        process.exit(0);
      }
    }
  });
  setInterval(() => {
    process.stdout.write(JSON.stringify({ type: "probe" }) + "\\n");
  }, ${LOOP_PROBE_INTERVAL_MS});
`;
function assertLoopStallDetected(measurement: { maxBlockedMs: number }) {
  expect(measurement.maxBlockedMs).toBeGreaterThan(50);
}
function startLoopProbe() {
  const child = spawn(process.execPath, ["-e", LOOP_PROBE_SOURCE], { stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  let output = "";
  let settled = false;
  let lastProbeAt: number | undefined;
  let maxBlockedMs = 0;
  let samples = 0;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: { maxBlockedMs: number; samples: number; elapsedMs: number }) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const result = new Promise<{ maxBlockedMs: number; samples: number; elapsedMs: number }>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output += chunk;
    for (let end; (end = output.indexOf("\n")) !== -1;) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      const message = JSON.parse(line);
      if (message.type === "probe") {
        const at = performance.now();
        if (lastProbeAt !== undefined) maxBlockedMs = Math.max(maxBlockedMs, at - lastProbeAt - LOOP_PROBE_INTERVAL_MS);
        lastProbeAt = at;
        samples++;
        resolveReady();
      } else if (message.type === "result") {
        settled = true;
        resolveResult({ ...message, maxBlockedMs, samples });
      }
    }
  });
  child.once("error", error => { rejectReady(error); if (!settled) rejectResult(error); });
  child.once("exit", (code, signal) => {
    if (code !== 0 || signal) {
      const error = new Error(`loop probe exited before a verdict (${signal ?? code})`);
      rejectReady(error);
      if (!settled) rejectResult(error);
    }
  });
  return {
    child,
    ready,
    result,
    finish: async () => { child.stdin.write(JSON.stringify({ type: "finish" }) + "\n"); return result; },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
      }
    },
  };
}
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const EMPTY: ProcessScan = { ownNamespace: "mnt:[fixture]", processes: [] };
function fixture(count = 8) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-test-"))); roots.push(root);
  const releases = path.join(root, "releases"); fs.mkdirSync(releases);
  const dirs: string[] = []; const shas: string[] = [];
  const now = Date.UTC(2030, 0, 1);
  for (let i = 0; i < count; i++) {
    const sha = (i + 1).toString(16).padStart(12, "0") + "a".repeat(28); shas.push(sha);
    const dir = path.join(releases, sha.slice(0, 12)); dirs.push(dir);
    for (const file of [".next/DELEGATUS_RELEASE_READY", ".next/BUILD_ID", ".next/cache/webpack/cache", ".next/cache/fetch-cache/runtime", ".next/cache/images/runtime", ".next/server/app.js", "node_modules/dep/index.js", "dist/server.js"]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), file.endsWith("READY") ? sha : "fixture data");
    }
    for (const file of [dir, path.join(dir, ".next/DELEGATUS_RELEASE_READY"), path.join(dir, ".next/BUILD_ID")]) fs.utimesSync(file, new Date(now - (count - i + 2) * DAY), new Date(now - (count - i + 2) * DAY));
  }
  const processEntry = { state: "healthy" as const, pid: null, startIdentity: null, startedAt: null, revision: null, error: null, requestId: null };
  const record: LauncherRecord = { version: 1, checkout: root, releasesDir: releases, releasePointer: path.join(root, "release.json"), requestFile: path.join(root, "request.json"),
    launcher: { pid: 42, startIdentity: "fixture" }, web: { ...processEntry }, runtimeHost: { ...processEntry }, port: 0, socket: path.join(root, "host.sock"), updatedAt: "" };
  fs.writeFileSync(record.releasePointer, JSON.stringify({ dir: dirs[0], sha: shas[0] }));
  const commands: string[][] = [];
  const locked = new Set<string>(); const unregistered = new Set<string>();
  const git: NonNullable<RetentionPorts["git"]> = async (args, at) => {
    commands.push(args);
    // A quarantined release answers Git as the release it was.
    const cwd = path.basename(path.dirname(at)).startsWith(".delegatus-trash-") ? path.join(path.dirname(path.dirname(at)), path.basename(at)) : at;
    // Like Git, a registration whose directory is missing stays listed as prunable until removed.
    if (args[0] === "worktree" && args[1] === "list") return { code: 0, stderr: "", stdout: dirs.filter(dir => !unregistered.has(dir)).map(dir =>
      `worktree ${dir}\0HEAD ${shas[dirs.indexOf(dir)]}\0${locked.has(dir) ? "locked fixture\0" : ""}${fs.existsSync(dir) ? "" : "prunable gitdir file points to non-existent location\0"}\0`).join("") };
    if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: shas[dirs.indexOf(cwd)]! };
    if (args[0] === "status") return { code: 0, stderr: "", stdout: "" };
    if (args[0] === "ls-files") return { code: 0, stderr: "", stdout: "H fixture.txt\0" };
    if (args[0] === "for-each-ref") return { code: 0, stderr: "", stdout: "refs/heads/main\n" };
    if (args[0] === "worktree" && args[1] === "remove") { fs.rmSync(args.at(-1)!, { recursive: true, force: true }); unregistered.add(args.at(-1)!); return { code: 0, stderr: "", stdout: "" }; }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  };
  const inputs: RetentionInputs = {};
  const ports: RetentionPorts = { maxCandidates: 128, git, scan: () => EMPTY, mountPoints: () => [], now: () => now, env: {},
    lockHead: () => () => {}, reportFile: path.join(root, "state/retention.json") };
  return { root, dirs, shas, record, inputs, ports, commands, locked, now, run: () => retainReleases(record, inputs, ports) };
}
const exists = fs.existsSync;

test.each([true, false])("a fresh install without a releases directory has nothing to retain (checkout=%s)", async checkout => {
  const h = fixture(0);
  fs.rmSync(h.record.releasesDir, { recursive: true });
  if (!checkout) h.record.checkout = null;
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([]);
  expect(JSON.parse(fs.readFileSync(h.ports.reportFile!, "utf8"))).toEqual(report);
  expect(exists(h.record.releasesDir)).toBeFalse();
});

test("a releases path that is a file still reports an inspection error", async () => {
  const h = fixture(0);
  fs.rmSync(h.record.releasesDir, { recursive: true });
  fs.writeFileSync(h.record.releasesDir, "not a directory");
  const report = await h.run();
  expect(report.errors).toHaveLength(1);
  expect(report.removed).toEqual([]);
  expect(fs.readFileSync(h.record.releasesDir, "utf8")).toBe("not a directory");
});

test("a scoped partial scan protects only its affected release, including caches", async () => {
  const h = fixture();
  h.ports.scan = () => ({ ...EMPTY, uncertain: [{ pid: 123, reason: "maps:EACCES", roots: [h.dirs[1]!] }] });
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs[1], reason: "process-unreadable:123:maps:EACCES" }));
  expect(exists(path.join(h.dirs[1]!, ".next/cache/webpack/cache"))).toBeTrue();
  expect(report.removed.some(row => row.dir === h.dirs[2])).toBeTrue();
});

test("an unscoped unreadable process keeps every release with its reason", async () => {
  const h = fixture();
  h.ports.scan = () => ({ ...EMPTY, uncertain: [{ pid: 123, reason: "fd:EACCES", roots: [h.record.releasesDir] }] });
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(report.kept.filter(row => row.reason.startsWith("process-unreadable:")).length).toBeGreaterThan(0);
  for (const dir of h.dirs) expect(exists(path.join(dir, ".next/cache/webpack/cache"))).toBeTrue();
});

test("a pass bounds release work and a later pass drains the remaining backlog", async () => {
  const h = fixture(12);
  const at = new Date(h.now - 10 * DAY);
  for (const dir of h.dirs) for (const file of [dir, path.join(dir, ".next/DELEGATUS_RELEASE_READY"), path.join(dir, ".next/BUILD_ID")]) fs.utimesSync(file, at, at);
  Object.assign(h.ports, { maxCandidates: 2 });
  const first = await h.run();
  expect(first.removed).toHaveLength(1);
  expect(first.kept.some(row => row.reason === "pass-budget")).toBeTrue();
  const second = await h.run();
  expect(second.removed).toHaveLength(2);
  expect(second.removed.every(row => !first.removed.some(old => old.dir === row.dir))).toBeTrue();
});

test("keep decisions over 87 releases use one inventory; destructive steps use fresh helper scans", async () => {
  const h = fixture(87);
  h.inputs.inFlight = [...h.dirs];
  let scans = 0;
  h.ports.scan = () => { scans++; return EMPTY; };
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(report.kept.map(row => row.dir)).toEqual(h.dirs);
  expect(scans).toBe(1);
});

test("the loop probe rejects observer loss after its readiness handshake", async () => {
  const probe = startLoopProbe();
  try {
    await probe.ready;
    probe.child.kill("SIGKILL");
    await expect(probe.result).rejects.toThrow("loop probe exited before a verdict");
  } finally {
    await probe.stop();
  }
});

test("a separately sampled 120 ms loop stall exceeds the 50 ms budget", async () => {
  const probe = startLoopProbe();
  try {
    await probe.ready;
    await new Promise(resolve => setTimeout(resolve, 25));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const measured = await probe.finish();
    expect(measured.samples).toBeGreaterThan(0);
    assertLoopStallDetected(measured);
    expect(() => assertLoopStallDetected({ maxBlockedMs: 0 })).toThrow();
  } finally {
    await probe.stop();
  }
});

test("the loop stays within 50 ms while counting 87 retained release trees", async () => {
  const h = fixture(87);
  h.ports.maxCandidates = 100;
  h.inputs.inFlight = [...h.dirs];
  for (const dir of h.dirs) {
    const tree = path.join(dir, "node_modules/fixture");
    fs.mkdirSync(tree);
    for (let i = 0; i < 128; i++) fs.writeFileSync(path.join(tree, `${i}.js`), "fixture");
  }
  const probe = startLoopProbe();
  try {
    await probe.ready;
    const report = await h.run();
    const measurement = await probe.finish();
    expect(report.errors).toEqual([]);
    expect(report.kept).toHaveLength(87);
    expect(report.kept.every(row => row.bytes > 0)).toBeTrue();
    console.info("[retention fixture]", JSON.stringify({ releases: 87, maxBlockedMs: measurement.maxBlockedMs, samples: measurement.samples, elapsedMs: measurement.elapsedMs }));
    expect(measurement.maxBlockedMs).toBeLessThanOrEqual(50);
    expect(measurement.samples).toBeGreaterThan(0);
  } finally {
    await probe.stop();
  }
}, 30_000);

test("the first pass removes every unprotected old release and reclaims retained caches", async () => {
  const h = fixture(); const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed.map(row => row.dir)).toEqual(h.dirs.slice(1, 5));
  expect(report.reclaimedCacheBytes).toBeGreaterThan(0);
  expect(JSON.parse(fs.readFileSync(h.ports.reportFile!, "utf8"))).toEqual(report);
  expect(h.commands.some(args => args.includes("prune"))).toBeFalse();
});

test.each(["active", "web", "runtimeHost", "launcher", "apply-rollback", "auto-rollback", "running", "failed", "apply-target", "locked"])("%s release is never removed", async kind => {
  const h = fixture(); const dir = h.dirs[1]!;
  if (kind === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir }));
  if (kind === "web" || kind === "runtimeHost" || kind === "launcher") h.record[kind].revision = h.shas[1]!.slice(0, 16);
  if (kind.endsWith("rollback")) h.inputs.rollbackPointers = [JSON.stringify({ dir })];
  if (["running", "failed", "apply-target"].includes(kind)) h.inputs.inFlight = [dir];
  if (kind === "locked") h.locked.add(dir);
  const report = await h.run();
  expect(exists(dir)).toBeTrue();
  expect(report.removed.some(row => row.dir === dir)).toBeFalse();
  expect(report.kept.some(row => row.dir === dir)).toBeTrue();
});

test.each(["cwd", "argv", "env", "maps"])("a release named by a running process through %s is kept", async kind => {
  const h = fixture(4); h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" }; const dir = h.dirs[1]!;
  if (kind === "maps") h.ports.scan = () => ({ ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [path.join(dir, "mapped.so")] }] });
  else {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...(kind === "argv" ? [path.join(dir, "script.ts")] : [])], {
      cwd: kind === "cwd" ? dir : h.root,
      env: { PATH: process.env.PATH, NODE_ENV: "test", ...(kind === "env" ? { CUSTOM_VENDOR: `prefix:${dir}/vendor:suffix` } : {}) }, stdio: "ignore",
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
    h.ports.scan = () => { const scan = scanProcesses(); return { ...scan, processes: scan.processes.filter(proc => proc.pid === child.pid) }; };
  }
  const report = await h.run();
  expect(exists(dir)).toBeTrue();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir, reason: "process" }));
}, 30_000);

test("the process scan is read again before each removal", async () => {
  const h = fixture(); let scans = 0;
  h.ports.scan = () => ++scans === 1 ? EMPTY : { ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [h.dirs[1]!] }] };
  const report = await h.run();
  expect(exists(h.dirs[1]!)).toBeTrue();
  expect(report.removed.some(row => row.dir === h.dirs[1])).toBeFalse();
});

test("a real process started during the final Git check protects its release", async () => {
  const h = fixture(4);
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.scan = scanProcesses;
  const run = h.ports.git!;
  const target = h.dirs[1]!;
  let refChecks = 0;
  let started = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "for-each-ref" && args[2] === h.shas[1] && ++refChecks === 2) {
      const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        cwd: target, env: { PATH: process.env.PATH, NODE_ENV: "test", HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR,
          LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL },
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
        child.once("exit", () => reject(new Error("holder exited before retention finished")));
      });
      started = true;
    }
    return result;
  };
  const report = await h.run();
  expect(started).toBeTrue();
  expect(report.errors).toEqual([]);
  expect(exists(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: target, reason: "changed" }));
}, 30_000);

test("a process acquired after an earlier removal still protects a later release in the same pass", async () => {
  const h = fixture(5);
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.scan = scanProcesses;
  const run = h.ports.git!;
  const first = h.dirs[1]!;
  const target = h.dirs[2]!;
  let started = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === first) {
      const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        cwd: target, env: { PATH: process.env.PATH, NODE_ENV: "test", HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR,
          LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL },
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
        child.once("exit", () => reject(new Error("holder exited before retention finished")));
      });
      started = true;
    }
    return result;
  };
  const report = await h.run();
  expect(started).toBeTrue();
  expect(report.errors).toEqual([]);
  expect(report.removed.some(row => row.dir === first)).toBeTrue();
  expect(exists(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
  expect(children.at(-1)!.exitCode).toBeNull();
  expect(children.at(-1)!.signalCode).toBeNull();
}, 30_000);

test("recovery advances past four held journals on a later pass", async () => {
  const h = fixture(0); h.record.checkout = null; h.ports.maxCandidates = 4;
  // Intact quarantines count toward the newest kept: the fifth is the oldest.
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const dirs = Array.from({ length: 5 }, (_, index) => path.join(h.record.releasesDir, `npm-2.0.${index}`));
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] }));
  const journals: string[] = [];
  for (const [index, dir] of dirs.entries()) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}");
    for (const entry of [path.join(dir, "package.json"), dir]) fs.utimesSync(entry, index === 4 ? 1 : 10 + index, index === 4 ? 1 : 10 + index);
    const journal = path.join(path.dirname(h.ports.reportFile!), `package-trash-${String(journals.length).padStart(3, "0")}.json`);
    await expect(removeTreeViaTrash(dir, { journal, held: () => false, remove: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    journals.push(journal);
  }
  const heldTrash = new Set(journals.slice(0, 4).map(file => JSON.parse(fs.readFileSync(file, "utf8")).trash as string));
  h.ports.scan = () => ({ ...EMPTY, processes: [...heldTrash].map((entry, index) => ({ pid: index + 100, namespace: EMPTY.ownNamespace, stamped: false, paths: [entry] })) });
  const first = await h.run();
  expect(first.removed).toEqual([]);
  expect(JSON.parse(fs.readFileSync(h.ports.reportFile!, "utf8")).recoveryCursor).toBe(path.basename(journals[3]!));
  const second = await h.run();
  expect(second.errors).toEqual([]);
  expect(second.removed).toContainEqual(expect.objectContaining({ dir: dirs[4] }));
  expect(fs.existsSync(dirs[4]!)).toBeFalse();
  for (const journal of journals.slice(0, 4)) expect(fs.existsSync(journal)).toBeTrue();
}, 30_000);

test("a process entering a recovered trash tree during owner IPC is refused, by either path", async () => {
  const h = fixture(0); h.record.checkout = null;
  const dir = path.join(h.record.releasesDir, "npm-4.0.0"); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.utimesSync(path.join(dir, "package.json"), 1, 1); fs.utimesSync(dir, 1, 1);
  // A newer release fills the one newest slot, so the quarantined one may go.
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const newer = path.join(h.record.releasesDir, "npm-5.0.0"); fs.mkdirSync(newer); fs.writeFileSync(path.join(newer, "package.json"), "{}");
  fs.utimesSync(path.join(newer, "package.json"), 2, 2); fs.utimesSync(newer, 2, 2);
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: path.join(h.record.releasesDir, "npm-0.0.0") }));
  const journal = path.join(path.dirname(h.ports.reportFile!), "package-trash-recovery-race.json");
  await expect(removeTreeViaTrash(dir, { journal, held: () => false, remove: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  const legacyTrash = JSON.parse(fs.readFileSync(journal, "utf8")).trash as string;
  let gated: string | undefined;
  h.ports.scan = () => {
    const gate = fs.readdirSync(h.record.releasesDir).find(name => name.startsWith(".delegatus-trash-npm-4.0.0-") && path.join(h.record.releasesDir, name) !== legacyTrash);
    if (gate) gated = path.join(h.record.releasesDir, gate, "npm-4.0.0");
    return EMPTY;
  };
  const refusals: (string | undefined)[] = [];
  const originalCurrent = h.ports.current;
  h.ports.current = async () => {
    if (gated && !refusals.length) {
      // The journal's own trash path is gone, and the gate is closed.
      for (const cwd of [legacyTrash, gated]) {
        const holder = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
          cwd, env: HOLDER_ENV(), stdio: ["ignore", "pipe", "ignore"] });
        children.push(holder);
        await new Promise<void>((resolve, reject) => {
          holder.once("error", error => { refusals.push((error as NodeJS.ErrnoException).code); children.splice(children.indexOf(holder), 1); resolve(); });
          holder.stdout!.once("data", () => reject(new Error("holder entered recovered trash")));
        });
      }
    }
    return originalCurrent?.() ?? { record: h.record, inputs: h.inputs, fenced: true };
  };
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(refusals).toEqual(["ENOENT", "EACCES"]);
  expect(report.removed).toContainEqual(expect.objectContaining({ dir }));
  expect(fs.existsSync(journal)).toBeFalse();
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
}, 30_000);

test("a process entering cache trash during owner IPC is refused at the closed gate", async () => {
  const h = fixture();
  const cache = path.join(h.dirs[0]!, ".next/cache/webpack");
  let gate: string | undefined;
  let refusal: NodeJS.ErrnoException | undefined;
  h.ports.scan = () => {
    const found = fs.readdirSync(path.dirname(cache)).find(name => name.startsWith(".delegatus-trash-webpack-"));
    if (found) gate = path.join(path.dirname(cache), found);
    return EMPTY;
  };
  const originalCurrent = h.ports.current;
  h.ports.current = async () => {
    if (gate && !refusal) {
      const holder = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        cwd: path.join(gate, "webpack"), env: HOLDER_ENV(), stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(holder);
      await new Promise<void>((resolve, reject) => {
        holder.once("error", error => { refusal = error; children.splice(children.indexOf(holder), 1); resolve(); });
        holder.stdout!.once("data", () => reject(new Error("holder entered a closed gate")));
      });
    }
    return originalCurrent?.() ?? { record: h.record, inputs: h.inputs, fenced: true };
  };
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(refusal?.code).toBe("EACCES");
  expect(fs.existsSync(cache)).toBeFalse();
  expect(fs.readdirSync(path.dirname(cache)).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  expect(exists(path.join(h.dirs[0]!, ".next/cache/fetch-cache/runtime"))).toBeTrue();
}, 30_000);

test("recent and newest-K releases are kept; K follows LLV_SELF_UPDATE_KEEP_RELEASES", async () => {
  const h = fixture(); h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  fs.utimesSync(path.join(h.dirs[1]!, ".next/BUILD_ID"), new Date(h.now), new Date(h.now));
  const report = await h.run();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs[1], reason: "recent" }));
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs.at(-1), reason: "newest" }));
  expect(report.removed).toHaveLength(5);
});

test.each(["pointer", "listing", "scan", "launcher"])("an unreadable %s removes nothing", async kind => {
  const h = fixture();
  if (kind === "pointer") fs.writeFileSync(h.record.releasePointer, "invalid");
  if (kind === "listing") h.ports.git = async () => ({ code: 1, stderr: "unavailable", stdout: "" });
  if (kind === "scan") h.ports.scan = () => ({ ownNamespace: null, processes: [] });
  if (kind === "launcher") h.ports.current = () => { throw new Error("cannot read launcher record"); };
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.removed).toEqual([]);
  for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
});

test("only registered release worktrees and npm containers are candidates", async () => {
  const h = fixture();
  const extra = ["notes", "eeeeeeeeeeee", "npm-1.2.3"];
  for (const name of extra) fs.mkdirSync(path.join(h.record.releasesDir, name));
  const outside = path.join(h.root, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.record.releasesDir, "ffffffffffff"));
  const report = await h.run();
  for (const name of extra) expect(exists(path.join(h.record.releasesDir, name))).toBeTrue();
  expect(exists(outside)).toBeTrue();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: path.join(h.record.releasesDir, "eeeeeeeeeeee"), reason: "unregistered" }));
});

test("cache reclamation removes only .next/cache/webpack", async () => {
  const h = fixture(); await h.run();
  const dir = h.dirs[0]!;
  expect(exists(path.join(dir, ".next/cache/webpack"))).toBeFalse();
  for (const file of [".next/BUILD_ID", ".next/server/app.js", ".next/cache/fetch-cache/runtime", ".next/cache/images/runtime", "node_modules/dep/index.js", "dist/server.js"]) expect(exists(path.join(dir, file))).toBeTrue();
});

test("webpack cache reclamation preserves a dirty nested Git checkout", async () => {
  const h = fixture(); const cache = path.join(h.dirs[0]!, ".next/cache/webpack/operator-project");
  fs.mkdirSync(cache, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: cache, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]);
  fs.writeFileSync(path.join(cache, "source.txt"), "committed source\n");
  git(["add", "source.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "source"]);
  fs.writeFileSync(path.join(cache, "source.txt"), "unique operator edits\n");
  fs.writeFileSync(path.join(cache, "untracked.txt"), "unique operator file\n");
  await h.run();
  expect(fs.readFileSync(path.join(cache, "source.txt"), "utf8")).toBe("unique operator edits\n");
  expect(fs.readFileSync(path.join(cache, "untracked.txt"), "utf8")).toBe("unique operator file\n");
});

test("webpack cache replay preserves a nested Git checkout from an older trash journal", async () => {
  const h = fixture(); const cache = path.join(h.dirs[0]!, ".next/cache/webpack");
  const nested = path.join(cache, "operator-project"); fs.mkdirSync(nested, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: nested, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]); fs.writeFileSync(path.join(nested, "source.txt"), "committed source\n");
  git(["add", "source.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "source"]);
  fs.writeFileSync(path.join(nested, "source.txt"), "unique edits\n");
  fs.writeFileSync(path.join(nested, "untracked.txt"), "unique file\n");
  const journal = path.join(path.dirname(h.ports.reportFile!), "cache-trash-legacy.json");
  await expect(removeTreeViaTrash(cache, { journal, held: () => false, remove: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  const trash = JSON.parse(fs.readFileSync(journal, "utf8")).trash as string;
  const report = await h.run();
  expect(fs.existsSync(trash)).toBeTrue();
  expect(fs.readFileSync(path.join(trash, "operator-project/source.txt"), "utf8")).toBe("unique edits\n");
  expect(fs.readFileSync(path.join(trash, "operator-project/untracked.txt"), "utf8")).toBe("unique file\n");
  expect(report.errors).toEqual([]);
});

test.each(["missing", "mismatch"])("a release with a %s ready marker keeps its build cache", async kind => {
  const h = fixture(); const marker = path.join(h.dirs[0]!, ".next/DELEGATUS_RELEASE_READY");
  if (kind === "missing") fs.unlinkSync(marker); else fs.writeFileSync(marker, "different");
  await h.run(); expect(exists(path.join(h.dirs[0]!, ".next/cache/webpack"))).toBeTrue();
});

test("a mount point under a release keeps it and its build cache", async () => {
  const h = fixture(); h.ports.mountPoints = dir => dir === h.dirs[1] ? [path.join(dir, "mounted")] : [];
  const report = await h.run();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs[1], reason: "mount-boundary" }));
  expect(exists(path.join(h.dirs[1]!, ".next/cache/webpack"))).toBeTrue();
});

test("package containers follow the same protected set", async () => {
  const h = fixture(0); h.record.checkout = null;
  const dirs = Array.from({ length: 8 }, (_, i) => path.join(h.record.releasesDir, `npm-1.0.${i}`));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}"); fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1); }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: path.join(dirs[0]!, "node_modules/delegatus-cli") }));
  h.inputs.rollbackPackage = path.join(dirs[1]!, "node_modules/delegatus-cli");
  const report = await h.run();
  expect(exists(dirs[0]!)).toBeTrue(); expect(exists(dirs[1]!)).toBeTrue();
  expect(report.removed.length).toBeGreaterThan(0);
});

function packageContainerFixture() {
  const h = fixture(0); h.record.checkout = null; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const dirs = Array.from({ length: 4 }, (_, i) => path.join(h.record.releasesDir, `npm-3.0.${i}`));
  for (const [i, dir] of dirs.entries()) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const date = new Date(h.now - (5 - i) * DAY);
    fs.utimesSync(dir, date, date); fs.utimesSync(path.join(dir, "package.json"), date, date);
  }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] })); h.inputs.rollbackPackage = dirs[1]!;
  return { ...h, dirs, target: dirs[2]! };
}

test.each(["active", "rollback", "serving", "in-flight"] as const)(
  "owner protection acquired during the final process scan preserves package trash (%s)", async protection => {
    const h = packageContainerFixture();
    const servingSha = "ab".repeat(20);
    const packageMetadata = path.join(h.target, "node_modules/delegatus-cli/package.json");
    fs.mkdirSync(path.dirname(packageMetadata), { recursive: true });
    fs.writeFileSync(packageMetadata, JSON.stringify({ gitHead: servingSha }));
    h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
    let acquired = false;
    h.ports.scan = () => {
      const quarantined = fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(`.delegatus-trash-${path.basename(h.target)}-`));
      if (quarantined && !acquired) {
        acquired = true;
        if (protection === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: h.target }));
        if (protection === "rollback") h.inputs.rollbackPackage = h.target;
        if (protection === "serving") h.record.web.revision = servingSha;
        if (protection === "in-flight") h.inputs.inFlight = [h.target];
      }
      return EMPTY;
    };

    const report = await h.run();
    expect(acquired).toBeTrue();
    expect(report.errors).toEqual([]);
    expect(fs.existsSync(path.join(h.target, "package.json"))).toBeTrue();
    expect(report.removed.some(row => row.dir === h.target)).toBeFalse();
    expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.target, reason: protection }));
  },
);

test("owner protection acquired during the final recovery scan preserves package trash", async () => {
  const h = packageContainerFixture();
  const journal = path.join(path.dirname(h.ports.reportFile!), "package-trash-recovery-race.json");
  await expect(removeTreeViaTrash(h.target, { journal, held: () => false, remove: async () => { throw new Error("interrupted"); } }))
    .rejects.toThrow("interrupted");
  h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
  let acquired = false;
  h.ports.scan = () => {
    const quarantined = fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(`.delegatus-trash-${path.basename(h.target)}-`));
    if (quarantined && !acquired) { acquired = true; h.inputs.rollbackPackage = h.target; }
    return EMPTY;
  };

  const report = await h.run();
  const trash = fs.readdirSync(h.record.releasesDir).find(name => name.startsWith(`.delegatus-trash-${path.basename(h.target)}-`));
  expect(acquired).toBeTrue();
  expect(report.errors).toEqual([]);
  expect(trash).toBeDefined();
  expect(fs.existsSync(path.join(h.record.releasesDir, trash!, "package.json"))).toBeTrue();
  expect(fs.existsSync(journal)).toBeTrue();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.target, reason: "rollback" }));
});

function dirtyNestedRepository(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]);
  fs.writeFileSync(path.join(directory, "tracked.txt"), "committed bytes\n");
  git(["add", "tracked.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(directory, "tracked.txt"), "unique modified bytes\n");
  fs.writeFileSync(path.join(directory, "untracked.txt"), "unique untracked bytes\n");
}

test("package retention preserves a dirty nested Git checkout", async () => {
  const h = packageContainerFixture();
  const nested = path.join(h.target, "workspace"); dirtyNestedRepository(nested);
  const report = await h.run();
  expect(fs.existsSync(nested)).toBeTrue();
  expect(fs.readFileSync(path.join(nested, "tracked.txt"), "utf8")).toBe("unique modified bytes\n");
  expect(fs.readFileSync(path.join(nested, "untracked.txt"), "utf8")).toBe("unique untracked bytes\n");
  expect(report.removed.some(row => row.dir === h.target)).toBeFalse();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.target, reason: "git-checkout" }));
});

test("package trash replay preserves a dirty nested Git checkout", async () => {
  const h = packageContainerFixture();
  const nested = path.join(h.target, "workspace"); dirtyNestedRepository(nested);
  const journal = path.join(path.dirname(h.ports.reportFile!), "package-trash-legacy.json");
  await expect(removeTreeViaTrash(h.target, { journal, held: () => false,
    remove: async () => { throw new Error("interrupted package removal"); } })).rejects.toThrow("interrupted package removal");
  const row = JSON.parse(fs.readFileSync(journal, "utf8")) as { trash: string };
  const report = await h.run();
  expect(fs.existsSync(row.trash)).toBeTrue();
  expect(fs.readFileSync(path.join(row.trash, "workspace/tracked.txt"), "utf8")).toBe("unique modified bytes\n");
  expect(fs.readFileSync(path.join(row.trash, "workspace/untracked.txt"), "utf8")).toBe("unique untracked bytes\n");
  expect(report.removed.some(entry => entry.dir === h.target)).toBeFalse();
});

test("one failed removal is reported and the next candidate is still reclaimed", async () => {
  const h = fixture(); const failing = path.basename(h.dirs[1]!);
  h.ports.removeTree = async entry => {
    // Removal runs from inside the quarantined tree: entries are relative.
    if (path.basename(process.cwd()) === failing && entry !== ".next/DELEGATUS_RELEASE_READY") throw new Error("fixture removal refused");
    await fs.promises.rm(entry, { recursive: true, force: true });
  };
  const report = await h.run();
  expect(report.errors).toHaveLength(1);
  expect(exists(h.dirs[1]!)).toBeFalse(); expect(exists(h.dirs[2]!)).toBeFalse();
  expect(report.removed.some(row => row.dir === h.dirs[1])).toBeFalse();
  // The partial tree stays journaled behind its gate, never ready, and the next pass finishes it.
  const gate = fs.readdirSync(h.record.releasesDir).find(name => name.startsWith(`.delegatus-trash-${failing}-`))!;
  expect(exists(path.join(h.record.releasesDir, gate, failing, ".next/DELEGATUS_RELEASE_READY"))).toBeFalse();
  h.ports.removeTree = undefined;
  const resumed = await h.run();
  expect(resumed.errors).toEqual([]);
  expect(resumed.removed.map(row => row.dir)).toContain(h.dirs[1]);
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  expect(h.commands.filter(args => args[0] === "worktree" && args[1] === "remove" && args.at(-1) === h.dirs[1])).toHaveLength(1);
});

test("retention never prunes other registrations", async () => {
  const h = fixture(0); const checkout = path.join(h.root, "repo"); fs.mkdirSync(checkout);
  const git = (args: string[]) => { const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" }); expect(result.status).toBe(0); return result.stdout; };
  git(["init", "-q"]); git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  const pipeline = path.join(h.root, "pipeline"); git(["worktree", "add", "--detach", pipeline]);
  fs.renameSync(pipeline, pipeline + "-away"); h.record.checkout = checkout;
  fs.unlinkSync(h.record.releasePointer); h.ports.git = runGit;
  await h.run(); expect(git(["worktree", "list", "--porcelain"])).toContain(pipeline);
});

function realReleaseFixture() {
  const h = fixture(0); const checkout = path.join(h.root, "source"); fs.mkdirSync(checkout);
  const git = (args: string[], cwd = checkout) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(checkout, ".gitignore"), ".next/\n");
  fs.writeFileSync(path.join(checkout, "source.txt"), "first\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "first"]);
  const first = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(checkout, "next.txt"), "second\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "second"]);
  const second = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(checkout, "third.txt"), "third\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "third"]);
  const third = git(["rev-parse", "HEAD"]);
  const active = path.join(h.record.releasesDir, first.slice(0, 12));
  const candidate = path.join(h.record.releasesDir, second.slice(0, 12));
  const newest = path.join(h.record.releasesDir, third.slice(0, 12));
  git(["worktree", "add", "--detach", active, first]); git(["worktree", "add", "--detach", candidate, second]); git(["worktree", "add", "--detach", newest, third]);
  for (const [dir, sha, age] of [[active, first, 3], [candidate, second, 4], [newest, third, 2]] as const) {
    fs.mkdirSync(path.join(dir, ".next"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".next/DELEGATUS_RELEASE_READY"), sha);
    fs.writeFileSync(path.join(dir, ".next/BUILD_ID"), "fixture");
    const date = new Date(h.now - age * DAY);
    for (const file of [dir, path.join(dir, ".next"), path.join(dir, ".next/DELEGATUS_RELEASE_READY"), path.join(dir, ".next/BUILD_ID")]) fs.utimesSync(file, date, date);
  }
  h.record.checkout = checkout;
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: active, sha: first }));
  h.ports.git = runGit;
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.mountPoints = () => [];
  return { ...h, active, candidate, newest, git };
}

test.each(["tracked-edit", "untracked-file", "unpublished-commit"])("release retention preserves %s", async kind => {
  const h = realReleaseFixture();
  if (kind === "tracked-edit") fs.writeFileSync(path.join(h.candidate, "source.txt"), "unique operator edit\n");
  if (kind === "untracked-file") fs.writeFileSync(path.join(h.candidate, "unique.txt"), "preserve me\n");
  if (kind === "unpublished-commit") {
    fs.writeFileSync(path.join(h.candidate, "private.txt"), "unpublished\n"); h.git(["add", "private.txt"], h.candidate);
    h.git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "unpublished"], h.candidate);
  }
  const old = new Date(h.now - 4 * DAY);
  for (const file of [h.candidate, path.join(h.candidate, ".next/DELEGATUS_RELEASE_READY"), path.join(h.candidate, ".next/BUILD_ID")]) fs.utimesSync(file, old, old);
  const report = await h.run();
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
  expect(fs.existsSync(h.candidate)).toBeTrue();
  if (kind === "tracked-edit") expect(fs.readFileSync(path.join(h.candidate, "source.txt"), "utf8")).toBe("unique operator edit\n");
  if (kind === "untracked-file") expect(fs.readFileSync(path.join(h.candidate, "unique.txt"), "utf8")).toBe("preserve me\n");
  if (kind === "unpublished-commit") expect(h.git(["status", "--porcelain"], h.candidate)).toBe("");
});

test("a release edit landing after the final ref check is refused by the quarantine status check", async () => {
  const h = realReleaseFixture(); let changed = false; const git = h.ports.git!;
  h.ports.git = async (args, cwd) => {
    // The last Git read before the rename; the edit lands at the release path.
    if (!changed && args[0] === "status" && path.basename(path.dirname(cwd)).startsWith(".delegatus-trash-")) {
      changed = true; fs.writeFileSync(path.join(cwd, "source.txt"), "late operator edit\n");
    }
    return git(args, cwd);
  };
  const report = await h.run();
  expect(changed).toBeTrue(); expect(fs.existsSync(h.candidate)).toBeTrue();
  expect(fs.readFileSync(path.join(h.candidate, "source.txt"), "utf8")).toBe("late operator edit\n");
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
});

test("an unpublished commit created during the last ref query protects its release", async () => {
  const h = realReleaseFixture(); h.ports.lockHead = undefined;
  const run = h.ports.git!; let committed = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (!committed && args[0] === "for-each-ref" && args[2] === h.git(["rev-parse", "HEAD"], h.candidate)) {
      committed = true;
      fs.writeFileSync(path.join(h.candidate, "late-commit.txt"), "unique commit\n");
      h.git(["add", "late-commit.txt"], h.candidate);
      h.git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "late local commit"], h.candidate);
    }
    return result;
  };
  const report = await h.run();
  expect(committed).toBeTrue(); expect(fs.existsSync(h.candidate)).toBeTrue();
  expect(fs.readFileSync(path.join(h.candidate, "late-commit.txt"), "utf8")).toBe("unique commit\n");
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
});

test("a late .next symlink cannot redirect ready-marker deletion into an active release", async () => {
  const h = realReleaseFixture(); const run = h.ports.git!; let replaced = false; let finalHeadReads = 0;
  const activeMarker = path.join(h.active, ".next/DELEGATUS_RELEASE_READY");
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (!replaced && args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD" && cwd === h.candidate
      && ++finalHeadReads === 2) {
      replaced = true;
      fs.rmSync(path.join(h.candidate, ".next"), { recursive: true, force: true });
      fs.symlinkSync(path.join(h.active, ".next"), path.join(h.candidate, ".next"), "dir");
    }
    return result;
  };
  const report = await h.run();
  expect(replaced).toBeTrue();
  expect(fs.readFileSync(activeMarker, "utf8")).toBe(h.git(["rev-parse", "HEAD"], h.active));
  expect(fs.existsSync(h.candidate)).toBeTrue();
  expect(report.removed.some(row => row.dir === h.candidate)).toBeFalse();
});

test.each(["active", "rollback", "process", "mount"] as const)("late %s protection acquired during the final ref check keeps the release", async kind => {
  const h = fixture(4); h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const target = h.dirs[1]!; const sha = h.shas[1]!; const run = h.ports.git!; let acquired = false; let refChecks = 0; let mounted = false;
  h.ports.mountPoints = directory => mounted && directory === target ? [path.join(target, "mounted")] : [];
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "for-each-ref" && args[2] === sha && ++refChecks === 2) {
      acquired = true;
      if (kind === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: target }));
      if (kind === "rollback") h.inputs.rollbackPointers = [JSON.stringify({ dir: target })];
      if (kind === "process") h.ports.scan = () => ({ ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [target] }] });
      if (kind === "mount") mounted = true;
    }
    return result;
  };
  const report = await h.run();
  expect(acquired).toBeTrue(); expect(fs.existsSync(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
});

test("a clean disposable release still expires", async () => {
  const h = realReleaseFixture(); const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed.map(row => row.dir)).toContain(h.candidate);
  expect(fs.existsSync(h.active)).toBeTrue(); expect(fs.existsSync(h.candidate)).toBeFalse();
  const listed = h.git(["worktree", "list", "--porcelain"]);
  expect(listed).not.toContain(h.candidate); expect(listed).toContain(h.active); expect(listed).toContain(h.newest);
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
});

test("an interrupted release removal finishes next pass even after its registration was pruned", async () => {
  const h = realReleaseFixture();
  h.ports.removeTree = async entry => {
    // Fail only the release-level removal; its generated `.next` output goes first, from its own gate.
    if (path.basename(process.cwd()) === path.basename(h.candidate)) throw new Error("interrupted release removal");
    await fs.promises.rm(entry, { recursive: true, force: true });
  };
  const interrupted = await h.run();
  expect(interrupted.errors).toHaveLength(1);
  expect(fs.existsSync(h.candidate)).toBeFalse();
  h.git(["worktree", "prune"]);
  h.ports.removeTree = undefined;
  const resumed = await h.run();
  expect(resumed.errors).toEqual([]);
  expect(resumed.removed.map(row => row.dir)).toContain(h.candidate);
  expect(h.git(["worktree", "list", "--porcelain"])).not.toContain(h.candidate);
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  expect(fs.existsSync(h.active)).toBeTrue(); expect(fs.existsSync(h.newest)).toBeTrue();
});

test("ten successive applies stay bounded by protected plus newest K", async () => {
  const h = fixture(0);
  for (let i = 0; i < 10; i++) {
    const sha = (i + 1).toString(16).padStart(12, "0") + "b".repeat(28);
    const dir = path.join(h.record.releasesDir, sha.slice(0, 12));
    h.dirs.push(dir); h.shas.push(sha); fs.mkdirSync(path.join(dir, ".next"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".next/DELEGATUS_RELEASE_READY"), sha); fs.writeFileSync(path.join(dir, ".next/BUILD_ID"), "fixture");
    for (const file of [dir, path.join(dir, ".next/DELEGATUS_RELEASE_READY"), path.join(dir, ".next/BUILD_ID")]) fs.utimesSync(file, 1000 + i, 1000 + i);
    h.inputs.rollbackPointers = i ? [JSON.stringify({ dir: h.dirs[i - 1] })] : [];
    fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir }));
    const report = await h.run(); expect(report.errors).toEqual([]);
    expect(exists(dir)).toBeTrue(); if (i) expect(exists(h.dirs[i - 1]!)).toBeTrue();
    expect(h.dirs.filter(exists).length).toBeLessThanOrEqual(5);
  }
  expect(h.dirs.filter(exists).length).toBe(5);
});

test("a holder acquired after the cache rename restores webpack", async () => {
  const h = fixture(); const dir = h.dirs[0]!;
  h.ports.scan = () => {
    const trash = fs.readdirSync(path.join(dir, ".next/cache")).find(name => name.startsWith(".delegatus-trash-"));
    return trash ? { ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [path.join(dir, ".next/cache", trash, "cache")] }] } : EMPTY;
  };
  const report = await h.run(); expect(report.errors).toEqual([]);
  expect(exists(path.join(dir, ".next/cache/webpack/cache"))).toBeTrue();
});

test("an interrupted cache removal leaves a trash name and resumes next pass", async () => {
  const h = fixture(); h.ports.removeTree = async () => { throw new Error("interrupted"); };
  const report = await h.run(); expect(report.errors.length).toBeGreaterThan(0);
  expect(exists(path.join(h.dirs[0]!, ".next/cache/webpack"))).toBeFalse();
  expect(fs.readdirSync(path.join(h.dirs[0]!, ".next/cache")).some(name => name.startsWith(".delegatus-trash-"))).toBeTrue();
  h.ports.removeTree = undefined; const resumed = await h.run(); expect(resumed.errors).toEqual([]);
  expect(fs.readdirSync(path.join(h.dirs[0]!, ".next/cache")).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  expect(exists(path.join(h.dirs[0]!, ".next/cache/fetch-cache/runtime"))).toBeTrue();
});

test("a cache symlink preserves the outside directory", async () => {
  const h = fixture(); const cache = path.join(h.dirs[0]!, ".next/cache");
  fs.renameSync(cache, cache + "-outside"); fs.symlinkSync(cache + "-outside", cache);
  await h.run(); expect(exists(path.join(cache + "-outside", "webpack/cache"))).toBeTrue();
});


test("a release completed during the final listing keeps its recent build", async () => {
  const h = fixture(); const run = h.ports.git!; let listings = 0;
  h.ports.git = async (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "list" && ++listings === 2)
      fs.utimesSync(path.join(h.dirs[1]!, ".next/BUILD_ID"), new Date(h.now), new Date(h.now));
    return run(args, cwd);
  };
  const report = await h.run();
  expect(report.removed.some(row => row.dir === h.dirs[1])).toBeFalse();
  expect(exists(h.dirs[1]!)).toBeTrue();
});


test("a process using an aliased argv path keeps the physical release", async () => {
  const h = fixture(); const alias = path.join(h.root, "release-alias"); fs.symlinkSync(h.dirs[1]!, alias);
  h.ports.scan = () => ({ ...EMPTY, processes: [{ pid: 42, namespace: EMPTY.ownNamespace, stamped: false, paths: [path.join(alias, "future-script.ts")] }] });
  const report = await h.run(); expect(report.errors).toEqual([]);
  expect(exists(h.dirs[1]!)).toBeTrue();
});


test.each([false, true])("package trash resumes safely with a new active pointer=%s", async reactivated => {
  const h = fixture(0); h.record.checkout = null; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const dirs = Array.from({ length: 8 }, (_, i) => path.join(h.record.releasesDir, `npm-1.0.${i}`));
  for (const dir of dirs) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1);
  }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] })); h.inputs.rollbackPackage = dirs[1];
  h.ports.removeTree = async () => { throw new Error("interrupted package removal"); };
  const interrupted = await h.run(); expect(interrupted.errors.length).toBeGreaterThan(0);
  const journals = fs.readdirSync(path.dirname(h.ports.reportFile!)).filter(name => name.startsWith("package-trash-") && name.endsWith(".json"));
  expect(journals.length).toBeGreaterThan(0);
  const row = JSON.parse(fs.readFileSync(path.join(path.dirname(h.ports.reportFile!), journals[0]!), "utf8"));
  expect(exists(row.directory)).toBeFalse(); expect(exists(row.trash)).toBeTrue();
  if (reactivated) fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: row.directory }));
  h.ports.removeTree = undefined; const resumed = await h.run(); expect(resumed.errors).toEqual([]);
  expect(exists(row.trash)).toBe(reactivated);
  if (!reactivated) expect(exists(dirs[0]!)).toBeTrue();
  expect(exists(dirs[1]!)).toBeTrue();
  if (reactivated) expect(resumed.kept).toContainEqual(expect.objectContaining({ dir: row.directory, reason: "active" }));
  else expect(resumed.removed.some(removed => removed.dir === row.directory)).toBeTrue();
});

test.each(["active", "rollback", "in-flight"])("package activation after rename preserves the %s container", async protection => {
  const h = fixture(0); h.record.checkout = null;
  const dirs = Array.from({ length: 8 }, (_, i) => path.join(h.record.releasesDir, `npm-2.0.${i}`));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}"); fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1); }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] })); h.inputs.rollbackPackage = dirs[1];
  const target = dirs[2]!; let acquired = false;
  h.ports.scan = () => {
    const renamed = fs.readdirSync(h.record.releasesDir).find(name => name.startsWith(".delegatus-trash-npm-2.0.2-"));
    if (renamed && !acquired) {
      acquired = true;
      if (protection === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: target }));
      if (protection === "rollback") h.inputs.rollbackPackage = target;
      if (protection === "in-flight") h.inputs.inFlight = [target];
    }
    return EMPTY;
  };
  const report = await h.run();
  expect(acquired).toBeTrue(); expect(exists(target)).toBeTrue();
  expect(exists(path.join(target, "package.json"))).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: target, reason: protection }));
});


test("a mount appearing above webpack during the HEAD read keeps the cache", async () => {
  const h = fixture(); const run = h.ports.git!; let mounted = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "rev-parse" && cwd === h.dirs[0]) mounted = true;
    return result;
  };
  h.ports.mountPoints = dir => mounted && dir === h.dirs[0] ? [path.join(dir, ".next")] : [];
  await h.run(); expect(exists(path.join(h.dirs[0]!, ".next/cache/webpack/cache"))).toBeTrue();
});

// Fail before any mutation: an uncertain inspection must stop the whole pass.
test.each(["scan-error", "scan-partial", "bytes-error", "helper-timeout"])("retention fails closed on %s", async failure => {
  const h = fixture();
  h.ports.scan = undefined;
  Object.assign(h.ports, { inspection: {
    scan: async () => {
      if (failure === "scan-error") throw new Error("scan unavailable");
      if (failure === "scan-partial") return { ...EMPTY, complete: false };
      return { ...EMPTY, complete: true };
    },
    bytes: async () => { throw new Error(failure === "helper-timeout" ? "helper deadline" : "bytes unavailable"); },
    close: async () => {},
  } });
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.removed).toEqual([]);
  expect(report.reclaimedCacheBytes).toBe(0);
  for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
});

test("a failed fresh safety scan aborts remaining candidates", async () => {
  const h = fixture(); let scans = 0;
  h.ports.scan = () => { if (++scans > 1) throw new Error("safety scan failed"); return EMPTY; };
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(scans).toBe(2);
  expect(report.removed).toEqual([]);
  for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
});

test.each(["exit", "hang", "malformed", "truncated", "oversize", "partial", "wrong-kind"])("a real %s helper removes nothing and leaves no helper behind", async failure => {
  const h = fixture(); h.ports.scan = undefined;
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [h.root, failure] }, 2_000);
  h.ports.inspection = worker;
  try {
    await worker.bytes(h.root); // ready, then fail the inventory request
    const pid = Number(fs.readFileSync(path.join(h.root, "helper-pid"), "utf8"));
    const report = await h.run();
    expect(report.errors.length).toBeGreaterThan(0); expect(report.removed).toEqual([]);
    expect(report.reclaimedCacheBytes).toBe(0);
    for (const dir of h.dirs) expect(exists(dir)).toBeTrue();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await worker.close(); }
}, 15_000);

test.each(["hold", "throw", "write", "allow"])("trash removal awaits its safety observation and revalidates: %s", async outcome => {
  const h = fixture(); const target = path.join(h.root, "disposable"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "file"), "original");
  const journal = path.join(h.root, "trash.json"); let resume!: () => void; let entered!: (trash: string) => void;
  const ready = new Promise<string>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { resume = resolve; });
  const removal = removeTreeViaTrash(target, { journal, held: async trash => {
    entered(trash); await proceed;
    if (outcome === "throw") throw new Error("inspection unavailable");
    return outcome === "hold";
  } });
  const trash = await ready;
  if (outcome === "write") fs.writeFileSync(path.join(trash, "late"), "preserve");
  resume();
  if (outcome === "throw") await expect(removal).rejects.toThrow("inspection unavailable");
  else expect(await removal).toBe(outcome === "allow");
  expect(exists(target)).toBe(outcome !== "allow");
  if (outcome === "write") expect(fs.readFileSync(path.join(target, "late"), "utf8")).toBe("preserve");
});

test.each(["hold", "throw", "write", "allow"])("trash replay awaits its safety observation and revalidates: %s", async outcome => {
  const h = fixture(); const target = path.join(h.root, "disposable"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "file"), "original");
  const journal = path.join(h.root, "trash.json");
  await expect(removeTreeViaTrash(target, { journal, held: () => false, remove: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  let resume!: () => void; let entered!: (trash: string) => void;
  const ready = new Promise<string>(resolve => { entered = resolve; }); const proceed = new Promise<void>(resolve => { resume = resolve; });
  const replay = finishTreeTrash(journal, async trash => {
    entered(trash); await proceed;
    if (outcome === "throw") throw new Error("inspection unavailable");
    return outcome === "hold";
  });
  const trash = await ready;
  if (outcome === "write") fs.writeFileSync(path.join(trash, "late"), "preserve");
  resume();
  if (outcome === "throw") await expect(replay).rejects.toThrow("inspection unavailable");
  else expect(await replay).toBe(outcome === "allow");
  expect(exists(trash)).toBe(outcome !== "allow");
  if (outcome === "write") expect(fs.readFileSync(path.join(trash, "late"), "utf8")).toBe("preserve");
});

test.each(["throw", "partial"])("a %s safety scan after package rename restores the release and aborts the pass", async failure => {
  const h = fixture(0); h.record.checkout = null; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const dirs = Array.from({ length: 4 }, (_, i) => path.join(h.record.releasesDir, `npm-3.0.${i}`));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}"); fs.utimesSync(dir, 1, 1); fs.utimesSync(path.join(dir, "package.json"), 1, 1); }
  fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: dirs[0] }));
  let failed = false;
  h.ports.scan = () => {
    if (fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))) {
      failed = true;
      if (failure === "throw") throw new Error("safety scan unavailable after rename");
      return { ...EMPTY, complete: false };
    }
    return EMPTY;
  };
  const report = await h.run();
  expect(failed).toBeTrue(); expect(report.errors.length).toBeGreaterThan(0); expect(report.removed).toEqual([]);
  for (const dir of dirs) expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe("{}");
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
});

test.each(["active", "rollback", "serving", "in-flight"])("fresh %s authority is read after awaiting the helper safety scan", async protection => {
  const h = fixture(4); const target = h.dirs[1]!;
  h.inputs.inFlight = [h.dirs[0]!]; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" }; h.ports.scan = undefined;
  h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
  let scans = 0; let acquired = false;
  h.ports.inspection = {
    scan: async () => {
      await Promise.resolve();
      if (++scans === 2) {
        acquired = true;
        if (protection === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: target }));
        if (protection === "rollback") h.inputs.rollbackPointers = [JSON.stringify({ dir: target })];
        if (protection === "serving") h.record.web.revision = h.shas[1]!;
        if (protection === "in-flight") h.inputs.inFlight = [h.dirs[0]!, target];
      }
      return { ...EMPTY, complete: true };
    }, bytes: async () => 0, close: async () => {},
  };
  const report = await h.run();
  expect(acquired).toBeTrue(); expect(report.errors).toEqual([]); expect(exists(target)).toBeTrue();
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
});

test.skipIf(process.platform !== "linux")("the leased helper rescans before later removals after an earlier release disappears", async () => {
  const h = fixture(5); const target = h.dirs[2]!; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  h.ports.scan = undefined; h.inputs.inFlight = [h.dirs[0]!];
  const proc = path.join(h.root, "proc"); fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true });
  fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [h.root, "inspect"] });
  h.ports.inspection = worker;
  const run = h.ports.git!; let acquired = false;
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === h.dirs[1]) {
      acquired = true;
      const base = path.join(proc, "123"); fs.mkdirSync(path.join(base, "ns"), { recursive: true }); fs.mkdirSync(path.join(base, "fd"));
      fs.symlinkSync("mnt:[fixture]", path.join(base, "ns/mnt"));
      fs.writeFileSync(path.join(base, "stat"), "123 (fixture) S " + "0 ".repeat(20));
      for (const link of ["cwd", "root", "exe"]) fs.symlinkSync(target, path.join(base, link));
      for (const file of ["cmdline", "environ", "maps"]) fs.writeFileSync(path.join(base, file), "");
    }
    return result;
  };
  try {
    await worker.bytes(h.root);
    const report = await h.run();
    expect(acquired).toBeTrue(); expect(report.errors).toEqual([]);
    expect(report.removed.some(row => row.dir === h.dirs[1])).toBeTrue();
    expect(report.removed.some(row => row.dir === target)).toBeFalse(); expect(exists(target)).toBeTrue();
    expect(fs.readFileSync(path.join(h.root, "requests"), "utf8").split("\n").filter(kind => kind === "scan").length).toBeGreaterThan(2);
    const pid = Number(fs.readFileSync(path.join(h.root, "helper-pid"), "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  } finally { await worker.close(); }
}, 30_000);

test("an inspection failure after a completed removal stops all remaining destructive work", async () => {
  const h = fixture(5); h.inputs.inFlight = [h.dirs[0]!]; h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const run = h.ports.git!; let removed = false;
  h.ports.scan = () => { if (removed) throw new Error("later safety scan unavailable"); return EMPTY; };
  h.ports.git = async (args, cwd) => {
    const result = await run(args, cwd);
    if (args[0] === "worktree" && args[1] === "remove") removed = true;
    return result;
  };
  const report = await h.run();
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.removed.map(row => row.dir)).toEqual([h.dirs[1]!]);
  for (const dir of [h.dirs[0]!, ...h.dirs.slice(2)]) expect(exists(dir)).toBeTrue();
});

test.skipIf(process.platform !== "linux")("87 keep decisions request exactly one inventory from the leased helper", async () => {
  const h = fixture(87); h.inputs.inFlight = [...h.dirs]; h.ports.scan = undefined;
  const proc = path.join(h.root, "proc"); fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true }); fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [h.root, "inspect"] }); h.ports.inspection = worker;
  try {
    await worker.bytes(h.root);
    const report = await h.run();
    expect(report.errors).toEqual([]); expect(report.removed).toEqual([]); expect(report.kept.map(row => row.dir)).toEqual(h.dirs);
    expect(fs.readFileSync(path.join(h.root, "requests"), "utf8").split("\n").filter(kind => kind === "scan")).toHaveLength(1);
    const pid = Number(fs.readFileSync(path.join(h.root, "helper-pid"), "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  } finally { await worker.close(); }
}, 30_000);

// Every scan point of a pass, found by a calibration run. A real proc root
// limited to this process and the probe's holders keeps each scan cheap.
type ScanProbe = (scan: number, location: string | null) => Promise<void>;
function scopedProcRoot(root: string, pids: number[]) {
  const proc = fs.mkdtempSync(path.join(root, "proc-"));
  fs.symlinkSync("/proc/self", path.join(proc, "self"));
  for (const pid of new Set([process.pid, ...pids])) fs.symlinkSync(`/proc/${pid}`, path.join(proc, String(pid)));
  return proc;
}
function probedInspection(h: ReturnType<typeof fixture>, probe: ScanProbe, located: () => string | null) {
  let scans = 0;
  const inspection: NonNullable<RetentionPorts["inspection"]> = {
    scan: async root => {
      const proc = scopedProcRoot(h.root, children.flatMap(child => child.pid && child.exitCode === null && child.signalCode === null ? [child.pid] : []));
      const snapshot = retentionProcessScan(root, proc);
      fs.rmSync(proc, { recursive: true, force: true });
      await probe(++scans, located());
      return snapshot;
    },
    bytes: async () => 0, close: async () => {},
  };
  return { inspection, scans: () => scans };
}
/** The release at its path, or wherever retention quarantined it. */
function quarantineLocator(releases: string, target: string, marker: string) {
  return () => {
    if (fs.existsSync(target)) return target;
    const gate = fs.readdirSync(releases).find(name => name.startsWith(`.delegatus-trash-${path.basename(target)}-`));
    if (!gate) return null;
    const outer = path.join(releases, gate);
    return fs.existsSync(path.join(outer, marker)) ? outer : path.join(outer, path.basename(target));
  };
}
const HOLDER_ENV = () => ({ PATH: process.env.PATH, NODE_ENV: "test" as const, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL });
/** Start a real holder of `location`; resolves whether it acquired the tree. */
async function startHolder(kind: "cwd" | "fd" | "mapped" | "module", location: string, file: string, cwd: string): Promise<ChildProcess | null> {
  const keep = "process.stdout.write('ready'); setInterval(() => {}, 1000);";
  const args = kind === "cwd" ? ["-e", keep]
    : kind === "fd" ? ["-e", `globalThis.held = require("node:fs").openSync(process.env.HOLD_PATH, "r"); ${keep}`]
      : kind === "mapped" ? ["-e", `globalThis.held = Bun.mmap(process.env.HOLD_PATH); ${keep}`]
        : [path.join(location, "holder.js")];
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, { cwd: kind === "cwd" ? location : cwd, env: { ...HOLDER_ENV(), HOLD_PATH: path.join(location, file) },
      stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
  children.push(child);
  return new Promise(resolve => {
    // A refused spawn never exits; it is no child to stop.
    child.once("error", () => { children.splice(children.indexOf(child) >>> 0, 1); resolve(null); });
    child.stdout!.once("data", () => resolve(child));
    child.once("exit", () => resolve(null));
  });
}
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
async function settleChildren() {
  for (const child of children.splice(0)) {
    if (!alive(child)) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
  }
}

function packageRaceFixture() {
  const h = packageContainerFixture();
  const servingSha = "ab".repeat(20);
  const metadata = path.join(h.target, "node_modules/delegatus-cli/package.json");
  fs.mkdirSync(path.dirname(metadata), { recursive: true }); fs.writeFileSync(metadata, JSON.stringify({ gitHead: servingSha }));
  fs.writeFileSync(path.join(h.target, "holder.js"), "process.stdout.write('ready'); setInterval(() => {}, 1000);");
  h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
  h.ports.scan = undefined;
  return { ...h, servingSha, marker: "package.json" };
}
function checkoutRaceFixture() {
  const h = fixture(3); h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "1" };
  const target = h.dirs[1]!;
  fs.writeFileSync(path.join(target, "holder.js"), "process.stdout.write('ready'); setInterval(() => {}, 1000);");
  h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
  h.ports.scan = undefined;
  return { ...h, target, servingSha: h.shas[1]!, marker: ".next/BUILD_ID" };
}
type RaceFixture = ReturnType<typeof packageRaceFixture> | ReturnType<typeof checkoutRaceFixture>;
const RACE_LAYOUTS = { package: packageRaceFixture, checkout: checkoutRaceFixture } as const;
async function calibratedScans(layout: keyof typeof RACE_LAYOUTS) {
  const h = RACE_LAYOUTS[layout]();
  const probe = probedInspection(h, async () => {}, () => null); h.ports.inspection = probe.inspection;
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed.map(row => row.dir)).toContain(h.target);
  return probe.scans();
}
function acquireHold(h: RaceFixture, kind: "active" | "rollback" | "serving" | "in-flight") {
  if (kind === "active") fs.writeFileSync(h.record.releasePointer, JSON.stringify({ dir: h.target }));
  if (kind === "rollback") h.inputs.rollbackPointers = [JSON.stringify({ dir: h.target })];
  if (kind === "serving") h.record.web.revision = h.servingSha;
  if (kind === "in-flight") h.inputs.inFlight = [h.target];
}

test.skipIf(process.platform !== "linux").each(["package", "checkout"] as const)(
  "an owner hold acquired during any process scan keeps the %s release", async layout => {
    const total = await calibratedScans(layout);
    expect(total).toBeGreaterThan(1);
    const removedAfterHold: string[] = [];
    for (const kind of ["active", "rollback", "serving", "in-flight"] as const) {
      for (let at = 1; at <= total; at++) {
        const h = RACE_LAYOUTS[layout]();
        let acquired = false;
        h.ports.inspection = probedInspection(h, async (scan, where) => { if (scan === at && where) { acquired = true; acquireHold(h, kind); } },
          quarantineLocator(h.record.releasesDir, h.target, h.marker)).inspection;
        const report = await h.run();
        expect(report.errors).toEqual([]);
        if (acquired && (!fs.existsSync(path.join(h.target, h.marker)) || report.removed.some(row => row.dir === h.target)))
          removedAfterHold.push(`${kind}@scan${at}/${total}`);
      }
    }
    expect(removedAfterHold).toEqual([]);
  }, 120_000);

test.skipIf(process.platform !== "linux").each(["package", "checkout"] as const)(
  "a real holder started after any scan snapshot is refused or keeps the %s release", async layout => {
    const total = await calibratedScans(layout);
    const deletedUnderHolder: string[] = [];
    let refused = 0; let protectedByHolder = 0;
    for (const kind of ["cwd", "fd", "mapped", "module"] as const) {
      for (let at = 1; at <= total; at++) {
        const h = RACE_LAYOUTS[layout]();
        let holder: ChildProcess | null = null; let tried = false; let location: string | null = null;
        h.ports.inspection = probedInspection(h, async (scan, where) => {
          if (scan !== at || !where) return;
          tried = true; location = where;
          holder = await startHolder(kind, where, h.marker, h.root);
        }, quarantineLocator(h.record.releasesDir, h.target, h.marker)).inspection;
        const report = await h.run();
        expect(report.errors).toEqual([]);
        if (tried && holder && alive(holder) && !fs.existsSync(path.join(location!, h.marker)) && !fs.existsSync(path.join(h.target, h.marker)))
          deletedUnderHolder.push(`${kind}@scan${at}/${total}`);
        if (tried && holder && report.removed.some(row => row.dir === h.target)) deletedUnderHolder.push(`${kind}@scan${at}/${total}:reported`);
        if (tried && !holder) refused++;
        if (tried && holder && fs.existsSync(path.join(h.target, h.marker))) protectedByHolder++;
        await settleChildren();
      }
    }
    expect(deletedUnderHolder).toEqual([]);
    // Both outcomes occur: early holders keep the release, late ones are refused.
    expect(refused).toBeGreaterThan(0); expect(protectedByHolder).toBeGreaterThan(0);
  }, 300_000);

test.each(["package", "checkout"] as const)("a hold acquired at any owner read keeps the %s release, and the final read fences later holds", async layout => {
  // Each read replies with the state from before its hold, as an IPC reply in
  // flight would. The owner fences holds on a release once retention claims
  // it, so a hold either lands before that claim (and keeps the release,
  // renamed or not) or is refused.
  const total = await calibratedScans(layout);
  const removedUnderHold: string[] = [];
  let refusedHolds = 0; let keptByHold = 0;
  for (const kind of ["rollback", "serving", "in-flight"] as const) {
    for (let at = 1; ; at++) {
      const h = RACE_LAYOUTS[layout]();
      h.ports.inspection = probedInspection(h, async () => {}, () => null).inspection;
      const claims = new Set<string>(); let reads = 0; let acquired = false;
      h.ports.current = ((claim?: string) => {
        if (claim) claims.add(claim);
        const reply = structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
        if (++reads === at) {
          if ([...claims].some(dir => h.target === dir || h.target.startsWith(dir + path.sep) || dir.startsWith(h.target + path.sep))) refusedHolds++;
          else { acquired = true; acquireHold(h, kind); }
        }
        return reply;
      }) as RetentionPorts["current"];
      const report = await h.run();
      expect(report.errors).toEqual([]);
      if (reads < at) break;
      if (acquired && (!fs.existsSync(path.join(h.target, h.marker)) || report.removed.some(row => row.dir === h.target))) removedUnderHold.push(`${kind}@read${at}`);
      if (acquired && fs.existsSync(path.join(h.target, h.marker))) keptByHold++;
    }
  }
  expect(total).toBeGreaterThan(0);
  expect(removedUnderHold).toEqual([]);
  expect(refusedHolds).toBeGreaterThan(0); expect(keptByHold).toBeGreaterThan(0);
}, 120_000);

test.each(["package", "checkout"] as const)("an owner that cannot fence holds never authorizes removal of the %s release", async layout => {
  const h = RACE_LAYOUTS[layout]();
  h.ports.inspection = probedInspection(h, async () => {}, () => null).inspection;
  h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs, fenced: false });
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(fs.existsSync(path.join(h.target, h.marker))).toBeTrue();
  expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.target, reason: "owner-unfenced" }));
});

test.skipIf(process.platform !== "linux").each(["package", "checkout"] as const)(
  "a holder entering through the remover's /proc cwd after the final scan is refused or keeps the %s release", async layout => {
    const h = RACE_LAYOUTS[layout]();
    const locate = quarantineLocator(h.record.releasesDir, h.target, h.marker);
    h.ports.inspection = probedInspection(h, async () => {}, () => null).inspection;
    let tried = 0; const entered: ChildProcess[] = [];
    h.ports.current = (async () => {
      const where = locate();
      if (where && where !== h.target) {
        tried++;
        const holder = await startHolder("cwd", `/proc/${process.pid}/cwd`, h.marker, h.root);
        if (holder) entered.push(holder);
      }
      return structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
    }) as RetentionPorts["current"];
    const report = await h.run();
    expect(report.errors).toEqual([]);
    expect(tried).toBeGreaterThan(0);
    if (entered.some(alive)) {
      expect(fs.existsSync(path.join(h.target, h.marker))).toBeTrue();
      expect(report.removed.some(row => row.dir === h.target)).toBeFalse();
    } else expect(report.removed.some(row => row.dir === h.target)).toBeTrue();
    await settleChildren();
  }, 60_000);

/** A Bun process outside the release that imports one of its modules by a
 * path it receives over stdin, keeping only what the import leaves behind. */
async function startModuleConsumer(file: string, cwd: string) {
  const child = spawn(process.execPath, ["-e", MODULE_CONSUMER_SOURCE], { cwd, env: HOLDER_ENV(), stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  const ready = new Promise<boolean>(resolve => {
    child.once("error", () => { children.splice(children.indexOf(child) >>> 0, 1); resolve(false); });
    child.stdout!.once("data", () => resolve(true));
    child.once("exit", () => resolve(false));
  });
  child.stdin!.write(file + "\n");
  expect(await ready).toBeTrue();
  return child;
}

test.skipIf(process.platform !== "linux").each(["package", "checkout"] as const)(
  "a process that loaded the real state-ownership module from the %s release keeps it for its lifetime", async layout => {
    const h = RACE_LAYOUTS[layout]();
    // A copy of the real module graph, loaded from inside the tree as a
    // checkout release built in place loads it; nothing here calls the hold.
    const entry = installStateOwnershipGraph(h.target);
    h.ports.inspection = probedInspection(h, async () => {}, () => null).inspection;
    h.ports.current = () => structuredClone({ record: h.record, inputs: h.inputs, fenced: true });
    const consumer = await startModuleConsumer(entry, h.root);
    // The consumer names the release in no argv, environment, cwd or mapping:
    // only the release root descriptor stateOwnership's own load opened.
    const own = retentionProcessScan(h.record.releasesDir, scopedProcRoot(h.root, [consumer.pid!])).processes.find(proc => proc.pid === consumer.pid);
    expect(own?.references ?? []).toEqual([]);
    expect(own?.paths ?? []).toEqual([h.target]);
    const report = await h.run();
    expect(report.errors).toEqual([]);
    expect(alive(consumer)).toBeTrue();
    expect(fs.existsSync(entry)).toBeTrue();
    expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.target, reason: "process" }));
    await settleChildren();
    const after = await h.run();
    expect(after.errors).toEqual([]);
    expect(after.removed.map(row => row.dir)).toContain(h.target);
  }, 60_000);

test.each(["package", "checkout"] as const)("a whole %s release quarantined before a crash is restored when a raised keep count names it", async layout => {
  const h = layout === "package" ? packageContainerFixture() : realReleaseFixture();
  const target = layout === "package" ? (h as ReturnType<typeof packageContainerFixture>).target : (h as ReturnType<typeof realReleaseFixture>).candidate;
  const marker = layout === "package" ? "package.json" : "source.txt";
  const sha = layout === "package" ? "" : (h as ReturnType<typeof realReleaseFixture>).git(["rev-parse", "HEAD"], target);
  const state = path.dirname(h.ports.reportFile!); fs.mkdirSync(state, { recursive: true });
  // The state a pass leaves when it dies after the rename, before removal.
  expect(quarantineTree(target, path.join(state, `${layout === "package" ? "package" : "release"}-trash-crash.json`), { sha })).not.toBeNull();
  expect(fs.existsSync(target)).toBeFalse();
  h.ports.env = { LLV_SELF_UPDATE_KEEP_RELEASES: "2" };
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed.some(row => row.dir === target)).toBeFalse();
  expect(fs.existsSync(path.join(target, marker))).toBeTrue();
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
});

test("a replayed checkout deletion preserves bytes written into its partial tree", async () => {
  const h = realReleaseFixture();
  h.ports.removeTree = async entry => {
    if (path.basename(process.cwd()) === path.basename(h.candidate)) throw new Error("interrupted release removal");
    await fs.promises.rm(entry, { recursive: true, force: true });
  };
  const interrupted = await h.run();
  expect(interrupted.errors).toHaveLength(1);
  const state = path.dirname(h.ports.reportFile!);
  const journal = fs.readdirSync(state).find(name => name.startsWith("release-trash-") && name.endsWith(".json"))!;
  const row = JSON.parse(fs.readFileSync(path.join(state, journal), "utf8"));
  expect(row.deleting).toBeTrue();
  fs.writeFileSync(path.join(row.trash, "source.txt"), "new uncommitted operator bytes\n");
  h.ports.removeTree = undefined;
  const resumed = await h.run();
  expect(resumed.removed.some(entry => entry.dir === h.candidate)).toBeFalse();
  expect(fs.readFileSync(path.join(row.trash, "source.txt"), "utf8")).toBe("new uncommitted operator bytes\n");
});

test.skipIf(process.platform !== "linux")("a helper scan of the sealed remover is replaced by the remover's own observation", async () => {
  const h = fixture(2);
  const proc = path.join(h.root, "proc"); fs.mkdirSync(proc);
  fs.symlinkSync("/proc/self", path.join(proc, "self")); fs.symlinkSync(`/proc/${process.pid}`, path.join(proc, String(process.pid)));
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [h.root, "inspect"] });
  const cwd = process.cwd(); process.chdir(h.dirs[1]!);
  let unseal: (() => void) | null = null;
  try {
    await worker.bytes(h.root);
    unseal = sealProcessLinks();
    expect(unseal).not.toBeNull();
    const helper = await worker.scan(h.record.releasesDir);
    // The helper, another process, cannot read a sealed process.
    expect(helper.uncertain?.some(row => row.pid === process.pid)).toBeTrue();
    const observed = withSelfObservation(helper, h.record.releasesDir);
    expect(observed.uncertain?.some(row => row.pid === process.pid)).toBeFalse();
    expect(observed.processes.find(proc => proc.pid === process.pid)?.paths).toContain(h.dirs[1]!);
  } finally { process.chdir(cwd); unseal?.(); await worker.close(); }
}, 30_000);


test("generated regular files no longer hold an old release", async () => {
  const h = fixture(), dir = h.dirs[1]!;
  fs.writeFileSync(path.join(dir, "next-env.d.ts"), "generated");
  const run = h.ports.git!;
  h.ports.git = async (args, cwd) => args[0] === "status" && cwd === dir
    ? { code: 0, stderr: "", stdout: fs.existsSync(path.join(dir, "next-env.d.ts")) ? "!! next-env.d.ts\0" : "" }
    : run(args, cwd);
  const report = await h.run();
  expect(report.errors).toEqual([]);
  expect(report.removed.some(row => row.dir === dir)).toBeTrue();
});


test("a generated-file replacement during the final owner read keeps the release", async () => {
  const h = fixture(), dir = h.dirs[1]!, target = path.join(dir, "next-env.d.ts");
  fs.writeFileSync(target, "original");
  const run = h.ports.git!;
  let inspecting = false, armed = false, replaced = false;
  h.ports.git = async (args, cwd) => {
    if (args[0] === "status") inspecting = cwd === dir;
    if (args[0] === "for-each-ref" && inspecting) armed = true;
    return args[0] === "status" && cwd === dir
      ? { code: 0, stderr: "", stdout: fs.existsSync(target) ? "!! next-env.d.ts\0" : "" } : run(args, cwd);
  };
  h.ports.current = async () => {
    if (!replaced && armed) {
      replaced = true; fs.writeFileSync(target + ".replacement", "replacement"); fs.renameSync(target + ".replacement", target);
    }
    return { record: h.record, inputs: h.inputs, fenced: true };
  };
  const report = await h.run();
  expect(replaced).toBeTrue(); expect(report.removed.some(row => row.dir === dir)).toBeFalse();
  expect(fs.readFileSync(target, "utf8")).toBe("replacement");
});


test("an unknown ignored file keeps an old release", async () => {
  const h = fixture(), dir = h.dirs[1]!; fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
  const run = h.ports.git!;
  h.ports.git = async (args, cwd) => args[0] === "status" && cwd === dir
    ? { code: 0, stderr: "", stdout: "!! notes.txt\0" } : run(args, cwd);
  const report = await h.run();
  expect(report.removed.some(row => row.dir === dir)).toBeFalse();
  expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("keep");
});

test.each(["release", "intermediate"])("generated file cleanup retains a replaced %s parent", async parent => {
  const h = fixture(), dir = h.dirs[1]!;
  const relative = parent === "release" ? "next-env.d.ts" : "generated/next-env.d.ts";
  const target = path.join(dir, relative), replacedParent = path.dirname(target);
  fs.mkdirSync(replacedParent, { recursive: true }); fs.writeFileSync(target, "preserved generated file");
  const outside = path.join(h.root, "outside-release-records");
  const run = h.ports.git!;
  let inspecting = false, armed = false, replaced = false;
  h.ports.git = async (args, cwd) => {
    if (args[0] === "status") inspecting = cwd === dir;
    if (args[0] === "for-each-ref" && inspecting) armed = true;
    return args[0] === "status" && cwd === dir
      ? { code: 0, stderr: "", stdout: fs.existsSync(target) ? `!! ${relative}\0` : "" } : run(args, cwd);
  };
  h.ports.current = async () => {
    if (armed && !replaced) {
      replaced = true; fs.renameSync(replacedParent, outside); fs.symlinkSync(outside, replacedParent, "dir");
    }
    return { record: h.record, inputs: h.inputs, fenced: true };
  };
  const report = await h.run();
  expect(replaced).toBeTrue();
  expect(report.removed.some(row => row.dir === dir)).toBeFalse();
  expect(fs.readFileSync(path.join(outside, "next-env.d.ts"), "utf8")).toBe("preserved generated file");
  expect(report.kept.some(row => row.dir === dir)).toBeTrue();
});
