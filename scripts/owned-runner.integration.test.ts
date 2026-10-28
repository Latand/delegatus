import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
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
for (const mode of ["exit", "timeout", "TERM", "KILL", "test-KILL", "deadline"] as const) test.skipIf(process.platform !== "linux" || !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`actual gate runner ${mode} ends its fixture and detached child, preserving same-argv bystanders`, async () => {
  const baseline = scopeBaseline();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-lifetime-"));
  const env = { ...process.env };
  // A signal-sandboxed stage keeps its marker: the fixture's owned runner really
  // starts in the stage's PID namespace, and without the marker its gate
  // service refuses an owner it cannot see.
  for (const key of Object.keys(env)) if (key.startsWith("LLV_") && key !== "LLV_SIGNAL_SANDBOX") delete env[key];
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_STAGING: "1", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_SOCKET: path.join(root, "absent.sock"), LLV_RUNNER_PROBE_ROOT: root, LLV_RUNNER_PROBE_MODE: mode, LLV_OWNED_RUN_TIMEOUT_MS: mode === "deadline" ? "1000" : "10000", LLV_GATE_LOCK_DIR: path.join(root, "locks") });
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

for (const mode of ["exit", "TERM", "KILL"] as const) test.skipIf(process.platform !== "linux" || !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`nested direct test ${mode} owns a descendant born and detached between polls`, async () => {
  const baseline = scopeBaseline();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-run-lifetime-"));
  const record = path.join(root, "child.json");
  const env = { ...process.env };
  // A signal-sandboxed stage keeps its marker: the fixture's owned runner really
  // starts in the stage's PID namespace, and without the marker its gate
  // service refuses an owner it cannot see.
  for (const key of Object.keys(env)) if (key.startsWith("LLV_") && key !== "LLV_SIGNAL_SANDBOX") delete env[key];
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

// Hide both systemd executables, or point the real client at an absent private
// bus. Neither case changes the machine's manager or cgroup mount.
function portableFixture(manager: "missing" | "unreachable") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-runner-"));
  const env = withoutInheritedGate({ ...process.env });
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_GATE_RUNNER: "off", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_GATE_LOCK_DIR: path.join(root, "locks"), LLV_OWNED_RUN_TIMEOUT_MS: "12000" });
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

for (const manager of ["missing", "unreachable"] as const) for (const entry of ["direct", "runner", "gate"] as const) {
  test.skipIf(process.platform !== "linux")(`Linux portable ${entry} admits a private test with ${manager} systemd`, async () => {
    const { root, env, repo } = portableFixture(manager);
    const report = path.join(root, "report.json");
    fs.writeFileSync(path.join(root, "example.test.ts"), `import { expect, test } from "bun:test";
import fs from "node:fs"; import os from "node:os";
test("portable admission", () => {
  expect(Number(process.env.LLV_PORTABLE_TEST_RUNNER_PID)).toBe(process.pid);
  expect(process.env.LLV_OWNED_TEST_RUN_CGROUP).toBeUndefined();
  expect(process.env.HOME).not.toBe(${JSON.stringify(env.HOME)});
  expect(process.env.LLV_STATE_DIR).not.toBe(${JSON.stringify(env.LLV_STATE_DIR)});
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ root: os.tmpdir(), home: process.env.HOME, state: process.env.LLV_STATE_DIR }));
});`);
    // A portable child must drop the native parent's admission even when the
    // launch environment carries it. Direct tests still validate native tokens.
    if (entry !== "direct") Object.assign(env, { LLV_OWNED_TEST_RUNNER_PID: process.env.LLV_OWNED_TEST_RUNNER_PID, LLV_OWNED_TEST_RUN_CGROUP: process.env.LLV_OWNED_TEST_RUN_CGROUP });
    const command = [process.execPath, "test", "./example.test.ts"];
    const argv = entry === "direct" ? command : entry === "runner"
      ? [process.execPath, path.join(repo, "scripts/owned-runner.ts"), ...command]
      : ["/bin/bash", path.join(repo, "scripts/gate-slot.sh"), ...command];
    const child = spawn(argv[0]!, argv.slice(1), { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = ""; child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    try {
      const code = await new Promise(resolve => { child.once("exit", resolve); child.once("error", () => resolve(-1)); });
      expect(code, diagnostic).toBe(0);
      expect(diagnostic.match(/portable cleanup on linux is best effort/g)).toHaveLength(1);
      const recorded = JSON.parse(fs.readFileSync(report, "utf8"));
      for (const directory of Object.values(recorded)) expect(fs.existsSync(directory as string)).toBe(false);
    } finally { await stopFixtureProcess(child); fs.rmSync(root, { recursive: true, force: true }); }
  }, 20000);
}

for (const entry of ["direct", "runner", "gate"] as const) for (const mode of ["complete", "exit", "deadline", "TERM", "INT", "KILL", "test-KILL", "supervisor-KILL"] as const) {
  // A direct test binds its supervising runner to its own dispatch process;
  // only the runner and gate interfaces accept an explicit supervisor identity.
  if (entry === "direct" && mode === "supervisor-KILL") continue;
  test.skipIf(process.platform !== "linux")(`Linux portable ${entry} ${mode} ends recorded children and preserves a bystander`, async () => {
    const { root, env, repo } = portableFixture("unreachable");
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
      await until(() => fs.existsSync(record) || runner.exitCode !== null);
      if (!fs.existsSync(record)) throw new Error(diagnostic);
      owned = JSON.parse(fs.readFileSync(record, "utf8"));
      if (mode === "exit" || mode === "complete") fs.writeFileSync(release, "go");
      if (mode === "TERM" || mode === "INT" || mode === "KILL") runner.kill(mode === "TERM" ? "SIGTERM" : mode === "INT" ? "SIGINT" : "SIGKILL");
      if (mode === "test-KILL") signalFixtureIdentity(owned[0]!, "SIGKILL");
      if (supervisor) {
        const ended = new Promise(resolve => supervisor.once("exit", resolve));
        supervisor.kill("SIGKILL"); await ended;
      }
      await until(() => runner.exitCode !== null || runner.signalCode !== null, 12000);
      await until(() => owned.every(identity => processIdentityStatus(identity) === "dead"));
      expect(processIdentityStatus(other)).toBe("alive");
      if (mode === "TERM" || mode === "INT") expect(fs.readFileSync(received, "utf8")).toBe(mode === "INT" ? "SIGINT" : "SIGTERM");
      expect(runner.exitCode).toBe(mode === "complete" ? 0 : mode === "exit" ? 1 : mode === "deadline" ? 124 : mode === "TERM" ? 143 : mode === "INT" ? 130 : mode === "KILL" ? null : 137);
    } finally {
      await stopFixtureProcess(runner);
      if (supervisor) await stopFixtureProcess(supervisor);
      await stopFixtureProcess(bystander);
      if (!owned.length && fs.existsSync(record)) owned = JSON.parse(fs.readFileSync(record, "utf8"));
      for (const identity of owned) signalFixtureIdentity(identity, "SIGKILL");
      await until(() => owned.every(identity => processIdentityStatus(identity) === "dead"));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}

test.skipIf(process.platform !== "linux")("Linux portable admission refuses an unverifiable supervisor before launch", async () => {
  const { root, env, repo } = portableFixture("unreachable");
  const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const identity = captureProcessIdentity(bystander.pid!);
  const marker = path.join(root, "ran");
  env.LLV_OWNED_RUN_PARENT_IDENTITY = JSON.stringify({ ...identity, startIdentity: "unmatched-start" });
  const runner = spawn(process.execPath, [path.join(repo, "scripts/owned-runner.ts"), process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], { cwd: root, env, stdio: "ignore" });
  try {
    const code = await new Promise(resolve => { runner.once("exit", resolve); runner.once("error", () => resolve(-1)); });
    expect(code).toBe(137);
    expect(fs.existsSync(marker)).toBe(false);
    expect(processIdentityStatus(identity)).toBe("alive");
  } finally { await stopFixtureProcess(runner); await stopFixtureProcess(bystander); fs.rmSync(root, { recursive: true, force: true }); }
}, 15000);

async function watchdogUntil(check: () => boolean, failure: () => string, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await Bun.sleep(20);
  }
}

type WatchdogMode = "slow" | "transient" | "renew" | "refused" | "missing" | "hung" | "command-exit" | "TERM" | "INT" | "deadline";
async function probeWatchdog(mode: WatchdogMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-watchdog-"));
  const env = withoutInheritedGate({ ...process.env });
  for (const [key, directory] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, directory); fs.mkdirSync(env[key]!);
  }
  env.LLV_OWNED_RUN_TIMEOUT_MS = mode === "deadline" ? "1000" : "45000";
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const attempts = path.join(root, "attempts.jsonl"), delivered = path.join(root, "delivered"), ready = path.join(root, "ready.json");
  const notifier = Bun.which("systemd-notify")!;
  // The real service and manager remain in use. Only this fixture's notifier
  // transport delays or refuses a delivery; successful attempts reach systemd.
  fs.writeFileSync(path.join(bin, "systemd-notify"), `#!${process.execPath}
import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/processIdentity.ts"))};
const file = ${JSON.stringify(attempts)};
const count = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(file, JSON.stringify({ ...captureProcessIdentity(process.pid), service: captureProcessIdentity(process.ppid) }) + "\\n");
if (${JSON.stringify(mode)} === "refused" || (${JSON.stringify(mode)} === "transient" && count === 0)) process.exit(17);
if (["hung", "command-exit", "TERM", "INT", "deadline"].includes(${JSON.stringify(mode)})) await new Promise(() => setInterval(() => {}, 1000));
if (${JSON.stringify(mode)} === "slow" && count === 0) await Bun.sleep(3000);
const child = Bun.spawn([${JSON.stringify(notifier)}, ...process.argv.slice(2)], { stdout: "ignore", stderr: "ignore" });
const code = await child.exited;
if (code === 0) fs.writeFileSync(${JSON.stringify(delivered)}, String(count + 1));
process.exit(code);
`, { mode: 0o700 });
  if (mode === "missing") {
    fs.unlinkSync(path.join(bin, "systemd-notify"));
    for (const name of ["systemctl", "systemd-run"]) fs.symlinkSync(Bun.which(name)!, path.join(bin, name));
    env.PATH = bin;
  } else env.PATH = `${bin}:${env.PATH}`;
  const command = `import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/processIdentity.ts"))};
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify(captureProcessIdentity(process.pid)));
while (!fs.existsSync(${JSON.stringify(mode === "command-exit" ? attempts : delivered)})
  || (${mode === "renew"} && Number(fs.readFileSync(${JSON.stringify(delivered)}, "utf8")) < 4)) await Bun.sleep(20);
`;
  const runner = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), process.execPath, "-e", command], { env, stdio: ["ignore", "ignore", "pipe"] });
  let output = "";
  runner.stderr!.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { runner.once("exit", resolve); runner.once("error", reject); });
  const identities = (): ProcessIdentity[] => [
    ...(fs.existsSync(ready) ? [JSON.parse(fs.readFileSync(ready, "utf8")) as ProcessIdentity] : []),
    ...(fs.existsSync(attempts) ? fs.readFileSync(attempts, "utf8").trim().split("\n").map(line => JSON.parse(line) as ProcessIdentity) : []),
  ];
  try {
    await watchdogUntil(() => fs.existsSync(ready) && (mode === "missing" || fs.existsSync(attempts)) || runner.exitCode !== null, () => output);
    expect(fs.existsSync(ready), output).toBe(true);
    if (mode === "INT") {
      const first = JSON.parse(fs.readFileSync(attempts, "utf8").trim().split("\n")[0]!) as { service: ProcessIdentity };
      expect(signalFixtureIdentity(first.service, "SIGINT")).toBe(true);
    } else if (mode === "TERM") runner.kill("SIGTERM");
    const code = await exited;
    await watchdogUntil(() => identities().every(identity => processIdentityStatus(identity) === "dead"), () => `fixture identities still alive: ${output}`);
    if (["slow", "transient", "renew", "command-exit"].includes(mode)) {
      expect(code, output).toBe(0);
      expect(output).not.toContain("surviving owned processes");
      if (mode !== "command-exit") {
        expect(fs.existsSync(delivered), output).toBe(true);
        expect(fs.readFileSync(attempts, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(mode === "renew" ? 4 : 2);
      }
    } else if (["TERM", "INT", "deadline"].includes(mode)) expect(code, output).toBe(mode === "INT" ? 130 : mode === "deadline" ? 124 : 143);
    else {
      expect(code, output).toBe(1);
      expect(output).toContain("watchdog notification failed");
      expect(output).toContain(mode === "refused" ? "exit 17" : mode === "missing" ? "ENOENT" : "SIGKILL");
      expect(fs.existsSync(delivered)).toBe(false);
    }
  } finally {
    await stopFixtureProcess(runner);
    await watchdogUntil(() => identities().every(identity => processIdentityStatus(identity) === "dead"), () => "watchdog fixture cleanup failed");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ["slow", "transient", "renew", "refused", "missing", "hung", "command-exit", "TERM", "INT", "deadline"] as const) {
  test.skipIf(process.platform !== "linux" || !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`service watchdog ${mode} retains its delivery and cleanup bounds`, async () => {
    await probeWatchdog(mode);
    // A new service must own a fresh failure window, even after a refusal.
    if (mode === "refused") await probeWatchdog("transient");
  }, 60_000);
}
