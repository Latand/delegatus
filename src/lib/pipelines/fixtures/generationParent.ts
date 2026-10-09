import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { captureProcessIdentity } from "@/lib/processIdentity";

const root = process.env.LLV_GENERATION_PROBE_ROOT!;
const child = spawn(process.execPath, ["run", path.join(import.meta.dir, "stageHostGeneration.ts"), "adopt", path.join(root, "registry.json"), root, "single"], {
  env: { ...process.env, LLV_FIXTURE_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)) },
  stdio: ["ignore", "pipe", "pipe"],
});
// This is the probe's independent recovery record, before any readiness wait.
fs.writeFileSync(path.join(root, `${process.env.LLV_GENERATION_PROBE_NAME}.json`), JSON.stringify(captureProcessIdentity(child.pid!)));
child.stdout?.resume(); child.stderr?.resume();
if (process.env.LLV_GENERATION_PROBE_MODE === "exit") {
  for (let i = 0; i < 200 && !fs.existsSync(path.join(root, "startup-pause-refresh.reached")); i++) await Bun.sleep(10);
  process.exit(0);
}
for (;;) await Bun.sleep(1_000);
