// A stub gate runner for the client's end-to-end tests: a fake ssh that runs
// the remote command under a temporary runner home on this machine, a fixture
// checkout whose tree equals the checkout under test, and a mirror.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutInheritedGate } from "../../src/lib/testing/inheritedGateEnv";

export const REPOSITORY = path.resolve(import.meta.dir, "..", "..");
const IDENTITY = { GIT_AUTHOR_NAME: "gate-test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "gate-test", GIT_COMMITTER_EMAIL: "noreply@example.invalid" };

export type Env = Record<string, string | undefined>;
export function cleanGitEnv(extra: Env = {}): NodeJS.ProcessEnv {
  const env: Env = { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG.*|PREFIX)$/.test(key)) delete env[key];
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: cleanGitEnv(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

export interface StubSettings {
  /** Probes exit 255. */
  failProbe?: boolean;
  /** Kill the ssh session once the run's output contains this text. */
  killOn?: string;
  /** A command containing this text exits 255 without running, as a lost connection does. */
  failOn?: string;
  /** A command containing this text never answers, as a hung connection does. */
  hangOn?: string;
  /** Serve this file for pack-outputs instead of the runner's archive. */
  packFile?: string;
  /** Extra environment for the runner side, as the runner host would have it. */
  remoteEnv?: Record<string, string>;
  /** Directories prepended to the runner's PATH (stub systemctl and friends). */
  remotePath?: string[];
}

export interface Harness {
  root: string; fixture: string; runnerHome: string; mirror: string; base: string; head: string;
  stub: string; log: string; cache: string; settings: (value: StubSettings) => void;
  calls: () => { command: string; stdin: number; head: string }[];
  env: (extra?: Env) => NodeJS.ProcessEnv;
  run: (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => { code: number | null; stdout: string; stderr: string };
  cleanup: () => void;
}

const STUB = `
const fs = require("node:fs"), { spawn } = require("node:child_process");
const [settingsFile, logFile, runnerHome, groupsFile] = __CONFIG__;
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const args = process.argv.slice(2);
let index = 0;
while (index < args.length && args[index].startsWith("-")) index += args[index] === "-o" ? 2 : 1;
const alias = args[index], command = args.slice(index + 1).join(" ");
const record = { alias, command, stdin: 0, head: "" };
const flush = () => fs.appendFileSync(logFile, JSON.stringify(record) + "\\n");
if (settings.failProbe && command.includes("manager=ok")) { flush(); process.exit(255); }
if (settings.failOn && command.includes(settings.failOn)) { flush(); process.exit(255); }
if (settings.hangOn && command.includes(settings.hangOn)) { flush(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000); process.exit(1); }
if (settings.packFile && command.includes("pack-outputs")) { flush(); process.stdout.write(fs.readFileSync(settings.packFile)); process.exit(0); }
const env = { HOME: runnerHome, USER: process.env.USER, LANG: "C.UTF-8",
  PATH: [...(settings.remotePath ?? []), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, ...(settings.remoteEnv ?? {}) };
for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
const child = spawn("/bin/bash", ["-c", command], { cwd: runnerHome, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
// The remote side outlives a killed session, as on a real runner; the
// harness stops each of these groups when the test ends.
fs.appendFileSync(groupsFile, child.pid + "\\n");
let output = "";
const watch = chunk => {
  if (!settings.killOn || !command.includes("serve.ts run")) return;
  output += chunk.toString();
  if (output.includes(settings.killOn)) { settings.killOn = undefined; flush(); process.kill(process.pid, "SIGKILL"); }
};
process.stdin.on("data", chunk => { if (record.stdin < 200) record.head += chunk.toString("latin1").slice(0, 200 - record.stdin); record.stdin += chunk.length; child.stdin.write(chunk); });
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => {});
child.stdout.on("data", chunk => { process.stdout.write(chunk); watch(chunk); });
child.stderr.on("data", chunk => { process.stderr.write(chunk); watch(chunk); });
child.on("close", code => { flush(); process.exit(code ?? 1); });
`;

export function makeHarness(options: { mirrorMain?: "base" | "behind" | "ahead" } = {}): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gate-runner-test-")));
  const fixture = path.join(root, "fixture");
  const base = git(REPOSITORY, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--shared", "--no-checkout", REPOSITORY, fixture);
  git(fixture, "checkout", "--quiet", "--detach", base);
  // The fixture's tree equals the working tree under test, uncommitted edits included.
  const changed = git(REPOSITORY, "ls-files", "-z", "-m", "-o", "--exclude-standard").split("\0").filter(Boolean);
  for (const file of changed) {
    const from = path.join(REPOSITORY, file), to = path.join(fixture, file);
    const stat = fs.lstatSync(from, { throwIfNoEntry: false });
    fs.rmSync(to, { force: true });
    if (!stat) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else { fs.copyFileSync(from, to); fs.chmodSync(to, stat.mode & 0o777); }
  }
  for (const file of git(REPOSITORY, "ls-files", "-z", "-d").split("\0").filter(Boolean)) fs.rmSync(path.join(fixture, file), { force: true });
  git(fixture, "add", "-A");
  git(fixture, "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "fixture tree");
  git(fixture, "update-ref", "refs/remotes/origin/main", base);
  fs.symlinkSync(fs.realpathSync(path.join(REPOSITORY, "node_modules")), path.join(fixture, "node_modules"), "dir");
  const head = git(fixture, "rev-parse", "HEAD");

  const runnerHome = path.join(root, "runner");
  fs.mkdirSync(path.join(runnerHome, ".bun", "bin"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(runnerHome, ".bun", "bin", "bun"));
  fs.symlinkSync(process.execPath, path.join(runnerHome, ".bun", "bin", "bunx"));
  fs.mkdirSync(path.join(runnerHome, "runs"));
  const mirror = path.join(runnerHome, "mirror", "delegatus.git");
  git(root, "init", "--quiet", "--bare", mirror);
  fs.writeFileSync(path.join(mirror, "objects", "info", "alternates"), `${path.join(fixture, ".git", "objects")}\n`);
  let mirrorMain = base;
  if (options.mirrorMain === "behind") mirrorMain = git(fixture, "rev-parse", `${base}~3`);
  if (options.mirrorMain === "ahead") mirrorMain = git(root, "--git-dir", mirror, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "main moved on");
  git(root, "--git-dir", mirror, "update-ref", "refs/heads/main", mirrorMain);
  // The runner side's own settings: fixture gates never wait on the host's CPU pressure.
  fs.writeFileSync(path.join(runnerHome, ".gate-runner.env"), `DELEGATUS_AGENT_CPU=off\nDELEGATUS_CPU_PRESSURE=off\nLLV_GATE_LOCK_DIR=${path.join(root, "runner-locks")}\nLLV_GATE_SLOTS=2\n`);

  const settingsFile = path.join(root, "stub-settings.json");
  const log = path.join(root, "stub-calls.jsonl");
  fs.writeFileSync(settingsFile, "{}"); fs.writeFileSync(log, "");
  const stub = path.join(root, "ssh");
  const groups = path.join(root, "stub-groups");
  fs.writeFileSync(groups, "");
  fs.writeFileSync(stub, `#!${process.execPath}\n${STUB.replace("__CONFIG__", JSON.stringify([settingsFile, log, runnerHome, groups]))}`, { mode: 0o755 });
  const nodeModules = fs.realpathSync(path.join(REPOSITORY, "node_modules"));
  const settings = (value: StubSettings) => fs.writeFileSync(settingsFile, JSON.stringify({ ...value, remoteEnv: { LLV_GATE_RUNNER_NODE_MODULES: nodeModules, ...value.remoteEnv } }));
  settings({});
  const cache = path.join(root, "cache");
  const config = path.join(root, "gate-runner.json");
  fs.writeFileSync(config, JSON.stringify({ ssh: "stub-runner" }));
  const home = path.join(root, "home"), tmp = path.join(root, "tmp"), state = path.join(root, "state"), xdg = path.join(root, "xdg");
  for (const dir of [home, tmp, state, xdg]) fs.mkdirSync(dir, { recursive: true });
  const env = (extra: Env = {}): NodeJS.ProcessEnv => withoutInheritedGate({
    ...cleanGitEnv() as Env, NODE_ENV: undefined, HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: xdg, LLV_STATE_DIR: state,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_GATE_RUNNER_CONFIG: config, LLV_GATE_RUNNER_CACHE: cache,
    LLV_GATE_RUNNER_SSH: stub, LLV_GATE_LOCK_DIR: path.join(root, "local-locks"), DELEGATUS_AGENT_CPU: "off",
    // Fixture gates take private slots and never wait on this machine's CPU pressure.
    DELEGATUS_CPU_PRESSURE: "off",
    LLV_GATE_RUNNER: undefined, LLV_PRIVACY_KNOWN_VALUES_FILE: undefined, ...extra,
  // A local fallback inside an agent's signal domain needs its marker.
  } as unknown as NodeJS.ProcessEnv, { keepSandbox: true });
  return {
    root, fixture, runnerHome, mirror, base, head, stub, log, cache, settings, env,
    calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)),
    run: (argv, runOptions = {}) => {
      const result = spawnSync("/bin/bash", [path.join(fixture, "scripts", "gate-slot.sh"), ...argv], {
        cwd: runOptions.cwd ?? fixture, env: runOptions.env ?? env(), encoding: "utf8", timeout: runOptions.timeout ?? 200_000, maxBuffer: 64 * 1024 * 1024,
      });
      return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    cleanup: () => {
      for (const id of fs.readdirSync(path.join(runnerHome, "runs"))) spawnSync("systemctl", ["--user", "stop", `gate-run-${id}`], { stdio: "ignore" });
      // Only the process groups the stub recorded at their start.
      const alive = (group: number) => { try { process.kill(-group, 0); return true; } catch { return false; } };
      const recorded = fs.readFileSync(groups, "utf8").split("\n").map(Number).filter(group => Number.isInteger(group) && group > 1);
      for (const group of recorded.filter(alive)) { try { process.kill(-group, "SIGTERM"); } catch { /* gone */ } }
      const until = Date.now() + 20_000;
      while (recorded.some(alive) && Date.now() < until) Bun.sleepSync(100);
      for (const group of recorded.filter(alive)) { try { process.kill(-group, "SIGKILL"); } catch { /* gone */ } }
      while (recorded.some(alive) && Date.now() < until + 5_000) Bun.sleepSync(50);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A fixture test file, untracked in the fixture checkout. */
export function testFile(h: Harness, name: string, body: string): string {
  const file = path.join(h.fixture, "gate-runner-fixture", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `import { test, expect } from "bun:test";\n${body}\n`);
  return `./gate-runner-fixture/${name}`;
}

/** A private value made at run time, so no source file holds it. */
export const privateValue = () => `pv${randomBytes(9).toString("hex")}`;

export const withoutRunnerLines = (text: string) => text.split("\n").filter(line => !line.startsWith("gate-runner: ")).join("\n");
