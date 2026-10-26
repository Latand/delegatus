import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { gateSnapshot, logTail, waitForGate } from "./gate-wait";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";
import { checkEnvironment } from "./gate-cache";
import { isolatedEnvironment } from "./local-gate";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await stopFixtureProcess(child);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-wait-test-")); roots.push(root);
  const log = path.join(root, "check.log"), dir = `${log}.gate`;
  return { root, log, dir };
}
function ticket(f: ReturnType<typeof fixture>, text = "") {
  fs.mkdirSync(f.dir);
  fs.writeFileSync(f.log, text);
  fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify(cpuOwnerIdentity(process.pid)));
}
function complete(dir: string, code: number) {
  fs.writeFileSync(path.join(dir, "exit.tmp"), `${code}\n`);
  fs.renameSync(path.join(dir, "exit.tmp"), path.join(dir, "exit"));
}
const wrapper = path.join(import.meta.dir, "gate-slot.sh");
const cli = (log: string, seconds = "0", env = process.env) => spawnSync("/bin/bash", [wrapper, "--wait", log, seconds], {
  env: { ...env, LLV_GATE_BUN: process.execPath }, encoding: "utf8", timeout: 10_000,
});

test("finished gates return the persisted exit and tail in fresh waiter processes", () => {
  const f = fixture(); ticket(f, "test output\n"); complete(f.dir, 37);
  // A finished ticket stays readable after its recorder has exited.
  fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ pid: 1, startIdentity: "ended", bootEpoch: "old" }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = cli(f.log);
    expect(result.status).toBe(37);
    expect(result.stdout).toBe('gate-slot: finished exit=37 | tail="test output"\n');
    expect(result.stderr).toBe("");
  }
});

test("queued deadline includes the latest position and reason; a later wait observes completion", async () => {
  const f = fixture();
  ticket(f, "gate-slot: Waiting for the CPU queue · 3rd · normal priority\ngate-slot: Waiting for measured CPU pressure · 2nd in CPU queue\n");
  const result = await waitForGate(f.log, 0);
  expect(result.state).toBe("queued position=2 reason=Waiting for measured CPU pressure · 2nd in CPU queue");
  expect(result.code).toBe(124);
  expect(fs.existsSync(path.join(f.dir, "exit"))).toBe(false);
  const resumed = waitForGate(f.log, 10_000);
  fs.writeFileSync(path.join(f.dir, "running"), "running\n");
  fs.appendFileSync(f.log, "done\n"); complete(f.dir, 0);
  expect(await resumed).toEqual({ state: "finished exit=0", code: 0, tail: `${result.tail}\ndone` });
});

test("a running deadline leaves the run intact and another process resumes the same wait", async () => {
  const f = fixture(); ticket(f, "working\n"); fs.writeFileSync(path.join(f.dir, "running"), "running\n");
  const result = cli(f.log);
  expect(result.status).toBe(124);
  expect(result.stdout).toBe('gate-slot: running | tail="working"\n');
  expect(fs.existsSync(path.join(f.dir, "exit"))).toBe(false);
  const resumed = waitForGate(f.log, 10_000); complete(f.dir, 23);
  expect((await resumed).code).toBe(23);
});

test("unknown logs and lost or malformed records refuse with their cause", async () => {
  const f = fixture();
  const unknown = cli(f.log);
  expect(unknown.status).toBe(2); expect(unknown.stderr).toContain("unknown gate log");
  ticket(f);
  fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ pid: 1, startIdentity: "ended", bootEpoch: "old" }));
  await expect(waitForGate(f.log)).rejects.toThrow("ownership unavailable");
  fs.writeFileSync(path.join(f.dir, "exit"), "partial");
  await expect(waitForGate(f.log)).rejects.toThrow("invalid gate exit record");
});

test("completion before subscription and during a wait both settle", async () => {
  const f = fixture(); ticket(f);
  const waiting = waitForGate(f.log); complete(f.dir, 0);
  expect((await waiting).code).toBe(0);
  expect((await waitForGate(f.log)).code).toBe(0);
});

test("bundled wait tooling reads a completed run without source-tree imports", async () => {
  const f = fixture(); ticket(f, "bundled\n"); complete(f.dir, 0);
  const outdir = path.join(f.root, "packed");
  const bundle = await Bun.build({ entrypoints: [path.join(import.meta.dir, "gate-wait.ts")], target: "bun", format: "esm", outdir });
  expect(bundle.success).toBe(true);
  fs.copyFileSync(wrapper, path.join(outdir, "gate-slot.sh"));
  // The shipped build keeps the .ts name beside the shell wrapper.
  fs.renameSync(path.join(outdir, "gate-wait.js"), path.join(outdir, "gate-wait.ts"));
  const result = spawnSync("/bin/bash", [path.join(outdir, "gate-slot.sh"), "--wait", f.log], {
    env: { ...process.env, LLV_GATE_BUN: process.execPath }, encoding: "utf8", timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('gate-slot: finished exit=0 | tail="bundled"\n');
  expect(result.stderr).toBe("");
});

test("tail reads are bounded by bytes and lines, and stay on one output line", () => {
  const f = fixture(); ticket(f, `${"x".repeat(50_000)}\n${Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n")}\n`);
  complete(f.dir, 0);
  expect(logTail(f.log)).toBe(Array.from({ length: 20 }, (_, i) => `line ${i + 5}`).join("\n"));
  expect(cli(f.log).stdout.trim().split("\n")).toHaveLength(1);
  fs.writeFileSync(f.log, "z".repeat(50_000));
  expect(Buffer.byteLength(logTail(f.log))).toBe(16_384);
});

test.each(["-1", "NaN", "Infinity", "2147484"])("invalid wait deadline %s refuses", seconds => {
  const f = fixture(); const result = cli(f.log, seconds);
  expect(result.status).toBe(2); expect(result.stderr).toContain("invalid wait deadline");
});

/** Register before observing, with an independent setup deadline. */
async function observe(root: string, ready: () => boolean) {
  await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(root, () => check());
    const timer = setTimeout(() => finish(new Error("fixture readiness deadline")), 10_000);
    const finish = (error?: Error) => { clearTimeout(timer); watcher.close(); if (error) reject(error); else resolve(); };
    const check = () => { if (ready()) finish(); };
    watcher.on("error", finish); check();
  });
}
function background(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn("/bin/bash", [wrapper, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, closed, output: () => ({ stdout, stderr }) };
}

function portableEnvironment(f: ReturnType<typeof fixture>) {
  const env = withoutInheritedGate(isolatedEnvironment(f.root, checkEnvironment(process.env)));
  const bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  // The fixture owns its one slot and queue. No real systemd service or live state.
  for (const name of ["bash", "date", "mkdir", "flock", "sleep", "dirname", "mktemp", "touch", "rm", "which", "true"]) {
    fs.symlinkSync(`/usr/bin/${name}`, path.join(bin, name));
  }
  Object.assign(env, { PATH: bin, LLV_GATE_BUN: process.execPath, LLV_GATE_LOCK_DIR: f.root,
    LLV_GATE_SLOTS: "1", LLV_GATE_POLL_SECONDS: "0.02", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off" });
  return env;
}

test.skipIf(process.platform !== "linux")("demonstration: a real queued gate finishes in two wait calls, including a fresh waiter", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const lock = spawn("/bin/bash", ["-c", 'exec 9>"$1"; /usr/bin/flock 9; echo ready; read -r release', "holder", path.join(f.root, "llv-heavy-gate.slot1.lock")], { stdio: ["pipe", "pipe", "ignore"] });
  children.push(lock); const lockClosed = once(lock, "close");
  await once(lock.stdout!, "data");
  const recording = background(["--record", f.log, "/bin/bash", "-c", 'printf "done\\n"; exit 17'], env);
  await once(recording.child.stdout!, "data");
  expect(recording.output().stdout).toBe("gate-slot: recording started\n");
  await observe(f.root, () => fs.readFileSync(f.log, "utf8").includes("gate-slot: Waiting"));
  // The recorder persists the reason even when unrelated diagnostics fill
  // the tail. Observe that checkpoint before adding the noise.
  await observe(f.dir, () => fs.existsSync(path.join(f.dir, "queued")));
  fs.appendFileSync(f.log, "diagnostic\n".repeat(50));
  const first = cli(f.log, "0", env);
  expect(first.status).toBe(124); expect(first.stdout).toContain("gate-slot: queued position=1 reason=Waiting");
  expect(first.stdout).toMatch(/(?:\d+(?:st|nd|rd|th)|all 1 busy)/);
  const second = background(["--wait", f.log, "10"], env);
  lock.stdin!.end("release\n"); await lockClosed;
  expect(await second.closed).toBe(17);
  expect(await recording.closed).toBe(17);
  expect(second.output().stdout).toContain("gate-slot: finished exit=17");
  expect(gateSnapshot(f.log).tail).toContain("done");
  // A duplicate recording never overwrites either the result or log.
  const original = fs.readFileSync(f.log, "utf8");
  const duplicate = background(["--record", f.log, "/bin/true"], env);
  expect(await duplicate.closed).toBe(2); expect(fs.readFileSync(f.log, "utf8")).toBe(original);
}, 30_000);

test.skipIf(process.platform !== "linux")("a running record forwards cancellation and publishes only after gate cleanup", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const ready = path.join(f.root, "ready"), cleaned = path.join(f.root, "cleaned");
  const command = 'const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(process.argv[2], "clean"); process.exit(0); }); fs.writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);';
  const recording = background(["--record", f.log, process.execPath, "-e", command, ready, cleaned], env);
  await observe(f.root, () => fs.existsSync(ready));
  const first = cli(f.log, "0", env);
  expect(first.status).toBe(124); expect(first.stdout).toContain("gate-slot: running");
  const waiting = background(["--wait", f.log, "10"], env);
  recording.child.kill("SIGTERM");
  expect(await waiting.closed).toBe(143);
  expect(waiting.output().stdout).toContain("finished exit=143");
  expect(await recording.closed).toBe(143);
  expect(fs.readFileSync(cleaned, "utf8")).toBe("clean");
}, 30_000);

test("recording refuses an existing caller log without leaving a ticket", async () => {
  const f = fixture(); fs.writeFileSync(f.log, "keep\n");
  const result = background(["--record", f.log, "/bin/true"], { ...process.env, LLV_GATE_BUN: process.execPath });
  expect(await result.closed).toBe(2);
  expect(fs.readFileSync(f.log, "utf8")).toBe("keep\n");
  expect(fs.existsSync(f.dir)).toBe(false);
});

test("a gate refused before admission still publishes its exit for later waits", async () => {
  const f = fixture();
  const result = background(["--record", f.log, "/bin/true"], {
    ...process.env, LLV_GATE_BUN: process.execPath, LLV_GATE_SLOTS: "0",
  });
  expect(await result.closed).toBe(2);
  expect(gateSnapshot(f.log)).toEqual({ state: "finished exit=2", code: 2, tail: "LLV_GATE_SLOTS must be a positive integer" });
  expect(cli(f.log).status).toBe(2);
});
