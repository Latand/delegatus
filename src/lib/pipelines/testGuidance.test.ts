import { gateToolingFiles } from "../../../scripts/gate-tooling";
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStageTestGuidance } from "./testGuidance";
import { resolveSignalTooling } from "@/lib/runtime/agentSignalSandbox";
import { Database } from "bun:sqlite";
import { CheckAdmission } from "../../../scripts/check-admission";
import { onlineCpuCount } from "../runtime/cpuPlacement";
import { withoutInheritedGate } from "../testing/inheritedGateEnv";
import { stopFixtureProcess } from "../testing/fixtureProcess";

test("standalone assembly finds the install and quotes its wrapper for another checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-gate-guidance-"));
  const install = path.join(root, "tool's installed copy");
  const standalone = path.join(install, "dist", "standalone");
  const checkout = path.join(root, "project");
  const wrapper = path.join(install, "scripts", "gate-slot.sh");
  try {
    for (const directory of [standalone, checkout, path.dirname(wrapper), path.join(install, "bin")]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(standalone, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(install, "bin", "cli.mjs"), "");
    fs.writeFileSync(wrapper, '#!/bin/bash\n# LLV_SIGNAL_SANDBOX\nprintf "%s\\n" "$@"\n');
    for (const file of gateToolingFiles.filter(name => name !== "gate-slot.sh")) fs.writeFileSync(path.join(install, "scripts", file), "runSandboxGate");
    fs.writeFileSync(path.join(install, "bin", "agent-signal-sandbox.py"), "");
    const guidance = resolveStageTestGuidance(standalone);
    const command = guidance.match(/: (bash .+?) <project-test-command>/)?.[1];
    expect(command).toBeDefined();
    const result = spawnSync("bash", ["-c", `${command} npm test -- src/example.test.ts`], { cwd: checkout, encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("npm\ntest\n--\nsrc/example.test.ts\n");
    fs.unlinkSync(path.join(install, "scripts", "owned-runner.ts"));
    expect(() => resolveSignalTooling(standalone)).toThrow("Gate wrapper unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packed tooling resolves without source files and the container bridge publishes host-visible bundles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packed-signal-tooling-"));
  const scripts = path.join(root, "dist/gate");
  const previous = process.env.LLV_DOCKER_NSENTER_SHIMS;
  try {
    fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(root, "bin/cli.mjs"), "");
    fs.writeFileSync(path.join(root, "bin/agent-signal-sandbox.py"), "# packed launcher");
    fs.writeFileSync(path.join(scripts, "gate-slot.sh"), "# LLV_SIGNAL_SANDBOX");
    for (const name of gateToolingFiles.filter(name => name !== "gate-slot.sh")) fs.writeFileSync(path.join(scripts, name), "// runSandboxGate");
    delete process.env.LLV_DOCKER_NSENTER_SHIMS;
    expect(resolveSignalTooling(root).gate).toBe(fs.realpathSync(path.join(scripts, "gate-slot.sh")));
    process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
    const tooling = resolveSignalTooling(root);
    expect(tooling.gate).toStartWith(path.join(os.homedir(), ".cache/delegatus/signal-tooling/"));
    expect(fs.readFileSync(tooling.launcher, "utf8")).toBe("# packed launcher");
    expect(fs.readFileSync(path.join(path.dirname(tooling.gate), "gate-wait.ts"), "utf8")).toBe("// runSandboxGate");
    expect(resolveSignalTooling(root)).toEqual(tooling);
    fs.unlinkSync(path.join(scripts, "test-child-guardian.ts"));
    expect(() => resolveSignalTooling(root)).toThrow("Gate wrapper unavailable");
  } finally {
    if (previous === undefined) delete process.env.LLV_DOCKER_NSENTER_SHIMS; else process.env.LLV_DOCKER_NSENTER_SHIMS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("the bridged host copy runs commands and queues a compiler before reading its implementation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridged-gate-"));
  const install = path.join(root, "install"), scripts = path.join(install, "dist/gate");
  const project = path.resolve(import.meta.dir, "../../..");
  const previous = process.env.LLV_DOCKER_NSENTER_SHIMS;
  const children: ReturnType<typeof spawn>[] = [];
  const env = withoutInheritedGate({ ...process.env });
  const admissionFile = path.join(root, "checks.sqlite");
  for (const key of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR"]) {
    env[key] = path.join(root, key); fs.mkdirSync(env[key]!, { recursive: true });
  }
  Object.assign(env, { LLV_CHECK_ADMISSION_FILE: admissionFile,
    DELEGATUS_GATE_CPU_HEADROOM: String(onlineCpuCount() - 1), LLV_GATE_LOCK_DIR: path.join(root, "locks"),
    LLV_GATE_RUNNER: "off", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off",
    XDG_RUNTIME_DIR: path.join(root, "no-manager"), DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-bus`,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_OWNED_RUN_TIMEOUT_MS: "30000" });
  delete env.LLV_CHECK_BROKER; delete env.DELEGATUS_CHECK_BROKER;
  delete env.LLV_DOCKER_NSENTER_SHIMS;
  new CheckAdmission(admissionFile).close();
  const db = new Database(admissionFile);
  const rows = () => db.query<{ held: number }, []>("SELECT held FROM checks ORDER BY seq").all().map(row => row.held);
  const until = async (check: () => boolean) => {
    const deadline = performance.now() + 15000;
    while (!check()) { if (performance.now() > deadline) throw new Error("cached gate did not reach its barrier"); await Bun.sleep(10); }
  };
  const start = (command: string[], cwd = root) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", data => stdout += data); child.stderr!.on("data", data => stderr += data);
    const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
    return { child, exit, output: () => stdout, diagnostic: () => stderr };
  };
  try {
    const built = start([process.execPath, path.join(project, "scripts/build-gate.ts"), scripts], project);
    // Build paths are resolved from the checkout, while the output stays private.
    expect(await built.exit, built.diagnostic()).toBe(0);
    fs.mkdirSync(path.join(install, "bin"));
    fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(install, "bin/cli.mjs"), "");
    fs.copyFileSync(path.join(project, "bin/agent-signal-sandbox.py"), path.join(install, "bin/agent-signal-sandbox.py"));
    process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
    const tooling = resolveSignalTooling(install), cached = path.dirname(tooling.gate);
    expect(fs.readdirSync(cached).sort()).toEqual([...gateToolingFiles, "launch.py"].sort());
    for (const name of gateToolingFiles) {
      const file = path.join(scripts, name), body = fs.readFileSync(file);
      fs.appendFileSync(file, "\n# digest probe\n");
      expect(resolveSignalTooling(install).gate).not.toBe(tooling.gate);
      fs.writeFileSync(file, body);
      fs.unlinkSync(file);
      expect(() => resolveSignalTooling(install)).toThrow("Gate wrapper unavailable");
      fs.writeFileSync(file, body);
    }
    const echo = start(["bash", tooling.gate, "/bin/echo", "cached gate ready"]);
    expect(await echo.exit, echo.diagnostic()).toBe(0);
    expect(echo.output()).toBe("cached gate ready\n");
    for (const name of ["held", "queued"]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, "source.ts"), "export const value: number = 42;\n");
      fs.writeFileSync(path.join(root, name, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], skipLibCheck: true, outDir: "out" }, files: ["source.ts"] }));
    }
    const compiler = path.join(project, "node_modules/typescript/bin/tsc");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { typecheck: `node '${compiler.replaceAll("'", "'\\''")}' --project queued/tsconfig.json --listEmittedFiles` } }));
    const holder = start(["bash", tooling.gate, "node", compiler, "--project", "held/tsconfig.json", "--watch", "--preserveWatchOutput"]);
    await until(() => fs.existsSync(path.join(root, "held/out/source.js")) || holder.child.exitCode !== null);
    expect(holder.child.exitCode, holder.diagnostic()).toBeNull();
    const worker = start(["bash", tooling.gate, process.execPath, "run", "typecheck"]);
    await until(() => rows().length === 2 || worker.child.exitCode !== null);
    expect(worker.child.exitCode, worker.diagnostic()).toBeNull();
    expect(rows()).toEqual([1, 0]);
    expect(worker.output()).toBe("");
    expect(fs.existsSync(path.join(root, "queued/out/source.js"))).toBe(false);
    await stopFixtureProcess(holder.child);
    expect(await worker.exit, worker.diagnostic()).toBe(0);
    expect(fs.existsSync(path.join(root, "queued/out/source.js"))).toBe(true);
    await until(() => rows().length === 0);
  } finally {
    if (previous === undefined) delete process.env.LLV_DOCKER_NSENTER_SHIMS; else process.env.LLV_DOCKER_NSENTER_SHIMS = previous;
    await Promise.all(children.map(child => stopFixtureProcess(child)));
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 90000);
