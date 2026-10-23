// The gate runner's side of one remote gate run (docs/design/remote-gate-runner.md §8.5).
// The client uploads this file with every run, so both ends speak the same
// protocol; it uses Node built-ins only because it runs before the tree exists.
//
//   serve.ts run <dir>           own the run, set it up, run it, report
//   serve.ts setup <dir>         inside the gate-setup-<id> unit: materialize, install, verify, contain
//   serve.ts exec <dir>          inside the gate-run-<id> unit: the command
//   serve.ts pack-outputs <dir>  a ustar stream of the declared outputs
//   serve.ts remove <dir>        stop the session and both units, then delete the run directory
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUN_ID = /^[0-9a-f]{12}$/;
/** Keys scripts/local-gate.ts isolatedEnvironment replaces; each gets a fresh
 * directory here except XDG_CACHE_HOME, which persists so pinned runtimes and
 * fixtures install once per runner. */
export const ISOLATED_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LLV_STATE_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"];
export const PERSISTENT_KEYS = ["XDG_CACHE_HOME", "TMPDIR"];
const LEASE_STALE_MS = 30 * 60_000;
/** How long `remove` waits for a signalled session process to stop its units and exit. */
const OWNER_STOP_MS = 40_000;
/** Setup (clone, install, checks) is ended by systemd after this long. */
const SETUP_MAX_SECONDS = 3600;
/** Both units a run can own; nothing else of it outlives `serve.ts run`. */
const units = (id: string) => [`gate-setup-${id}`, `gate-run-${id}`];

export interface Manifest {
  version: 1; id: string;
  kind: "git" | "export";
  tree: string; head?: string; base?: string; parent?: string;
  argv: string[]; cwd: string; shape: string;
  env: Record<string, string>;
  outputs: string[];
  chrome: boolean;
}

const home = () => os.homedir();
const runsRoot = () => path.join(home(), "runs");
const bunBin = (name: string) => path.join(home(), ".bun", "bin", name);

/** Refuses anything but a run directory directly under ~/runs. */
export function runDirectory(argument: string | undefined): string {
  if (!argument) throw new Error("missing run directory");
  const dir = path.resolve(argument);
  if (path.dirname(dir) !== runsRoot() || !RUN_ID.test(path.basename(dir))) throw new Error(`refusing run directory ${argument}`);
  return dir;
}

/** "unknown" when the user manager gives no answer: nothing is removed then. */
export function unitState(unit: string): "active" | "inactive" | "unknown" {
  const result = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8", timeout: 10_000 });
  const state = String(result.stdout ?? "").trim();
  if (state === "inactive" || state === "failed") return "inactive";
  if (/^(?:active|activating|deactivating|reloading|refreshing)$/.test(state)) return "active";
  return "unknown";
}

/** The process that runs `serve.ts run` records itself before anything
 * else, so `remove` and the sweep can tell a live session from a dead one. */
interface Owner { pid: number; start: string }
function processStart(pid: number | "self"): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}
function writeOwner(dir: string): void {
  const start = processStart("self");
  fs.writeFileSync(path.join(dir, "owner"), `${process.pid} ${start ?? "-"}\n`, { flag: "wx" });
}
function readOwner(dir: string): Owner | null {
  try {
    const match = /^(\d+) (\d+|-)\n$/.exec(fs.readFileSync(path.join(dir, "owner"), "utf8"));
    return match ? { pid: Number(match[1]), start: match[2]! } : null;
  } catch { return null; }
}
/** Alive while the same process (same start time) has any task that is not a
 * zombie: a leader that exited leaves the process running in its threads. */
export function ownerAlive(owner: Owner | null): boolean {
  if (!owner) return false;
  if (processStart(owner.pid) !== owner.start) return false;
  let tasks: string[] = [];
  try { tasks = fs.readdirSync(`/proc/${owner.pid}/task`); } catch { return false; }
  return tasks.some(task => {
    try {
      const stat = fs.readFileSync(`/proc/${owner.pid}/task/${task}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      return state !== "Z" && state !== "X";
    } catch { return false; }
  });
}
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Removes run directories of this protocol whose lease stopped being touched
 * 30 minutes ago, whose session process is gone and whose units are both
 * inactive. Other names under ~/runs belong to someone else and stay. */
export function sweep(except: string, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(runsRoot()); } catch { return removed; }
  for (const name of names) {
    if (!RUN_ID.test(name) || name === except) continue;
    const dir = path.join(runsRoot(), name);
    let touched: number;
    try { touched = fs.statSync(path.join(dir, "lease")).mtimeMs; }
    catch { try { touched = fs.statSync(dir).mtimeMs; } catch { continue; } }
    if (now - touched < LEASE_STALE_MS || ownerAlive(readOwner(dir)) || units(name).some(unit => unitState(unit) !== "inactive")) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

class SetupFailed extends Error {
  constructor(readonly step: string, detail: string) { super(detail); }
}

function readEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return env; }
  for (const line of text.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

/** The command's environment: nothing inherited but what systemctl needs. */
export function commandEnvironment(dir: string, manifest: Manifest, source: NodeJS.ProcessEnv, budget: { remainingMs?: number; receivedAt: number } = { receivedAt: Date.now() }): Record<string, string> {
  const env: Record<string, string> = { ...manifest.env };
  Object.assign(env, readEnvFile(path.join(home(), ".gate-runner.env")));
  env.PATH = `${path.join(home(), ".bun", "bin")}:${source.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"]) if (source[key]) env[key] = source[key]!;
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  for (const key of ISOLATED_KEYS) {
    env[key] = path.join(dir, "iso", key.toLowerCase());
    fs.mkdirSync(env[key]!, { recursive: true });
  }
  env.TMPDIR = path.join(dir, "t");
  env.CLAUDE_CODE_TMPDIR = env.TMPDIR;
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  env.XDG_CACHE_HOME = path.join(home(), ".cache", "gate-runner");
  fs.mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  env.PLAYWRIGHT_BROWSERS_PATH = path.join(home(), ".cache", "ms-playwright");
  if (manifest.chrome) {
    const chrome = newestChromium(env.PLAYWRIGHT_BROWSERS_PATH);
    if (chrome) {
      const short = path.join(dir, "c");
      fs.mkdirSync(short, { recursive: true });
      const wrapper = path.join(dir, "chrome");
      fs.writeFileSync(wrapper, `#!/bin/sh\nexport TMPDIR=${short}\nexec ${chrome} "$@"\n`, { mode: 0o755 });
      env.CHROME_BIN = wrapper;
    }
  }
  for (const name of manifest.outputs) {
    env[name] = path.join(dir, "out", name);
    fs.mkdirSync(env[name]!, { recursive: true });
  }
  env.LLV_GATE_RUNNER = "off";
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  // The caller's git identity never travels, and the runner's fresh home has
  // none, so a test that commits without setting one would fail only here.
  // A no-reply address, as an agent's own identity is, passes the privacy
  // rules that publication code applies to the commits it reads.
  for (const role of ["AUTHOR", "COMMITTER"]) {
    env[`GIT_${role}_NAME`] = "gate-run";
    env[`GIT_${role}_EMAIL`] = "noreply@example.invalid";
  }
  const ledger = path.join(dir, "ledger");
  fs.mkdirSync(ledger, { recursive: true, mode: 0o700 });
  env.LLV_CPU_WAIT_ROOTS = JSON.stringify([ledger]);
  env.LLV_GATE_ADMISSION_WAIT_ROOTS = env.LLV_CPU_WAIT_ROOTS;
  // The runner's clock at the session's first line plus what was left then,
  // so setup here counts against the push budget.
  if (budget.remainingMs !== undefined) env.LLV_GATE_PUSH_DEADLINE = String(budget.receivedAt + budget.remainingMs);
  return env;
}

function newestChromium(root: string): string | null {
  try {
    const versions = fs.readdirSync(root).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const version of versions) {
      const chrome = path.join(root, version, "chrome-linux64", "chrome");
      if (fs.existsSync(chrome)) return chrome;
    }
  } catch { /* none installed */ }
  return null;
}

function sh(log: number, step: string, command: string[], options: SpawnSyncOptions = {}): string {
  fs.writeSync(log, `$ ${command.join(" ")}\n`);
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024, ...options, stdio: ["ignore", "pipe", "pipe"] });
  const out = String(result.stdout ?? ""), err = String(result.stderr ?? "");
  if (out) fs.writeSync(log, out);
  if (err) fs.writeSync(log, err);
  if (result.status !== 0) {
    const last = `${err}\n${out}`.split("\n").map(line => line.trim()).filter(Boolean).at(-1);
    throw new SetupFailed(step, `${command.slice(0, 3).join(" ")} exited ${result.status ?? result.signal ?? result.error?.message}${last ? `: ${last}` : ""}`);
  }
  return out.trim();
}

/** Checks out the shipped tree and returns its git environment. */
function materialize(dir: string, manifest: Manifest, log: number): { cwd: string; env: NodeJS.ProcessEnv } {
  const mirror = path.join(home(), "mirror", "delegatus.git");
  const tree = path.join(dir, "tree");
  const bundle = path.join(dir, "run.bundle");
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const fetchBundle = (gitDir: string) => {
    try { sh(log, "bundle", ["git", "--git-dir", gitDir, "fetch", "--quiet", bundle, "refs/gate/*:refs/gate/*"], { env: gitEnv }); }
    catch {
      // The mirror lags its origin by up to one timer period; one refresh.
      sh(log, "bundle", ["git", "--git-dir", mirror, "fetch", "--quiet", "--prune", "origin"], { env: gitEnv });
      sh(log, "bundle", ["git", "--git-dir", gitDir, "fetch", "--quiet", bundle, "refs/gate/*:refs/gate/*"], { env: gitEnv });
    }
  };
  if (manifest.kind === "git") {
    sh(log, "clone", ["git", "clone", "--quiet", "--shared", "--no-checkout", mirror, tree], { env: gitEnv });
    fetchBundle(path.join(tree, ".git"));
    const git = (...args: string[]) => sh(log, "checkout", ["git", "-C", tree, "-c", "core.hooksPath=/dev/null", ...args], { env: gitEnv });
    git("update-ref", "refs/remotes/origin/main", manifest.base!);
    git("checkout", "--quiet", "--detach", manifest.head!);
    git("read-tree", "--reset", "-u", "refs/gate/tree");
    return { cwd: tree, env: gitEnv };
  }
  const source = path.join(dir, "src.git");
  sh(log, "clone", ["git", "clone", "--quiet", "--bare", "--shared", mirror, source], { env: gitEnv });
  fetchBundle(source);
  fs.mkdirSync(tree, { recursive: true });
  const env = { ...gitEnv, GIT_DIR: source, GIT_WORK_TREE: tree, GIT_INDEX_FILE: path.join(dir, "index") };
  sh(log, "checkout", ["git", "read-tree", "--reset", "-u", "refs/gate/tree"], { env, cwd: tree });
  return { cwd: tree, env };
}

function install(tree: string, log: number): void {
  const linked = process.env.LLV_GATE_RUNNER_NODE_MODULES;
  if (linked) {
    // Test seam: the stub runner links the checkout's own dependencies.
    fs.symlinkSync(linked, path.join(tree, "node_modules"), "dir");
    return;
  }
  if (!fs.existsSync(path.join(tree, "package.json")) || !fs.existsSync(path.join(tree, "bun.lock"))) return;
  sh(log, "install", [bunBin("bun"), "install", "--frozen-lockfile"], { cwd: tree, env: { ...process.env, PATH: `${path.join(home(), ".bun", "bin")}:${process.env.PATH ?? ""}` } });
}

/** Hashes the files as they are; write-tree alone would only serialize the
 * index read-tree wrote, whatever the files hold. */
function verify(tree: string, gitEnv: NodeJS.ProcessEnv, expected: string, log: number): void {
  sh(log, "tree check", ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fileMode=true", "-c", "core.symlinks=true", "add", "-A"], { cwd: tree, env: gitEnv });
  const actual = sh(log, "tree check", ["git", "write-tree"], { cwd: tree, env: gitEnv });
  if (actual !== expected) throw new SetupFailed("tree check", `the runner checked out tree ${actual} for ${expected}`);
}

function containment(tree: string, env: Record<string, string>, log: number): void {
  const mode = env.DELEGATUS_AGENT_CPU ?? env.LLV_AGENT_CPU ?? "auto";
  if (mode === "off" || process.platform !== "linux") return;
  const slice = env.LLV_GATE_SLICE || "delegatus-agents-work.slice";
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  const quota = Math.max(1, Math.floor(cpus * 3 / 4)) * 100;
  const options = { env: { ...process.env, ...env } as NodeJS.ProcessEnv };
  sh(log, "containment", ["systemctl", "--user", "show-environment"], options);
  sh(log, "containment", ["systemctl", "--user", "set-property", "--runtime", slice, "CPUWeight=100", `CPUQuota=${quota}%`, "CPUQuotaPeriodSec=20ms"], options);
  sh(log, "containment", ["systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect", `--slice=${slice}`, "-p", "CPUQuota=300%", "--",
    "/bin/bash", path.join(tree, "scripts", "gate-slot.sh"), "--in-cpu-scope", "/bin/true"], options);
}

/** The session's first line: the nonce and the push budget left when the
 * session opened, or "-". Neither is ever written to disk. */
async function readNonce(timeoutMs: number): Promise<{ nonce: string; remainingMs: number | undefined; receivedAt: number; ended: Promise<void> }> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let endResolve!: () => void;
    const ended = new Promise<void>(done => { endResolve = done; });
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("no nonce on standard input")); } }, timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const match = /^([0-9a-f]{64}) (-|\d{1,12})$/.exec(buffer.slice(0, newline).trim());
      settled = true; clearTimeout(timer);
      if (!match) reject(new Error("malformed nonce line"));
      else resolve({ nonce: match[1]!, remainingMs: match[2] === "-" ? undefined : Number(match[2]), receivedAt: Date.now(), ended });
    });
    process.stdin.on("end", () => { endResolve(); if (!settled) { settled = true; clearTimeout(timer); reject(new Error("standard input closed before the nonce")); } });
    process.stdin.on("error", () => endResolve());
  });
}

async function run(dir: string): Promise<number> {
  const id = path.basename(dir);
  // First, so no unit of this run can exist without a recorded owner.
  writeOwner(dir);
  sweep(id);
  const lease = path.join(dir, "lease");
  fs.writeFileSync(lease, "");
  const touch = setInterval(() => { try { const now = new Date(); fs.utimesSync(lease, now, now); } catch { /* removed */ } }, 30_000);
  // Every process this run starts lives in one of its two units; while one
  // runs, `active` is the systemd-run that waits for it.
  let active: ChildProcess | null = null, stopRequested = false, again: ReturnType<typeof setInterval> | null = null;
  const stopUnits = () => { for (const unit of units(id)) spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 30_000 }); };
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    stopUnits();
    if (!active) { clearInterval(touch); process.exit(0); }
    // A stop that reached systemd before the unit was loaded stops nothing:
    // ask again until the waiting systemd-run has seen its unit end.
    again = setInterval(stopUnits, 1000);
  };
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, requestStop);
  let nonce: string, ended: Promise<void>, remainingMs: number | undefined, receivedAt: number;
  try { ({ nonce, ended, remainingMs, receivedAt } = await readNonce(10_000)); }
  catch (error) { clearInterval(touch); process.stderr.write(`gate-runner serve: ${(error as Error).message}\n`); return 2; }
  void ended.then(requestStop);
  const record = (text: string) => process.stderr.write(`\n${nonce} ${text.replace(/[\r\n]+/g, " ")}\n`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  const bus = busEnvironment(process.env);
  const inUnit = (unit: string, verb: string, properties: string[], stdio: ("ignore" | "inherit" | number)[]) => new Promise<number | null>(resolve => {
    const child = spawn("systemd-run", ["--user", "--quiet", "--collect", "--wait", "--pipe", `--unit=${unit}`, "-p", "TimeoutStopSec=15s", ...properties, `--setenv=HOME=${home()}`,
      "--", process.execPath, path.join(dir, "serve.ts"), verb, dir], { stdio: stdio as never, env: bus });
    active = child;
    child.on("error", () => { active = null; resolve(null); });
    child.on("exit", code => { active = null; resolve(code); });
  });

  // Setup runs in its own unit from its first process on, so a stop, a lost
  // session or `remove` reaches every clone and install it started.
  fs.writeFileSync(path.join(dir, "setup-env.json"), JSON.stringify({ env: process.env, remainingMs, receivedAt }), { mode: 0o600 });
  const log = fs.openSync(path.join(dir, "setup.log"), "a");
  const setupCode = await inUnit(`gate-setup-${id}`, "setup", ["-p", `RuntimeMaxSec=${SETUP_MAX_SECONDS}`], ["ignore", log, log]);
  fs.closeSync(log);
  if (stopRequested) { clearInterval(touch); if (again) clearInterval(again); return 0; }
  const setup = readSetupResult(dir);
  if (!setup?.ok) {
    clearInterval(touch);
    record(setup ? `setup-failed ${setup.step} ${setup.detail.slice(0, 400)}` : `setup-failed setup the setup unit left no result (systemd-run exited ${setupCode ?? "without a code"})`);
    return 0;
  }
  record("started");
  const unitCode = await inUnit(`gate-run-${id}`, "exec", [], ["ignore", "inherit", "inherit"]);
  clearInterval(touch);
  if (stopRequested) { if (again) clearInterval(again); return 0; }
  const verdict = completion(unitCode, readExitRecord(dir));
  record("code" in verdict ? `end ${verdict.code} ${manifest.tree}` : `no-verdict ${verdict.reason}`);
  return 0;
}

/** What systemd-run needs to reach the user manager. */
function busEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return env;
}

type SetupResult = { ok: true } | { ok: false; step: string; detail: string };
function readSetupResult(dir: string): SetupResult | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, "setup-result.json"), "utf8")) as SetupResult;
    if (value.ok === true) return value;
    if (value.ok === false && typeof value.step === "string" && typeof value.detail === "string") return value;
  } catch { /* none */ }
  return null;
}

/** Inside the gate-setup-<id> unit. The unit starts with the user manager's
 * environment, so the session's own comes through a file only its account
 * reads, removed once read. The nonce is never in it. */
function setup(dir: string): number {
  const result = path.join(dir, "setup-result.json");
  const answer = (value: SetupResult) => { fs.rmSync(result, { force: true }); fs.writeFileSync(result, JSON.stringify(value), { flag: "wx" }); };
  try {
    const id = path.basename(dir);
    const file = path.join(dir, "setup-env.json");
    const handed = JSON.parse(fs.readFileSync(file, "utf8")) as { env: Record<string, string>; remainingMs?: number; receivedAt: number };
    fs.rmSync(file, { force: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, handed.env);
    const log = fs.openSync(path.join(dir, "setup.log"), "a");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
    if (manifest.id !== id || manifest.version !== 1) throw new SetupFailed("manifest", "the manifest names another run or protocol");
    const free = fs.statfsSync(home());
    if (free.bavail * free.bsize < 2 * 1024 ** 3) throw new SetupFailed("disk", "under 2 GB free on the runner");
    const tree = materialize(dir, manifest, log);
    install(tree.cwd, log);
    if (process.env.LLV_GATE_RUNNER_TEST_AFTER_INSTALL) spawnSync("/bin/bash", ["-c", process.env.LLV_GATE_RUNNER_TEST_AFTER_INSTALL], { cwd: tree.cwd, stdio: "ignore" });
    verify(tree.cwd, tree.env, manifest.tree, log);
    const env = commandEnvironment(dir, manifest, process.env, { remainingMs: handed.remainingMs, receivedAt: handed.receivedAt });
    const cwd = path.resolve(tree.cwd, manifest.cwd);
    if (path.relative(tree.cwd, cwd).startsWith("..")) throw new SetupFailed("manifest", "the working directory leaves the tree");
    containment(tree.cwd, env, log);
    fs.writeFileSync(path.join(dir, "command.json"), JSON.stringify({ argv: manifest.argv.map((arg, index) => index === 0 && (arg === "bun" || arg === "bunx") ? bunBin(arg) : arg), cwd, env }), { mode: 0o600 });
    answer({ ok: true });
    return 0;
  } catch (error) {
    try { answer({ ok: false, step: error instanceof SetupFailed ? error.step : "setup", detail: (error as Error).message.slice(0, 400) }); } catch { /* the run directory is gone */ }
    return 1;
  }
}

function readExitRecord(dir: string): string | null {
  try { return fs.readFileSync(path.join(dir, "exit"), "utf8"); } catch { return null; }
}

/** The verdict comes from the supervised unit: `systemd-run --wait` exits with
 * the main process's own code. It also exits 0 when that process dies by
 * SIGTERM, SIGHUP, SIGINT or SIGPIPE, or when the unit is stopped, so the
 * `exit` record that `serve.ts exec` writes tells a real 0 from those. The
 * command runs as the same account and can write that record, never the
 * unit's code, so the two must agree: a record planted before `exec` dies,
 * or rewritten after it wrote its own, gives no verdict, never a pass. */
export function completion(unitCode: number | null, record: string | null): { code: number } | { reason: string } {
  if (unitCode === null) return { reason: "the run's unit ended without an exit code" };
  const recorded = record === null ? null : /^(\d{1,3})\n$/.exec(record);
  if (!recorded) return { reason: `the run's command left no completion record (unit exit ${unitCode})` };
  if (Number(recorded[1]) !== unitCode) return { reason: `the run's completion record disagrees with its unit (unit exit ${unitCode})` };
  return { code: unitCode };
}

async function exec(dir: string): Promise<number> {
  const command = JSON.parse(fs.readFileSync(path.join(dir, "command.json"), "utf8")) as { argv: string[]; cwd: string; env: Record<string, string> };
  let child: ReturnType<typeof spawn> | null = null;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { try { child?.kill(signal); } catch { /* gone */ } });
  // A clean-exit signal would end this process with no record and a unit
  // code of 0 (completion() then refuses); the forwarded ones above end the
  // command instead, and this one changes nothing.
  process.on("SIGPIPE", () => { /* ignored */ });
  child = spawn("/bin/bash", [path.join(dir, "tree", "scripts", "gate-slot.sh"), ...command.argv], { cwd: command.cwd, env: command.env as NodeJS.ProcessEnv, stdio: ["ignore", "inherit", "inherit"] });
  const code = await new Promise<number>(resolve => child!.on("exit", (exit, signal) => resolve(exit ?? 128 + (signal ? os.constants.signals[signal] ?? 0 : 1))));
  // Whatever the command left at this name, link or file, is replaced.
  const record = path.join(dir, "exit");
  fs.rmSync(record, { force: true });
  fs.writeFileSync(record, `${code}\n`, { flag: "wx" });
  return code;
}

function walk(root: string, prefix: string, into: string[]): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name), name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(full, `${name}/`, into);
    else if (entry.isFile()) into.push(name);
  }
}

/** One ustar header and its padded body. */
export function ustarEntry(name: string, body: Buffer, mtime = Math.floor(Date.now() / 1000)): Buffer {
  const header = Buffer.alloc(512);
  let base = name, prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`name too long for ustar: ${name}`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  const put = (value: string, offset: number, length: number) => { header.write(value, offset, length, "utf8"); };
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0");
  put(base, 0, 100);
  put(octal(0o644, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(body.length, 12), 124, 12); put(octal(mtime, 12), 136, 12);
  header.fill(" ", 148, 156);
  put("0", 156, 1);
  put("ustar", 257, 6); put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0; for (const byte of header) sum += byte;
  put(`${octal(sum, 7)}\0`, 148, 8);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

async function packOutputs(dir: string): Promise<number> {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  const tree = path.join(dir, "tree");
  const env: NodeJS.ProcessEnv = manifest.kind === "git" ? { ...process.env }
    : { ...process.env, GIT_DIR: path.join(dir, "src.git"), GIT_WORK_TREE: tree, GIT_INDEX_FILE: path.join(dir, "index") };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: tree, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.split("\0").filter(Boolean);
  };
  const roots = ["evidence", ".artifacts"];
  // The index holds the tree as verified before the command: modified tracked
  // files and every untracked file, ignored ones included, are the outputs.
  const changed = new Set([...git("diff", "--name-only", "-z", "--diff-filter=AMT", "--", ...roots), ...git("ls-files", "-z", "--others", "--", ...roots)]);
  const deleted = git("diff", "--name-only", "-z", "--diff-filter=D", "--", ...roots);
  const names: [string, string][] = [];
  for (const file of [...changed].sort()) {
    const full = path.join(tree, file);
    if (fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) names.push([`tree/${file}`, full]);
  }
  for (const name of manifest.outputs) {
    const files: string[] = [];
    walk(path.join(dir, "out", name), "", files);
    for (const file of files.sort()) names.push([`out/${name}/${file}`, path.join(dir, "out", name, file)]);
  }
  if (deleted.length) process.stderr.write(`deleted ${deleted.join(" ")}\n`);
  // process.exit drops what the pipe has not taken yet: wait for each write.
  const write = (bytes: Buffer) => new Promise<void>((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
  for (const [name, full] of names) await write(ustarEntry(name, fs.readFileSync(full)));
  await write(Buffer.alloc(1024));
  return 0;
}

/** Deletes the run only once its session process has exited and both its
 * units are proven stopped; otherwise the directory, its owner record and its
 * lease stay for a retry or the sweep. */
function remove(dir: string): number {
  const id = path.basename(dir);
  const owner = readOwner(dir);
  if (ownerAlive(owner)) {
    // `serve.ts run` stops its units on SIGTERM and exits once they ended.
    try { process.kill(owner!.pid, "SIGTERM"); } catch { /* gone */ }
    const until = Date.now() + OWNER_STOP_MS;
    while (ownerAlive(owner) && Date.now() < until) sleepSync(100);
    if (ownerAlive(owner)) {
      process.stderr.write("gate-runner serve: the run's session process did not exit; the run directory stays\n");
      return 3;
    }
  }
  for (const unit of units(id)) {
    let state = unitState(unit);
    if (state === "active") {
      const stop = spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 30_000 });
      state = unitState(unit);
      if (stop.status !== 0 && state !== "inactive") {
        process.stderr.write(`gate-runner serve: stopping the run's unit failed (systemctl exited ${stop.status ?? "on timeout"})\n`);
        return 3;
      }
    }
    if (state !== "inactive") {
      process.stderr.write(`gate-runner serve: the run's unit is ${state}; the run directory stays\n`);
      return 3;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return 0;
}

if (import.meta.main) {
  const [verb, argument] = process.argv.slice(2);
  try {
    const dir = runDirectory(argument);
    const code = verb === "run" ? await run(dir) : verb === "setup" ? setup(dir) : verb === "exec" ? await exec(dir)
      : verb === "pack-outputs" ? await packOutputs(dir) : verb === "remove" ? remove(dir) : (() => { throw new Error(`unknown verb ${verb}`); })();
    process.exit(code);
  } catch (error) {
    process.stderr.write(`gate-runner serve: ${(error as Error).message}\n`);
    process.exit(2);
  }
}
