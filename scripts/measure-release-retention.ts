import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { retainReleases, type RetentionPorts } from "../src/lib/selfUpdate/retention";
import { scanProcesses } from "../src/lib/tempSweep";
import type { LauncherRecord } from "../src/lib/selfUpdate/launcher";

// T19 full-pass replay. Only pre-copied, read-only trees below this run's temp
// root are admitted. The Git port lists these copies and refuses every write.
const [seedArgument, output, revision, workloadObservedAt, liveAgentsRaw, runningAgentsRaw] = process.argv.slice(2);
if (!seedArgument || !output || !revision || !workloadObservedAt || !liveAgentsRaw || !runningAgentsRaw)
  throw new Error("usage: measure-release-retention <scratch seed> <output> <source revision> <agent_fleet observedAt> <live agents> <running agents>");
const liveAgents = Number(liveAgentsRaw);
const runningAgents = Number(runningAgentsRaw);
if (!Number.isSafeInteger(liveAgents) || liveAgents < 0 || !Number.isSafeInteger(runningAgents) || runningAgents < 0
  || !Number.isFinite(Date.parse(workloadObservedAt))) throw new Error("retention replay requires valid contemporaneous agent_fleet counts");
const seed = fs.realpathSync(seedArgument);
const temp = fs.realpathSync(os.tmpdir());
if (!seed.startsWith(temp + path.sep)) throw new Error("retention replay requires copies below TMPDIR");
const names = fs.readdirSync(seed).filter(name => /^[a-f0-9]{12}$/.test(name)).sort();
if (names.length !== 87) throw new Error("retention replay requires 87 copied releases");
const dirs = names.map(name => path.join(seed, name));
const sha = (dir: string) => {
  try { return fs.readFileSync(path.join(dir, ".next/DELEGATUS_RELEASE_READY"), "utf8").trim(); }
  catch { return path.basename(dir).padEnd(40, "0"); }
};
const heads = new Map(dirs.map(dir => [dir, sha(dir)]));
function inventory() {
  const hash = createHash("sha256"); let entries = 0;
  const pending = [seed];
  while (pending.length) {
    const file = pending.pop()!; const stat = fs.lstatSync(file); entries++;
    if (!stat.isSymbolicLink() && (stat.mode & 0o222)) throw new Error("retention replay seed must be read-only");
    hash.update(JSON.stringify([path.relative(seed, file), stat.mode, stat.size, stat.mtimeMs, stat.ino, stat.nlink, stat.blocks]));
    if (stat.isDirectory()) pending.push(...fs.readdirSync(file).sort().map(name => path.join(file, name)));
  }
  return { entries, digest: hash.digest("hex") };
}
const initial = inventory();
const processEntry = { state: "healthy" as const, pid: null, startIdentity: null, startedAt: null, revision: null, error: null, requestId: null };
const record: LauncherRecord = { version: 1, checkout: seed, releasesDir: seed, releasePointer: path.join(os.tmpdir(), "release.json"), requestFile: path.join(os.tmpdir(), "request.json"),
  launcher: { pid: 42, startIdentity: "fixture" }, web: { ...processEntry }, runtimeHost: { ...processEntry }, port: 0, socket: path.join(os.tmpdir(), "host.sock"), updatedAt: "" };
fs.writeFileSync(record.releasePointer, JSON.stringify({ dir: dirs[0], sha: heads.get(dirs[0]!) }));
let scans = 0;
const ports: RetentionPorts = {
  // Keep the same legacy /proc collector on both sides so this replay measures
  // full passes, independently of stricter production refusal on unreadable proc.
  scan: () => { scans++; return scanProcesses(); },
  env: { LLV_SELF_UPDATE_KEEP_RELEASES: "3" }, mountPoints: () => [],
  now: () => Date.UTC(2030, 0, 1), reportFile: path.join(os.tmpdir(), "retention-report.json"),
  git: async (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "list") return { code: 0, stderr: "", stdout: dirs.map(dir => `worktree ${dir}\0HEAD ${heads.get(dir)}\0\0`).join("") };
    if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: heads.get(cwd)! };
    throw new Error("read-only retention replay refused a Git operation");
  },
};
function cgroupLoad() {
  const groups = []; let directory = path.join("/sys/fs/cgroup", fs.readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1]!);
  while (directory.startsWith("/sys/fs/cgroup")) {
    const read = (name: string) => { try { return fs.readFileSync(path.join(directory, name), "utf8").trim(); } catch { return null; } };
    groups.push({ cpuMax: read("cpu.max"), memoryMax: read("memory.max"), cpuStat: read("cpu.stat"), memoryEvents: read("memory.events") });
    if (directory === "/sys/fs/cgroup") break;
    directory = path.dirname(directory);
  }
  return groups;
}
const load = () => ({ cgroups: cgroupLoad(), loadavg: os.loadavg(), cpus: os.availableParallelism(), memoryFree: os.freemem(),
  cpuPressure: fs.readFileSync("/proc/pressure/cpu", "utf8").trim() });
const sourceHashes: Record<string, string> = {};
function fingerprint(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) fingerprint(file);
    else if (/\.(ts|mjs|json)$/.test(file) && !/\.(test|fixture)\./.test(file))
      sourceHashes[path.relative(process.cwd(), file)] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
}
fingerprint("src/lib");
const sourceDigest = createHash("sha256").update(JSON.stringify(sourceHashes)).digest("hex");
let last = performance.now(); let maxGapMs = 0; let samples = 0; let nextSample: (() => void) | undefined;
const sample = () => new Promise<void>(resolve => { nextSample = resolve; });
const timer = setInterval(() => { const at = performance.now(); maxGapMs = Math.max(maxGapMs, at - last); last = at; samples++; const next = nextSample; nextSample = undefined; next?.(); }, 10);
const beforeLoad = load();
let report; let wallMs; let during;
try {
  await sample(); maxGapMs = 0; const before = samples; const started = performance.now();
  report = await retainReleases(record, { inFlight: dirs }, ports);
  wallMs = performance.now() - started; during = samples - before;
  await sample();
} finally { clearInterval(timer); }
if (report.errors.length || report.removed.length || report.reclaimedCacheBytes || report.kept.length !== 87) throw new Error("retention replay did not complete a read-only full pass");
const afterLoad = load(); const final = inventory();
if (initial.digest !== final.digest) throw new Error("retention replay changed its seed");
fs.writeFileSync(output, JSON.stringify({ case: "T19-full-pass", at: new Date().toISOString(), revision, bun: Bun.version, sourceDigest, sourceHashes, measurementSha256: createHash("sha256").update(fs.readFileSync(import.meta.path)).digest("hex"),
  releases: 87, entries: initial.entries, seedDigest: initial.digest, scans, wallMs, maxGapMs, timerSamplesDuringPass: during,
  workload: { source: "agent_fleet", scope: "project", observedAt: workloadObservedAt, liveAgents, runningAgents },
  kept: report.kept.map(row => ({ release: path.basename(row.dir), reason: row.reason, bytes: row.bytes })), removed: report.removed.length,
  loadBefore: beforeLoad, loadAfter: afterLoad }, null, 2));
console.log(JSON.stringify({ wallMs, maxGapMs, scans }));
