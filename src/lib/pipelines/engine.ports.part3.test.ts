import "./engineEnvironment.fixture";
import { expect, test, fs, realExec, savePipelines } from "./engine.fixture";

import { detachedAttemptFixture } from "./engine.attemptGit.fixture";

async function commitAttemptSuffix(f: Awaited<ReturnType<typeof detachedAttemptFixture>>, count: number, env = f.env) {
  // Keep every native Git hook, receipt and commit. One owned child avoids
  // re-entering the command supervisor for each member of the same suffix.
  const script = `for (let index = 0; index < ${count}; index++) {
    const result = Bun.spawnSync({ cmd: ["git", "commit", "--allow-empty", "-m", "attempt change " + index], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) { process.stderr.write(result.stderr); process.exit(result.exitCode || 1); }
  }`;
  return await realExec(process.execPath, ["-e", script], f.detached, env, { timeoutMs: 110_000 });
}

test("a suffix batch retains the native attempt receipt fence", async () => {
  const f = await detachedAttemptFixture("attempt-git-batch-fence");
  try {
    const refused = await commitAttemptSuffix(f, 2, { ...f.env, LLV_STAGE_GIT_RECEIPT: "" });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("stage Git guard");
    expect(await f.run("rev-parse", "HEAD")).toBe(f.base);
    expect(await f.run("rev-list", "--count", `${f.base}..HEAD`)).toBe("0");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});


test.each([256, 257])("attempt Git custody accepts every proved suffix commit (%i)", async (count) => {
  const f = await detachedAttemptFixture(`attempt-git-bound-${count}`);
  try {
    const created = await commitAttemptSuffix(f, count);
    expect(created.code, created.stderr).toBe(0);
    expect(await f.run("rev-list", "--count", `${f.base}..HEAD`)).toBe(String(count));
    const fixed = await f.run("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const settled = await f.finish();
    expect(settled.lastPassedCommit).toBe(fixed);
    expect(settled.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 120_000);
