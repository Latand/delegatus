import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";

import { retireViewerHelpers, viewerProcessTree } from "./viewer-helpers-retire.mjs";

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

test("nothing is waited for or signalled without owners", async () => {
  expect(await retireViewerHelpers(path.join(SANDBOX, "nothing"), [], { leaseMs: 10 })).toEqual({ exited: 0, terminated: 0, killed: 0, survived: [] });
  expect(viewerProcessTree(undefined)).toEqual([]);
});
