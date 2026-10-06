import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { signalFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { procBackend } from "../src/lib/proc";

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
for (const mode of ["exit", "timeout", "TERM", "KILL", "test-KILL", "deadline"] as const) test.skipIf(process.platform !== "linux")(`actual gate runner ${mode} ends its fixture and detached child, preserving same-argv bystanders`, async () => {
  const baseline = scopeBaseline();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-lifetime-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LLV_")) delete env[key];
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_STAGING: "1", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_SOCKET: path.join(root, "absent.sock"), LLV_RUNNER_PROBE_ROOT: root, LLV_RUNNER_PROBE_MODE: mode, LLV_OWNED_RUN_TIMEOUT_MS: mode === "deadline" ? "1000" : "10000", LLV_GATE_LOCK_DIR: path.join(root, "locks") });
  if (mode === "KILL") {
    // Keep the real systemd transport alive briefly after its unit ends. Hard
    // wrapper death cannot await this client, so the observer must drain it.
    const executable = Bun.which("systemd-run")!;
    const quoted = "'" + executable.replaceAll("'", "'\"'\"'") + "'";
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "systemd-run"), `#!/bin/sh\n${quoted} "$@" &\ntransport=$!\nwait "$transport"\nstatus=$?\nsleep 1\nexit "$status"\n`, { mode: 0o700 });
    env.PATH = `${bin}:${env.PATH}`;
  }
  fs.writeFileSync(path.join(root, "startup-pause-refresh"), "hold");
  const bystander = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  const other = captureProcessIdentity(bystander.pid!);
  const handles: ChildProcess[] = [bystander];
  const fixtureBystander = spawn(process.execPath, ["run", path.resolve("src/lib/pipelines/fixtures/stageHostGeneration.ts"), "adopt", path.join(root, "registry.json"), root, "single"], { env, stdio: "ignore" });
  handles.push(fixtureBystander);
  const otherFixture = captureProcessIdentity(fixtureBystander.pid!);
  const owned: ProcessIdentity[] = [];
  try {
    const runner = spawn("/bin/bash", [path.join(import.meta.dir, "gate-slot.sh"), process.execPath, "test", path.join(import.meta.dir, "fixtures/ownedRunner.fixture.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
    handles.push(runner);
    let diagnostic = ""; runner.stderr?.on("data", chunk => { diagnostic += String(chunk); });
    await until(() => fs.existsSync(path.join(root, "ready")) || runner.exitCode !== null || runner.signalCode !== null);
    if (!fs.existsSync(path.join(root, "ready"))) throw new Error(`runner exited before readiness: ${diagnostic}`);
    owned.push(JSON.parse(fs.readFileSync(path.join(root, "ready"), "utf8")));
    owned.push(...fs.readFileSync(path.join(root, "owned.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    if (mode === "TERM" || mode === "KILL") runner.kill(mode === "TERM" ? "SIGTERM" : "SIGKILL");
    if (mode === "test-KILL") {
      expect(processIdentityStatus(owned[0]!)).toBe("alive");
      signalFixtureIdentity(owned[0]!, "SIGKILL");
    }
    await until(() => runner.exitCode !== null || runner.signalCode !== null, 8_000);
    await until(() => owned.every(identity => processIdentityStatus(identity) === "dead"));
    await drainScope([...baseline, other, otherFixture]);
    expect(processIdentityStatus(other)).toBe("alive");
    expect(processIdentityStatus(otherFixture)).toBe("alive");
    if (mode === "exit") { expect(runner.exitCode).not.toBe(0); expect(diagnostic).toContain("surviving owned processes"); }
  } finally {
    // Recover the evidence even if an assertion failed before readiness.
    const file = path.join(root, "owned.jsonl");
    if (fs.existsSync(file)) owned.push(...fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)));
    for (const handle of handles) await stopFixtureProcess(handle);
    for (const identity of owned) if (processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    await until(() => owned.every(identity => processIdentityStatus(identity) === "dead"));
    expect(processIdentityStatus(other)).toBe("dead");
    expect(processIdentityStatus(otherFixture)).toBe("dead");
    await drainScope(baseline);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

for (const mode of ["exit", "TERM", "KILL"] as const) test.skipIf(process.platform !== "linux")(`nested direct test ${mode} owns a descendant born and detached between polls`, async () => {
  const baseline = scopeBaseline();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-run-lifetime-"));
  const record = path.join(root, "child.json");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LLV_")) delete env[key];
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_DETACHED_CHILD_RECORD: record, LLV_NESTED_HOLD: mode === "exit" ? "0" : "1", LLV_OWNED_RUN_TIMEOUT_MS: "10000" });
  const bystander = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  const other = captureProcessIdentity(bystander.pid!);
  const runner = spawn(process.execPath, ["test", path.join(import.meta.dir, "fixtures/nestedTestRunner.fixture.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let output = ""; runner.stderr?.on("data", chunk => { output += String(chunk); });
  let owned: ProcessIdentity | undefined;
  try {
    await until(() => fs.existsSync(`${record}.runner`) || runner.exitCode !== null);
    if (!fs.existsSync(record)) throw new Error(`nested test did not record its child: ${output}`);
    owned = JSON.parse(fs.readFileSync(record, "utf8"));
    if (mode !== "exit") runner.kill(mode === "TERM" ? "SIGTERM" : "SIGKILL");
    await until(() => runner.exitCode !== null || runner.signalCode !== null);
    await until(() => processIdentityStatus(owned!) === "dead");
    await drainScope([...baseline, other]);
    expect(processIdentityStatus(other)).toBe("alive");
    if (mode === "exit") { expect(runner.exitCode).not.toBe(0); expect(output).toContain("surviving owned processes"); }
  } finally {
    if (!owned && fs.existsSync(record)) owned = JSON.parse(fs.readFileSync(record, "utf8"));
    await stopFixtureProcess(runner);
    await stopFixtureProcess(bystander);
    if (owned && processIdentityStatus(owned) === "alive") process.kill(owned.pid, "SIGKILL");
    if (owned) await until(() => processIdentityStatus(owned!) === "dead");
    expect(processIdentityStatus(other)).toBe("dead");
    await drainScope(baseline);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
