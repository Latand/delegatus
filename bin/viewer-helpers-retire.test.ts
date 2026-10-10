import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";

import { retireViewerDescendants, retireViewerHelpers, viewerProcessTree } from "./viewer-helpers-retire.mjs";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-helpers-retire-"));
const LEASE_ENTRY = path.resolve(import.meta.dir, "helper-lease.mjs");
const owned: Array<{ pid: number; identity: string }> = [];
afterAll(() => {
  for (const { pid, identity } of owned) {
    if (procBackend.processIdentity(pid) !== identity) continue;
    try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const alive = (pid: number, identity: string) => procBackend.processIdentity(pid) === identity && !procBackend.processExited(pid);

function own(pid: number): { pid: number; identity: string } {
  const entry = { pid, identity: procBackend.processIdentity(pid)! };
  owned.push(entry);
  return entry;
}

/** A Viewer stand-in that starts one leased helper (which ignores SIGTERM and
    has a child of its own) and reports the guardian, helper and child. */
async function viewerWithHelper(name: string, state: string) {
  const report = path.join(SANDBOX, `${name}.json`);
  const helper = path.join(SANDBOX, `${name}-helper.mjs`);
  fs.writeFileSync(helper, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "process.on('SIGTERM', () => {});",
    "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ helper: process.pid, child: child.pid }));`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const viewerScript = path.join(SANDBOX, `${name}-viewer.mjs`);
  fs.writeFileSync(viewerScript, [
    `const { spawnLeasedHelper } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/helperLease.ts"))});`,
    `const guardian = spawnLeasedHelper(${JSON.stringify(name)}, { command: process.execPath, args: [${JSON.stringify(helper)}], cwd: process.cwd(), env: process.env }, ${JSON.stringify(state)});`,
    "process.stdout.write(JSON.stringify({ guardian: guardian.pid }) + '\\n');",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const viewer: ChildProcess = spawn(process.execPath, [viewerScript], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, LLV_HELPER_LEASE_ENTRY: LEASE_ENTRY },
  });
  own(viewer.pid!);
  const { guardian } = await new Promise<{ guardian: number }>((resolve) => {
    let buffered = "";
    viewer.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.includes("\n")) resolve(JSON.parse(buffered.split("\n")[0]!));
    });
  });
  own(guardian);
  const deadline = Date.now() + 8_000;
  let pids: { helper: number; child: number } | null = null;
  while (!pids && Date.now() < deadline) {
    try { pids = JSON.parse(fs.readFileSync(report, "utf8")); } catch { await Bun.sleep(25); }
  }
  if (!pids) throw new Error(`${name} never started its helper`);
  return { viewer, guardian: own(guardian), helper: own(pids.helper), child: own(pids.child) };
}

const stopped = (child: ChildProcess) => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });

test.if(process.platform === "linux")("the launcher finishes the helpers of the Viewer it stopped and leaves a successor's alone", async () => {
  const state = path.join(SANDBOX, "shared-state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const mine = await viewerWithHelper("stopped-viewer", state);
  const theirs = await viewerWithHelper("successor-viewer", state);
  expect(fs.readdirSync(path.join(state, "helpers")).filter((file) => file.endsWith(".json"))).toHaveLength(2);
  /* Read before the stop, as the launcher does. */
  const owners = viewerProcessTree(mine.viewer.pid);
  expect(owners.map((owner) => owner.pid)).toContain(mine.guardian.pid);
  /* A guardian that cannot act (stopped by the kernel, or wedged): its lease
     closes with the Viewer, but only the launcher can finish the helper. */
  process.kill(mine.guardian.pid, "SIGSTOP");
  await stopped(mine.viewer);
  const outcome = await retireViewerHelpers(state, owners, { leaseMs: 300, termMs: 300, killMs: 2_000 });
  expect(outcome.survived).toEqual([]);
  expect(outcome.killed).toBe(1);
  for (const process of [mine.guardian, mine.helper, mine.child]) expect(alive(process.pid, process.identity)).toBe(false);
  for (const process of [theirs.guardian, theirs.helper, theirs.child]) expect(alive(process.pid, process.identity)).toBe(true);
  expect(fs.readdirSync(path.join(state, "helpers")).filter((file) => file.endsWith(".json"))).toEqual([`${theirs.guardian.pid}.json`]);
  await stopped(theirs.viewer);
}, 30_000);

test.if(process.platform === "linux")("a helper whose guardian ends it with the Viewer is only waited for", async () => {
  const state = path.join(SANDBOX, "lease-state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const mine = await viewerWithHelper("leased-viewer", state);
  const owners = viewerProcessTree(mine.viewer.pid);
  await stopped(mine.viewer);
  const outcome = await retireViewerHelpers(state, owners, { leaseMs: 5_000, termMs: 300, killMs: 2_000 });
  expect(outcome).toEqual({ exited: 1, terminated: 0, killed: 0, survived: [] });
  for (const process of [mine.guardian, mine.helper, mine.child]) expect(alive(process.pid, process.identity)).toBe(false);
}, 30_000);

/* A Viewer's other children (a `git fetch` stuck on the network, a worker
   nobody leased) are spared by KillMode=process and kept the old cgroup path
   populated after the Viewer stopped: their deadlines lived in the Viewer. They
   stay in the Viewer's process group; agents are started detached. */
test.if(process.platform === "linux")("the launcher ends what the stopped Viewer left in its process group and spares its agents", async () => {
  const stuck = path.join(SANDBOX, "descendants-stuck.mjs");
  fs.writeFileSync(stuck, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
  const hung = path.join(SANDBOX, "descendants-hung.mjs");
  fs.writeFileSync(hung, [
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, [${JSON.stringify(stuck)}], { stdio: 'ignore' });`,
    "process.stdout.write(child.pid + '\\n');",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const viewerScript = path.join(SANDBOX, "descendants-viewer.mjs");
  fs.writeFileSync(viewerScript, [
    "import { spawn } from 'node:child_process';",
    `const hung = spawn(process.execPath, [${JSON.stringify(hung)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
    "const quick = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'ignore' });",
    "const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
    "const agentChild = spawn('/bin/sh', ['-c', 'sleep 300 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });",
    "let grandchild = null; let agentGrandchild = null;",
    "const done = () => { if (grandchild && agentGrandchild) process.stdout.write(JSON.stringify({ hung: hung.pid, grandchild, quick: quick.pid, agent: agent.pid, agentGrandchild }) + '\\n'); };",
    "hung.stdout.once('data', (chunk) => { grandchild = Number(String(chunk).trim()); done(); });",
    "agentChild.stdout.once('data', (chunk) => { agentGrandchild = Number(String(chunk).trim()); done(); });",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const viewer: ChildProcess = spawn(process.execPath, [viewerScript], { stdio: ["ignore", "pipe", "inherit"] });
  own(viewer.pid!);
  const pids = await new Promise<Record<string, number>>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("the Viewer stand-in never reported")), 8_000);
    viewer.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(buffered.split("\n")[0]!)); }
    });
  });
  const processes = Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, own(pid)]));
  /* Read before the stop, as the launcher does. */
  const owners = viewerProcessTree(viewer.pid);
  expect(owners.map((owner) => owner.pid)).toEqual(expect.arrayContaining(Object.values(pids)));
  await stopped(viewer);
  const outcome = await retireViewerDescendants(viewer.pid, owners, { waitMs: 1_000, termMs: 300, killMs: 2_000 });
  expect(outcome).toEqual({ exited: 1, terminated: 0, killed: 2, survived: [] });
  for (const name of ["hung", "grandchild", "quick"]) expect(alive(processes[name]!.pid, processes[name]!.identity)).toBe(false);
  for (const name of ["agent", "agentGrandchild"]) expect(alive(processes[name]!.pid, processes[name]!.identity)).toBe(true);
}, 30_000);

test("nothing is waited for or signalled without owners", async () => {
  expect(await retireViewerDescendants(undefined, [], { waitMs: 10 })).toEqual({ exited: 0, terminated: 0, killed: 0, survived: [] });
  expect(await retireViewerHelpers(path.join(SANDBOX, "nothing"), [], { leaseMs: 10 })).toEqual({ exited: 0, terminated: 0, killed: 0, survived: [] });
  expect(viewerProcessTree(undefined)).toEqual([]);
});
