import { expect, fixture, path, root, source, spawnSync, test, writeFileSync } from "./local-gate-tests.fixture";

const serviceTest = test.skipIf(process.platform !== "linux"
  || spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status !== 0);
serviceTest.each(["timeout first", "cleanup first", "only timeouts"] as const)("filtered worker refusals survive comparator restarts: %s", mode => {
  const timeout = 'import { test } from "bun:test"; test("contract", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000));';
  const cleanup = `import { test } from "bun:test";
test("contract", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); process.exit(0)'], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  process.exit(0);
});`;
  const f = fixture(source(true));
  const files = ["a.test.ts", "b.test.ts"];
  const cleanupFile = mode === "cleanup first" ? files[0]! : files[1]!;
  for (const file of files) writeFileSync(path.join(f.dir, file), mode !== "only timeouts" && file === cleanupFile ? cleanup : timeout);
  f.git("add", "."); f.git("commit", "-m", "Filtered worker refusal baseline");
  const base = f.git("rev-parse", "HEAD");
  for (const file of files) writeFileSync(path.join(f.dir, file), 'import { test, expect } from "bun:test"; test("contract", () => expect(false).toBe(true));');
  const driver = path.join(f.dir, "driver.ts");
  writeFileSync(driver, `import { touchedTests, comparatorEnding } from ${JSON.stringify(path.join(root, "scripts/local-gate-tests.ts"))};
import { publicationDeadlineOnly } from ${JSON.stringify(path.join(root, "src/lib/pipelines/publication.ts"))};
try { await touchedTests(${JSON.stringify(f.dir)}, ${JSON.stringify(base)}, ${JSON.stringify(files)}, { budgets: { fileMs: 3500, runMs: 60000 } }); }
catch (error) { const ending = comparatorEnding(error); console.log(ending.line); console.log("retryable=" + publicationDeadlineOnly(ending.line)); process.exitCode = ending.code; }`);
  // Restart the real comparator: no in-memory state may conceal a refusal on
  // the next publication attempt. The owned runners reap the fixture children.
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = spawnSync(process.execPath, [driver], { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 30000 });
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(mode === "only timeouts" ? 75 : 1);
    expect(outcome.stdout).toContain(`retryable=${mode === "only timeouts"}`);
    if (mode === "only timeouts") expect(outcome.stdout).toContain("nothing was judged");
    else {
      expect(outcome.stdout).toContain(`baseline: ${cleanupFile}:`);
      expect(outcome.stdout).toContain("owned runner: surviving owned processes:");
      expect(outcome.stdout).toContain("gate error (blocking)");
    }
  }
}, 60000);

serviceTest.each(["head-only cleanup", "pre-existing cleanup", "no cleanup"] as const)("initial refusal precedence survives comparator restarts: %s", mode => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "initial-refusal-runs");
  const scheduled = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const marker = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(run));
test("contract", async () => {
  if (side === "head" && run === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  if (run === 1 && (${JSON.stringify(mode)} === "pre-existing cleanup" || (${JSON.stringify(mode)} === "head-only cleanup" && side === "head"))) {
    const child = Bun.spawn([process.execPath, "-e", 'require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); process.exit(0)'], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
  }
  expect(side === "base" || run > 1).toBe(true);
});`;
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduled);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "Initial refusal baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), `${scheduled}\n// reviewed head`);
  const driver = path.join(f.dir, "driver.ts");
  writeFileSync(driver, `import { touchedTests, comparatorEnding } from ${JSON.stringify(path.join(root, "scripts/local-gate-tests.ts"))};
import { publicationDeadlineOnly } from ${JSON.stringify(path.join(root, "src/lib/pipelines/publication.ts"))};
try { const result = await touchedTests(${JSON.stringify(f.dir)}, ${JSON.stringify(base)}, ["example.test.ts"], { budgets: { fileMs: 2500, runMs: 60000 } }); process.exitCode = result.introduced.length ? 1 : 0; }
catch (error) { const ending = comparatorEnding(error); console.log(ending.line); console.log("retryable=" + publicationDeadlineOnly(ending.line)); process.exitCode = ending.code; }`);
  const invoke = () => spawnSync(process.execPath, [driver], { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 30000 });
  for (let attempt = 0; attempt < 2; attempt++) {
    writeFileSync(marker + "-head", "0"); writeFileSync(marker + "-base", "0");
    const outcome = invoke();
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(mode === "head-only cleanup" ? 1 : 75);
    expect(outcome.stdout).toContain(`retryable=${mode !== "head-only cleanup"}`);
    expect(outcome.stdout).toContain("head rerun: example.test.ts: runner did not finish (124)");
    if (mode === "head-only cleanup") {
      expect(outcome.stdout).toContain("NEW example.test.ts: <ownership error> owned runner: surviving owned processes:");
      expect(outcome.stdout).toContain("gate error (blocking)");
    }
    const next = invoke();
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).toContain("green head; no baseline checkout or sample needed");
  }
}, 60000);
