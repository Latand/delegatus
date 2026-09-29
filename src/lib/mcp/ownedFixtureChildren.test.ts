import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fixturePidAlive, ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

const roots: string[] = [];
afterEach(async () => {
  await reapFixtureChildren();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(reapFixtureChildren);

async function runProbe(mode: "failure" | "killed"): Promise<{ childPid: number; runnerExit: number; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-owned-child-probe-"));
  roots.push(root);
  const runner = ownFixtureChild(Bun.spawn({
    cmd: [process.execPath, "test", path.join(import.meta.dir, "ownedChildren.runnerFixture.ts")],
    env: { ...process.env, LLV_ORPHAN_PROBE_DIR: root, LLV_ORPHAN_PROBE_MODE: mode },
    stdout: "pipe",
    stderr: "pipe",
  }));
  const pidFile = path.join(root, "child.pid");
  const ready = path.join(root, "fixture", "ready");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(pidFile) || (mode === "killed" && !fs.existsSync(ready))) {
    if (Date.now() >= deadline) throw new Error("sub-runner child never reached its barrier");
    await Bun.sleep(10);
  }
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  if (mode === "killed") runner.kill(9);
  const runnerExit = await runner.exited;
  if (mode === "failure") expect(fs.existsSync(path.join(root, "fixture"))).toBeFalse();
  const survivorDeadline = Date.now() + 2_000;
  while (fixturePidAlive(childPid) && Date.now() < survivorDeadline) await Bun.sleep(20);
  expect(fixturePidAlive(childPid)).toBeFalse();
  return { childPid, runnerExit, root };
}

test("failed readiness assertion reaps its recorded child before removing the root", async () => {
  const { childPid, runnerExit, root } = await runProbe("failure");
  expect(runnerExit).not.toBe(0);
  expect(fixturePidAlive(childPid)).toBeFalse();
  const afterReap = JSON.parse(fs.readFileSync(path.join(root, "after-reap.json"), "utf8")) as
    Array<{ pid: number; startTime: string | null; alive: boolean }>;
  expect(afterReap.map((entry) => entry.pid)).toEqual([childPid]);
  expect(afterReap[0]!.startTime).not.toBeNull();
  expect(afterReap.filter((entry) => entry.alive)).toEqual([]);
}, 15_000);

test("SIGKILLed parent leaves no recorded waiting child", async () => {
  const { childPid, runnerExit } = await runProbe("killed");
  expect(runnerExit).not.toBe(0);
  expect(fixturePidAlive(childPid)).toBeFalse();
}, 15_000);
