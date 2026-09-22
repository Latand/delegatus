import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkForUpdate, readRevision, runGit } from "./git";
import { applyCheck, initialCheck } from "./state";

/* A local bare repository stands in for the canonical remote: no network. */
const root = mkdtempSync("/var/tmp/self-update-git-");
const remote = join(root, "remote.git");
const work = join(root, "work");
const checkout = join(root, "checkout");
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit([...identity, ...args], cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function packageJson(version: string): string {
  return `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`;
}

const CHANGELOG_V1 = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] — 2026-09-01\n\n### Added\n\n- First release (#1)\n";
const CHANGELOG_V2 = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A later fix (#5)\n\n## [1.0.1] — 2026-09-02\n\n### Changed\n\n- Second release (#2)\n\n## [1.0.0] — 2026-09-01\n\n### Added\n\n- First release (#1)\n";

let firstSha = "";
let tipSha = "";

beforeAll(async () => {
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(root, "init", "--initial-branch=main", work);
  writeFileSync(join(work, "package.json"), packageJson("1.0.0"));
  writeFileSync(join(work, "CHANGELOG.md"), CHANGELOG_V1);
  await git(work, "add", ".");
  await git(work, "commit", "-m", "Initial release");
  firstSha = await git(work, "rev-parse", "HEAD");
  await git(work, "remote", "add", "origin", remote);
  await git(work, "push", "origin", "main");
  await git(root, "clone", remote, checkout);

  writeFileSync(join(work, "package.json"), packageJson("1.0.1"));
  writeFileSync(join(work, "CHANGELOG.md"), CHANGELOG_V2);
  await git(work, "commit", "-am", "Release 1.0.1");
  for (const subject of ["Fix the header", "Tidy the step rows", "Say when the check fails"]) {
    writeFileSync(join(work, "notes.txt"), `${subject}\n`);
    await git(work, "add", ".");
    await git(work, "commit", "-m", subject);
  }
  await git(work, "push", "origin", "main");
  tipSha = await git(work, "rev-parse", "HEAD");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("checkForUpdate against a bare-repo remote", () => {
  test("reads the running revision from package.json and git", async () => {
    const running = await readRevision(checkout, "HEAD");
    expect(running.version).toBe("1.0.0");
    expect(running.sha).toBe(firstSha);
    expect(running.short).toBe(firstSha.slice(0, 7));
    expect(Date.parse(running.date)).not.toBeNaN();
  });

  test("a newer tip is update-available with commits, version and the changelog delta", async () => {
    const outcome = await checkForUpdate({ checkout, remote, branch: "main" });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.relation).toBe("behind");
    expect(outcome.behind).toBe(4);
    expect(outcome.available?.sha).toBe(tipSha);
    expect(outcome.available?.version).toBe("1.0.1");
    expect(outcome.delta?.commits.map((commit) => commit.subject)).toEqual([
      "Say when the check fails",
      "Tidy the step rows",
      "Fix the header",
      "Release 1.0.1",
    ]);
    expect(outcome.delta?.changelog.headings).toEqual(["1.0.1"]);
    expect(outcome.delta?.changelog.entries.map((entry) => entry.text)).toEqual(["A later fix (#5)", "Second release (#2)"]);
    expect(outcome.delta?.summary.line).toBe("4 commits · 2 changelog entries (1 Fixed, 1 Changed)");
    const state = applyCheck(initialCheck(), outcome, new Date("2026-09-22T12:04:00"), 60);
    expect(state.check.state).toBe("update-available");
    expect(state.available?.sha).toBe(tipSha);
  });

  test("the fetch lands on refs/self-update/tip and moves nothing else", async () => {
    expect(await git(checkout, "rev-parse", "refs/self-update/tip")).toBe(tipSha);
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(firstSha);
    expect(await git(checkout, "status", "--porcelain")).toBe("");
  });

  test("a failed check keeps the previous available revision and carries git's message", async () => {
    const before = applyCheck(initialCheck(), await checkForUpdate({ checkout, remote, branch: "main" }), new Date(), 60);
    const moved = `${remote}-moved`;
    renameSync(remote, moved);
    try {
      const outcome = await checkForUpdate({ checkout, remote, branch: "main" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain(remote);
      const after = applyCheck(before, outcome, new Date("2026-09-22T12:05:00"), 60);
      expect(after.check.state).toBe("failed");
      expect(after.check.error).toBe(outcome.error);
      expect(after.available?.sha).toBe(tipSha);
      expect(after.check.delta?.commits).toHaveLength(4);
    } finally {
      renameSync(moved, remote);
    }
  });

  test("after checking out the tip the install is up to date", async () => {
    await git(checkout, "checkout", "--detach", tipSha);
    const outcome = await checkForUpdate({ checkout, remote, branch: "main" });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.relation).toBe("equal");
    expect(outcome.available).toBeNull();
    expect(applyCheck(initialCheck(), outcome, new Date(), 60).check.state).toBe("up-to-date");
  });

  test("a checkout ahead of the remote is up to date and says it is ahead", async () => {
    await git(checkout, "checkout", "-b", "local-work");
    writeFileSync(join(checkout, "local.txt"), "ahead\n");
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", "Local commit");
    const outcome = await checkForUpdate({ checkout, remote, branch: "main" });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.relation).toBe("ahead");
    expect(outcome.ahead).toBe(1);
    const state = applyCheck(initialCheck(), outcome, new Date(), 60);
    expect(state.check.state).toBe("up-to-date");
    expect(state.check.note).toBe("Ahead of origin/main by 1");
  });

  test("a checkout that diverged is still update-available", async () => {
    writeFileSync(join(work, "notes.txt"), "remote moved on\n");
    await git(work, "commit", "-am", "Remote moves on");
    await git(work, "push", "origin", "main");
    const outcome = await checkForUpdate({ checkout, remote, branch: "main" });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.relation).toBe("diverged");
    const state = applyCheck(initialCheck(), outcome, new Date(), 60);
    expect(state.check.state).toBe("update-available");
    expect(state.check.note).toBe("Diverged from origin/main");
  });
});
