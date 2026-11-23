import "./engineEnvironment.fixture";
import { expect, test, fs, path, realExec, savePipelines } from "./engine.fixture";

import { detachedAttemptFixture } from "./engine.attemptGit.fixture";

test.each([256, 257])("attempt Git custody accepts every proved suffix commit (%i)", async (count) => {
  const f = await detachedAttemptFixture(`attempt-git-bound-${count}`);
  try {
    // Import the empty changes in one Git invocation. Each commit still gets
    // its native post-applypatch receipt before the real pre-push guard runs.
    const mailbox = path.join(f.root, "changes.mbox");
    const author = `${f.env.GIT_AUTHOR_NAME} <${f.env.GIT_AUTHOR_EMAIL}>`;
    const date = new Date(f.env.GIT_AUTHOR_DATE!).toUTCString();
    fs.writeFileSync(mailbox, Array.from({ length: count }, (_, n) => [
      `From ${f.base} Mon Sep 17 00:00:00 2001`,
      `From: ${author}`,
      `Date: ${date}`,
      `Subject: [PATCH] attempt change ${n}`,
      "",
      "",
    ].join("\n")).join("\n"));
    await f.run("am", "--empty=keep", "--quiet", mailbox);
    expect(await f.run("rev-list", "--count", `${f.base}..HEAD`)).toBe(String(count));
    const fixed = await f.run("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const settled = await f.finish();
    expect(settled.lastPassedCommit).toBe(fixed);
    expect(settled.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 120_000);
