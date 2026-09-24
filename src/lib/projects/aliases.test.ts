import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import {
  canonicalProject,
  durableProjectAliasCandidates,
  persistProjectAliases,
  projectAliasSnapshot,
  recordedProjectRemote,
  resetProjectAliasesForTests,
} from "./aliases";
import { localRepositoryProjectId, projectIdentityFromRepositoryRoot } from "./identity";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-aliases-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("legacy project buckets persist as aliases of one repository identity", () => {
  const target = "repo-0123456789abcdef0123456789abcdef";
  expect(persistProjectAliases([
    { source: "shared-repository", target, displayName: "shared-repository" },
    { source: "-alternate-root-shared-repository", target, displayName: "shared-repository" },
  ])).toBe(true);

  resetProjectAliasesForTests();
  expect(canonicalProject("shared-repository")).toBe(target);
  expect(canonicalProject("-alternate-root-shared-repository")).toBe(target);
  expect(projectAliasSnapshot()).toEqual({
    aliases: {
      "shared-repository": target,
      "-alternate-root-shared-repository": target,
    },
    displayNames: {
      [target]: "shared-repository",
    },
  });
});

test("a conflicting legacy alias fails closed without changing the durable map", () => {
  const first = "repo-0123456789abcdef0123456789abcdef";
  const second = "repo-abcdef0123456789abcdef0123456789";
  expect(persistProjectAliases([
    { source: "legacy-bucket", target: first, displayName: "first" },
  ])).toBe(true);
  expect(persistProjectAliases([
    { source: "legacy-bucket", target: second, displayName: "second" },
  ])).toBe(false);
  expect(canonicalProject("legacy-bucket")).toBe(first);
});

test("current-production durable records provide repository-backed aliases", () => {
  const repository = path.join(SANDBOX, "durable-record-repository");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    "\turl = ssh://git@example.invalid/team/shared-repository.git",
    "",
  ].join("\n"));
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "flows.json"), JSON.stringify({
    flows: [{ project: "-legacy-root-shared-repository", cwd: repository }],
  }));

  const identity = projectIdentityFromRepositoryRoot(repository)!;
  expect(durableProjectAliasCandidates()).toEqual({
    registrations: [{
      source: "-legacy-root-shared-repository",
      target: identity.project,
      displayName: "shared-repository",
    }],
    conflicts: [],
    remoteMoves: [],
  });
});

test("one legacy key resolving to two repositories is reported as a conflict", () => {
  const repositories = ["first", "second"].map((name) => {
    const repository = path.join(SANDBOX, `conflict-${name}`);
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(repository, ".git", "config"), [
      '[remote "origin"]',
      `\turl = ssh://git@example.invalid/team/${name}.git`,
      "",
    ].join("\n"));
    return repository;
  });
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "flows.json"), JSON.stringify({
    flows: repositories.map((cwd) => ({ project: "ambiguous-legacy-key", cwd })),
  }));

  expect(durableProjectAliasCandidates()).toEqual({
    registrations: [],
    conflicts: ["ambiguous-legacy-key"],
    remoteMoves: [],
  });
});

test("one poisoned record cannot block a majority-backed legacy source", () => {
  const clean = path.join(SANDBOX, "majority-clean");
  const poison = path.join(SANDBOX, "majority-poison");
  for (const [repository, name] of [[clean, "shared-repository"], [poison, "unrelated-repository"]] as const) {
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(repository, ".git", "config"), [
      '[remote "origin"]',
      `\turl = ssh://git@example.invalid/team/${name}.git`,
      "",
    ].join("\n"));
  }
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  /* One closed flow stamped with the legacy key but pointing at a foreign
     checkout — the production shape that froze alias persistence entirely. */
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "flows.json"), JSON.stringify({
    flows: [
      { project: "-legacy-root-shared-repository", cwd: clean },
      { project: "-legacy-root-shared-repository", cwd: poison, closedAt: "2026-07-11T00:00:00.000Z" },
    ],
  }));
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "pipelines.json"), JSON.stringify({
    pipelines: [{ id: "pipe0001", project: "-legacy-root-shared-repository", repoDir: clean }],
  }));

  const identity = projectIdentityFromRepositoryRoot(clean)!;
  expect(durableProjectAliasCandidates()).toEqual({
    registrations: [{
      source: "-legacy-root-shared-repository",
      target: identity.project,
      displayName: "shared-repository",
    }],
    conflicts: [],
    remoteMoves: [],
  });
});

test("a canonical repository id with foreign records never aliases to another repository", () => {
  const repositories = ["current-repository", "foreign-repository"].map((name) => {
    const repository = path.join(SANDBOX, name);
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(repository, ".git", "config"), [
      '[remote "origin"]',
      `\turl = ssh://git@example.invalid/team/${name}.git`,
      "",
    ].join("\n"));
    return repository;
  });
  const current = projectIdentityFromRepositoryRoot(repositories[0]!)!;
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "flows.json"), JSON.stringify({
    flows: [
      { project: current.project, cwd: repositories[0] },
      { project: current.project, cwd: repositories[1] },
      { project: current.project, cwd: repositories[1] },
    ],
  }));

  expect(durableProjectAliasCandidates()).toEqual({
    registrations: [],
    conflicts: [current.project],
    remoteMoves: [],
  });
});

test("a durable alias from a deleted worktree checkout resolves through the worktree map", () => {
  const repository = path.join(SANDBOX, "deleted-worktree-main");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    "\turl = ssh://git@example.invalid/team/shared-repository.git",
    "",
  ].join("\n"));
  const deleted = path.join(SANDBOX, "deleted-worktree-sibling");
  expect(fs.existsSync(deleted)).toBe(false);
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"), JSON.stringify({
    [deleted]: { repo: repository, worktree: "deleted-worktree-sibling" },
  }));
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "flows.json"), JSON.stringify({
    flows: [{ project: "-legacy-root-deleted-worktree", cwd: deleted }],
  }));

  const identity = projectIdentityFromRepositoryRoot(repository)!;
  expect(durableProjectAliasCandidates()).toEqual({
    registrations: [{
      source: "-legacy-root-deleted-worktree",
      target: identity.project,
      displayName: "shared-repository",
    }],
    conflicts: [],
    remoteMoves: [],
  });
});

test("id collisions defer only the colliding sources, never the clean batch", () => {
  const repositories = ["collision", "clean"].map((name) => {
    const repository = path.join(SANDBOX, `collision-${name}`);
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(repository, ".git", "config"), [
      '[remote "origin"]',
      `\turl = ssh://git@example.invalid/team/${name}-repository.git`,
      "",
    ].join("\n"));
    return repository;
  });
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "pipelines.json"), JSON.stringify({
    pipelines: [
      { id: "same-id", project: "legacy-a", repoDir: repositories[0] },
      { id: "same-id", project: "legacy-b", repoDir: repositories[0] },
    ],
  }));
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "flows.json"), JSON.stringify({
    flows: [{ project: "legacy-clean", cwd: repositories[1] }],
  }));

  const identity = projectIdentityFromRepositoryRoot(repositories[1]!)!;
  expect(durableProjectAliasCandidates()).toEqual({
    registrations: [{
      source: "legacy-clean",
      target: identity.project,
      displayName: "clean-repository",
    }],
    conflicts: ["pipelines id collision"],
    remoteMoves: [],
  });
});

test("#2035: a re-pointed remote is handed to the forge, never registered, and a path-derived source still is", () => {
  const repository = path.join(SANDBOX, "repointed-remote");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  const origin = (name: string) => fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    `\turl = https://github.com/team/${name}.git`,
    "",
  ].join("\n"));
  origin("original-repository");
  const before = projectIdentityFromRepositoryRoot(repository)!;
  const local = localRepositoryProjectId(repository)!;
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "pipelines.json"), JSON.stringify({
    pipelines: [
      { id: "pipe-remote", project: before.project, repoDir: repository },
      { id: "pipe-local", project: local, repoDir: repository },
    ],
  }));

  /* While the checkout still mints the recorded key, the pass only fills the
     ledger with the remote behind it. */
  expect(durableProjectAliasCandidates().remoteMoves).toEqual([]);
  expect(recordedProjectRemote(before.project)).toBe("github.com/team/original-repository");

  origin("unrelated-fork");
  const after = projectIdentityFromRepositoryRoot(repository)!;
  const candidates = durableProjectAliasCandidates();
  expect(candidates.registrations).toEqual([{ source: local, target: after.project, displayName: "unrelated-fork" }]);
  expect(candidates.remoteMoves).toEqual([{ source: before.project, target: after }]);
});
