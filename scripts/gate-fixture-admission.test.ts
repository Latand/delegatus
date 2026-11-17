import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHookFixture } from "./local-gate.fixture";
import { fixture as comparisonFixture, source } from "./local-gate-tests.fixture";
import { CheckAdmission, checkAdmissionFile } from "./check-admission";
import { checkEnvironment } from "./gate-cache";
import { pipelinePublicationHookEnv } from "../src/lib/pipelines/git";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";
import { onlineCpuCount } from "../src/lib/runtime/cpuPlacement";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

for (const kind of ["hook", "comparator"] as const) test(`a ${kind} fixture completes while its parent's private admission pool stays saturated`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-admission-")); roots.push(root);
  const parentFile = path.join(root, "parent.sqlite"), parent = new CheckAdmission(parentFile), owner = cpuOwnerIdentity(process.pid);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    expect(parent.claim(owner, 1)).toBe(true);
    const keys = ["LLV_CHECK_ADMISSION_FILE", "LLV_GATE_CHECK_ADMISSION_FILE"] as const;
    const previous = keys.map(key => process.env[key]);
    let f: ReturnType<typeof comparisonFixture> | ReturnType<typeof createHookFixture>;
    try {
      for (const key of keys) process.env[key] = parentFile;
      f = kind === "hook" ? createHookFixture(path.resolve(import.meta.dir, ".."), roots) : comparisonFixture(source(true));
    } finally {
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    }
    const env = checkEnvironment({ ...f.env, ...pipelinePublicationHookEnv(f.env) });
    Object.assign(env, { LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
      DELEGATUS_GATE_CPU_HEADROOM: String(onlineCpuCount() - 1), LLV_OWNED_RUN_TIMEOUT_MS: "20000" });
    const selected = checkAdmissionFile(env);
    // Fail before launching or opening a database when the red control
    // inherits the parent. Every probe remains inside this test's scratch.
    expect(checkAdmissionFile(f.env)).not.toBe(parentFile);
    expect(selected).toBe(checkAdmissionFile(f.env));
    expect(selected.startsWith(f.dir + path.sep)).toBe(true);
    const marker = path.join(root, "executed");
    fs.writeFileSync(path.join(f.dir, "worker.test.ts"), `import { test } from "bun:test"; import fs from "node:fs";
      test("independent fixture", () => fs.writeFileSync(${JSON.stringify(marker)}, "yes"));`);
    child = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), "--portable", process.execPath, "test", "./worker.test.ts"],
      { cwd: f.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout!.on("data", value => output += value); child.stderr!.on("data", value => output += value);
    const closed = once(child, "close");
    expect(await closed, output).toEqual([0, null]);
    expect(fs.readFileSync(marker, "utf8")).toBe("yes");
    expect(parent.db.query("SELECT held FROM checks").all()).toEqual([{ held: 1 }]);
    const own = new CheckAdmission(selected);
    try { expect(own.db.query("SELECT * FROM checks").all()).toEqual([]); } finally { own.close(); }
  } finally { if (child) await stopFixtureProcess(child); parent.cancel(owner); parent.close(); }
}, 30_000);
