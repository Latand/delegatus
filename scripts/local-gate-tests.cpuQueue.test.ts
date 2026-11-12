import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gateTemporaryRoot, isolatedEnvironment } from "./local-gate";
import { touchedTests } from "./local-gate-tests";
import { CpuAdmissionQueue } from "../src/lib/runtime/cpuAdmission";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(gateTemporaryRoot(), "comparison-cpu-")); directories.push(dir);
  const env = isolatedEnvironment(path.join(dir, "env"), process.env);
  Object.assign(env, { GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_LOCK_DIR: path.join(dir, "locks"), LLV_GATE_POLL_SECONDS: "0.02" });
  mkdirSync(env.LLV_GATE_LOCK_DIR!, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null"); git("remote", "add", "origin", "https://example.invalid/repository.git");
  writeFileSync(path.join(dir, "README.md"), "Fixture baseline\n"); git("add", "README.md"); git("commit", "-m", "baseline");
  return { dir, env, base: git("rev-parse", "HEAD") };
}

test("nested queue waits exceed the old per-file wall cap and leave the next file its execution budget", async () => {
  const f = fixture(), repo = path.resolve(import.meta.dir, "..");
  const source = `import { expect, test } from "bun:test";
import { CpuAdmissionQueue, cpuAdmissionFile, cpuCommandOwner } from ${JSON.stringify(path.join(repo, "src/lib/runtime/cpuAdmission.ts"))};
test("queued heavy command", async () => {
  const queue = new CpuAdmissionQueue(cpuAdmissionFile());
  queue.check("command:predecessor", false, cpuCommandOwner());
  const release = setTimeout(() => queue.cancel("command:predecessor"), 12000);
  try {
    const child = Bun.spawn(["bash", ${JSON.stringify(path.join(repo, "scripts/gate-slot.sh"))}, process.execPath, "-e", ""], { stdout: "ignore", stderr: "inherit" });
    expect(await child.exited).toBe(0);
  } finally { clearTimeout(release); queue.cancel("command:predecessor"); queue.close(); }
}, 30000);`;
  // Fill the head pool so its next file starts after the long admission.
  // Two files start together and cannot detect a lost comparator credit.
  const queued = Array.from({ length: 8 }, (_, index) => `a-${index}.test.ts`);
  for (const file of queued) writeFileSync(path.join(f.dir, file), source);
  const marker = path.join(f.dir, "next-file");
  writeFileSync(path.join(f.dir, "b.test.ts"), `import { test } from "bun:test"; import { writeFileSync } from "node:fs";
test("next file", () => writeFileSync(${JSON.stringify(marker)}, "completed"));`);
  const started = Date.now();
  const result = await touchedTests(f.dir, f.base, [...queued, "b.test.ts"], { env: { ...f.env, LLV_GATE_TEST_WORKERS: "8" }, log: () => {}, budgets: { fileMs: 4000, runMs: 8000 } });
  expect(Date.now() - started).toBeGreaterThan(12000);
  expect(result.introduced).toHaveLength(0);
  expect(readFileSync(marker, "utf8")).toBe("completed");
}, 45000);

test("a touched test cannot leave a synthetic stage head in its outer gate queue", async () => {
  const f = fixture(), repo = path.resolve(import.meta.dir, "..");
  const file = path.join(f.env.LLV_GATE_LOCK_DIR!, "admission.sqlite"), outer = new CpuAdmissionQueue(file);
  try {
    outer.check("stage:outer", false);
    writeFileSync(path.join(f.dir, "example.test.ts"), `import { expect, test } from "bun:test";
import { CpuAdmissionQueue, cpuAdmissionFile } from ${JSON.stringify(path.join(repo, "src/lib/runtime/cpuAdmission.ts"))};
test("synthetic workflow ticket", () => {
  const file = cpuAdmissionFile(), queue = new CpuAdmissionQueue(file);
  try { queue.check("workflow:synthetic", false); expect(file).not.toBe(${JSON.stringify(file)}); }
  finally { queue.close(); }
});`);
    const result = await touchedTests(f.dir, f.base, ["example.test.ts"], { env: f.env, log: () => {} });
    expect(result.introduced).toHaveLength(0);
    expect(outer.check("command:later", false)?.position).toBe(2);
  } finally { outer.close(); }
}, 30000);

test("a touched test still expires when execution spends its budget without a CPU wait", async () => {
  const f = fixture();
  writeFileSync(path.join(f.dir, "example.test.ts"), 'import { test } from "bun:test"; test("execution over budget", async () => { await Bun.sleep(5000); }, 10000);');
  const result = await touchedTests(f.dir, f.base, ["example.test.ts"], { env: f.env, log: () => {}, budgets: { fileMs: 1500, runMs: 4000 } });
  expect(result.introduced).toHaveLength(1);
  expect(result.introduced[0]!.kind).toBe("error");
  expect(result.introduced[0]!.name).toContain("runner did not finish");
}, 15000);

test("the outer execution guard closes a stalled supervisor", async () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), "--budget", "700", process.execPath, "-e", 'process.on("SIGTERM", () => {}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'], { env: f.env, encoding: "utf8" });
  expect(result.status).toBe(124);
  expect(result.stderr).toContain("execution guard expired");
}, 10000);
