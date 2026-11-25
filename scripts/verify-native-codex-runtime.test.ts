import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codexHostContractFiles, nativeBatches } from "./verify-native-codex-runtime";

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
  // Record the CLI's request and return a fixed verdict. The separate
  // admission case below exercises the real runner without a test double.
  fs.writeFileSync(preload, `import fs from "node:fs";
import { runNativeVerifier } from ${JSON.stringify(path.join(import.meta.dir, "verify-native-codex-runtime.ts"))};
await runNativeVerifier((command, args, options) => {
    fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
      command, args, timeout: options.timeout, killSignal: options.killSignal, stdio: options.stdio,
    }) + "\\n");
    return { status: ${outcome === "success" ? 0 : 1}, error: undefined };
});`);
  const result = spawnSync(process.execPath, [preload, process.execPath, "--steering-only"], {
    cwd: root, env: { ...process.env, LLV_GATE_COMPARE_BASE: undefined }, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(outcome === "success" ? 0 : 1);
  expect(fs.existsSync(capture), result.stdout + result.stderr).toBeTrue();
  const launches = fs.readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(launches).toEqual([{
    command: process.execPath,
    args: ["test", "--timeout=60000", "src/lib/runtime/codexSteerDelivery.integration.test.ts"],
    timeout: 300_000, killSignal: "SIGKILL", stdio: "inherit",
  }]);
  const output = result.stdout + result.stderr;
  expect(output).not.toContain("timed out");
  expect(result.status).toBe(outcome === "success" ? 0 : 1);
});

test("destructive guard native checks run once in each engine window and default selection", () => {
  const file = "src/lib/agent/destructiveGuard.native.test.ts";
  expect(nativeBatches("--engine-only").flat().filter(value => value === file)).toHaveLength(1);
  expect(nativeBatches().flat().filter(value => value === file)).toHaveLength(1);
  expect(nativeBatches("--shared-only").flat()).not.toContain(file);
});

test("every split host contract runs once in shared and default verification", () => {
  const defaultFiles = nativeBatches().flat();
  const sharedFiles = nativeBatches("--shared-only").flat();
  const engineFiles = nativeBatches("--engine-only").flat();
  expect(codexHostContractFiles).toHaveLength(10);
  for (const file of codexHostContractFiles) {
    expect(fs.existsSync(path.resolve(import.meta.dir, "..", file))).toBeTrue();
    expect(defaultFiles.filter(value => value === file)).toHaveLength(1);
    expect(sharedFiles.filter(value => value === file)).toHaveLength(1);
    expect(engineFiles).not.toContain(file);
  }
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
  expect(process.env.TMPDIR?.startsWith(process.env.LLV_GATE_TEMP_ROOT + "/")).toBeTrue();
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
