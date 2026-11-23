import { expect, test, fixture } from "./stageAttemptPush.fixture";

test("B: every commit remains provable beyond the former 256 limit", async () => {
  const f = await fixture();
  try {
    const base = f.pipeline.baseRef;
    const count = 260;
    const stream = Array.from({ length: count - 1 }, (_, index) => {
      const message = `own ${index}`;
      return [
        `commit refs/heads/${f.pipeline.branch}`,
        `committer Fixture <noreply@example.invalid> ${Date.parse(f.env.GIT_COMMITTER_DATE!) / 1000} +0000`,
        `data ${Buffer.byteLength(message)}`,
        message,
        ...(index === 0 ? [`from ${base}`] : []),
        "",
      ].join("\n");
    }).join("\n");
    const imported = Bun.spawnSync(["git", "fast-import", "--quiet", "--done"], {
      cwd: f.lane, env: f.env, stdin: Buffer.from(`${stream}\ndone\n`), timeout: 15_000,
    });
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    // One ordinary commit still writes a native receipt. Seed the imported
    // prefix with the same on-disk evidence to exercise settlement's paging.
    const head = await f.commit("own final");
    const commits = (await f.own("rev-list", "--reverse", `${base}..${head}`)).split("\n");
    expect(commits).toHaveLength(count);
    const [oldest, ...rest] = commits;
    for (const sha of rest.slice(0, -1)) {
      await fs.writeFile(path.join(f.receipt, "commits", sha), "", { flag: "wx" });
    }
    await f.push();
    expect(await f.settle()).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${oldest} was not created`) });
    await fs.writeFile(path.join(f.receipt, "commits", oldest!), "", { flag: "wx" });
    expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
}, 60000);
