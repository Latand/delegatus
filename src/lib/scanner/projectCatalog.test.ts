import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { globalCache } from "./caches";
import { projectInfoFromCwd } from "./describe";
import { projectCatalogSnapshotFromRaw } from "./projectCatalog";

const disk = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-worktrees-"));
afterAll(() => fs.rmSync(disk, { recursive: true, force: true }));

test("warm catalog-only passes record a cwd that became a worktree, before outside removal", async () => {
  process.env.LLV_STATE_DIR = path.join(disk, "state");
  const repo = path.join(disk, "widgets");
  const checkout = repo + "-lane-42";
  const cwd = path.join(checkout, "src");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/widgets.git\n');
  fs.mkdirSync(cwd, { recursive: true });
  const filename = path.join(disk, "session.jsonl");
  fs.writeFileSync(filename, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n");
  const raw = [{ rootName: "codex-sessions" as const, root: disk, path: filename, st: fs.statSync(filename) }];
  const first = await projectCatalogSnapshotFromRaw(raw);
  expect(first.projectCatalog[0]?.project.startsWith("dir-")).toBe(true);
  fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "lane-42")}\n`);
  const second = await projectCatalogSnapshotFromRaw(raw, { persist: false });
  const identity = projectIdentityFromRepositoryRoot(repo)!;
  expect(second.projectCatalog[0]).toMatchObject({ project: identity.project, displayName: identity.displayName });
  const map = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"), "utf8"));
  expect(map[checkout]).toEqual({ repo, worktree: "lane-42" });
  fs.rmSync(checkout, { recursive: true });
  globalCache("project-info-cwd-v2").clear();
  globalCache("worktree-git").clear();
  expect(projectInfoFromCwd(cwd)).toMatchObject({ project: identity.project, displayName: identity.displayName });
});

test("a catalog-only observation persists separate Git directory ownership through ordinary removal", async () => {
  const base = path.join(disk, "separate-git");
  const state = path.join(base, "state");
  process.env.LLV_STATE_DIR = state;
  const repo = path.join(base, "widgets");
  const common = path.join(base, "git-data");
  const checkout = repo + "-review";
  const cwd = path.join(checkout, "src");
  fs.mkdirSync(repo, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=", "-C", repo, ...args], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
  };
  git("init", "--separate-git-dir=" + common);
  git("commit", "--allow-empty", "-m", "fixture");
  git("remote", "add", "origin", "https://example.invalid/team/widgets.git");
  fs.mkdirSync(cwd, { recursive: true });
  const filenames = [repo, cwd].map((sessionCwd, index) => {
    const filename = path.join(base, `session-${index}.jsonl`);
    fs.writeFileSync(filename, JSON.stringify({ type: "session_meta", payload: { cwd: sessionCwd } }) + "\n");
    return filename;
  });
  const raw = filenames.map(filename => ({ rootName: "codex-sessions" as const, root: base, path: filename, st: fs.statSync(filename) }));
  await projectCatalogSnapshotFromRaw(raw);
  globalCache("project-info-cwd-v2").clear(); // Only the persisted catalog knows the repository.
  expect(fs.existsSync(path.join(state, "worktree-map.json"))).toBe(false);
  fs.rmdirSync(cwd); fs.rmdirSync(checkout);
  git("worktree", "add", "--detach", checkout);
  fs.mkdirSync(cwd);
  const identity = projectIdentityFromRepositoryRoot(repo)!;
  const observed = await projectCatalogSnapshotFromRaw(raw, { persist: false });
  expect(observed.projectByPath.get(filenames[1]!)).toBe(identity.project);
  expect(JSON.parse(fs.readFileSync(path.join(state, "worktree-map.json"), "utf8"))[checkout]).toEqual({ repo, worktree: path.basename(checkout) });
  fs.rmdirSync(cwd);
  git("worktree", "remove", checkout);
  const script = `const { projectInfoFromCwd } = await import(${JSON.stringify(path.join(import.meta.dir, "describe.ts"))});`
    + `console.log(JSON.stringify(projectInfoFromCwd(${JSON.stringify(cwd)})));`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: path.resolve(import.meta.dir, "../../.."), env, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ project: identity.project, repo, worktree: path.basename(checkout) });
});
