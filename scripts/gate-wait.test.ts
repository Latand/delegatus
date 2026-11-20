import { materializeStructuredHostAccess } from "../src/lib/runtime/structuredSpawn";
import { readAttemptCheckTiming } from "../src/lib/runtime/attemptCheckTiming";
import { reportCpuWait, cpuInheritedWaitMs } from "../src/lib/runtime/cpuAdmissionBudget";
import { afterEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { waitForGateCompletion, gateSnapshot, logTail, waitForGate, closedQueueSpans } from "./gate-wait";
import { bindGateCheckRoot, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
import { GATE_CHECK_LAUNCH_ROOT_ENV, GATE_CHECK_ROOT_ENV, GATE_CHECK_ROOT_IDENTITY_ENV } from "../src/lib/runtime/gateCheckRecord";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";
import { checkEnvironment } from "./gate-cache";
import { isolatedEnvironment } from "./local-gate";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { fixtureReport, stopFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { buildManifest, digest, writeEnvelope, readEnvelope, terminalSchema, descriptorSchema, reportSchema, physical } from "../src/lib/recordedChecks/wire";

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
  const result = await waitForGate(f.log, 1);
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
  const result = cli(f.log, "0.001");
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
  const f = fixture(); ticket(f); const result = cli(f.log, seconds);
  expect(result.status).toBe(2); expect(result.stderr).toContain("invalid wait deadline");
});

test.each(["540.001", "541", "600", "601"])("custom wait deadline %s above the engine-safe ceiling refuses on a live ticket", seconds => {
  const f = fixture(); ticket(f, "queued\n");
  const before = gateSnapshot(f.log);
  const result = cli(f.log, seconds);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("invalid wait deadline");
  expect(result.stdout).toBe("");
  expect(gateSnapshot(f.log)).toEqual(before);
});

test.each([-1, NaN, Infinity, 540_001, 541_000, 600_000, 601_000, 2_147_483_648])("the wait API rejects invalid deadline %i even for a finished ticket", async ms => {
  const f = fixture(); ticket(f); complete(f.dir, 0);
  await expect(waitForGate(f.log, ms)).rejects.toThrow("invalid wait deadline");
});

test("the nine-minute ceiling is inclusive through the CLI and wait API", async () => {
  const f = fixture(); ticket(f, "done\n"); complete(f.dir, 17);
  expect((await waitForGate(f.log, 540_000)).code).toBe(17);
  const result = cli(f.log, "540");
  expect(result.status).toBe(17);
  expect(result.stdout).toBe('gate-slot: finished exit=17 | tail="done"\n');
  expect(result.stderr).toBe("");
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
function background(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const child = spawn("/bin/bash", [wrapper, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let stdout = "", stderr = "";
  let started!: () => void;
  const ticketReady = new Promise<void>(resolve => { started = resolve; });
  child.stdout!.on("data", data => { stdout += data; if (/^gate-slot: runId=[a-f0-9]{64}$/m.test(stdout)) started(); });
  child.stderr!.on("data", data => { stderr += data; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, closed, ticketReady, output: () => ({ stdout, stderr }) };
}

function portableEnvironment(f: ReturnType<typeof fixture>) {
  const env = withoutInheritedGate(isolatedEnvironment(f.root, checkEnvironment(process.env)));
  const bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  // The fixture owns its one slot and queue. No real systemd service or live state.
  for (const name of ["bash", "date", "mkdir", "flock", "sleep", "dirname", "mktemp", "touch", "rm", "which", "true"]) {
    fs.symlinkSync(`/usr/bin/${name}`, path.join(bin, name));
  }
  Object.assign(env, { TMPDIR: f.root, PATH: bin, LLV_GATE_BUN: process.execPath, LLV_GATE_LOCK_DIR: f.root,
    LLV_GATE_SLOTS: "1", LLV_GATE_POLL_SECONDS: "0.02", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off" });
  env[GATE_CHECK_ROOT_ENV] = f.root;
  env[GATE_CHECK_LAUNCH_ROOT_ENV] = f.root;
  env[GATE_CHECK_ROOT_IDENTITY_ENV] = physical(f.root);
  return env;
}

test.skipIf(process.platform !== "linux")("demonstration: a real queued gate finishes in two wait calls, including a fresh waiter", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const lock = spawn("/bin/bash", ["-c", 'exec 9>"$1"; /usr/bin/flock 9; echo ready; read -r release', "holder", path.join(f.root, "llv-heavy-gate.slot1.lock")], { stdio: ["pipe", "pipe", "ignore"] });
  children.push(lock); const lockClosed = once(lock, "close");
  await once(lock.stdout!, "data");
  const recording = background(["--record", f.log, "/bin/bash", "-c", 'printf "done\\n"; exit 17'], env);
  await once(recording.child.stdout!, "data");
  expect(recording.output().stdout).toStartWith("gate-slot: recording started\n");
  await observe(f.root, () => fs.readFileSync(f.log, "utf8").includes("gate-slot: Waiting"));
  // The recorder persists the reason even when unrelated diagnostics fill
  // the tail. Observe that checkpoint before adding the noise.
  await observe(f.dir, () => fs.existsSync(path.join(f.dir, "queued")));
  fs.appendFileSync(f.log, "diagnostic\n".repeat(50));
  const first = cli(f.log, "0.001", env);
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

test.skipIf(process.platform !== "linux")("a recorded run with a missing scratch index waits through CPU admission", async () => {
  const f = fixture(), env = portableEnvironment(f), evidence = fixture().root;
  env.LLV_GATE_CHECK_EVIDENCE = JSON.stringify({ directory: evidence, identity: physical(evidence), rootDirectoryIdentity: physical(f.root) });
  const lock = spawn("/bin/bash", ["-c", 'exec 9>"$1"; /usr/bin/flock 9; echo ready; read -r release', "holder", path.join(f.root, "llv-heavy-gate.slot1.lock")], { stdio: ["pipe", "pipe", "ignore"] });
  children.push(lock); const lockClosed = once(lock, "close");
  await once(lock.stdout!, "data");
  const recording = background(["--record", f.log, "/bin/bash", "-c", 'printf "done\\n"; exit 37'], env);
  await recording.ticketReady;
  const runId = recording.output().stdout.match(/runId=([a-f0-9]{64})/)?.[1];
  expect(runId).toHaveLength(64);
  await observe(f.dir, () => fs.existsSync(path.join(f.dir, "queued")));
  fs.unlinkSync(path.join(f.root, ".gate-runs", `${runId}.json`));
  const binding = bindGateCheckRoot(f.root, evidence);
  const args = { runId, reason: "queued recorded check" };
  const signal = new AbortController().signal;
  const queued = await runGateCheckTool({ ...args, timeoutMs: 10 }, binding, signal);
  expect(queued.success, queued.contentItems[0].text).toBe(true);
  expect(JSON.parse(queued.contentItems[0].text)).toMatchObject({ runId, terminal: false,
    state: expect.stringMatching(/^queued position=1 reason=Waiting/), reason: expect.stringContaining("Still queued"), code: 124 });
  let settled = false;
  const held = runGateCheckTool(args, binding, signal).then(result => { settled = true; return result; });
  for (let i = 0; i < 100; i++) fs.appendFileSync(f.log, `progress ${i}\n`);
  await Promise.resolve();
  expect(settled).toBe(false);
  lock.stdin!.end("release\n"); await lockClosed;
  expect(await recording.closed).toBe(37);
  const answer = await held;
  expect(answer.success).toBe(true);
  expect(JSON.parse(answer.contentItems[0].text)).toMatchObject({ terminal: true, code: 37, runId });
  // A second reader sees the durable result after its recorder exits.
  expect((await waitForGateCompletion(f.log)).code).toBe(37);
  fs.unlinkSync(f.log);
  const withoutTail = await runGateCheckTool(args, binding, signal);
  expect(withoutTail.success).toBe(true);
  expect(JSON.parse(withoutTail.contentItems[0].text)).toMatchObject({ terminal: true, code: 37, runId, tail: "" });
}, 30_000);

test("an unregistered gate cannot supply a completion result", async () => {
  const f = fixture(); ticket(f);
  await expect(waitForGateCompletion(f.log)).rejects.toThrow();
});

test.skipIf(process.platform !== "linux")("a real recorder's run id survives wrong and omitted paths in fresh readers", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const recording = background(["--record", f.log, "/bin/bash", "-c", "exit 37"], env);
  await recording.ticketReady;
  const runId = recording.output().stdout.match(/runId=([a-f0-9]{64})/)?.[1];
  expect(runId).toHaveLength(64);
  expect(await recording.closed).toBe(37);
  const reader = path.join(f.root, "reader.ts");
  fs.writeFileSync(reader, `import { bindGateCheckRoot, runGateCheckTool } from ${JSON.stringify(path.join(import.meta.dir, "../src/lib/runtime/gateCheckTool.ts"))};
const [root, runId, log] = process.argv.slice(2);
console.log(JSON.stringify(await runGateCheckTool({ runId, ...(log ? { log } : {}), reason: "persisted check" }, bindGateCheckRoot(root), new AbortController().signal)));`);
  for (const log of [f.log, path.join(f.root, "missing/check.log"), undefined]) {
    const result = spawnSync(process.execPath, [reader, f.root, runId!, ...(log ? [log] : [])], { env, encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.success).toBe(true);
    expect(JSON.parse(answer.contentItems[0].text)).toMatchObject({ terminal: true, code: 37, runId });
  }
  const foreign = fixture();
  expect((await runGateCheckTool({ runId, log: f.log, reason: "foreign run" }, bindGateCheckRoot(foreign.root), new AbortController().signal)).success).toBe(false);
}, 30_000);

test.skipIf(process.platform !== "linux")("a fresh waiter reports a lost recording after the recorder and its scratch disappear", async () => {
  const f = fixture(), env = portableEnvironment(f), evidence = fixture().root;
  env.LLV_GATE_CHECK_EVIDENCE = JSON.stringify({ directory: evidence, identity: physical(evidence), rootDirectoryIdentity: physical(f.root) });
  const launch = path.join(evidence, "recorder.ts");
  fs.writeFileSync(launch, `import { openGateRecording } from ${JSON.stringify(path.join(import.meta.dir, "gate-wait.ts"))};
const { runId } = await openGateRecording(process.argv[2], ["/bin/true"]);
console.log(JSON.stringify({ runId }));
setInterval(() => {}, 60_000);`);
  // Crash after the real recorder has published its ticket and before dispatch.
  // No command or supervisor is started in this fault injection.
  const recorder = spawn(process.execPath, [launch, f.log], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(recorder);
  const closed = once(recorder, "close");
  const { runId } = await fixtureReport<{ runId: string }>(recorder, "recorder before dispatch", []);
  expect(runId).toHaveLength(64);
  const binding = bindGateCheckRoot(f.root, evidence);
  const args = { runId, reason: "restart recovery" };
  const hidden = `${f.root}.retained`;
  fs.renameSync(f.root, hidden);
  try {
    const live = await runGateCheckTool(args, binding, new AbortController().signal);
    expect(live.success).toBeFalse();
    expect(live.contentItems[0].text).toContain("Check result unknown");
  } finally { fs.renameSync(hidden, f.root); }
  const losingOwner = runGateCheckTool(args, binding, new AbortController().signal);
  recorder.kill("SIGKILL");
  await closed;
  const activeAnswer = await losingOwner;
  const reader = path.join(evidence, "reader.ts");
  fs.writeFileSync(reader, `import { runGateCheckTool } from ${JSON.stringify(path.join(import.meta.dir, "../src/lib/runtime/gateCheckTool.ts"))};
const [binding, args] = process.argv.slice(2).map(JSON.parse);
console.log(JSON.stringify(await runGateCheckTool(args, binding, new AbortController().signal)));`);
  const read = (input = args): Awaited<ReturnType<typeof runGateCheckTool>> => {
    const readerEnv = isolatedEnvironment(fs.mkdtempSync(path.join(evidence, "reader-")), env);
    readerEnv.LLV_GATE_LOCK_DIR = readerEnv.TMPDIR;
    readerEnv.PATH = process.env.PATH;
    const result = spawnSync(process.execPath, [reader, JSON.stringify(binding), JSON.stringify(input)], {
      env: readerEnv, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const withScratch = read();
  fs.rmSync(f.dir, { recursive: true });
  const withoutTicket = read();
  fs.rmSync(f.root, { recursive: true });
  const withoutScratch = read();
  expect(fs.existsSync(f.root)).toBeFalse();
  expect(withScratch.success, withScratch.contentItems[0].text).toBe(true);
  expect(JSON.parse(withScratch.contentItems[0].text)).toMatchObject({ runId, terminal: true, state: "lost", outcome: "lost", code: null,
    reason: expect.stringContaining("recorder exited") });
  expect(activeAnswer).toEqual(withScratch);
  for (const lost of [withoutTicket, withoutScratch]) {
    expect(lost.success, lost.contentItems[0].text).toBe(true);
    expect(JSON.parse(lost.contentItems[0].text)).toMatchObject({ runId, terminal: true, state: "lost", code: null,
      reason: expect.stringContaining("scratch") });
  }
  const unknown = `${runId[0] === "0" ? "1" : "0"}${runId.slice(1)}`;
  for (const [id, cause] of [["../check.log", "invalid"], [`${runId}\n`, "invalid"], [unknown, "unknown"]]) {
    const refusal = read({ ...args, runId: id });
    expect(refusal.success).toBe(false);
    expect(refusal.contentItems[0].text).toContain(`${cause} gate run id`);
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("nested check TMPDIR publishes its run under the native launch root", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const nestedTmp = path.join(f.root, "nested-tmp"); fs.mkdirSync(nestedTmp);
  env.TMPDIR = nestedTmp;
  env[GATE_CHECK_ROOT_ENV] = f.root;
  env[GATE_CHECK_ROOT_IDENTITY_ENV] = physical(f.root);
  const log = path.join(nestedTmp, "nested-check.log");
  const recording = background(["--record", log, "/bin/bash", "-c", "exit 37"], env);
  await recording.ticketReady;
  const runId = recording.output().stdout.match(/runId=([a-f0-9]{64})/)?.[1];
  expect(runId).toHaveLength(64);
  expect(await recording.closed).toBe(37);
  expect(fs.existsSync(path.join(f.root, ".gate-runs", `${runId}.json`))).toBe(true);
  expect(fs.existsSync(path.join(nestedTmp, ".gate-runs", `${runId}.json`))).toBe(false);

  const binding = bindGateCheckRoot(f.root);
  for (const logHint of [path.join(f.root, "wrong/check.log"), undefined]) {
    const result = await runGateCheckTool({ runId, ...(logHint ? { log: logHint } : {}), reason: "nested TMPDIR check" }, binding, new AbortController().signal);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ terminal: true, code: 37, runId });
  }
  const foreign = fixture();
  expect((await runGateCheckTool({ runId, reason: "foreign nested run" }, bindGateCheckRoot(foreign.root), new AbortController().signal)).success).toBe(false);
}, 30_000);

test.each(["outside", "indirect", "linked-file", "missing-parent", "standalone", "index-link"])("a recorder refuses %s before starting the command", async fault => {
  const f = fixture(), other = fixture(), env = portableEnvironment(f);
  const marker = path.join(f.root, "command-started");
  let log = f.log;
  if (fault === "outside" || fault === "standalone") log = other.log;
  if (fault === "missing-parent") log = path.join(other.root, "absent/check.log");
  if (fault === "indirect") { fs.symlinkSync(other.root, path.join(f.root, "indirect"), "dir"); log = path.join(f.root, "indirect/check.log"); }
  if (fault === "linked-file") {
    const nested = path.join(f.root, "nested"); fs.mkdirSync(nested);
    fs.writeFileSync(other.log, "existing external target\n");
    log = path.join(nested, "check.log"); fs.symlinkSync(other.log, log);
  }
  if (fault === "index-link") fs.symlinkSync(other.root, path.join(f.root, ".gate-runs"), "dir");
  if (fault === "standalone") {
    const alias = path.join(other.root, "allowed");
    fs.symlinkSync(f.root, alias, "dir");
    env.TMPDIR = alias;
    env[GATE_CHECK_ROOT_ENV] = env[GATE_CHECK_LAUNCH_ROOT_ENV] = env[GATE_CHECK_ROOT_IDENTITY_ENV] = undefined;
  }
  const recording = background(["--record", log, "/usr/bin/touch", marker], env);
  expect(await recording.closed).toBe(2);
  expect(recording.output().stdout).not.toContain("recording started");
  expect(fs.existsSync(marker)).toBe(false);
  if (fault !== "index-link") {
    expect(recording.output().stderr).toContain(`resolvedRoot=${JSON.stringify(fs.realpathSync(f.root))}`);
    for (const entry of [`${log}.gate`, path.join(f.root, ".gate-runs"), path.join(other.root, ".gate-runs")]) {
      expect(fs.existsSync(entry)).toBe(false);
    }
    if (fault === "linked-file") expect(fs.readlinkSync(log)).toBe(other.log);
  }
});

test.skipIf(process.platform !== "linux")("a moved launch root replaced by its old-path symlink refuses before dispatch", () => {
  const f = fixture(), env = portableEnvironment(f);
  env.LLV_GATE_RUNNER = "off";
  const retained = `${f.root}.retained`, marker = `${f.root}.marker`;
  roots.push(retained, marker);
  fs.renameSync(f.root, retained);
  fs.symlinkSync(retained, f.root, "dir");

  const result = spawnSync("/bin/bash", [wrapper, "--record", path.join(f.root, "check.log"),
    "/bin/bash", "-c", 'touch "$1"; exit 37', "fixture", marker], {
    env: { ...env, MARKER: marker }, encoding: "utf8", timeout: 10_000,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("gate launch root identity changed");
  expect(result.stdout).not.toContain("recording started");
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(path.join(retained, "check.log"))).toBe(false);
  expect(fs.existsSync(path.join(retained, "check.log.gate"))).toBe(false);
});

test.skipIf(process.platform !== "linux")("a running record forwards cancellation and publishes only after gate cleanup", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const ready = path.join(f.root, "ready"), cleaned = path.join(f.root, "cleaned");
  const command = 'const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(process.argv[2], "clean"); process.exit(0); }); fs.writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);';
  const recording = background(["--record", f.log, process.execPath, "-e", command, ready, cleaned], env);
  await observe(f.root, () => fs.existsSync(ready));
  const first = cli(f.log, "0.001", env);
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
  const result = background(["--record", f.log, "/bin/true"], {
    ...checkEnvironment(process.env), TMPDIR: f.root, LLV_GATE_BUN: process.execPath,
    [GATE_CHECK_ROOT_ENV]: undefined, [GATE_CHECK_LAUNCH_ROOT_ENV]: undefined, [GATE_CHECK_ROOT_IDENTITY_ENV]: undefined,
  });
  expect(await result.closed).toBe(2);
  expect(result.output().stderr).toContain("EEXIST");
  expect(fs.readFileSync(f.log, "utf8")).toBe("keep\n");
  expect(fs.existsSync(f.dir)).toBe(false);
});

test("a gate refused before admission still publishes its exit for later waits", async () => {
  const f = fixture();
  const result = background(["--record", f.log, "/bin/true"], { ...portableEnvironment(f), LLV_GATE_SLOTS: "0" });
  expect(await result.closed).toBe(2);
  expect(gateSnapshot(f.log)).toEqual({ state: "finished exit=2", code: 2, tail: "LLV_GATE_SLOTS must be a positive integer" });
  expect(cli(f.log).status).toBe(2);
});

async function declaredRecording(f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv, deadlineMs: number, wallShift = 0) {
  const script = path.join(f.root, "command.ts"), declaration = path.join(f.root, "manifest.json");
  fs.writeFileSync(script, 'import fs from "node:fs";fs.appendFileSync(import.meta.dir+"/executions","run\\n");fs.writeFileSync(import.meta.dir+"/started","ready");await new Promise(()=>{fs.watch(import.meta.dir,()=>{})});');
  const manifest = await buildManifest({ executionEnvironment: {}, cwd: f.root, deadline: Date.now() + deadlineMs,
    executionMs: 60_000, selection: ["blocked-command"], configurationDigest: digest({ fixture: true }),
    roots: [{ directory: f.root, purpose: "evidence" }], inputs: [{ root: f.root, file: "command.ts" }],
    outputs: [{ root: f.root, file: "late.patch" }], completion: { root: f.root, file: "complete.json" } });
  writeEnvelope(declaration, manifest);
  if (wallShift) {
    const preload = path.join(f.root, "wall-clock.ts"), binary = path.join(f.root, "shifted-bun");
    fs.writeFileSync(preload, `const now = Date.now.bind(Date); Date.now = () => now() + ${wallShift};`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(binary, `#!/bin/bash\nexec ${quote(process.execPath)} --preload ${quote(preload)} "$@"\n`, { mode: 0o700 });
    env = { ...env, LLV_GATE_BUN: binary };
  }
  return background(["--record", f.log, "--manifest", declaration, "--", process.execPath, script], env, f.root);
}

test.skipIf(process.platform !== "linux")("a declared queued cancellation retains the original deadline and no command exit", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const lock = spawn("/bin/bash", ["-c", 'exec 9>"$1"; /usr/bin/flock 9; echo ready; read -r release', "holder", path.join(f.root, "llv-heavy-gate.slot1.lock")], { stdio: ["pipe", "pipe", "ignore"] });
  children.push(lock); await once(lock.stdout!, "data");
  const recording = await declaredRecording(f, env, 30_000);
  await observe(f.root, () => fs.existsSync(f.dir));
  await observe(f.dir, () => fs.existsSync(path.join(f.dir, "queued")));
  recording.child.kill("SIGTERM");
  expect(await recording.closed, JSON.stringify(recording.output())).toBe(143);
  const terminal = terminalSchema.parse(readEnvelope(path.join(f.dir, "result.json")));
  expect(terminal.cancellation?.reason).toBe("SIGTERM");
  expect(terminal.report).toBeNull();
  expect(fs.existsSync(path.join(f.root, "executions"))).toBeFalse();
}, 45_000);

test.skipIf(process.platform !== "linux")("the original custody deadline expires a queued record without dispatching its command", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const lock = spawn("/bin/bash", ["-c", 'exec 9>"$1"; /usr/bin/flock 9; echo ready; read -r release', "holder", path.join(f.root, "llv-heavy-gate.slot1.lock")], { stdio: ["pipe", "pipe", "ignore"] });
  children.push(lock); await once(lock.stdout!, "data");
  const recording = await declaredRecording(f, env, 3000);
  await observe(f.root, () => fs.existsSync(f.dir));
  await observe(f.dir, () => fs.existsSync(path.join(f.dir, "queued")));
  const descriptor = descriptorSchema.parse(readEnvelope(path.join(f.dir, "descriptor.json")));
  expect([124, 143]).toContain(await recording.closed ?? -1);
  const terminal = terminalSchema.parse(readEnvelope(path.join(f.dir, "result.json")));
  expect(terminal.cancellation?.reason).toBe("deadline");
  expect(terminal.descriptorDigest).toBe(descriptor.descriptorDigest);
  expect(terminal.report).toBeNull();
  expect(fs.existsSync(path.join(f.root, "executions"))).toBeFalse();
}, 45_000);

for (const shift of [-86_400_000, 86_400_000]) test.skipIf(process.platform !== "linux")(`a recorder wall-clock shift of ${shift} cannot renew or prematurely expire its original deadline`, async () => {
  const f = fixture(), env = portableEnvironment(f);
  const recording = await declaredRecording(f, env, 3000, shift);
  await observe(f.root, () => fs.existsSync(path.join(f.root, "started")));
  expect([124, 143]).toContain(await recording.closed ?? -1);
  const terminal = terminalSchema.parse(readEnvelope(path.join(f.dir, "result.json")));
  expect(terminal.cancellation?.reason).toBe("deadline");
  expect(terminal.report?.cleanup).toBe("confirmed");
  expect(fs.readFileSync(path.join(f.root, "executions"), "utf8")).toBe("run\n");
}, 45_000);

// The supervised Bun process may exit on SIGTERM or handle it and exit 143.
const terminatedCommandOutcomes: [exit: number | null, signal: string | null][] = [[null, "SIGTERM"], [143, null]];

test.skipIf(process.platform !== "linux")("the original absolute deadline closes a running recorder with real command and cleanup evidence", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const recording = await declaredRecording(f, env, 3000);
  await observe(f.root, () => fs.existsSync(path.join(f.root, "started")));
  expect([124, 143]).toContain(await recording.closed ?? -1);
  const terminal = terminalSchema.parse(readEnvelope(path.join(f.dir, "result.json")));
  expect(terminal.cancellation?.reason).toBe("deadline");
  const { report } = terminal;
  assert(report, "expected the supervisor's close report");
  expect(report.phase).toBe("close");
  expect(terminatedCommandOutcomes).toContainEqual([report.commandExit, report.commandSignal]);
  expect(report.cleanup).toBe("confirmed");
  expect(fs.readFileSync(path.join(f.root, "executions"), "utf8")).toBe("run\n");
}, 45_000);

test.skipIf(process.platform !== "linux")("recorder death ends its original supervised command without inventing a terminal recorder result", async () => {
  const f = fixture(), env = portableEnvironment(f);
  const recording = await declaredRecording(f, env, 30_000);
  await observe(f.root, () => fs.existsSync(path.join(f.root, "started")));
  const descriptor = descriptorSchema.parse(readEnvelope(path.join(f.dir, "descriptor.json")));
  try {
    recording.child.kill("SIGKILL"); await recording.closed;
    await observe(f.dir, () => {
      try { return reportSchema.parse(readEnvelope(path.join(f.dir, "portable.json"))).phase === "close"; }
      catch { return false; }
    });
    const report = reportSchema.parse(readEnvelope(path.join(f.dir, "portable.json")));
    expect(terminatedCommandOutcomes).toContainEqual([report.commandExit, report.commandSignal]);
    expect(report.cleanup).toBe("confirmed");
    expect(report.cancellation?.reason).toBe("owner");
    expect(fs.existsSync(path.join(f.dir, "result.json"))).toBeFalse();
    expect(fs.existsSync(path.join(f.dir, "exit"))).toBeFalse();
    await expect(waitForGate(f.log, 1000)).rejects.toThrow("ownership unavailable");
    expect(fs.readFileSync(path.join(f.root, "executions"), "utf8")).toBe("run\n");
  } finally { if (descriptor.wrapper) await stopFixtureIdentity(descriptor.wrapper, 5000); }
}, 45_000);


test("closed queue observations round-trip independently of execution budgets", () => {
  const f = fixture();
  const env = { NODE_ENV: "test" as const, LLV_CPU_WAIT_ROOTS: "[]", LLV_RECORDED_CHECK_WAIT_ROOT: f.root };
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  let end: (() => void) | undefined;
  try {
    end = reportCpuWait(env);
    expect(closedQueueSpans(f.root)).toEqual([]);
    clock.mockReturnValue(1500); end(); end = undefined;
    expect(closedQueueSpans(f.root)).toEqual([{ start: 1000, end: 1500 }]);
    expect(cpuInheritedWaitMs(env)).toBe(0);
    fs.writeFileSync(path.join(f.root, "invalid.json"), "not JSON");
    fs.writeFileSync(path.join(f.root, "open.json"), JSON.stringify({ start: 1500, end: 2000, closed: false }));
    expect(closedQueueSpans(f.root)).toEqual([{ start: 1000, end: 1500 }]);
    expect(closedQueueSpans(path.join(f.root, "missing"))).toBeUndefined();
  } finally { end?.(); clock.mockRestore(); }
});


test.skipIf(process.platform !== "linux")("a plain recorded foreground gate supplies controller timing without a custody manifest", async () => {
  const parent = fixture();
  const access = materializeStructuredHostAccess(false, process.env, null, parent.root,
    { pipelineId: "foreground-lane", launchId: "foreground-launch", retainUntilClose: false });
  if (!access.scratchDirectory) throw new Error("expected an owned scratch root");
  const log = path.join(access.env.TMPDIR!, "plain.log");
  const f = { root: access.scratchDirectory, log, dir: log + ".gate" };
  const env = portableEnvironment(f);
  for (const key of ["LLV_ATTEMPT_TIMING_ROOT", "LLV_ATTEMPT_TIMING_ROOT_IDENTITY", "TMPDIR"]) env[key] = access.env[key];
  const go = path.join(f.root, "go");
  const command = `import fs from "node:fs"; import path from "node:path"; const go=process.argv[1]; fs.writeFileSync(go+".ready","ready"); await new Promise(resolve=>{ const watcher=fs.watch(path.dirname(go),()=>{ if(fs.existsSync(go)){watcher.close();resolve();} }); if(fs.existsSync(go)){watcher.close();resolve();} });`;
  try {
    const recording = background(["--record", log, process.execPath, "-e", command, go], env);
    await recording.ticketReady;
    await observe(f.root, () => fs.existsSync(go + ".ready"));
    fs.writeFileSync(go, "continue");
    expect(await recording.closed).toBe(0);
    expect(fs.existsSync(path.join(f.dir, "descriptor.json"))).toBe(false);
    const spans = readAttemptCheckTiming("foreground-launch", "foreground-lane");
    expect(spans.some(span => span.kind === "checkRunner")).toBe(true);
    expect(spans.some(span => span.kind === "checkQueue")).toBe(true);
    expect(spans.every(span => Number.isFinite(span.start) && span.end >= span.start)).toBe(true);
  } finally { access.cleanup(); }
}, 30_000);

test.each(["unchanged", "nested", "retargeted"])("review: launch TMPDIR alias %s agrees at dispatch and wait", async shape => {
  const f = fixture(), aliases = fixture(), foreign = fixture();
  const link = path.join(aliases.root, "launch-tmp");
  fs.symlinkSync(f.root, link, "dir");
  const binding = bindGateCheckRoot(link);
  const env = portableEnvironment(f);
  env.TMPDIR = link;
  env[GATE_CHECK_LAUNCH_ROOT_ENV] = link;
  env[GATE_CHECK_ROOT_ENV] = fs.realpathSync(link);
  env[GATE_CHECK_ROOT_IDENTITY_ENV] = physical(fs.realpathSync(link));
  env.LLV_GATE_RUNNER = "off";
  if (shape === "nested") {
    env.TMPDIR = path.join(f.root, "nested-tmp");
    fs.mkdirSync(env.TMPDIR);
  }
  if (shape === "retargeted") {
    fs.unlinkSync(link);
    fs.symlinkSync(foreign.root, link, "dir");
  }
  const marker = path.join(f.root, "command-started");
  const recording = background(["--record", f.log, "/bin/bash", "-c", 'touch "$1"; exit 37', "fixture", marker], env);
  const code = await recording.closed;
  const started = recording.output().stdout.includes("recording started");
  const runId = recording.output().stdout.match(/runId=([a-f0-9]{64})/)?.[1];
  const answer = runId ? await runGateCheckTool({ runId, reason: "launch alias binding" }, binding, new AbortController().signal) : null;
  console.log(JSON.stringify({ shape, code, started, marker: fs.existsSync(marker), waitSuccess: answer?.success,
    waiterRefusedRoot: answer?.contentItems[0].text.includes("stage temporary root identity changed") }));
  if (shape !== "retargeted") {
    expect(code).toBe(37);
    expect(started).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(answer?.success).toBe(true);
    for (const log of [f.log, path.join(foreign.root, "absent/check.log"), undefined]) {
      const result = await runGateCheckTool({ runId, log, reason: "launch alias log hint" }, binding, new AbortController().signal);
      expect(result.success).toBe(true);
      expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ terminal: true, code: 37, runId });
    }
    for (const owner of [bindGateCheckRoot(foreign.root), null]) {
      expect((await runGateCheckTool({ runId, reason: "unverified alias run" }, owner, new AbortController().signal)).success).toBe(false);
    }
  } else {
    expect(code).toBe(2);
    expect(recording.output().stderr).toContain("gate launch root identity changed");
    expect(started).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    for (const entry of [f.log, f.dir, path.join(f.root, ".gate-runs")]) expect(fs.existsSync(entry)).toBe(false);
  }
}, 30_000);
