import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { SUPPORTED_CODEX_VERSIONS } from "../src/lib/accounts/codexVersions";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { installedGateAdmissionEnv } from "../src/lib/runtime/agentSignalSandbox";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, nativeFixture, touchedChecks, commitFixtureInputs } = createPublicationFixtures(root, roots);

nativeTest.each(["Codex", "Bun and Codex"])("cold %s cache produces evidence once and warm preparation reuses it", tools => {
  const coldBun = tools === "Bun and Codex";
  const f = nativeFixture(coldBun);
  f.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  expect(fs.existsSync(f.codex)).toBeFalse();
  const cold = f.run(true);
  expect(cold.status, cold.stderr).toBe(0);
  expect(readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env)).inputs).toMatch(/^[a-f0-9]{64}$/);
  expect(touchedChecks(f)).toHaveLength(1);
  const installations = () => f.calls().filter(call => call.args[0] === "native-install").map(call => call.args[2]);
  const expected = [...(coldBun ? ["bun@0.0.2"] : []), ...SUPPORTED_CODEX_VERSIONS.map(version => `@openai/codex@${version}`)];
  expect(installations()).toEqual(expected);
  for (const call of f.calls().filter(call => call.args[0] === "native-install")) {
    expect(call.names).toContain("LLV_DOCKER_NSENTER_SHIMS");
    expect(call.home).toBeDefined();
    expect(path.isAbsolute(call.home ?? "")).toBeTrue();
    expect(call.home).not.toBe(f.env.HOME);
  }
  expect(f.run(false).status).toBe(0);
  f.env.LLV_GATE_PUBLICATION_ID = "warm-native-cache";
  const warm = f.run(true);
  expect(warm.status, warm.stderr).toBe(0);
  expect(touchedChecks(f)).toHaveLength(1);
  expect(installations()).toEqual(expected);
  const before = f.calls().length;
  expect(f.run(false).status).toBe(0);
  expect(f.calls().slice(before).map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
}, 120_000);

nativeTest.each(["install failure", "deadline", "custody", "during checks", "after checks"])("native preparation retains refusal on %s", change => {
  const f = nativeFixture();
  if (change === "install failure") f.env.HOOK_FAIL = "native-install";
  if (change === "deadline") f.env.LLV_GATE_PUSH_DEADLINE = "1";
  if (change === "custody") delete f.env.LLV_GATE_PUBLICATION_FENCE;
  if (change === "during checks") {
    fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "scripts/local-gate-tests.ts") require("node:fs").appendFileSync(${JSON.stringify(f.codex)}, "# changed tool\\n");\n`);
    f.git("-c", "core.hooksPath=/dev/null", "add", "record.ts");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "tool drift fixture");
    f.head = f.git("rev-parse", "HEAD").toString().trim(); f.env.LLV_GATE_PUSH_HEAD = f.head;
  }
  const prepared = f.run(true);
  if (change === "after checks") {
    expect(prepared.status, prepared.stderr).toBe(0);
    fs.appendFileSync(f.codex, "# changed tool\n");
    const before = f.calls().length;
    const refused = f.run(false);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("publication check inputs changed");
    expect(f.calls()).toHaveLength(before);
  } else {
    expect(prepared.status).not.toBe(0);
    if (change === "during checks") expect(prepared.stderr).toContain("publication inputs changed during checks");
    else expect(f.calls().filter(call => call.args[0] === "scripts/local-gate-tests.ts")).toHaveLength(0);
    if (change === "custody") expect(f.calls().filter(call => call.args[0] === "native-install")).toHaveLength(0);
    if (change === "deadline") expect(prepared.status).toBe(75);
    expect(fs.existsSync(f.receipt)).toBeFalse();
  }
}, 90_000);

test("a Cloud verdict does not require unused local native installations", () => {
  const f = nativeFixture();
  f.env.LLV_GATE_EXECUTION = "cloud";
  f.env.HOOK_FAIL = "native-install";
  // Cloud receives scalar fixture inputs; the local recorder stays private.
  f.env.LLV_GATE_CHECK_ENV = "HOOK_FAIL";
  delete f.env.LLV_GATE_BUN;
  delete f.env.CHROME_BIN;
  delete f.env.PLAYWRIGHT_BROWSERS_PATH;
  f.env.NODE_OPTIONS = "--max-old-space-size=1024";
  f.env.SHELL = "/bin/sh";
  for (const name of Object.keys(f.env)) if (/^(?:BUN_|GIT_CONFIG_)/.test(name)) delete f.env[name];
  // Only the account/transport seams are controlled in this fresh CLI process.
  // The production Cloud verifier still binds its returned verdict to the job.
  const preload = path.join(f.dir, ".git", "cloud-verdict.ts");
  fs.writeFileSync(preload, `import { mock } from "bun:test";
    const cloud = await import(${JSON.stringify(path.join(root, "scripts/cloud-checks.ts"))});
    mock.module(${JSON.stringify(path.join(root, "scripts/cloud-check-config.ts"))}, () => ({ cloudCheckConfig: async () => ({}) }));
    mock.module(${JSON.stringify(path.join(root, "scripts/cloud-checks.ts"))}, () => ({ ...cloud, AppServerCloudTransport: class {
      async run(job) { return { kind: "verdict", head: job.head, tree: job.tree, base: job.base, inputs: cloud.cloudInputDigest(job.inputs), code: 0 }; }
    } }));`);
  const result = spawnSync(process.execPath, ["--preload", preload, "scripts/local-gate.ts", "pre-push", "--publication-prepare"], {
    cwd: f.dir, env: f.env, encoding: "utf8", timeout: 45_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("pre-push: Cloud checks");
  expect(readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env)).inputs).toMatch(/^[a-f0-9]{64}$/);
  expect(fs.existsSync(f.codex)).toBeFalse();
  expect(touchedChecks(f)).toHaveLength(0);
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
}, 60_000);

test.skipIf(process.platform !== "linux").each(["verdict", "fallback"])("image admission keeps Cloud inputs portable and checks intact (%s)", mode => {
  const f = fixture();
  const localBun = f.writablePath(".git/bun-container"), localCalls = f.writablePath(".git/local-admission");
  fs.writeFileSync(localBun, `#!/bin/bash\nprintf '%s\\n' "\$*" >> ${JSON.stringify(localCalls)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o700 });
  delete f.env.LLV_GATE_BUN;
  Object.assign(f.env, installedGateAdmissionEnv(f.env, localBun));
  expect(f.env.LLV_GATE_BUN).toBeDefined();
  f.env.LLV_GATE_EXECUTION = "cloud";
  f.env.LLV_GATE_CHECK_ENV = "HOOK_LOG,HOOK_RECORD,HOOK_REAL_LINT";
  f.env.HOOK_LOG = ".git/commands.jsonl";
  f.env.HOOK_RECORD = "record.ts";
  f.env.SHELL = "/bin/sh";
  delete f.env.CHROME_BIN;
  delete f.env.PLAYWRIGHT_BROWSERS_PATH;
  for (const name of Object.keys(f.env)) if (/^(?:BUN_|GIT_CONFIG_)/.test(name)) delete f.env[name];
  for (const name of ["bun", "bunx"]) {
    const shim = f.writablePath(`shims/${name}`);
    fs.writeFileSync(shim, fs.readFileSync(shim, "utf8").replaceAll('"$HOOK_BUN"', JSON.stringify(process.execPath)));
  }
  commitFixtureInputs(f);
  const dispatches = f.writablePath(".git/dispatches.jsonl");
  const preload = f.writablePath(".git/cloud-image.ts");
  fs.writeFileSync(preload, `import { mock } from "bun:test";
    import { appendFileSync } from "node:fs";
    const cloud = await import(${JSON.stringify(path.join(root, "scripts/cloud-checks.ts"))});
    mock.module(${JSON.stringify(path.join(root, "scripts/cloud-check-config.ts"))}, () => ({ cloudCheckConfig: async () => ({}) }));
    mock.module(${JSON.stringify(path.join(root, "scripts/cloud-checks.ts"))}, () => ({ ...cloud, AppServerCloudTransport: class {
      async run(job) {
        const command = cloud.cloudCommand(job);
        appendFileSync(${JSON.stringify(dispatches)}, JSON.stringify({ head: job.head, inputs: job.inputs,
          runsChecks: command.includes("bun scripts/local-gate.ts pre-push --admitted") }) + "\\n");
        return ${mode === "fallback" ? '{ kind: "unavailable" }' : '{ kind: "verdict", head: job.head, tree: job.tree, base: job.base, inputs: cloud.cloudInputDigest(job.inputs), code: 0 }'};
      }
    } }));`);
  const result = spawnSync(process.execPath, ["--preload", preload, "scripts/local-gate.ts", "pre-push", "--publication-prepare"], {
    cwd: f.dir, env: f.env, encoding: "utf8", timeout: 45_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const jobs = fs.readFileSync(dispatches, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(jobs).toHaveLength(mode === "fallback" ? 2 : 1);
  for (const job of jobs) {
    expect(job).toMatchObject({ head: f.head, inputs: { HOOK_RECORD: "record.ts" }, runsChecks: true });
    expect(job.inputs).not.toHaveProperty("LLV_GATE_BUN");
  }
  const calls = f.calls().map(call => call.args[0]).sort();
  expect(calls).toEqual(mode === "fallback"
    ? ["scripts/eslint-changes.ts", "scripts/local-gate-tests.ts", "scripts/privacy-publication-gate.ts", "tsc"]
    : ["scripts/privacy-publication-gate.ts"]);
  if (mode === "fallback") expect(fs.readFileSync(localCalls, "utf8")).toContain("cpu-admission.ts --claim");
  expect(readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env)).checksMs).toEqual(expect.any(Number));
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
  expect(f.calls().at(-1)?.args[0]).toBe("scripts/privacy-publication-gate.ts");
  expect(f.calls()).toHaveLength(calls.length + 1);
}, 60_000);
