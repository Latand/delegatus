import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { durableSkillCheckout, linkSkills } from "./skillLinks.mjs";

/* Everything lives under one sandbox; `tempRoot` names a directory outside it
   so the sandbox checkout itself counts as durable, except in the test that
   asks for the temp-root refusal. Never the real ~/.claude or ~/.codex. */
const NOT_TEMP = "/nonexistent-temp-root";
let sandbox: string;
let home: string;
let primary: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, stdio: "ignore" });
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "llv-skill-links-")));
  home = join(sandbox, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  primary = join(sandbox, "repo");
  for (const name of ["delegatus-conveyor", "review-loop"]) {
    mkdirSync(join(primary, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(primary, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  git(primary, "init", "-q");
  git(primary, "add", ".");
  git(primary, "commit", "-q", "-m", "fixture");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const roots = () => [join(home, ".claude", "skills"), join(home, ".codex", "skills")];

test("a run from a linked worktree links the primary checkout, which survives the worktree's removal", () => {
  const worktree = join(sandbox, "lane");
  git(primary, "worktree", "add", "-q", worktree);
  expect(durableSkillCheckout(worktree, { tempRoot: NOT_TEMP })).toBe(primary);

  linkSkills(worktree, { home, tempRoot: NOT_TEMP });
  git(primary, "worktree", "remove", "--force", worktree);
  expect(existsSync(worktree)).toBe(false);

  for (const root of roots()) {
    for (const name of ["delegatus-conveyor", "review-loop"]) {
      expect(readlinkSync(join(root, name))).toBe(join(primary, ".claude", "skills", name));
      expect(existsSync(join(root, name, "SKILL.md"))).toBe(true);
    }
  }
});

test("a dangling Delegatus skill link is repaired on the next run; other skills are never touched", () => {
  const [claudeSkills] = roots();
  mkdirSync(claudeSkills, { recursive: true });
  symlinkSync(join(sandbox, "deleted-lane", ".claude", "skills", "review-loop"), join(claudeSkills, "review-loop"), "dir");
  const foreignDangling = join(sandbox, "gone", "someone-else");
  symlinkSync(foreignDangling, join(claudeSkills, "someone-else"), "dir");
  mkdirSync(join(claudeSkills, "hand-written"));
  writeFileSync(join(claudeSkills, "hand-written", "SKILL.md"), "mine");

  linkSkills(primary, { home, tempRoot: NOT_TEMP });

  expect(readlinkSync(join(claudeSkills, "review-loop"))).toBe(join(primary, ".claude", "skills", "review-loop"));
  expect(existsSync(join(claudeSkills, "review-loop", "SKILL.md"))).toBe(true);
  expect(readlinkSync(join(claudeSkills, "someone-else"))).toBe(foreignDangling);
  expect(lstatSync(join(claudeSkills, "hand-written")).isDirectory()).toBe(true);
  expect(existsSync(join(claudeSkills, ".skill-backups", "hand-written"))).toBe(false);
});

test("a checkout under the temp root and a non-checkout link nothing", () => {
  expect(durableSkillCheckout(primary, { tempRoot: sandbox })).toBeNull();
  linkSkills(primary, { home, tempRoot: sandbox });
  for (const root of roots()) expect(existsSync(root)).toBe(false);

  const installed = join(sandbox, "installed-package");
  mkdirSync(join(installed, ".claude", "skills", "review-loop"), { recursive: true });
  expect(durableSkillCheckout(installed, { tempRoot: NOT_TEMP })).toBeNull();
});
