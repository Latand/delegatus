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
