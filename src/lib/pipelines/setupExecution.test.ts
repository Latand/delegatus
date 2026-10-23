import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { AgentMemoryCell } from "@/lib/runtime/agentMemory";
import type { AgentCpuPlan } from "@/lib/runtime/cpuPlacement";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { ownFixtureTree, stopFixtureIdentity, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { reviewSetupRecipe, setupInterpreter } from "@/lib/projects/setupRecipe";
import { executeSetupRecipe, runSetupRecipe, type SetupExecution } from "./setupExecution";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-execution-"));
const checkout = path.join(root, "checkout"); fs.mkdirSync(checkout);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const isolationRefusal = /bwrap: (?:not found|No such file or directory|setting up uid map: Permission denied|loopback: Failed RTM_NEWADDR: Operation not permitted|Creating new namespace failed: Operation not permitted)|FileNotFoundError: (?:.*'bwrap'|\[Errno 2\] No such file or directory(?:\r?\n|$))|setup isolation could not start; no command was run/;

// Sandbox cases own their launch plan; host memory pressure is not fixture input.
// The scope case below separately requires the memory wrapper and work CPU plan.
const executeSandboxRecipe: SetupExecution = (root, recipe, sandbox, signal, authorize) =>
  runSetupRecipe(root, recipe, sandbox, signal, authorize, { planMemory: () => null, planCpu: () => null });

test("the real process runs immutable reviewed bytes with isolated state, home, credentials and filesystem", async () => {
  const sentinel = path.join(root, "operator-state"); fs.writeFileSync(sentinel, "preserved");
  // The parent-death helper runs before filesystem isolation. Python must not
  // import a checkout's modules while establishing that boundary.
  fs.writeFileSync(path.join(checkout, "ctypes.py"), `open(${JSON.stringify(sentinel)}, "w").write("unreviewed import")\n`);
  fs.writeFileSync(path.join(checkout, "setup.sh"), `test -z "$SETUP_TEST_SECRET" || exit 11
test "$HOME" != ${JSON.stringify(process.env.HOME)} || exit 12
test -n "$LLV_STATE_DIR" || exit 13
printf private > "$HOME/created"
printf changed > ${JSON.stringify(sentinel)} 2>/dev/null || true
printf ready > setup-created
printf reviewed
`);
  const recipe = await reviewSetupRecipe(checkout, { command: ["sh", "setup.sh"], cwd: "." });
  // Replacing the live file between review and actual exec cannot change execution.
  fs.writeFileSync(path.join(checkout, "setup.sh"), "echo unreviewed; exit 19\n");
  const previous = process.env.SETUP_TEST_SECRET;
  process.env.SETUP_TEST_SECRET = String(7);
  try {
    if (process.platform !== "linux") {
      await expect(executeSandboxRecipe(checkout, recipe, "restricted")).rejects.toThrow("requires Linux");
      expect(fs.existsSync(path.join(checkout, "setup-created"))).toBe(false);
      return;
    }
    const result = await executeSandboxRecipe(checkout, recipe, "restricted");
    if (process.env.SETUP_REQUIRE_ISOLATION === "1") expect(result.code, result.stderr).toBe(0);
    if (result.code === 0) {
      expect(result.stdout).toBe("reviewed");
      expect(fs.readFileSync(path.join(checkout, "setup-created"), "utf8")).toBe("ready");
    } else {
      expect(result.stderr).toMatch(isolationRefusal);
      expect(fs.existsSync(path.join(checkout, "setup-created"))).toBe(false);
    }
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserved");
  } finally {
    if (previous === undefined) delete process.env.SETUP_TEST_SECRET; else process.env.SETUP_TEST_SECRET = previous;
  }
});

test("an aborted real launch cannot produce setup effects", async () => {
  fs.writeFileSync(path.join(checkout, "cancel.sh"), "printf wrong > cancelled-effect\n");
  const recipe = await reviewSetupRecipe(checkout, { command: ["sh", "cancel.sh"], cwd: "." });
  const abort = new AbortController(); abort.abort();
  const result = await executeSetupRecipe(checkout, recipe, "full", abort.signal);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("cancelled");
  expect(fs.existsSync(path.join(checkout, "cancelled-effect"))).toBe(false);
});

test.skipIf(process.platform !== "linux")("losing the real setup owner ends its detached descendants", async () => {
  const marker = path.join(checkout, "owner-ready");
  fs.writeFileSync(path.join(checkout, "owner.sh"), "setsid sleep 30 &\nprintf ready > owner-ready\nwait\n");
  const source = `import { reviewSetupRecipe } from ${JSON.stringify(path.resolve("src/lib/projects/setupRecipe.ts"))};
    import { runSetupRecipe } from ${JSON.stringify(path.resolve("src/lib/pipelines/setupExecution.ts"))};
    const root=process.env.SETUP_CHECKOUT;
    const recipe=await reviewSetupRecipe(root,{command:['sh','owner.sh'],cwd:'.'});
    console.log(JSON.stringify(await runSetupRecipe(root,recipe,'restricted',undefined,undefined,{planMemory:()=>null,planCpu:()=>null})));`;
  const child = ownFixtureTree(spawn(process.execPath, ["-e", source], { env: { ...process.env, SETUP_CHECKOUT: checkout,
    LLV_AGENT_CPU: "off", DELEGATUS_AGENT_CPU: "off", LLV_AGENT_MEMORY: "watchdog", DELEGATUS_AGENT_MEMORY: "watchdog" }, stdio: ["ignore", "pipe", "pipe"] }));
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
  let owned: ProcessIdentity[] = [];
  try {
    const readyBy = Date.now() + 10_000;
    while (!fs.existsSync(marker) && child.exitCode === null && child.signalCode === null && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 10));
    if (!fs.existsSync(marker)) {
      expect(process.env.SETUP_REQUIRE_ISOLATION).not.toBe("1");
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await ended;
      const refusal = JSON.parse(output.trim()) as { code: number | null; stderr: string };
      expect(refusal.code).not.toBe(0);
      expect(refusal.stderr).toMatch(isolationRefusal);
      return;
    }
    owned = descendantPids(child.pid!, procBackend.ppidMap()).filter(pid => pid !== child.pid).map(pid => captureProcessIdentity(pid));
    expect(owned.length).toBeGreaterThan(0);
    child.kill("SIGKILL"); await ended;
    const alive = () => owned.filter(identity => processIdentityStatus(identity) !== "dead" && !procBackend.processExited(identity.pid));
    const reapedBy = Date.now() + 5_000;
    while (alive().length && Date.now() < reapedBy) await new Promise(resolve => setTimeout(resolve, 10));
    expect(alive()).toEqual([]);
  } finally {
    await stopFixtureTree(child);
    for (const identity of owned) await stopFixtureIdentity(identity);
  }
});

function requireExecution(result: { code: number | null; stderr: string }) {
  if (process.env.SETUP_REQUIRE_ISOLATION === "1") expect(result.code, result.stderr).toBe(0);
  if (result.code !== 0) { expect(result.stderr).toMatch(isolationRefusal); return false; }
  return true;
}

test.skipIf(process.platform !== "linux")("Python ignores adjacent module shadows after approval", async () => {
  const directory = fs.mkdtempSync(path.join(root, "python-"));
  fs.mkdirSync(path.join(directory, "scripts"));
  fs.writeFileSync(path.join(directory, "scripts/setup.py"), 'import json\nprint("reviewed", json.dumps(1))\n');
  const input = { command: ["python3", "scripts/setup.py"], cwd: "." };
  const approved = await reviewSetupRecipe(directory, input);
  fs.writeFileSync(path.join(directory, "scripts/json.py"), 'open("injected", "w").write("wrong")\n');
  expect((await reviewSetupRecipe(directory, input)).hash).toBe(approved.hash);
  const result = await executeSandboxRecipe(directory, approved, "restricted");
  if (requireExecution(result)) expect(result.stdout.trim()).toBe("reviewed 1");
  expect(fs.existsSync(path.join(directory, "injected"))).toBe(false);
});

test.skipIf(process.platform !== "linux")("Bun ignores checkout preload config added after approval", async () => {
  const directory = fs.mkdtempSync(path.join(root, "bun-"));
  fs.writeFileSync(path.join(directory, "setup.ts"), 'if (process.env.SETUP_DOTENV) throw new Error("unreviewed environment"); console.log("reviewed")');
  const input = { command: ["bun", "setup.ts"], cwd: "." };
  const approved = await reviewSetupRecipe(directory, input);
  fs.writeFileSync(path.join(directory, "bunfig.toml"), 'preload=["./evil.ts"]');
  fs.writeFileSync(path.join(directory, ".env"), "SETUP_DOTENV=1\n");
  fs.writeFileSync(path.join(directory, "evil.ts"), 'await Bun.write("injected", "wrong"); console.log("preloaded")');
  expect((await reviewSetupRecipe(directory, input)).hash).toBe(approved.hash);
  const result = await executeSandboxRecipe(directory, approved, "restricted");
  if (requireExecution(result)) expect(result.stdout.trim()).toBe("reviewed");
  expect(fs.existsSync(path.join(directory, "injected"))).toBe(false);
});

for (const mode of ["paths", "jsx"] as const) {
  test.skipIf(process.platform !== "linux")(`Bun ignores compiler configuration added after approval (${mode})`, async () => {
    const directory = fs.mkdtempSync(path.join(root, `bun-${mode}-`));
    const script = mode === "paths" ? "setup.ts" : "setup.tsx";
    fs.writeFileSync(path.join(directory, script), mode === "paths"
      ? 'import { value } from "fixture"; console.log(value)'
      : 'console.log((<div />).type)');
    const pkg = path.join(directory, "node_modules", mode === "paths" ? "fixture" : "react");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify(mode === "paths"
      ? { name: "fixture", main: "index.ts" }
      : { name: "react", exports: { "./jsx-runtime": "./jsx-runtime.ts", "./jsx-dev-runtime": "./jsx-runtime.ts" } }));
    fs.writeFileSync(path.join(pkg, mode === "paths" ? "index.ts" : "jsx-runtime.ts"), mode === "paths"
      ? 'export const value="reviewed"'
      : 'export const jsx=(type)=>({type}); export const jsxs=jsx; export const jsxDEV=jsx;');
    const input = { command: ["bun", script], cwd: "." };
    const approved = await reviewSetupRecipe(directory, input);
    fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: mode === "paths"
      ? { baseUrl: ".", paths: { fixture: ["./evil.ts"] } } : { jsxImportSource: "./evil" } }));
    if (mode === "paths") fs.writeFileSync(path.join(directory, "evil.ts"), 'await Bun.write("injected","wrong"); export const value="unreviewed"');
    else {
      fs.mkdirSync(path.join(directory, "evil"));
      const source = 'export const jsx=()=>{require("node:fs").writeFileSync("injected","wrong");return {type:"unreviewed"}}; export const jsxs=jsx; export const jsxDEV=jsx;';
      for (const name of ["jsx-runtime.ts", "jsx-dev-runtime.ts"]) fs.writeFileSync(path.join(directory, "evil", name), source);
    }
    expect((await reviewSetupRecipe(directory, input)).hash).toBe(approved.hash);
    const result = await executeSandboxRecipe(directory, approved, "restricted");
    if (requireExecution(result)) expect(result.stdout.trim()).toBe(mode === "paths" ? "reviewed" : "div");
    expect(fs.existsSync(path.join(directory, "injected"))).toBe(false);
  });
}

test.skipIf(process.platform !== "linux")("Bun executes a reviewed file whose name is a native command", async () => {
  const directory = fs.mkdtempSync(path.join(root, "bun-dispatch-"));
  fs.writeFileSync(path.join(directory, "test"), 'console.log("reviewed")');
  const input = { command: ["bun", "test"], cwd: "." };
  const approved = await reviewSetupRecipe(directory, input);
  fs.writeFileSync(path.join(directory, "evil.test.ts"), 'import {test} from "bun:test"; test("fixture",()=>{require("node:fs").writeFileSync("injected","wrong")});');
  expect((await reviewSetupRecipe(directory, input)).hash).toBe(approved.hash);
  const result = await executeSandboxRecipe(directory, approved, "restricted");
  if (requireExecution(result)) expect(result.stdout.trim()).toBe("reviewed");
  expect(fs.existsSync(path.join(directory, "injected"))).toBe(false);
});

test.skipIf(process.platform !== "linux")("frozen Bun installation retains its package-manager dispatch", async () => {
  const directory = fs.mkdtempSync(path.join(root, "bun-install-"));
  const manifest = { name: "setup-fixture", version: "0.0.0", scripts: { postinstall: "printf reviewed > installed" } };
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
  // Bun removes empty generated locks; seed the reviewed frozen input directly.
  fs.writeFileSync(path.join(directory, "bun.lock"), JSON.stringify({ lockfileVersion: 1, configVersion: 1,
    workspaces: { "": { name: manifest.name } }, packages: {} }));
  expect(fs.existsSync(path.join(directory, "installed"))).toBe(false);
  const approved = await reviewSetupRecipe(directory, { command: ["bun", "install", "--frozen-lockfile"], cwd: "." });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ ...manifest, scripts: { postinstall: "printf unreviewed > injected" } }));
  const result = await executeSandboxRecipe(directory, approved, "restricted");
  if (requireExecution(result)) expect(fs.readFileSync(path.join(directory, "installed"), "utf8")).toBe("reviewed");
  expect(fs.existsSync(path.join(directory, "injected"))).toBe(false);
});

test.skipIf(process.platform !== "linux")("restricted setup cannot reach an owned loopback listener while full setup can", async () => {
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.end("owned"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as net.AddressInfo).port;
    const directory = fs.mkdtempSync(path.join(root, "network-"));
    fs.writeFileSync(path.join(directory, "setup.py"), `import socket\ntry:\n s=socket.create_connection(("127.0.0.1", ${port}), timeout=1)\n print(s.recv(32).decode())\n s.close()\nexcept OSError:\n print("isolated")\n`);
    const recipe = await reviewSetupRecipe(directory, { command: ["python3", "setup.py"], cwd: "." });
    const restricted = await executeSandboxRecipe(directory, recipe, "restricted");
    if (!requireExecution(restricted)) return;
    expect(restricted.stdout.trim()).toBe("isolated"); expect(connections).toBe(0);
    const full = await executeSandboxRecipe(directory, recipe, "full");
    expect(full.code).toBe(0); expect(full.stdout.trim()).toBe("owned"); expect(connections).toBe(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test.skipIf(process.platform !== "linux")("setup launches through the memory cell with the work CPU plan", async () => {
  const directory = fs.mkdtempSync(path.join(root, "scope-"));
  fs.writeFileSync(path.join(directory, "setup.sh"), "printf scoped");
  const recipe = await reviewSetupRecipe(directory, { command: ["sh", "setup.sh"], cwd: "." });
  const cpu: AgentCpuPlan = { workload: "work", slice: "delegatus-agents-work.slice", weight: 100, quotaPercent: 300, periodMs: 20, systemdVersion: 255 };
  const original = AgentMemoryCell.prototype.wrapSpawn;
  let wrapped = 0, launched = 0;
  // Keep real process and sandbox coverage while observing the cell boundary.
  // Scope command generation is covered by agentMemory's own tests.
  AgentMemoryCell.prototype.wrapSpawn = function(base) {
    wrapped++; expect(this.plan.mechanism).toBe("scope"); expect(this.plan.cpu).toBe(cpu); expect(this.plan.limitBytes).toBe(512 * 1024 * 1024);
    return (command, args, options) => { launched++; return base!(command, args, options); };
  };
  try {
    const result = await runSetupRecipe(directory, recipe, "restricted", undefined, undefined, {
      planCpu: workload => { expect(workload).toBe("work"); return cpu; },
      planMemory: input => {
        expect(input.cpu).toBe(cpu); expect(input.engine).toBe("setup"); expect(input.sessionKey).toBe(directory);
        return { mechanism: "scope", mode: "scope", platform: "linux", limitBytes: 512 * 1024 * 1024, budgetBytes: 1024 ** 3,
          reserveBytes: 0, totalBytes: 2 * 1024 ** 3, score: 500, unit: "setup-fixture.scope", slice: "delegatus-agents.slice", viewerUnit: null, systemdVersion: 255, cpu: input.cpu };
      },
    });
    expect(wrapped).toBe(1); expect(launched).toBe(1);
    if (requireExecution(result)) expect(result.stdout).toBe("scoped");
  } finally { AgentMemoryCell.prototype.wrapSpawn = original; }
});

test.skipIf(process.platform !== "linux")("node is resolved from PATH including system locations outside usr bin", async () => {
  const directory = fs.mkdtempSync(path.join(root, "node-"));
  fs.writeFileSync(path.join(directory, "setup.js"), 'console.log("resolved node")');
  let recipe;
  try { recipe = await reviewSetupRecipe(directory, { command: ["node", "setup.js"], cwd: "." }); }
  catch (error) { expect(String(error)).toContain("setup interpreter is unavailable"); return; }
  const result = await executeSandboxRecipe(directory, recipe, "restricted");
  expect(result.stderr).not.toContain("Can't find source path");
  if (requireExecution(result)) expect(result.stdout.trim()).toBe("resolved node");
});

test.skipIf(process.platform !== "linux")("missing Bubblewrap refuses before repository effects across Python diagnostics", async () => {
  const directory = fs.mkdtempSync(path.join(root, "missing-isolation-"));
  const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
  for (const name of ["sh", "python3"]) fs.symlinkSync(await setupInterpreter(name), path.join(bin, name));
  fs.writeFileSync(path.join(directory, "setup.sh"), "printf wrong > unexpected-effect");
  const recipe = await reviewSetupRecipe(directory, { command: ["sh", "setup.sh"], cwd: "." });
  const prior = process.env.PATH;
  process.env.PATH = bin;
  try {
    const result = await executeSandboxRecipe(directory, recipe, "restricted");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(isolationRefusal);
    expect(fs.existsSync(path.join(directory, "unexpected-effect"))).toBe(false);
  } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; }
});

test.skipIf(process.platform !== "linux")("memory admission refusal prevents setup effects", async () => {
  const directory = fs.mkdtempSync(path.join(root, "memory-refusal-"));
  fs.writeFileSync(path.join(directory, "setup.sh"), "printf wrong > unexpected-effect");
  const recipe = await reviewSetupRecipe(directory, { command: ["sh", "setup.sh"], cwd: "." });
  await expect(runSetupRecipe(directory, recipe, "restricted", undefined, undefined, {
    planCpu: () => null,
    planMemory: () => { throw new Error("fixture memory admission refused"); },
  })).rejects.toThrow("fixture memory admission refused");
  expect(fs.existsSync(path.join(directory, "unexpected-effect"))).toBe(false);
});
