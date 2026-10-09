import { test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { captureProcessIdentity } from "../../src/lib/processIdentity";

const root = process.env.LLV_RUNNER_PROBE_ROOT!;
test("owned runner lifetime probe", async () => {
  const fixture = spawn(process.execPath, ["run", path.resolve("src/lib/pipelines/fixtures/stageHostGeneration.ts"), "adopt", path.join(root, "registry.json"), root, "single"], {
    env: { ...process.env, LLV_FIXTURE_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)) },
    stdio: "ignore",
  });
  fs.appendFileSync(path.join(root, "owned.jsonl"), `${JSON.stringify(captureProcessIdentity(fixture.pid!))}\n`);
  const escaped = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  fs.appendFileSync(path.join(root, "owned.jsonl"), `${JSON.stringify(captureProcessIdentity(escaped.pid!))}\n`);
  fixture.unref(); escaped.unref();
  fs.writeFileSync(path.join(root, "ready"), JSON.stringify(captureProcessIdentity(process.pid)));
  if (process.env.LLV_RUNNER_PROBE_MODE === "exit") process.exit(0);
  for (;;) await Bun.sleep(1_000);
}, process.env.LLV_RUNNER_PROBE_MODE === "timeout" ? 750 : 20_000);
