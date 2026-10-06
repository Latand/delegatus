import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

async function until(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(20); }
  throw new Error("owned runner probe exceeded its bounded wait");
}
for (const mode of ["exit", "timeout", "TERM", "KILL", "test-KILL", "deadline"] as const) test.skipIf(process.platform !== "linux")(`actual gate runner ${mode} ends its fixture and detached child, preserving same-argv bystanders`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-lifetime-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LLV_")) delete env[key];
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_STAGING: "1", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_SOCKET: path.join(root, "absent.sock"), LLV_RUNNER_PROBE_ROOT: root, LLV_RUNNER_PROBE_MODE: mode, LLV_OWNED_RUN_TIMEOUT_MS: mode === "deadline" ? "1000" : "10000", LLV_GATE_LOCK_DIR: path.join(root, "locks") });
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
      process.kill(owned[0]!.pid, "SIGKILL");
    }
    await until(() => runner.exitCode !== null || runner.signalCode !== null, 8_000);
    await until(() => owned.every(identity => processIdentityStatus(identity) === "dead"));
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
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

for (const mode of ["exit", "TERM", "KILL"] as const) test.skipIf(process.platform !== "linux")(`nested direct test ${mode} owns a descendant born and detached between polls`, async () => {
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
    expect(processIdentityStatus(other)).toBe("alive");
    if (mode === "exit") { expect(runner.exitCode).not.toBe(0); expect(output).toContain("surviving owned processes"); }
  } finally {
    if (!owned && fs.existsSync(record)) owned = JSON.parse(fs.readFileSync(record, "utf8"));
    await stopFixtureProcess(runner);
    await stopFixtureProcess(bystander);
    if (owned && processIdentityStatus(owned) === "alive") process.kill(owned.pid, "SIGKILL");
    if (owned) await until(() => processIdentityStatus(owned!) === "dead");
    expect(processIdentityStatus(other)).toBe("dead");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
