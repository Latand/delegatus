import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";

/* 2026-10-10: helpers a Viewer started outlived it in the service's cgroup,
   and systemd started every replacement in that old cgroup path instead of
   the configured slice. Every helper here waits forever and starts a child of
   its own, as the provisioner starts `uv sync`; both must end with the Viewer
   that started them, while an agent that Viewer started lives on. */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-helper-lease-"));
const REPO = path.resolve(import.meta.dir, "../..");
const LEASE_ENTRY = path.join(REPO, "bin", "helper-lease.mjs");
const owned: Array<{ pid: number; identity: string }> = [];

afterAll(() => {
  for (const { pid, identity } of owned) {
    if (procBackend.processIdentity(pid) === identity) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** A helper program that starts a child, reports both pids, and waits. */
function waitingHelper(file: string, report: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ helper: process.pid, child: child.pid }));`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  return file;
}

async function readReport(report: string, ms = 8_000): Promise<{ helper: number; child: number }> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(report, "utf8")) as { helper: number; child: number };
      for (const pid of [parsed.helper, parsed.child]) {
        const identity = procBackend.processIdentity(pid);
        if (identity) owned.push({ pid, identity });
      }
      return parsed;
    } catch { await Bun.sleep(25); }
  }
  throw new Error("the helper never reported");
}

async function gone(pids: number[], ms = 6_000): Promise<boolean> {
  const identities = pids.map((pid) => [pid, procBackend.processIdentity(pid)] as const);
  const deadline = Date.now() + ms;
  const live = () => identities.filter(([pid, identity]) => identity !== null
    && procBackend.processIdentity(pid) === identity && !procBackend.processExited(pid));
  while (live().length && Date.now() < deadline) await Bun.sleep(25);
  return live().length === 0;
}

/** A Viewer process running `body`, which prints one JSON line and waits. */
async function startViewer(name: string, body: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const script = path.join(SANDBOX, `${name}.mjs`);
  fs.writeFileSync(script, [...body, "setInterval(() => {}, 1000);", ""].join("\n"));
  const viewer = spawn(process.execPath, [script], {
    cwd: options.cwd ?? REPO,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...options.env },
  });
  owned.push({ pid: viewer.pid!, identity: procBackend.processIdentity(viewer.pid!)! });
  const line = await Promise.race([
    new Promise<Record<string, number>>((resolve) => {
      let buffered = "";
      viewer.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        if (buffered.includes("\n")) resolve(JSON.parse(buffered.split("\n")[0]!));
      });
    }),
    Bun.sleep(8_000).then(() => { throw new Error(`${name} never reported`); }),
  ]);
  for (const pid of Object.values(line)) {
    const identity = pid > 1 ? procBackend.processIdentity(pid) : null;
    if (identity) owned.push({ pid, identity });
  }
  return { viewer, line };
}

/* An agent the same Viewer starts afterwards: it must not inherit a lease. */
const AGENT = [
  "const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
  "agent.unref();",
];

test.if(process.platform === "linux")("the Telegram provisioner and the process it runs end when the Viewer that started them dies", async () => {
  const state = path.join(SANDBOX, "provisioner-state");
  const report = path.join(SANDBOX, "provisioner.json");
  const provisioner = waitingHelper(path.join(SANDBOX, "provisioner", "provision.mjs"), report);
  const { viewer, line } = await startViewer("provisioning-viewer", [
    "import { spawn } from 'node:child_process';",
    `const { ensureConnectorProvisioned } = await import(${JSON.stringify(path.join(REPO, "src/lib/telegram/packaging.ts"))});`,
    "void ensureConnectorProvisioned();",
    ...AGENT,
    "process.stdout.write(JSON.stringify({ agent: agent.pid }) + '\\n');",
  ], { env: { LLV_STATE_DIR: state, LLV_TELEGRAM_PROVISIONER: provisioner, LLV_HELPER_LEASE_ENTRY: LEASE_ENTRY } });
  const helper = await readReport(report);
  expect(fs.readdirSync(path.join(state, "helpers")).filter((file) => file.endsWith(".json"))).toHaveLength(1);
  /* The Viewer crashes: no shutdown code of its own runs. */
  viewer.kill("SIGKILL");
  expect(await gone([helper.helper, helper.child])).toBe(true);
  expect(() => process.kill(line.agent!, 0)).not.toThrow();
  /* The guardian removes its record as it exits. */
  const records = () => fs.readdirSync(path.join(state, "helpers")).filter((file) => file.endsWith(".json"));
  const deadline = Date.now() + 3_000;
  while (records().length && Date.now() < deadline) await Bun.sleep(25);
  expect(records()).toEqual([]);
}, 30_000);

test.if(process.platform === "linux")("a transcript search index worker ends when the Viewer that started it dies", async () => {
  const state = path.join(SANDBOX, "index-state");
  const cwd = path.join(SANDBOX, "index-viewer");
  const report = path.join(SANDBOX, "index.json");
  waitingHelper(path.join(cwd, "src", "lib", "transcriptSearchIndex.worker.ts"), report);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  /* A v4 index without its search index: a search schedules the worker. */
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(state, "transcript-search.sqlite"));
  db.exec("PRAGMA user_version = 4;");
  db.close();
  const { viewer, line } = await startViewer("indexing-viewer", [
    "import { spawn } from 'node:child_process';",
    `const { searchTranscripts } = await import(${JSON.stringify(path.join(REPO, "src/lib/search/transcriptSearch.ts"))});`,
    "try { searchTranscripts({ query: 'cobalt', order: 'relevance' }); } catch { /* the stand-in index has no tables */ }",
    ...AGENT,
    "process.stdout.write(JSON.stringify({ agent: agent.pid }) + '\\n');",
  ], { cwd, env: { LLV_STATE_DIR: state, LLV_HELPER_LEASE_ENTRY: LEASE_ENTRY } });
  const helper = await readReport(report);
  viewer.kill("SIGKILL");
  expect(await gone([helper.helper, helper.child])).toBe(true);
  expect(() => process.kill(line.agent!, 0)).not.toThrow();
}, 30_000);

test.if(process.platform === "linux")("a helper ends when its Viewer hands release traffic to a successor", async () => {
  const { spawnLeasedHelper } = await import("./helperLease");
  const state = path.join(SANDBOX, "release-state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const target = path.join(state, "viewer-release.json");
  fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:4001" }));
  const report = path.join(SANDBOX, "release.json");
  const program = waitingHelper(path.join(SANDBOX, "release", "helper.mjs"), report);
  const oldPort = process.env.PORT;
  process.env.PORT = "4001";
  let guardian;
  try {
    guardian = spawnLeasedHelper("release-helper", { command: process.execPath, args: [program], cwd: SANDBOX, env: process.env }, state);
  } finally {
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
  }
  const exited = new Promise<number | null>((resolve) => guardian.once("exit", (code) => resolve(code)));
  const helper = await readReport(report);
  await Bun.sleep(300);
  expect(() => process.kill(helper.helper, 0)).not.toThrow();
  fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:4002" }));
  expect(await Promise.race([exited, Bun.sleep(8_000).then(() => "timeout")])).not.toBe("timeout");
  expect(await gone([helper.helper, helper.child])).toBe(true);
}, 20_000);

test("a helper that finishes passes its status through and leaves no record", async () => {
  const { spawnLeasedHelper } = await import("./helperLease");
  const state = path.join(SANDBOX, "status-state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const guardian = spawnLeasedHelper("status-helper", { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(7), 200)"], cwd: SANDBOX, env: process.env }, state);
  const code = await new Promise<number | null>((resolve) => guardian.once("exit", (status) => resolve(status)));
  expect(code).toBe(7);
  expect(fs.existsSync(path.join(state, "helpers")) ? fs.readdirSync(path.join(state, "helpers")) : []).toEqual([]);
}, 10_000);

test.if(process.platform === "linux")("a signal to the guardian ends the helper's whole group with it", async () => {
  const { spawnLeasedHelper } = await import("./helperLease");
  const state = path.join(SANDBOX, "signal-state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const report = path.join(SANDBOX, "signal.json");
  const program = waitingHelper(path.join(SANDBOX, "signal", "helper.mjs"), report);
  const guardian = spawnLeasedHelper("signal-helper", { command: process.execPath, args: [program], cwd: SANDBOX, env: process.env }, state);
  const exited = new Promise((resolve) => guardian.once("exit", resolve));
  const helper = await readReport(report);
  guardian.kill("SIGINT");
  await exited;
  expect(await gone([helper.helper, helper.child])).toBe(true);
}, 20_000);

/* A helper that starts its work at end of file on its standard input, as the
   file scanner and the backup pass do: closing that input never ends it. */
function requestWorker(file: string, report: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "let request = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { request += chunk; });",
    "process.stdin.on('end', () => {",
    "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ helper: process.pid, child: child.pid, request }));`,
    "  setInterval(() => {}, 1000);",
    "});",
    "",
  ].join("\n"));
  return file;
}

test.if(process.platform === "linux")("a file scan worker that is mid-scan ends when the Viewer that started it dies", async () => {
  const report = path.join(SANDBOX, "scanner.json");
  const worker = requestWorker(path.join(SANDBOX, "scanner", "worker.mjs"), report);
  const { viewer, line } = await startViewer("scanning-viewer", [
    "import { spawn } from 'node:child_process';",
    `const { collectFileScanInWorker } = await import(${JSON.stringify(path.join(REPO, "src/lib/scanner/fileScanWorker.ts"))});`,
    `void collectFileScanInWorker({}, undefined, { launch: { executable: process.execPath, workerPath: ${JSON.stringify(worker)} } }).catch(() => {});`,
    ...AGENT,
    "process.stdout.write(JSON.stringify({ agent: agent.pid }) + '\\n');",
  ], { env: { LLV_STATE_DIR: path.join(SANDBOX, "scanner-state"), LLV_HELPER_LEASE_ENTRY: LEASE_ENTRY } });
  const helper = await readReport(report);
  /* The request still reached the worker through the guardian. */
  expect(JSON.parse(fs.readFileSync(report, "utf8")).request).toContain("\"type\":\"scan\"");
  viewer.kill("SIGKILL");
  expect(await gone([helper.helper, helper.child])).toBe(true);
  expect(() => process.kill(line.agent!, 0)).not.toThrow();
}, 30_000);

for (const operation of ["backup", "activation"] as const) {
test.if(process.platform === "linux")(`a state ${operation} pass ends when the Viewer that started it dies`, async () => {
  const state = path.join(SANDBOX, `${operation}-state`);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const report = path.join(SANDBOX, `${operation}.json`);
  const cwd = path.join(SANDBOX, `${operation}-viewer`);
  const worker = requestWorker(path.join(cwd, "src", "lib", "stateBackup.worker.ts"), report);
  const { viewer, line } = await startViewer(`${operation}-viewer`, [
    "import { spawn } from 'node:child_process';",
    `const durability = await import(${JSON.stringify(path.join(REPO, "src/lib/state/durability.ts"))});`,
    operation === "backup"
      ? `void durability.runBackupPassInWorker(${JSON.stringify(state)}, new Map(), { launch: { executable: process.execPath, workerPath: ${JSON.stringify(worker)} } }).catch(() => {});`
      : `void durability.checkStateDatabasesInWorker(${JSON.stringify(state)}).catch(() => {});`,
    ...AGENT,
    "process.stdout.write(JSON.stringify({ agent: agent.pid }) + '\\n');",
  ], { cwd, env: { LLV_STATE_DIR: state, LLV_HELPER_LEASE_ENTRY: LEASE_ENTRY } });
  const helper = await readReport(report);
  expect(JSON.parse(fs.readFileSync(report, "utf8")).request).toContain(JSON.stringify(state));
  expect(fs.readdirSync(path.join(state, "helpers")).filter((file) => file.endsWith(".json"))).toHaveLength(1);
  viewer.kill("SIGKILL");
  expect(await gone([helper.helper, helper.child])).toBe(true);
  expect(() => process.kill(line.agent!, 0)).not.toThrow();
}, 30_000);
}

/* The display reading of the update drain (#2594): an observation that was
   in flight when its Viewer crashed left this worker behind, and a later
   retirement of the successor could not know it. */
test.if(process.platform === "linux")("a work reads worker ends when the Viewer that started it dies", async () => {
  const report = path.join(SANDBOX, "work-reads.json");
  const worker = waitingHelper(path.join(SANDBOX, "work-reads", "worker.mjs"), report);
  const { viewer, line } = await startViewer("observing-viewer", [
    "import { spawn } from 'node:child_process';",
    `const { readWorkOffThread } = await import(${JSON.stringify(path.join(REPO, "src/lib/selfUpdate/workReads.ts"))});`,
    `void readWorkOffThread({ launch: { executable: process.execPath, workerPath: ${JSON.stringify(worker)} }, timeoutMs: 300_000 }).catch(() => {});`,
    ...AGENT,
    "process.stdout.write(JSON.stringify({ agent: agent.pid }) + '\\n');",
  ], { env: { LLV_STATE_DIR: path.join(SANDBOX, "work-reads-state"), LLV_HELPER_LEASE_ENTRY: LEASE_ENTRY } });
  const helper = await readReport(report);
  viewer.kill("SIGKILL");
  expect(await gone([helper.helper, helper.child])).toBe(true);
  expect(() => process.kill(line.agent!, 0)).not.toThrow();
}, 30_000);

/* A self-update step leads a process group of its own, so the runner's abort
   can end it; nothing ended it when its Viewer died mid-build. It is
   recorded, and the launcher ends its group with the Viewer's generation. */
test.if(process.platform === "linux")("a self-update step's group ends with the Viewer generation that ran it", async () => {
  const { retireViewerHelpers, viewerGeneration, viewerGenerationSpawnOptions } = await import("../../bin/viewer-helpers-retire.mjs");
  const state = path.join(SANDBOX, "step-state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const script = path.join(SANDBOX, "stepping-viewer.mjs");
  fs.writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    `const { realPorts } = await import(${JSON.stringify(path.join(REPO, "src/lib/selfUpdate/steps.ts"))});`,
    ...AGENT,
    "const ports = realPorts(() => {});",
    "void ports.run(['/bin/sh', '-c', 'trap \"\" TERM; sleep 300 & echo $$ $!; wait'], { cwd: process.cwd(), env: process.env, onLine: (text) => {",
    "  const [step, child] = text.trim().split(' ').map(Number);",
    "  process.stdout.write(JSON.stringify({ step, child, agent: agent.pid }) + '\\n');",
    "} });",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const viewer = spawn(process.execPath, [script], viewerGenerationSpawnOptions({
    cwd: REPO, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, LLV_STATE_DIR: state },
  }));
  owned.push({ pid: viewer.pid!, identity: procBackend.processIdentity(viewer.pid!)! });
  const generation = viewerGeneration(viewer.pid)!;
  const line = await Promise.race([
    new Promise<{ step: number; child: number; agent: number }>((resolve) => {
      let buffered = "";
      viewer.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        if (buffered.includes("\n")) resolve(JSON.parse(buffered.split("\n")[0]!));
      });
    }),
    Bun.sleep(8_000).then(() => { throw new Error("the step never started"); }),
  ]);
  for (const pid of [line.step, line.child, line.agent]) owned.push({ pid, identity: procBackend.processIdentity(pid)! });
  expect(fs.readdirSync(path.join(state, "helpers"))).toEqual([`${line.step}.json`]);
  viewer.kill("SIGKILL");
  await new Promise((resolve) => viewer.once("exit", resolve));
  const outcome = await retireViewerHelpers(state, [generation], { leaseMs: 200, termMs: 300, killMs: 2_000 });
  expect(outcome.survived).toEqual([]);
  expect(await gone([line.step, line.child], 100)).toBe(true);
  expect(() => process.kill(line.agent, 0)).not.toThrow();
  expect(fs.readdirSync(path.join(state, "helpers"))).toEqual([]);
}, 30_000);

const PYTHON = Bun.which("python3");

test.if(process.platform === "linux" && PYTHON !== null)("a local transcription ends when the Viewer that started it dies", async () => {
  const cwd = path.join(SANDBOX, "whisper-viewer");
  const venv = path.join(SANDBOX, "whisper-venv");
  const report = path.join(SANDBOX, "whisper.json");
  fs.mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
  fs.symlinkSync(PYTHON!, path.join(venv, "bin", "python"));
  fs.writeFileSync(path.join(cwd, "scripts", "whisper_transcribe.py"), [
    "import json, os, subprocess, sys, time",
    "child = subprocess.Popen(['sleep', '300'])",
    `json.dump({'helper': os.getpid(), 'child': child.pid}, open(${JSON.stringify(report)}, 'w'))`,
    "time.sleep(300)",
    "",
  ].join("\n"));
  const { viewer, line } = await startViewer("transcribing-viewer", [
    "import { spawn } from 'node:child_process';",
    `const { localTranscribe } = await import(${JSON.stringify(path.join(REPO, "src/lib/transcribe/local.ts"))});`,
    "void localTranscribe('/dev/null', 'en').catch(() => {});",
    ...AGENT,
    "process.stdout.write(JSON.stringify({ agent: agent.pid }) + '\\n');",
  ], { cwd, env: { LLV_STATE_DIR: path.join(SANDBOX, "whisper-state"), LLV_WHISPER_VENV: venv, LLV_HELPER_LEASE_ENTRY: LEASE_ENTRY } });
  const helper = await readReport(report);
  viewer.kill("SIGKILL");
  expect(await gone([helper.helper, helper.child])).toBe(true);
  expect(() => process.kill(line.agent!, 0)).not.toThrow();
}, 30_000);

test("a local transcription passes the helper's answer through its guardian", async () => {
  const { localTranscribe } = await import("@/lib/transcribe/local");
  const cwd = path.join(SANDBOX, "whisper-answer");
  const venv = path.join(SANDBOX, "whisper-answer-venv");
  fs.mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
  /* Any interpreter: the stand-in prints the answer line the script prints. */
  fs.writeFileSync(path.join(venv, "bin", "python"), "#!/bin/sh\necho 'loading model'\necho '{\"text\": \"cobalt\"}'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(cwd, "scripts", "whisper_transcribe.py"), "");
  const savedVenv = process.env.LLV_WHISPER_VENV;
  const savedCwd = process.cwd();
  process.env.LLV_WHISPER_VENV = venv;
  process.env.LLV_HELPER_LEASE_ENTRY = LEASE_ENTRY;
  process.chdir(cwd);
  try {
    expect(await localTranscribe("/dev/null", "en")).toEqual({ text: "cobalt" });
    fs.writeFileSync(path.join(venv, "bin", "python"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    await expect(localTranscribe("/dev/null", "en")).rejects.toThrow("exited with 3");
  } finally {
    process.chdir(savedCwd);
    delete process.env.LLV_HELPER_LEASE_ENTRY;
    if (savedVenv === undefined) delete process.env.LLV_WHISPER_VENV; else process.env.LLV_WHISPER_VENV = savedVenv;
  }
}, 10_000);

/* macOS has no /proc. The guardian ran its Linux identity reader there, read
   "owner gone" on its first poll and ended every helper after a second. Node
   with a preload stands in for that platform: /proc reads fail and
   process.platform is darwin. */
const NODE = Bun.which("node");
const NO_PROC = path.join(SANDBOX, "no-proc.mjs");
fs.writeFileSync(NO_PROC, [
  "import fs from 'node:fs';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const read = fs.readFileSync;",
  "fs.readFileSync = function (file, ...rest) {",
  "  if (String(file).startsWith('/proc/')) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }",
  "  return read.call(this, file, ...rest);",
  "};",
  "Object.defineProperty(process, 'platform', { value: 'darwin' });",
  "syncBuiltinESMExports();",
  "",
].join("\n"));

test.if(NODE !== null && process.platform === "linux")("without /proc a guardian keeps its helper while the lease is open, and ends it at end of file", async () => {
  const report = path.join(SANDBOX, "no-proc.json");
  const program = waitingHelper(path.join(SANDBOX, "no-proc", "helper.mjs"), report);
  const guardian = spawn(NODE!, ["--import", NO_PROC, LEASE_ENTRY, "no-proc", "--", NODE!, program], {
    stdio: ["pipe", "ignore", "inherit"],
    env: { ...process.env, LLV_HELPER_LEASE_STATE: path.join(SANDBOX, "no-proc-state") },
  });
  owned.push({ pid: guardian.pid!, identity: procBackend.processIdentity(guardian.pid!)! });
  const exited = new Promise<number | null>((resolve) => guardian.once("exit", (code) => resolve(code)));
  const helper = await readReport(report);
  /* Three owner polls. */
  await Bun.sleep(3_200);
  expect(guardian.exitCode).toBeNull();
  expect(procBackend.processExited(helper.helper)).toBe(false);
  guardian.stdin!.end();
  expect(await Promise.race([exited, Bun.sleep(6_000).then(() => "timeout")])).toBe(143);
  expect(await gone([helper.helper, helper.child])).toBe(true);
}, 20_000);

test.if(NODE !== null && process.platform === "linux")("without /proc a guardian whose owner dies while the lease stays open ends its helper", async () => {
  const report = path.join(SANDBOX, "no-proc-owner.json");
  const program = waitingHelper(path.join(SANDBOX, "no-proc-owner", "helper.mjs"), report);
  /* The owner hands the guardian its own stdin, which this test holds: the
     lease stays open after the owner dies, so only re-parenting reveals it. */
  const owner = spawn(NODE!, ["-e", [
    "const { spawn } = require('node:child_process');",
    `const guardian = spawn(process.execPath, ['--import', ${JSON.stringify(NO_PROC)}, ${JSON.stringify(LEASE_ENTRY)}, 'no-proc-owner', '--', process.execPath, ${JSON.stringify(program)}], { stdio: [0, 'ignore', 'inherit'] });`,
    "process.stdout.write(JSON.stringify({ guardian: guardian.pid }) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, LLV_HELPER_LEASE_STATE: path.join(SANDBOX, "no-proc-owner-state") } });
  owned.push({ pid: owner.pid!, identity: procBackend.processIdentity(owner.pid!)! });
  const { guardian } = await new Promise<{ guardian: number }>((resolve) => {
    let buffered = "";
    owner.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.includes("\n")) resolve(JSON.parse(buffered.split("\n")[0]!));
    });
  });
  owned.push({ pid: guardian, identity: procBackend.processIdentity(guardian)! });
  const helper = await readReport(report);
  await Bun.sleep(1_500);
  expect(procBackend.processExited(helper.helper)).toBe(false);
  owner.kill("SIGKILL");
  try {
    expect(await gone([guardian, helper.helper, helper.child])).toBe(true);
  } finally {
    owner.stdin!.end();
  }
}, 20_000);
