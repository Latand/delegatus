import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";

test.skipIf(process.platform !== "linux")("an adopt generation sleeps after startup instead of polling an empty event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generation-idle-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LLV_")) delete env[key];
  for (const [key, directory] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, directory);
    fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_STAGING: "1", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_SOCKET: path.join(root, "absent.sock") });
  const child = spawn(process.execPath, ["run", path.join(import.meta.dir, "fixtures/stageHostGeneration.ts"), "adopt", path.join(root, "registry.json"), root, "single"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const identity = captureProcessIdentity(child.pid!);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    await Bun.sleep(1_000);
    expect(processIdentityStatus(identity)).toBe("alive");
    const before = procBackend.processCpuMs(identity.pid)!;
    await Bun.sleep(1_000);
    const after = procBackend.processCpuMs(identity.pid)!;
    expect(after - before).toBeLessThan(200);
  } finally {
    if (processIdentityStatus(identity) === "alive") child.kill("SIGKILL");
    await Promise.race([exited, Bun.sleep(2_000).then(() => { throw new Error("generation idle fixture survived cleanup"); })]);
    expect(processIdentityStatus(identity)).toBe("dead");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 8_000);
