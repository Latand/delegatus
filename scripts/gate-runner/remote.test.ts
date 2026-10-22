// End-to-end runs of scripts/gate-slot.sh through the gate runner client
// against a stub runner (harness.fixture.ts): the remote command really runs,
// under a temporary runner home, through the real serve.ts.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { reviewExport } from "../review-export";
import { cleanGitEnv, git, makeHarness, privateValue, testFile, withoutRunnerLines, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(options?: Parameters<typeof makeHarness>[0]): Harness { const h = makeHarness(options); harnesses.push(h); return h; }
// Timings and the local CPU queue's waiting lines differ between any two runs.
const normalized = (text: string) => withoutRunnerLines(text).replace(/\[[\d.]+m?s\]/g, "[t]").replace(/^bun test v.*$/m, "").replace(/^gate-slot: Waiting for the CPU queue.*\n/gm, "");
const remoteRuns = (h: Harness) => h.calls().filter(call => call.command.includes("serve.ts run"));
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;

function treeHashes(root: string, skip: (relative: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (skip(relative)) continue;
      if (entry.isDirectory()) walk(full);
      else out[relative] = entry.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : createHash("sha1").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

// T1
test.if(linux)("without a configured runner nothing is contacted and the command runs as today", () => {
  const h = harness();
  const file = testFile(h, "plain.test.ts", `test("one", () => expect(1).toBe(1));`);
  const unconfigured = h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER_CONFIG: path.join(h.root, "absent.json") }) });
  const today = h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER: "off" }) });
  expect(h.calls()).toEqual([]);
  expect(unconfigured.code).toBe(0);
  expect(unconfigured.stderr).not.toContain("gate-runner:");
  expect(normalized(unconfigured.stdout + unconfigured.stderr)).toBe(normalized(today.stdout + today.stderr));
});

// T2
test.if(linux)("off, a test run, an ineligible shape, an isolated check and an outside path never contact the runner", () => {
  const h = harness();
  const file = testFile(h, "plain.test.ts", `test("one", () => expect(1).toBe(1));`);
  expect(h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER: "off" }) }).code).toBe(0);
  expect(h.run(["bun", "test", file], { env: h.env({ NODE_ENV: "test" }) }).code).toBe(0);
  expect(h.run(["/bin/true"]).code).toBe(0);
  expect(h.run(["bun", "--version"]).code).toBe(0);
  // T21, second half: an absolute path outside the tree keeps the command here.
  const outside = path.join(h.root, "outside.test.ts");
  fs.writeFileSync(outside, `import { test } from "bun:test"; test("x", () => {});`);
  expect(h.run(["bun", "test", outside]).code).toBe(0);
  expect(h.calls()).toEqual([]);
  const log = fs.readFileSync(path.join(h.cache, "runner-decisions.log"), "utf8");
  expect(log).toContain("\tineligible\tnot a command shape the runner takes\t");
  expect(log).toContain("\tineligible\tan argument names a path outside the checkout\t");
});

// T3 and T21
test.if(linux)("a passing and a failing test file give the same verdict and output remotely as here, once", () => {
  const h = harness();
  const pass = testFile(h, "pass.test.ts", `test("adds", () => { console.log("visible"); expect(1 + 1).toBe(2); });`);
  const fail = testFile(h, "fail.test.ts", `test("breaks", () => { expect(1 + 1).toBe(3); });`);
  for (const file of [pass, fail]) {
    const remote = h.run(["bun", "test", file]);
    const local = h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER: "off" }) });
    expect(remote.stderr).toMatch(RUNNING);
    expect(remote.code).toBe(local.code);
    // A stack trace names the file where it ran: the runner's copy of the tree.
    const here = (text: string) => normalized(text).replace(new RegExp(`${path.join(h.runnerHome, "runs")}/[0-9a-f]{12}/tree`, "g"), h.fixture);
    expect(here(remote.stdout)).toBe(normalized(local.stdout));
    expect(here(remote.stderr)).toBe(normalized(local.stderr));
  }
  expect(remoteRuns(h)).toHaveLength(2);
  // An absolute in-tree argument names the same file there.
  const absolute = h.run(["bun", "test", path.join(h.fixture, fail.slice(2))]);
  expect(absolute.stderr).toMatch(RUNNING);
  expect(absolute.code).toBe(1);
  expect(absolute.stderr).toContain("(fail) breaks");
  expect(fs.readdirSync(path.join(h.runnerHome, "runs"))).toEqual([]);
});

// T4
// The privacy gate refuses a changed symlink, so the symlink case of T4 is in
// remoteShip.test.ts, which ships without the scan.
test.if(linux)("the runner checks out exactly the working tree, and the local index, refs and objects stay", () => {
  const h = harness();
  const at = (file: string) => path.join(h.fixture, file);
  fs.appendFileSync(at("README.md"), "\nstaged edit\n"); git(h.fixture, "add", "README.md");
  fs.appendFileSync(at("CONTRIBUTING.md"), "\nunstaged edit\n");
  fs.writeFileSync(at("untracked-note.txt"), "new file\n");
  git(h.fixture, "rm", "--quiet", "--cached", "LICENSE"); fs.rmSync(at("LICENSE"));
  fs.chmodSync(at("scripts/review-export.ts"), 0o755);
  const ignoredTracked = git(h.fixture, "ls-files", "-ci", "--exclude-standard").split("\n").filter(Boolean)[0]!;
  expect(ignoredTracked).toBeTruthy();
  const file = testFile(h, "tree.test.ts", `
import fs from "node:fs";
test("tree", () => {
  expect(fs.readFileSync("README.md", "utf8")).toEndWith("staged edit\\n");
  expect(fs.readFileSync("CONTRIBUTING.md", "utf8")).toEndWith("unstaged edit\\n");
  expect(fs.readFileSync("untracked-note.txt", "utf8")).toBe("new file\\n");
  expect(fs.existsSync("LICENSE")).toBe(false);
  expect(fs.statSync("scripts/review-export.ts").mode & 0o111).toBe(0o111);
  expect(fs.existsSync(${JSON.stringify(ignoredTracked)})).toBe(true);
});`);
  const indexFile = path.join(h.fixture, ".git", "index");
  const indexBefore = fs.readFileSync(indexFile), refsBefore = git(h.fixture, "for-each-ref");
  const loose = () => git(h.fixture, "count-objects").split(" ")[0];
  // The tree the hook would judge, computed independently.
  const scratchIndex = path.join(h.root, "expected-index");
  fs.copyFileSync(indexFile, scratchIndex);
  const expectedEnv = cleanGitEnv({ GIT_INDEX_FILE: scratchIndex });
  spawnSync("git", ["add", "-A"], { cwd: h.fixture, env: expectedEnv });
  const expected = spawnSync("git", ["write-tree"], { cwd: h.fixture, env: expectedEnv, encoding: "utf8" }).stdout.trim();
  fs.rmSync(scratchIndex);
  // Counted after the independent computation above, which stores its blobs.
  const looseBefore = loose();
  const result = h.run(["bun", "test", file]);
  expect(result.stderr).toContain(`tree ${expected.slice(0, 12)})`);
  expect(result.code).toBe(0);
  expect(fs.readFileSync(indexFile).equals(indexBefore)).toBeTrue();
  expect(git(h.fixture, "for-each-ref")).toBe(refsBefore);
  expect(loose()).toBe(looseBefore);
});

// T5
test.if(linux)("a mirror behind or ahead of the local origin/main still verifies the bundle", () => {
  for (const mirrorMain of ["behind", "ahead"] as const) {
    const h = harness({ mirrorMain });
    const file = testFile(h, "pass.test.ts", `test("one", () => expect(1).toBe(1));`);
    const result = h.run(["bun", "test", file]);
    expect(result.stderr).toMatch(RUNNING);
    expect(result.code).toBe(0);
  }
});

// T9
test.if(linux)("a tree that changes on the runner after install starts nothing there and runs here", () => {
  const h = harness();
  h.settings({ remoteEnv: { LLV_GATE_RUNNER_TEST_AFTER_INSTALL: "echo changed >> README.md" } });
  const file = testFile(h, "where.test.ts", `test("where", () => console.log("cwd=" + process.cwd()));`);
  const result = h.run(["bun", "test", file]);
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/^gate-runner: running here: tree check failed: the runner checked out tree [0-9a-f]{40} for [0-9a-f]{40}$/m);
  expect(result.stderr).not.toMatch(RUNNING);
  expect(result.stdout).toContain(`cwd=${h.fixture}`);
  expect(result.stdout).not.toContain("/runner/runs/");
});

// T12
test.if(linux)("secrets stay here, driver switches travel, and the push deadline keeps its remaining budget", () => {
  const h = harness();
  const known = path.join(h.root, "known-values.txt");
  fs.writeFileSync(known, `${privateValue()}\n`);
  const file = testFile(h, "env.test.ts", `test("env", () => console.log("ENV " + JSON.stringify(process.env)));`);
  const deadline = Date.now() + 600_000;
  const result = h.run(["bun", "test", file], { env: h.env({
    GH_TOKEN: "gh-secret", LLV_TOKEN: "llv-secret", LLV_PRIVACY_KNOWN_VALUES_FILE: known, OPENROUTER_API_KEY: "or-secret",
    LLV_KANBAN_BROWSER_TEST: "1", LLV_GATE_PUSH_DEADLINE: String(deadline),
  }) });
  expect(result.stderr).toMatch(RUNNING);
  const remote = JSON.parse(/^ENV (.*)$/m.exec(result.stdout)![1]!) as Record<string, string>;
  const seen = JSON.stringify(remote);
  for (const secret of ["gh-secret", "llv-secret", "or-secret", known, h.root + "/home"]) expect(seen).not.toContain(secret);
  expect(remote.GH_TOKEN).toBeUndefined();
  expect(remote.LLV_PRIVACY_KNOWN_VALUES_FILE).toBeUndefined();
  expect(remote.LLV_KANBAN_BROWSER_TEST).toBe("1");
  expect(remote.HOME).toStartWith(path.join(h.runnerHome, "runs"));
  expect(Math.abs(Number(remote.LLV_GATE_PUSH_DEADLINE) - deadline)).toBeLessThan(2_000);
});

// T15
test.if(linux)("a tree holding a known private value is never uploaded and runs here", () => {
  const h = harness();
  const known = path.join(h.root, "known-values.txt");
  const value = privateValue();
  fs.writeFileSync(known, `${value}\n`);
  fs.writeFileSync(path.join(h.fixture, "leak.txt"), `text with ${value} inside\n`);
  const file = testFile(h, "pass.test.ts", `test("one", () => expect(1).toBe(1));`);
  const result = h.run(["bun", "test", file], { env: h.env({ LLV_PRIVACY_KNOWN_VALUES_FILE: known }) });
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/^gate-runner: running here: the privacy scan refused the tree: /m);
  expect(h.calls().filter(call => !call.command.includes("manager=ok"))).toEqual([]);
});

// T19
test.if(linux)("a review export runs remotely through its record; a copy without one stays here", () => {
  const h = harness();
  const scratchDir = path.join(h.root, "exports");
  fs.mkdirSync(scratchDir);
  const exported = reviewExport(h.fixture, h.head, scratchDir);
  const at = (file: string) => path.join(exported.directory, file);
  const before = treeHashes(path.dirname(exported.directory));
  fs.appendFileSync(at("README.md"), "\nedited in the export\n");
  fs.rmSync(at("LICENSE"));
  fs.mkdirSync(at("gate-runner-fixture"));
  fs.writeFileSync(at("gate-runner-fixture/export.test.ts"), `import { test, expect } from "bun:test";
import fs from "node:fs";
test("export tree", () => {
  expect(fs.readFileSync("README.md", "utf8")).toEndWith("edited in the export\\n");
  expect(fs.existsSync("LICENSE")).toBe(false);
  expect(fs.existsSync(".git")).toBe(false);
  expect(fs.existsSync(".artifacts/form-draft-brief.md")).toBe(true);
});`);
  const edited = treeHashes(path.dirname(exported.directory));
  const result = h.run(["bun", "test", "./gate-runner-fixture/export.test.ts"], { cwd: exported.directory });
  expect(result.stderr).toMatch(RUNNING);
  expect(result.code).toBe(0);
  const local = h.run(["bun", "test", "./gate-runner-fixture/export.test.ts"], { cwd: exported.directory, env: h.env({ LLV_GATE_RUNNER: "off" }) });
  expect(local.code).toBe(0);
  expect(normalized(result.stderr)).toBe(normalized(local.stderr));
  expect(treeHashes(path.dirname(exported.directory))).toEqual(edited);
  expect(Object.keys(before)).toContain("export.json");
  // A copy of the same files without the record never contacts the runner.
  const copy = path.join(h.root, "copy");
  fs.cpSync(exported.directory, copy, { recursive: true, verbatimSymlinks: true });
  const calls = h.calls().length;
  expect(h.run(["bun", "test", "./gate-runner-fixture/export.test.ts"], { cwd: copy }).code).toBe(0);
  expect(h.calls()).toHaveLength(calls);
  expect(fs.readFileSync(path.join(h.cache, "runner-decisions.log"), "utf8")).toContain("\tineligible\ta copy without git metadata or an export record\t");
});
