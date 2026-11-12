import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { endingOf, isolatedEnvironment, NoVerdict, runPushPair, runSteps } from "./local-gate";
import { createHookFixture } from "./local-gate.fixture";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { recordFixtureIdentities, stepRunner, soon } = createGateTestFixtures(roots, owned);
afterEach(async () => {
  for (const identity of owned.splice(0)) await stopFixtureIdentity(identity);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hookFixture(realLint = false, controlledClock = false) {
  return createHookFixture(root, roots, realLint, controlledClock);
}

test.skipIf(process.platform !== "linux")("a real push takes one queue ticket and nested capped steps reuse its slot", () => {
  const f = hookFixture();
  const slot = path.join(f.dir, "scripts/gate-slot.sh");
  writeFileSync(slot, readFileSync(slot, "utf8").replace('queue_key="command:$$:$RANDOM:$RANDOM"', 'queue_key="command:$$:$RANDOM:$RANDOM"\nprintf "%s\\n" "$queue_key" >> "$QUEUE_PROBE"'));
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  const env: NodeJS.ProcessEnv = { ...f.env, DELEGATUS_CPU_PRESSURE: "off", QUEUE_PROBE: path.join(f.dir, "queue-probe") };
  delete env.LLV_GATE_SLOT_LEASE;
  const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(env.QUEUE_PROBE!, "utf8").trim().split("\n")).toHaveLength(1);
  const calls = f.calls();
  expect(calls.some(call => call.args.includes("tsc"))).toBeTrue();
  expect(calls.some(call => call.args.includes("scripts/eslint-changes.ts"))).toBeTrue();
  expect(calls.some(call => call.args.includes("scripts/local-gate-tests.ts"))).toBeTrue();
}, 20_000);

for (const failed of ["privacy", "checks"] as const) test(`publication refuses ${failed} after its peer passes`, async () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  const record = path.join(f.dir, "record.ts");
  const source = readFileSync(record, "utf8");
  writeFileSync(record, source + `
const privacy = process.argv.includes("scripts/privacy-publication-gate.ts");
const selected = ${JSON.stringify(failed)} === "privacy" ? privacy : process.argv.includes("tsc");
if (selected) {
  const until = Date.now() + 10000;
  while (!require("node:fs").existsSync(process.env.PEER_PASSED!)) {
    if (Date.now() > until) throw new Error("peer did not pass");
    await Bun.sleep(10);
  }
  process.exit(19);
}
if (${JSON.stringify(failed)} === "privacy" ? process.argv.includes("scripts/local-gate-tests.ts") : privacy)
  require("node:fs").writeFileSync(process.env.PEER_PASSED!, "passed");
`);
  const passed = path.join(f.dir, "peer-passed");
  const child = Bun.spawn({ cmd: ["bash", ".githooks/pre-push"], cwd: f.dir, env: { ...f.env, PEER_PASSED: passed }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(existsSync(passed)).toBeTrue();
  expect(stdout + stderr).toContain(failed === "privacy" ? "pre-push: bun failed (19); gate failed" : 'pre-push: "types" failed: 19; gate failed');
}, 20000);

test("privacy refusal stops running admitted checks and their detached helper", async () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  const record = path.join(f.dir, "record.ts");
  const observed = path.join(f.dir, "identities-observed");
  writeFileSync(record, readFileSync(record, "utf8") + `
const fs = require("node:fs");
if (process.argv.includes("tsc")) {
  const helper = require("node:child_process").spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  helper.unref();
  fs.writeFileSync(process.env.CHECK_PID!, String(process.pid));
  fs.writeFileSync(process.env.HELPER_PID!, String(helper.pid));
  await Bun.sleep(60000);
}
if (process.argv.includes("scripts/privacy-publication-gate.ts")) {
  while (!fs.existsSync(${JSON.stringify(observed)})) await Bun.sleep(10);
  process.exit(19);
}
`);
  const check = path.join(f.dir, "check.pid"), helper = path.join(f.dir, "helper.pid");
  const child = Bun.spawn({ cmd: ["bash", ".githooks/pre-push"], cwd: f.dir, env: { ...f.env, CHECK_PID: check, HELPER_PID: helper }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let identities: ProcessIdentity[] = [];
  try {
    identities = await recordFixtureIdentities([check, helper]);
  } finally {
    writeFileSync(observed, "observed\n");
    await child.exited;
    await output;
  }
  expect(await child.exited).toBe(1);
  expect((await output).join("")).toContain("pre-push: bun failed (19); gate failed");
  for (const identity of identities) expect(processIdentityStatus(identity)).toBe("dead");
}, 20000);

for (const slow of ["privacy", "checks"] as const) test(`a ${slow} deadline preserves its missing-verdict refusal after its peer passes`, async () => {
  const runner = stepRunner(soon(500), () => ({ slow: "sleep 60", pass: "exit 0" }));
  const missing = slow === "privacy" ? { name: "privacy", command: [] } : { name: "types", command: [] };
  let passed = false;
  const passing = async () => { passed = true; };
  const timed = (cancel: AbortSignal) => runSteps("pre-push", [missing], {
    root, deadline: soon(500), logDir: runner.dir, say: () => {}, cancel,
    prepare: () => ({ command: ["bash", "-c", "sleep 60"], env: process.env }),
  });
  const error = await runPushPair(slow === "privacy" ? timed : passing, slow === "checks" ? timed : passing).then(() => null, (error: unknown) => error);
  expect(passed).toBeTrue();
  expect(error).toBeInstanceOf(NoVerdict);
  expect(endingOf("pre-push", error)).toMatchObject({ code: 75 });
  expect(endingOf("pre-push", error).line).toContain(`"${missing.name}" was still running`);
}, 15000);


test("a deadline-killed gate removes the exact sandbox recorded by its creator", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gate-record-fixture-")); roots.push(directory);
  const env = isolatedEnvironment(directory, process.env);
  delete env.LLV_GATE_SANDBOX_RECORD;
  env.LLV_OWNED_RUN_TIMEOUT_MS = "3000";
  const marker = path.join(directory, "created.json");
  const script = path.join(directory, "allocate.ts");
  writeFileSync(script, `import { createGateSandbox } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
    import fs from "node:fs"; import path from "node:path";
    const directory = createGateSandbox(process.platform, prefix => fs.mkdtempSync(path.join(process.env.TMPDIR!, path.basename(prefix))));
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({directory}));
    setInterval(() => {}, 1000); await new Promise(() => {});`);
  const child = Bun.spawn([process.execPath, path.join(root, "scripts/owned-runner.ts"), "--portable", process.execPath, script],
    { env, stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, error, code }).toMatchObject({ code: 124 });
  const created = JSON.parse(readFileSync(marker, "utf8")).directory;
  expect(existsSync(created)).toBeFalse();
}, 20_000);


test.skipIf(process.platform !== "linux")("the real unadmitted hook owns its sandbox before a deadline", async () => {
  const f = createHookFixture(root, roots);
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts");
  const env = isolatedEnvironment(path.join(f.dir, "isolated"), f.env);
  delete env.LLV_GATE_SANDBOX_RECORD;
  env.LLV_OWNED_RUN_TIMEOUT_MS = "10000";
  const marker = path.join(f.dir, "phase.pid"), allocation = path.join(f.dir, "allocation.json"), recorder = path.join(f.dir, "record.ts");
  const preload = path.join(f.dir, "observe-allocation.ts");
  writeFileSync(preload, `import fs from "node:fs"; import path from "node:path"; import {mock} from "bun:test";
    const allocate=fs.mkdtempSync;
    mock.module("node:fs",()=>({...fs,default:fs,mkdtempSync:(prefix,options)=>{const directory=allocate(prefix,options);
      if(path.basename(String(prefix))==="delegatus-local-gate-") fs.writeFileSync(${JSON.stringify(allocation)},JSON.stringify(directory));
      return directory;}}));`);
  writeFileSync(recorder, readFileSync(recorder, "utf8") + `\n(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {});`);
  const child = Bun.spawn([process.execPath, "--preload", preload, path.join(root, "scripts/local-gate.ts"), "pre-commit"],
    { cwd: f.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  owned.push(captureProcessIdentity(child.pid));
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [phase] = await recordFixtureIdentities([marker], 8000);
    const created = JSON.parse(readFileSync(allocation, "utf8"));
    expect(path.basename(created)).toStartWith("delegatus-local-gate-"); roots.push(created);
    const code = await Promise.race([child.exited, new Promise<number>(resolve => {
      timer = setTimeout(() => { child.kill("SIGTERM"); resolve(143); }, 18000);
    })]);
    await stopFixtureIdentity(phase!);
    const [out, error] = await output;
    expect(code, out + error).not.toBe(0);
    expect(existsSync(created)).toBeFalse();
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}, 35_000);
