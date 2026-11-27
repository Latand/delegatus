import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, processIdentityMayRun, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { signalFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { procBackend } from "../src/lib/proc";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";

function scopeMembers(): ProcessIdentity[] {
  const cgroup = process.env.LLV_OWNED_TEST_RUN_CGROUP;
  if (!cgroup || !fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").includes(`0::${cgroup}`)) throw new Error("runner probe has no verified owning cgroup");
  return fs.readFileSync(path.join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim().split(/\s+/).map(Number)
    .filter(pid => pid > 0 && !procBackend.processExited(pid)).map(pid => captureProcessIdentity(pid));
}

function scopeBaseline(): ProcessIdentity[] {
  const members = scopeMembers();
  if (members.some(identity => identity.pid !== process.pid && identity.pid !== process.ppid)) throw new Error("previous probe left an owned transport in the test scope");
  return members;
}

async function drainScope(allowed: ProcessIdentity[]) {
  const extra = () => scopeMembers().filter(identity => !allowed.some(owner => owner.pid === identity.pid && owner.startIdentity === identity.startIdentity && owner.bootEpoch === identity.bootEpoch));
  // SIGKILL of the outer wrapper leaves its systemd-run transport waiting for
  // service shutdown. Await every kernel-owned member, including that client,
  // before this probe says it has zero survivors or the test run can finish.
  await until(() => extra().length === 0, 5_000);
  expect(extra()).toEqual([]);
}

async function until(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(20); }
  throw new Error("owned runner probe exceeded its bounded wait");
}
// Hide both systemd executables, or point the real client at an absent private
// bus. Neither case changes the machine's manager or cgroup mount.
function portableFixture(manager: "missing" | "unreachable") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-runner-"));
  const env = withoutInheritedGate({ ...process.env });
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_GATE_RUNNER: "off", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_GATE_LOCK_DIR: path.join(root, "locks"), LLV_OWNED_RUN_TIMEOUT_MS: "12000" });
  // The outer test already holds a machine permit. Exercise nested admission
  // against a private queue so unrelated checks cannot delay fixture readiness.
  env.LLV_CHECK_ADMISSION_FILE = path.join(root, "checks.sqlite");
  if (manager === "missing") {
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    for (const name of ["bash", "date", "mkdir", "flock", "sleep", "dirname", "mktemp", "touch", "rm"]) fs.symlinkSync(`/usr/bin/${name}`, path.join(bin, name));
    fs.symlinkSync(process.execPath, path.join(bin, "bun"));
    env.PATH = bin;
  } else {
    env.XDG_RUNTIME_DIR = path.join(root, "absent-runtime");
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${root}/absent-bus`;
  }
  env.LLV_STATE_DIR = undefined;
  const repo = path.resolve(import.meta.dir, "..");
  fs.writeFileSync(path.join(root, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(path.join(repo, "test-preload.ts"))}]\n`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": [path.join(repo, "src/*")] } } }));
  return { root, env, repo };
}

export function portableLifetimeCases(entry: "direct" | "runner" | "gate") {
for (const mode of ["complete", "exit", "deadline", "TERM", "INT", "KILL", "test-KILL", "supervisor-KILL"] as const) {
  // A direct test binds its supervising runner to its own dispatch process;
  // only the runner and gate interfaces accept an explicit supervisor identity.
  if (entry === "direct" && mode === "supervisor-KILL") continue;
  test.skipIf(process.platform !== "linux")(`Linux portable ${entry} ${mode} ends recorded children and preserves a bystander`, async () => {
    const { root, env, repo } = portableFixture(entry === "gate" && mode === "KILL" ? "missing" : "unreachable");
    const record = path.join(root, "ready.json"), release = path.join(root, "release"), received = path.join(root, "signal");
    fs.writeFileSync(path.join(root, "example.test.ts"), `import { test } from "bun:test";
import { spawn } from "node:child_process"; import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.join(repo, "src/lib/processIdentity.ts"))};
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) process.on(signal, () => {
  fs.writeFileSync(${JSON.stringify(received)}, signal); process.exit(code);
});
test("portable lifetime", async () => {
  const child = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" }); child.unref();
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify([captureProcessIdentity(process.pid), captureProcessIdentity(child.pid)]));
  while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
  if (${mode === "complete"}) {
    const ended = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM"); await ended;
  }
});`);
    const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    const other = captureProcessIdentity(bystander.pid!);
    const supervisor = mode === "supervisor-KILL" ? spawn("/bin/sleep", ["300"], { stdio: "ignore" }) : undefined;
    if (supervisor) env.LLV_OWNED_RUN_PARENT_IDENTITY = JSON.stringify(captureProcessIdentity(supervisor.pid!));
    if (mode === "deadline") env.LLV_OWNED_RUN_TIMEOUT_MS = "3000";
    const command = [process.execPath, "test", "./example.test.ts"];
    const argv = entry === "direct" ? command : entry === "runner" ? [process.execPath, path.join(repo, "scripts/owned-runner.ts"), ...command]
      : ["/bin/bash", path.join(repo, "scripts/gate-slot.sh"), ...command];
    const runner = spawn(argv[0]!, argv.slice(1), { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = ""; runner.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    let owned: ProcessIdentity[] = [];
    try {
      await until(() => fs.existsSync(record) || runner.exitCode !== null || runner.signalCode !== null);
      if (!fs.existsSync(record)) throw new Error(`runner exited before readiness: ${diagnostic}`);
      owned = JSON.parse(fs.readFileSync(record, "utf8"));
      if (mode === "exit" || mode === "complete") fs.writeFileSync(release, "go");
      if (mode === "TERM" || mode === "INT" || mode === "KILL") runner.kill(mode === "TERM" ? "SIGTERM" : mode === "INT" ? "SIGINT" : "SIGKILL");
      if (mode === "test-KILL") signalFixtureIdentity(owned[0]!, "SIGKILL");
      if (supervisor) {
        const ended = new Promise(resolve => supervisor.once("exit", resolve));
        supervisor.kill("SIGKILL"); await ended;
      }
      await until(() => runner.exitCode !== null || runner.signalCode !== null, 12000);
      // A killed orphan can retain its identity as a zombie until reaped by
      // its new parent. The runner must end execution of every recorded child.
      await until(() => owned.every(identity => !processIdentityMayRun(identity)));
      expect(processIdentityStatus(other)).toBe("alive");
      expect(processIdentityMayRun(other)).toBe(true);
      if (mode === "TERM" || mode === "INT") expect(fs.readFileSync(received, "utf8")).toBe(mode === "INT" ? "SIGINT" : "SIGTERM");
      expect(runner.exitCode).toBe(mode === "complete" ? 0 : mode === "exit" ? 1 : mode === "deadline" ? 124 : mode === "TERM" ? 143 : mode === "INT" ? 130 : mode === "KILL" ? null : 137);
      expect(runner.signalCode).toBe(mode === "KILL" ? "SIGKILL" : null);
    } finally {
      await stopFixtureProcess(runner);
      if (supervisor) await stopFixtureProcess(supervisor);
      await stopFixtureProcess(bystander);
      if (!owned.length && fs.existsSync(record)) owned = JSON.parse(fs.readFileSync(record, "utf8"));
      for (const identity of owned) signalFixtureIdentity(identity, "SIGKILL");
      await until(() => owned.every(identity => !processIdentityMayRun(identity)));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}
}

export { scopeBaseline, drainScope, until, portableFixture };
