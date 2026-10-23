import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proveParkRestore } from "./pipeline-park-proof";

function fixture(detached = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "park-proof-")));
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "checkout");
  const evidence = path.join(root, "evidence");
  const artifact = path.join(root, "artifacts");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=", "-C", repo, ...args], {
    encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" },
  }).trim();
  git("init", "--initial-branch=main");
  fs.writeFileSync(path.join(repo, "source"), Buffer.from([0, 255, 10, 13]));
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored\n");
  fs.writeFileSync(path.join(repo, "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.symlinkSync("source", path.join(repo, "link"));
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=noreply", "commit", "-m", "fixture");
  git("worktree", "add", ...(detached ? ["--detach"] : ["-b", "proof"]), checkout, "HEAD");
  fs.mkdirSync(artifact);
  fs.writeFileSync(path.join(artifact, "result"), Buffer.from([255, 0, 1]));
  return { root, repo, checkout, evidence, artifact, git,
    run: (stopped = true) => proveParkRestore({ checkout, evidence, stopped, artifacts: [artifact] }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const detached of [false, true]) test(`preserves commit, binary bytes, links, executable mode and artifacts (detached: ${detached})`, () => {
  const f = fixture(detached);
  try {
    fs.chmodSync(path.join(f.checkout, "source"), 0o600);
    fs.chmodSync(path.join(f.checkout, "run"), 0o755);
    const before = fs.readFileSync(path.join(f.checkout, "source"));
    const record = f.run();
    expect(fs.readFileSync(path.join(f.checkout, "source"))).toEqual(before);
    expect(fs.readFileSync(path.join(f.evidence, "checkout-files", "source"))).toEqual(before);
    expect(fs.statSync(path.join(f.checkout, "source")).mode & 0o777).toBe(0o600);
    expect(fs.readlinkSync(path.join(f.checkout, "link"))).toBe("source");
    expect(fs.statSync(path.join(f.checkout, "run")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(f.evidence, "artifact-0", "result"))).toEqual(fs.readFileSync(path.join(f.artifact, "result")));
    expect(f.git("bundle", "list-heads", path.join(f.evidence, "checkout.bundle"))).toBe(`${record.commit} HEAD`);
    expect(JSON.parse(fs.readFileSync(path.join(f.evidence, "verified.json"), "utf8"))).toEqual({ commit: record.commit, byteIdentical: true, worktreeRemoved: true });
    expect(JSON.parse(fs.readFileSync(path.join(f.evidence, "manifest.json"), "utf8"))).toEqual(record);
  } finally { f.cleanup(); }
});

for (const change of ["modified", "deleted", "staged", "untracked", "ignored", "empty-directory", "skip-worktree", "assume-unchanged"]) test(`refuses ${change} without removing checkout`, () => {
  const f = fixture();
  try {
    if (change === "modified" || change === "staged") fs.writeFileSync(path.join(f.checkout, "source"), "changed");
    if (change === "deleted") fs.unlinkSync(path.join(f.checkout, "source"));
    if (change === "staged") execFileSync("git", ["-C", f.checkout, "add", "source"]);
    if (change === "untracked" || change === "ignored") fs.writeFileSync(path.join(f.checkout, change), "unaccounted");
    if (change === "empty-directory") fs.mkdirSync(path.join(f.checkout, "empty"));
    if (change === "skip-worktree" || change === "assume-unchanged") {
      execFileSync("git", ["-C", f.checkout, "update-index", `--${change}`, "source"]);
      fs.writeFileSync(path.join(f.checkout, "source"), "hidden change");
    }
    expect(() => f.run()).toThrow();
    expect(fs.existsSync(path.join(f.checkout, ".git"))).toBe(true);
    expect(fs.existsSync(f.evidence)).toBe(false);
  } finally { f.cleanup(); }
});

test("refuses running, overlapping, primary and already preserved locations", () => {
  const f = fixture();
  try {
    expect(() => f.run(false)).toThrow("stopped");
    expect(() => proveParkRestore({ checkout: f.checkout, evidence: f.evidence, stopped: true, artifacts: [f.checkout] })).toThrow("independent");
    expect(() => proveParkRestore({ checkout: f.repo, evidence: f.evidence, stopped: true, artifacts: [] })).toThrow("linked");
    fs.mkdirSync(f.evidence);
    expect(() => f.run()).toThrow("new");
    expect(fs.existsSync(path.join(f.checkout, "source"))).toBe(true);
  } finally { f.cleanup(); }
});

test("removal refusal retains checkout and recovery evidence without claiming success", () => {
  const f = fixture();
  try {
    f.git("worktree", "lock", f.checkout);
    expect(() => f.run()).toThrow("Git operation");
    expect(fs.existsSync(path.join(f.checkout, "source"))).toBe(true);
    expect(fs.existsSync(path.join(f.evidence, "checkout.bundle"))).toBe(true);
    expect(fs.existsSync(path.join(f.evidence, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(f.evidence, "verified.json"))).toBe(false);
  } finally { f.cleanup(); }
});
