import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { currentCheckout, sharedCheckout } from "./source-checkout";
import { fixtureGitEnv } from "./local-gate.fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-source-")); roots.push(root);
  const source = path.join(root, "source"); fs.mkdirSync(source);
  const env = { ...fixtureGitEnv(), GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture", GIT_COMMITTER_EMAIL: "fixture" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q"); git("config", "core.hooksPath", "/dev/null");
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n.next/\ndist/\n");
  fs.writeFileSync(path.join(source, "input"), "committed");
  fs.writeFileSync(path.join(source, "deleted"), "deleted");
  git("add", "."); git("commit", "-qm", "fixture");
  fs.mkdirSync(path.join(source, "node_modules")); fs.writeFileSync(path.join(source, "node_modules/package"), "shared");
  return { root, source, git };
}

test("current inputs retain Git provenance, staged and unstaged edits, additions, deletions, links and modes", () => {
  const f = fixture(), head = f.git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.source, "input"), "staged"); f.git("add", "input");
  fs.writeFileSync(path.join(f.source, "input"), "working");
  fs.rmSync(path.join(f.source, "deleted"));
  fs.writeFileSync(path.join(f.source, "new"), "new", { mode: 0o755 });
  fs.symlinkSync("input", path.join(f.source, "link"));
  fs.mkdirSync(path.join(f.source, ".next")); fs.writeFileSync(path.join(f.source, ".next/cache"), "ignored");
  const status = f.git("status", "--porcelain"), target = path.join(f.root, "export");
  currentCheckout(f.source, target);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim()).toBe(head);
  expect(fs.readFileSync(path.join(target, "input"), "utf8")).toBe("working");
  expect(fs.readlinkSync(path.join(target, "link"))).toBe("input");
  expect(fs.statSync(path.join(target, "new")).mode & 0o100).toBe(0o100);
  expect(fs.existsSync(path.join(target, "deleted"))).toBeFalse();
  expect(fs.existsSync(path.join(target, ".next"))).toBeFalse();
  expect(fs.realpathSync(path.join(target, "node_modules"))).toBe(fs.realpathSync(path.join(f.source, "node_modules")));
  expect(fs.readFileSync(path.join(target, ".git/objects/info/alternates"), "utf8").trim()).toBe(path.join(f.source, ".git/objects"));
  expect(f.git("status", "--porcelain")).toBe(status);
  fs.rmSync(target, { recursive: true });
  expect(f.git("worktree", "list", "--porcelain").split("worktree ").length).toBe(2);
});

test("an invalid revision refuses without altering source refs or files", () => {
  const f = fixture(), head = f.git("rev-parse", "HEAD");
  expect(() => sharedCheckout(f.source, path.join(f.root, "export"), "missing")).toThrow();
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(fs.readFileSync(path.join(f.source, "input"), "utf8")).toBe("committed");
});

test("removing one export leaves sealed dependencies and another export intact without chmod", () => {
  const f = fixture(), modules = path.join(f.source, "node_modules"), file = path.join(modules, "package");
  fs.chmodSync(file, 0o444); fs.chmodSync(modules, 0o555);
  const mode = fs.statSync(file).mode, inode = fs.statSync(file).ino;
  try {
    const first = path.join(f.root, "first"), second = path.join(f.root, "second");
    currentCheckout(f.source, first); currentCheckout(f.source, second);
    fs.rmSync(first, { recursive: true });
    expect(fs.readFileSync(path.join(second, "node_modules/package"), "utf8")).toBe("shared");
    fs.rmSync(second, { recursive: true });
    expect(fs.statSync(file).mode).toBe(mode);
    expect(fs.statSync(file).ino).toBe(inode);
    expect(fs.statSync(modules).mode & 0o777).toBe(0o555);
  } finally { fs.chmodSync(modules, 0o755); fs.chmodSync(file, 0o644); }
});

test("assume-unchanged bytes and staged deletions cannot make the exported tree stale", () => {
  const f = fixture();
  f.git("update-index", "--assume-unchanged", "input");
  fs.writeFileSync(path.join(f.source, "input"), "hidden edit");
  f.git("rm", "deleted");
  currentCheckout(f.source, path.join(f.root, "export"));
  expect(fs.readFileSync(path.join(f.root, "export/input"), "utf8")).toBe("hidden edit");
  expect(fs.existsSync(path.join(f.root, "export/deleted"))).toBeFalse();
});

test("comparison refs retain upstream main when the source's local main differs", () => {
  const f = fixture(), original = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/remotes/origin/main", original);
  fs.writeFileSync(path.join(f.source, "input"), "next"); f.git("add", "input"); f.git("commit", "-qm", "next fixture");
  const target = path.join(f.root, "export"); sharedCheckout(f.source, target, "HEAD");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
  expect(git("rev-parse", "refs/remotes/origin/main")).toBe(original);
  expect(git("rev-parse", "HEAD")).toBe(f.git("rev-parse", "HEAD"));
});
