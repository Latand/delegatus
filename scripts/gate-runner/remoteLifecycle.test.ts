// Stub-runner runs: cancellation, cleanup and the sweep (T10, T11).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts). Each case owns its fixture and runner
// processes, including local fallback and cancellation cleanup.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git, makeHarness, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run ([0-9a-f]{12}), tree [0-9a-f]{12}\)$/m;
const unitActive = (id: string) => spawnSync("systemctl", ["--user", "is-active", "--quiet", `gate-run-${id}`]).status === 0;

test.if(linux)("a mock session scope refuses agent PIDs before changing its settings", () => {
  const h = harness(), settings = path.join(h.root, "stub-settings.json");
  const before = fs.readFileSync(settings, "utf8");
  const sandbox = process.env.LLV_SIGNAL_SANDBOX;
  try {
    process.env.LLV_SIGNAL_SANDBOX = "fixture namespace";
    expect(() => h.settings({ sessionScope: true })).toThrow("native PID namespace");
    expect(fs.readFileSync(settings, "utf8")).toBe(before);
    expect(h.calls()).toEqual([]);
  } finally {
    if (sandbox === undefined) delete process.env.LLV_SIGNAL_SANDBOX;
    else process.env.LLV_SIGNAL_SANDBOX = sandbox;
  }
});

// T10 and T11
test.if(linux)("SIGTERM stops the remote unit and removes the run; every finished run is removed; stale runs are swept, live ones kept", async () => {
  const h = harness();
  const runs = path.join(h.runnerHome, "runs");
  const pass = testFile(h, "pass.test.ts", `test("one", () => {});`);
  const fail = testFile(h, "fail.test.ts", `test("one", () => { throw new Error("no"); });`);
  expect(h.run(["bun", "test", pass]).code).toBe(0);
  expect(h.run(["bun", "test", fail]).code).toBe(1);
  expect(fs.readdirSync(runs)).toEqual([]);

  const stale = randomBytes(6).toString("hex"), live = randomBytes(6).toString("hex"), foreign = "e2e-manual";
  for (const name of [stale, live, foreign]) fs.mkdirSync(path.join(runs, name));
  const old = new Date(Date.now() - 31 * 60_000);
  for (const name of [stale, live]) { fs.writeFileSync(path.join(runs, name, "lease"), ""); fs.utimesSync(path.join(runs, name, "lease"), old, old); }
  fs.utimesSync(path.join(runs, foreign), old, old);
  const holder = spawnSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=gate-run-${live}`, "sleep", "120"]);
  expect(holder.status).toBe(0);
  try {
    // The command says it is running and then waits; the deadline below is a
    // guard against a hang, never the signal the test acts on.
    const slow = testFile(h, "slow.test.ts", `test("slow", async () => { console.log("sleeping"); await Bun.sleep(120000); }, 150000);`);
    const child = spawn(process.execPath, [path.join(h.fixture, "scripts", "gate-runner", "client.ts"), "bun", "test", slow], { cwd: h.fixture, env: h.env(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => { stdout += chunk; });
    const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
    const deadline = Date.now() + 150_000;
    while (!stdout.includes("sleeping") && Date.now() < deadline) await Bun.sleep(20);
    expect(stdout).toContain("sleeping");
    const id = RUNNING.exec(stderr)![1]!;
    // The command printed from inside the run's unit, so the unit is active now.
    expect(unitActive(id)).toBeTrue();
    // The sweep ran when this run started.
    expect(fs.existsSync(path.join(runs, stale))).toBeFalse();
    expect(fs.existsSync(path.join(runs, live))).toBeTrue();
    expect(fs.existsSync(path.join(runs, foreign))).toBeTrue();
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(unitActive(id)).toBeFalse();
    expect(fs.existsSync(path.join(runs, id))).toBeFalse();
  } finally {
    spawnSync("systemctl", ["--user", "stop", `gate-run-${live}`]);
  }
}, E2E_TIMEOUT);

/** Each held setup process takes a lock on fd 9 and keeps it to its end, so
 * the lock is free only once every process holding it is gone, whatever PID
 * namespace the test sees. */
const held = (lock: string) => spawnSync("flock", ["-n", lock, "true"]).status !== 0;
const hold = (lock: string, ready: string) => `exec 9>${lock} && flock -n 9 && touch ${ready} && exec sleep 600`;
const waitFor = async (file: string, until: number) => { while (!fs.existsSync(file) && Date.now() < until) await Bun.sleep(20); return fs.existsSync(file); };

// The comparator uses the legacy remote runner; pre-push explicitly stays
// local. Both must contain the descendants of the selected test on cancel.
for (const entry of ["comparator", "wrapped pre-push"] as const)
for (const signal of ["SIGTERM", "SIGINT"] as const) test.if(linux && (entry === "comparator" || !process.env.LLV_SIGNAL_SANDBOX))(`${entry} contains ${entry === "comparator" ? "remote" : "local"} descendants after ${signal}`, async () => {
  const h = harness();
  const target = entry === "comparator" ? h.runnerHome : path.join(h.fixture, ".git");
  const ready = path.join(target, "comparator-ready"), lock = path.join(target, "comparator.lock");
  const file = testFile(h, "held.test.ts", `
import fs from "node:fs";
import path from "node:path";
test("held descendant", async () => {
  const local = ${entry === "wrapped pre-push"};
  let dir = local ? path.join(process.cwd(), ".git") : process.cwd();
  while (!local && !fs.existsSync(path.join(dir, ".gate-runner.env")) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const child = Bun.spawn(["flock", "-x", path.join(dir, "comparator.lock"), "bash", "-c", 'touch "$1"; exec sleep 120', "held", path.join(dir, "comparator-ready")]);
  await child.exited;
}, 150000);`);
  if (entry === "wrapped pre-push") {
    fs.writeFileSync(path.join(h.fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", paths: { "@/*": ["./src/*"] }, skipLibCheck: true, types: ["bun"], noEmit: true },
      include: [file],
    }));
    git(h.fixture, "add", "-A");
    git(h.fixture, "commit", "--quiet", "--no-verify", "-m", "held privacy parent fixture");
    const base = git(h.fixture, "rev-parse", "HEAD");
    git(h.fixture, "update-ref", "refs/remotes/origin/main", base);
    git(h.root, "--git-dir", h.mirror, "update-ref", "refs/heads/main", base);
    git(h.fixture, "remote", "set-url", "origin", h.mirror);
    fs.appendFileSync(path.join(h.fixture, file), "\n// Changed input.\n");
  }
  const argv = entry === "comparator" ? [process.execPath, "scripts/local-gate-tests.ts", "--base", "HEAD", file]
    : ["bash", "scripts/gate-slot.sh", "bun", "scripts/local-gate.ts", "pre-push"];
  const child = spawn(argv[0]!, argv.slice(1), { cwd: h.fixture, env: h.env(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  try {
    expect(await waitFor(ready, Date.now() + 150_000), stderr).toBeTrue();
    expect(held(lock)).toBeTrue();
    const id = entry === "comparator" ? RUNNING.exec(stderr)![1]! : null;
    if (id) expect(unitActive(id)).toBeTrue();
    child.kill(signal);
    expect(await exited).toBe(entry === "comparator" && signal === "SIGINT" ? 130 : 143);
    if (entry === "wrapped pre-push") {
      // The client allows up to a minute to confirm remote cleanup. The
      // owning local cgroup may have already ended the client itself.
      const until = Date.now() + 60_000;
      while (held(lock) && Date.now() < until) await Bun.sleep(20);
    }
    expect(held(lock)).toBeFalse();
    if (id) expect(unitActive(id)).toBeFalse();
    expect(fs.readdirSync(path.join(h.runnerHome, "runs"))).toEqual([]);
    expect(stderr.match(/^gate-runner: running on the gate runner /gm) ?? []).toHaveLength(entry === "comparator" ? 1 : 0);
    if (entry === "wrapped pre-push") expect(h.calls()).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
  }
}, E2E_TIMEOUT);

// §8.9: setup processes are owned from their start.
test.if(linux)("a cancel during the clone and a lost session during install leave no setup process alive and no run behind", async () => {
  const h = harness();
  const runs = path.join(h.runnerHome, "runs");
  const pass = testFile(h, "pass.test.ts", `test("one", () => {});`);

  // 1. SIGTERM to the client while the runner's clone holds.
  const bin = path.join(h.root, "runner-bin"), cloneLock = path.join(h.root, "clone.lock"), cloning = path.join(h.root, "cloning");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash
if [[ "$1" == clone && ! -e ${cloning} ]]; then ${hold(cloneLock, cloning)}; fi
exec /usr/bin/git "$@"
`, { mode: 0o755 });
  h.settings({ remotePath: [bin] });
  const child = spawn(process.execPath, [path.join(h.fixture, "scripts", "gate-runner", "client.ts"), "bun", "test", pass], { cwd: h.fixture, env: h.env(), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
  try {
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.resume();
    expect(await waitFor(cloning, Date.now() + 150_000)).toBeTrue();
    const [id] = fs.readdirSync(runs);
    expect(held(cloneLock)).toBeTrue();
    expect(spawnSync("systemctl", ["--user", "is-active", "--quiet", `gate-setup-${id}`]).status).toBe(0);
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(stderr).not.toContain("cancellation was not confirmed");
    expect(held(cloneLock)).toBeFalse();
    expect(spawnSync("systemctl", ["--user", "is-active", "--quiet", `gate-setup-${id}`]).status).not.toBe(0);
    expect(fs.readdirSync(runs)).toEqual([]);
  } finally {
    // A failed assertion still lets the client cancel and clean up its run.
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
  }

  // 2. The session is lost while install holds: the client's removal stops
  // the setup, and only then runs the command here.
  h.settings({ killWhen: "installing", remoteEnv: { LLV_GATE_RUNNER_TEST_AFTER_INSTALL_ACTION: JSON.stringify({ hold: { lock: "install.lock", mark: "installing" } }) } });
  const lost = h.run(["bun", "test", pass]);
  expect(h.calls().some(call => (call as { killedAtMarker?: boolean }).killedAtMarker)).toBeTrue();
  expect(lost.stderr).toMatch(/^gate-runner: running here: the runner session failed before the command started/m);
  expect(lost.stderr).not.toContain("cleanup on the runner was not confirmed");
  expect(lost.code).toBe(0);
  expect(fs.readdirSync(runs)).toEqual([]);
}, E2E_TIMEOUT);
