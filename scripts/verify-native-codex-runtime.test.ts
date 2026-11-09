import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.each(["success", "failure"])("the native verifier uses the project test timeout and retains the %s verdict", outcome => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runner-timeout-"));
  roots.push(root);
  const target = path.join(root, "src/lib/runtime/codexSteerDelivery.integration.test.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `import { expect, test } from "bun:test";
test("native verifier assertion fixture", () => {
  expect(${JSON.stringify(outcome)}).toBe("success");
});`);
  const capture = path.join(root, "child-launch.jsonl");
  const preload = path.join(root, "capture-child-launch.ts");
  // Observe the real CLI's launch, then run its child unchanged. Keep the mock
  // in this subprocess so it cannot affect other tests or nested admission.
  fs.writeFileSync(preload, `import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const runChild = spawnSync;
mock.module("node:child_process", () => ({
  spawnSync(command, args, options) {
    fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
      command, args, timeout: options.timeout, killSignal: options.killSignal, stdio: options.stdio,
    }) + "\\n");
    return runChild(command, args, options);
  },
}));`);
  const result = spawnSync(process.execPath, ["--preload", preload, path.join(import.meta.dir, "verify-native-codex-runtime.ts"), process.execPath, "--steering-only"], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  const launches = fs.readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(launches).toEqual([{
    command: process.execPath,
    args: ["test", "--timeout=60000", "src/lib/runtime/codexSteerDelivery.integration.test.ts"],
    timeout: 300_000, killSignal: "SIGKILL", stdio: "inherit",
  }]);
  const output = result.stdout + result.stderr;
  expect(output).not.toContain("timed out");
  expect(result.status).toBe(outcome === "success" ? 0 : 1);
  expect(output).toContain(outcome === "success" ? "1 pass" : "1 fail");
  if (outcome === "failure") expect(output).toContain('expect(received).toBe(expected)');
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
  const boundary = process.env.LLV_SIGNAL_SANDBOX ? JSON.parse(process.env.LLV_SIGNAL_SANDBOX) : null;
  expect(boundary?.pidNamespace).toBe(${JSON.stringify(process.env.LLV_SIGNAL_SANDBOX ? JSON.parse(process.env.LLV_SIGNAL_SANDBOX).pidNamespace : undefined)});
  expect(boundary?.userNamespace).toBe(${JSON.stringify(process.env.LLV_SIGNAL_SANDBOX ? JSON.parse(process.env.LLV_SIGNAL_SANDBOX).userNamespace : undefined)});
  if (boundary) expect(boundary.gate.cgroup).toBe(process.env.LLV_OWNED_TEST_RUN_CGROUP);
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
