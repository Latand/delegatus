import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "linux")("the native verifier's private environment admits its real nested test runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runner-admission-"));
  roots.push(root);
  fs.symlinkSync(import.meta.dir, path.join(root, "scripts"), "dir");
  fs.writeFileSync(path.join(root, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(path.resolve(import.meta.dir, "../test-preload.ts"))}]\n`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": [path.resolve(import.meta.dir, "../src/*")] } } }));
  const target = path.join(root, "src/lib/runtime/codexSteerDelivery.integration.test.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `import { expect, test } from "bun:test";
import fs from "node:fs";
test("kernel admission with private state", () => {
  expect(Number(process.env.LLV_OWNED_TEST_RUNNER_PID)).toBe(process.pid);
  expect(fs.readFileSync("/proc/self/cgroup", "utf8")).toContain("0::" + process.env.LLV_OWNED_TEST_RUN_CGROUP);
  expect(process.env.LLV_OWNED_TEST_RUN_CGROUP).not.toBe(${JSON.stringify(process.env.LLV_OWNED_TEST_RUN_CGROUP)});
  expect(process.env.XDG_RUNTIME_DIR).toBe(${JSON.stringify(process.env.XDG_RUNTIME_DIR)});
  expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe(${JSON.stringify(process.env.DBUS_SESSION_BUS_ADDRESS)});
  expect(process.env.HOME).not.toBe(${JSON.stringify(process.env.HOME)});
  expect(process.env.LLV_STATE_DIR).not.toBe(${JSON.stringify(process.env.LLV_STATE_DIR)});
  expect(process.env.LLV_STATE_OWNER).toBeUndefined();
  expect(process.env.NATIVE_ADMISSION_UNRELATED).toBeUndefined();
});`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, "verify-native-codex-runtime.ts"), "/bin/true", "--steering-only"], {
    cwd: root, env: { ...process.env, LLV_STATE_OWNER: "viewer", NATIVE_ADMISSION_UNRELATED: "synthetic" },
    encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("1 pass");
});
