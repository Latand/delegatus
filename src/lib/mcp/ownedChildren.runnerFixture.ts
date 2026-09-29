import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { fixturePidAlive, ownFixtureChild, ownedFixturePids, reapFixtureChildren } from "./ownedFixtureChildren";

const root = process.env.LLV_ORPHAN_PROBE_DIR!;
const fixture = path.join(root, "fixture");

// Field 22 of /proc/<pid>/stat, so a recycled PID never reads as the recorded child.
function processStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

const startTimes = new Map<number, string | null>();

afterEach(async () => {
  await reapFixtureChildren();
  const afterReap = ownedFixturePids().map((pid) => ({
    pid,
    startTime: startTimes.get(pid) ?? null,
    alive: fixturePidAlive(pid) && processStartTime(pid) === startTimes.get(pid),
  }));
  fs.writeFileSync(path.join(root, "after-reap.json"), JSON.stringify(afterReap));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("held child is owned during a failed assertion or runner death", async () => {
  fs.mkdirSync(fixture);
  const child = ownFixtureChild(Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "receiptStoreProbeChild.ts"), "cold-start",
      path.join(fixture, "receipts.sqlite"), path.join(fixture, "ready"),
      path.join(fixture, "start"), path.join(fixture, "result"), "0", "fixture-key"],
    env: { ...process.env, LLV_FIXTURE_PARENT_PID: String(process.pid) },
    stdout: "ignore",
    stderr: "pipe",
  }));
  startTimes.set(child.pid, processStartTime(child.pid));
  fs.writeFileSync(path.join(root, "child.pid"), String(child.pid));
  const ready = path.join(fixture, "ready");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error("child never reached readiness barrier");
    await Bun.sleep(10);
  }
  if (process.env.LLV_ORPHAN_PROBE_MODE === "failure") {
    expect(fs.existsSync(path.join(fixture, "start"))).toBeTrue();
  } else {
    await new Promise<never>(() => {});
  }
}, 15_000);
