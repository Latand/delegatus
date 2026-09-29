import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

const root = process.env.LLV_ORPHAN_PROBE_DIR!;
const fixture = path.join(root, "fixture");

afterEach(async () => {
  await reapFixtureChildren();
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
