import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { fixtureReport, stopFixtureProcess } from "@/lib/testing/fixtureProcess";

const handles: ChildProcess[] = [];
const owned: ProcessIdentity[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of handles.splice(0)) await stopFixtureProcess(child);
  for (const identity of owned.splice(0)) {
    if (processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    await until(() => processIdentityStatus(identity) === "dead");
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await Bun.sleep(10); }
  throw new Error("fixture lifecycle did not settle within 3 seconds");
}
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generation-lifetime-")); roots.push(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LLV_")) delete env[key];
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { NODE_ENV: "test", LLV_STAGING: "1", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_SOCKET: path.join(root, "missing.sock"), LLV_GENERATION_PROBE_ROOT: root });
  fs.writeFileSync(path.join(root, "startup-pause-refresh"), "hold");
  return { root, env };
}
function start(command: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command[0]!, command.slice(1), { env, stdio: ["ignore", "ignore", "ignore"] });
  handles.push(child);
  return child;
}
async function reported(root: string, name: string) {
  const file = path.join(root, `${name}.json`);
  await until(() => fs.existsSync(file));
  const identity = JSON.parse(fs.readFileSync(file, "utf8")) as ProcessIdentity;
  owned.push(identity);
  return identity;
}
for (const mode of ["exit", "SIGKILL"] as const) test(`real pre-report fixture exits after parent ${mode}, preserving a same-argv bystander`, async () => {
  const { root, env } = sandbox();
  const command = [process.execPath, "run", path.join(import.meta.dir, "fixtures/generationParent.ts")];
  const bystander = start(command, { ...env, LLV_GENERATION_PROBE_NAME: "bystander", LLV_GENERATION_PROBE_MODE: "wait" });
  const other = await reported(root, "bystander");
  const parent = start(command, { ...env, LLV_GENERATION_PROBE_NAME: "owned", LLV_GENERATION_PROBE_MODE: mode === "exit" ? "exit" : "wait" });
  const fixture = await reported(root, "owned");
  await until(() => fs.existsSync(path.join(root, "startup-pause-refresh.reached")));
  if (mode === "SIGKILL") parent.kill("SIGKILL");
  await until(() => parent.exitCode !== null || parent.signalCode !== null);
  await until(() => processIdentityStatus(fixture) === "dead");
  expect(processIdentityStatus(other)).toBe("alive");
  expect(bystander.exitCode).toBeNull();
}, 10_000);

test("a real fixture stalled before its first report is reaped by a named readiness deadline", async () => {
  const { root, env } = sandbox();
  const child = spawn(process.execPath, ["run", path.join(import.meta.dir, "fixtures/stageHostGeneration.ts"), "adopt", path.join(root, "registry.json"), root, "single"], { env, stdio: ["ignore", "pipe", "pipe"] });
  handles.push(child);
  const identity = captureProcessIdentity(child.pid!); owned.push(identity);
  const bystander = spawn(process.execPath, ["run", path.join(import.meta.dir, "fixtures/stageHostGeneration.ts"), "adopt", path.join(root, "registry.json"), root, "single"], { env, stdio: "ignore" });
  handles.push(bystander);
  const other = captureProcessIdentity(bystander.pid!); owned.push(other);
  await expect(fixtureReport(child, "stageHostGeneration adopt", [], 500)).rejects.toThrow("stageHostGeneration adopt did not report within 500ms");
  expect(processIdentityStatus(identity)).toBe("dead");
  expect(processIdentityStatus(other)).toBe("alive");
}, 5_000);
