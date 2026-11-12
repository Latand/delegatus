import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { nativeFixture, touchedChecks } = createPublicationFixtures(root, roots);

nativeTest.each(["Codex", "Bun and Codex"])("cold %s cache produces evidence once and warm preparation reuses it", tools => {
  const coldBun = tools === "Bun and Codex";
  const f = nativeFixture(coldBun);
  expect(fs.existsSync(f.codex)).toBeFalse();
  const cold = f.run(true);
  expect(cold.status, cold.stderr).toBe(0);
  expect(readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env)).inputs).toMatch(/^[a-f0-9]{64}$/);
  expect(touchedChecks(f)).toHaveLength(1);
  const installations = () => f.calls().filter(call => call.args[0] === "native-install").map(call => call.args[1]);
  expect(installations()).toEqual(coldBun ? ["bun", "codex"] : ["codex"]);
  expect(f.run(false).status).toBe(0);
  f.env.LLV_GATE_PUBLICATION_ID = "warm-native-cache";
  const warm = f.run(true);
  expect(warm.status, warm.stderr).toBe(0);
  expect(touchedChecks(f)).toHaveLength(1);
  expect(installations()).toEqual(coldBun ? ["bun", "codex"] : ["codex"]);
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
