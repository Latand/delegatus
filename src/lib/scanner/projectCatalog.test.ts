import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
