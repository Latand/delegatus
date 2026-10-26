import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";

/* A throw-away repository shaped like a lane, shared by the lane review tests:
   `main` with its fetched `origin/main`, and a lane branch that adds,
   updates, deletes and changes a binary file. Fixed identities and dates keep
   every SHA the same from run to run. */

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Lane Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Lane Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-23T08:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-23T08:00:00Z",
};

export type LaneRepo = {
  dir: string;
  git: (...args: string[]) => string;
  write: (file: string, content: string | Buffer) => void;
  commit: (message: string) => string;
  pipeline: (overrides?: Partial<Pipeline>) => Pipeline;
  cleanup: () => void;
};

export const LANE_BRANCH = "pipeline/lane-fixture";

export const NUMBERED = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

export function createLaneRepo(root = os.tmpdir()): LaneRepo {
  const dir = fs.mkdtempSync(path.join(root, "lane-review-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();
  const write = (file: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  write("src/app.ts", NUMBERED);
  write("src/gone.ts", "export const gone = true;\n");
  write("assets/logo.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
  const base = commit("base");
  git("update-ref", "refs/remotes/origin/main", base);
  git("checkout", "-q", "-b", LANE_BRANCH);
  write("src/app.ts", NUMBERED.replace("line 5\n", "line five\n").replace("line 25\n", "line 25\nline 25b\n"));
  write("src/added.ts", "export const added = 1;\n");
  fs.rmSync(path.join(dir, "src/gone.ts"));
  write("assets/logo.bin", Buffer.from([0, 9, 9, 9, 0, 255]));
  commit("lane work");
  git("checkout", "-q", "--detach");
  const pipeline = (overrides: Partial<Pipeline> = {}): Pipeline => ({
    id: "pipeline-fixture",
    repoDir: dir,
    worktreeDir: path.join(dir, "missing-worktree"),
    branch: LANE_BRANCH,
    baseBranch: "main",
    baseRef: base,
    lastPassedCommit: "",
    runs: [],
    stages: [],
    ...overrides,
  }) as Pipeline;
  return { dir, git, write, commit, pipeline, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
