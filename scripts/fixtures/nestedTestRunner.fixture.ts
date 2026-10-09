import { test } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { captureProcessIdentity } from "../../src/lib/processIdentity";

test("short-lived helper leaves a detached descendant for the runner guard", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "detachedChildParent.fixture.ts")], { stdout: "ignore", stderr: "inherit" });
  await child.exited;
  fs.writeFileSync(`${process.env.LLV_DETACHED_CHILD_RECORD!}.runner`, JSON.stringify(captureProcessIdentity(process.pid)));
  if (process.env.LLV_NESTED_HOLD === "1") await Bun.sleep(30_000);
});
