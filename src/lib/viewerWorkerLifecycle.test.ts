import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureProcess, stopFixtureIdentity } from "@/lib/testing/fixtureProcess";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function exited(pid: number): boolean {
  try {
    // A zombie has exited; its init may reap it after this test finishes.
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function reportedWorkerPid(parent: ReturnType<typeof spawn>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent did not report worker PID")), 5_000);
    parent.once("error", reject);
    parent.stdout!.once("data", (data: Buffer) => {
      clearTimeout(timer);
      const pid = Number(String(data).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) reject(new Error("invalid worker PID"));
      else resolve(pid);
    });
  });
}

function waitForExit(pid: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (exited(pid)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`worker ${pid} remained alive`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

test("resident worker exits when its Viewer parent is killed", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worker-parent-"));
  const parent = spawn(process.execPath, [path.join(import.meta.dir, "viewerWorkerLifecycle.parent.ts")], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LLV_STATE_DIR: path.join(sandbox, "state"), XDG_CONFIG_HOME: sandbox },
  });
  let workerPid: number | null = null;
  let workerIdentity: ProcessIdentity | undefined;
  try {
    workerPid = await reportedWorkerPid(parent);
    workerIdentity = captureProcessIdentity(workerPid);
    expect(exited(workerPid)).toBe(false);
    parent.kill("SIGKILL");
    await waitForExit(workerPid);
  } finally {
    if (workerIdentity) await stopFixtureIdentity(workerIdentity);
    await stopFixtureProcess(parent);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("resident worker exits when a successor replaces its live Viewer", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worker-release-"));
  const targetFile = path.join(sandbox, "viewer-release.json");
  fs.writeFileSync(targetFile, JSON.stringify({ endpoint: "http://127.0.0.1:17990" }));
  const parent = spawn(process.execPath, [path.join(import.meta.dir, "viewerWorkerLifecycle.parent.ts")], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "17990", LLV_VIEWER_DEPLOY_TARGET: targetFile,
      LLV_STATE_DIR: path.join(sandbox, "state"), XDG_CONFIG_HOME: sandbox },
  });
  let workerPid: number | null = null;
  let workerIdentity: ProcessIdentity | undefined;
  try {
    workerPid = await reportedWorkerPid(parent);
    workerIdentity = captureProcessIdentity(workerPid);
    expect(exited(workerPid)).toBe(false);
    const replacement = path.join(sandbox, "replacement.json");
    fs.writeFileSync(replacement, JSON.stringify({ endpoint: "http://127.0.0.1:17991" }));
    fs.renameSync(replacement, targetFile);
    await waitForExit(workerPid);
    expect(exited(parent.pid!)).toBe(false);
  } finally {
    if (workerIdentity) await stopFixtureIdentity(workerIdentity);
    await stopFixtureProcess(parent);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
