// Stub-runner runs: the exact working tree and the mirror prerequisites (T4, T5).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanGitEnv, git, makeHarness, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(options?: Parameters<typeof makeHarness>[0]): Harness { const h = makeHarness(options); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;


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
}, E2E_TIMEOUT);

// T5
test.if(linux)("a mirror behind or ahead of the local origin/main still verifies the bundle", () => {
  for (const mirrorMain of ["behind", "ahead"] as const) {
    const h = harness({ mirrorMain });
    const file = testFile(h, "pass.test.ts", `test("one", () => expect(1).toBe(1));`);
    const result = h.run(["bun", "test", file]);
    expect(result.stderr).toMatch(RUNNING);
    expect(result.code).toBe(0);
  }
}, E2E_TIMEOUT);
