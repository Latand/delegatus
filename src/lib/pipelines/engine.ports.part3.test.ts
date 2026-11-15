import "./engineEnvironment.fixture";
import { expect, test, fs, realExec, savePipelines } from "./engine.fixture";

import { detachedAttemptFixture } from "./engine.attemptGit.fixture";

test.each([256, 257])("attempt Git custody accepts every proved suffix commit (%i)", async (count) => {
  const f = await detachedAttemptFixture(`attempt-git-bound-${count}`);
  try {
    for (let n = 0; n < count; n++) await f.run("commit", "--allow-empty", "-m", `attempt change ${n}`);
    const fixed = await f.run("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const settled = await f.finish();
    expect(settled.lastPassedCommit).toBe(fixed);
    expect(settled.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 120_000);
