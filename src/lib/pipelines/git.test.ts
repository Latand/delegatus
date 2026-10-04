import { afterEach, beforeEach, expect, test } from "bun:test";
import { CONTROLLER_ARTIFACT_GIT_PATHS, CONTROLLER_ARTIFACT_PATHSPECS } from "./controllerArtifacts";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { commitPipelineStage, currentPipelineRemoteBranchHead, mapReplayPatchLocation, pipelineWorktreeChanges, provisionPipelineWorktree, provisionPipelineWorktreeAsync, realProvisionExec, resolvePipelineBaseAsync, publishPipelineBranch, reconcilePipelinePublication, reconcilePipelineStageHead, resetPipelineStage, resolvePipelineBase, synchronizePipelineRetryHead } from "./git";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import type { Pipeline } from "./types";
import { createPipelineWithDelivery, findPipelineRecord, savePipelines, takeoverPipelineDelivery, withPipelineMutation } from "./store";
import { realExec, type ExecPort } from "@/lib/workflows/provision";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";

test.each(["probe", "push-reply"] as const)("closing a lane during a real publication %s fences its outcome", async (phase) => {
  const box = await publishSandbox();
  const { patchPipeline, defaultPipelinePorts } = await import("./engine");
  const { registerPipelineTick } = await import("./controllerSignal");
  const restoreTick = registerPipelineTick(async () => {});
  const head = await box.commit("accepted.txt", "accepted\n");
  const bin = path.join(box.root, "bin"); fs.mkdirSync(bin);
  const entered = path.join(bin, "entered"), released = path.join(bin, "released");
  const gitBinary = Bun.which("git")!;
  fs.writeFileSync(path.join(bin, "git"), phase === "probe"
    ? '#!/bin/sh\nif [ "$1" = "ls-remote" ]; then touch "$PUBLISH_ENTERED"; while [ ! -f "$PUBLISH_RELEASED" ]; do sleep 0.01; done; fi\nexec "$PUBLISH_GIT" "$@"\n'
    : '#!/bin/sh\nif [ "$1" = "push" ]; then "$PUBLISH_GIT" "$@" || exit $?; touch "$PUBLISH_ENTERED"; while [ ! -f "$PUBLISH_RELEASED" ]; do sleep 0.01; done; exit 0; fi\nexec "$PUBLISH_GIT" "$@"\n', { mode: 0o700 });
  const previous = { PATH: process.env.PATH, PUBLISH_ENTERED: process.env.PUBLISH_ENTERED, PUBLISH_RELEASED: process.env.PUBLISH_RELEASED, PUBLISH_GIT: process.env.PUBLISH_GIT };
  Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, PUBLISH_ENTERED: entered, PUBLISH_RELEASED: released, PUBLISH_GIT: gitBinary });
  let pending: ReturnType<typeof publishPipelineBranch> | undefined;
  try {
    pending = publishPipelineBranch(box.subject, realExec, { acceptedSha: head });
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(fs.existsSync(entered)).toBe(true);
    const ports = { ...defaultPipelinePorts(), stopStageAgent: async () => ({ outcome: "not-running" as const }), paneAgentAlive: async () => false, stageHostResident: async () => false };
    expect((await patchPipeline(box.subject.id, { action: "close" }, ports)).error).toBeUndefined();
    fs.writeFileSync(released, "");
    expect(await pending).toMatchObject(phase === "probe" ? { ok: false, error: expect.stringContaining("superseded") }
      : { ok: true, remote: "unreachable", uncertain: true, detail: expect.stringContaining("superseded") });
    expect(findPipelineRecord(box.subject.id)!.state).toBe("closed");
    expect(findPipelineRecord(box.subject.id)!.publishedCommit).not.toBe(head);
    const remote = await realExec(gitBinary, ["show-ref", "--verify", `refs/heads/${box.subject.branch}`], box.origin);
    if (phase === "probe") expect(remote.code).not.toBe(0);
    else {
      expect(remote.code).toBe(0);
      expect(remote.stdout).toContain(head);
      expect(findPipelineRecord(box.subject.id)!.delivery!.operation!.state).toBe("running");
      expect(findPipelineRecord(box.subject.id)!.delivery!.journal.at(-1)!.reason).toContain("reconcile");
    }
  } finally {
    fs.writeFileSync(released, ""); await pending;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    restoreTick(); fs.rmSync(box.root, { recursive: true, force: true });
  }
});

let previousState: string | undefined;
let publicationState: string;
beforeEach(() => {
  closeAgentRegistryForTests();
  previousState = process.env.LLV_STATE_DIR;
  publicationState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-git-state-"));
  process.env.LLV_STATE_DIR = publicationState;
});
afterEach(() => {
  closeAgentRegistryForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(publicationState, { recursive: true, force: true });
});

function pipeline(): Pipeline {
  const subject: Pipeline = {
    id: "12345678", task: "task", taskIds: [], project: "viewer", repoDir: "/repo", worktreeDir: "/repo-pipeline-12345678",
    branch: "pipeline/task-12345678", baseBranch: "", baseRef: "", lastPassedCommit: "base",
    stages: [{ id: "build", kind: "run", prompt: "build", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    runs: [{ stageId: "build", attempts: [] }], cursor: null, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "now", closedAt: null,
  };
  subject.delivery = { target: { repository: "repo-fixture", remote: "origin", branch: `refs/heads/${subject.branch}` },
    disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
  if (!findPipelineRecord(subject.id)) savePipelines([subject]);
  return subject;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env: Partial<NodeJS.ProcessEnv> = {};
  for (const key of ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]) env[key] = undefined;
  for (const key of Object.keys(process.env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) env[key] = undefined;
  const result = await realExec("git", args, cwd, env);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function isolatedIdentityRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-identity-"));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const repo = path.join(root, "repo");
  for (const directory of [home, xdg, repo]) fs.mkdirSync(directory);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:AUTHOR_|COMMITTER_|CONFIG_|ALTERNATE_OBJECT_DIRECTORIES$|OBJECT_DIRECTORY$|DIR$|WORK_TREE$|IMPLICIT_WORK_TREE$|GRAFT_FILE$|INDEX_FILE$|NO_REPLACE_OBJECTS$|REPLACE_REF_BASE$|PREFIX$|SHALLOW_FILE$|COMMON_DIR$)/.test(key)) delete env[key];
  }
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") });
  const exec: ExecPort = (command, args, cwd, overrides) => {
    const result = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
  };
  const run = async (...args: string[]) => {
    const result = (await exec("git", args, repo));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  (await run("init", "--initial-branch=main"));
  fs.writeFileSync(path.join(repo, "source.ts"), "export const value = 1;\n");
  (await run("add", "source.ts"));
  (await run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "initial"));
  return { root, repo, env, exec, run };
}

test("a real stale dirty checkout provisions from the freshly fetched origin/main tip", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-base-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const source = path.join(root, "source");
  try {
    fs.mkdirSync(seed);
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(seed, "init", "--initial-branch=main"));
    (await git(seed, "config", "user.email", "pipeline-test@example.com"));
    (await git(seed, "config", "user.name", "Pipeline Test"));
    (await git(seed, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(seed, "tracked.txt"), "old\n");
    (await git(seed, "add", "tracked.txt"));
    (await git(seed, "commit", "-m", "old base"));
    (await git(seed, "remote", "add", "origin", origin));
    (await git(seed, "push", "-u", "origin", "main"));
    (await git(root, "clone", origin, source));
    const staleHead = (await git(source, "rev-parse", "HEAD"));

    fs.writeFileSync(path.join(seed, "tracked.txt"), "new\n");
    (await git(seed, "commit", "-am", "advance main"));
    (await git(seed, "push", "origin", "main"));
    const currentMain = (await git(seed, "rev-parse", "HEAD"));
    fs.writeFileSync(path.join(source, "dirty.txt"), "preserve me\n");

    const subject = pipeline();
    subject.repoDir = source;
    subject.worktreeDir = path.join(root, "source-pipeline-12345678");
    const resolved = (await resolvePipelineBase(source, {}, realExec));
    expect(resolved).toEqual({ ok: true, baseBranch: "main", baseRef: currentMain });
    if (!resolved.ok) throw new Error(resolved.error);
    subject.baseBranch = resolved.baseBranch;
    subject.baseRef = resolved.baseRef;
    subject.lastPassedCommit = resolved.baseRef;

    expect((await provisionPipelineWorktree(subject, realExec))).toEqual({ ok: true, sha: currentMain, baseBranch: "main" });
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(currentMain);
    expect((await git(source, "rev-parse", "HEAD"))).toBe(staleHead);
    expect((await git(source, "status", "--porcelain"))).toBe("?? dirty.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const advanceRemote of [false, true]) {
  test(`a held PR branch provisions on the lane branch and publishes only to the delivery ref (stale local: ${advanceRemote})`, async () => {
    const box = (await isolatedIdentityRepo());
    const { root, repo } = box;
    const origin = path.join(root, "origin.git");
    const builder = path.join(root, "builder with spaces");
    const deliveryBranch = "feature/held-pr";
    try {
      (await git(repo, "config", "user.name", "Fixture"));
      (await git(repo, "config", "user.email", "noreply"));
      (await git(repo, "config", "commit.gpgSign", "false"));
      (await git(root, "init", "--bare", "--initial-branch=main", origin));
      (await git(repo, "remote", "add", "origin", origin));
      (await git(repo, "push", "origin", "main"));
      (await git(repo, "worktree", "add", "-b", deliveryBranch, builder));
      fs.writeFileSync(path.join(builder, "pr.txt"), "existing PR work\n");
      (await git(builder, "add", "pr.txt"));
      (await git(builder, "commit", "-m", "existing PR work"));
      (await git(builder, "push", "origin", deliveryBranch));
      const base = (await git(builder, "rev-parse", "HEAD"));
      const writer = path.join(root, "writer");
      (await git(root, "clone", origin, writer));
      (await git(writer, "config", "user.name", "Fixture"));
      (await git(writer, "config", "user.email", "noreply"));
      (await git(writer, "config", "commit.gpgSign", "false"));
      (await git(writer, "checkout", deliveryBranch));
      if (advanceRemote) {
        (await git(writer, "commit", "--allow-empty", "-m", "newer remote work"));
        (await git(writer, "push", "origin", deliveryBranch));
      }
      const current = (await git(writer, "rev-parse", "HEAD"));
      fs.writeFileSync(path.join(builder, "pr.txt"), "uncommitted builder work\n");
      fs.writeFileSync(path.join(builder, "keep.txt"), "untracked builder work\n");
      const status = (await git(builder, "status", "--porcelain"));
      const subject = { ...pipeline(), repoDir: repo, worktreeDir: path.join(root, "repo-pipeline-12345678"),
        baseBranch: deliveryBranch, baseRef: base, lastPassedCommit: base };
      subject.delivery!.target.branch = `refs/heads/${deliveryBranch}`;
      savePipelines([subject]);

      expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: current, baseBranch: deliveryBranch });
      expect((await git(subject.worktreeDir, "branch", "--show-current"))).toBe(subject.branch);
      expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: current });
      fs.writeFileSync(path.join(subject.worktreeDir, "stage.txt"), "accepted work\n");
      (await git(subject.worktreeDir, "add", "stage.txt"));
      (await git(subject.worktreeDir, "commit", "-m", "accepted stage"));
      const accepted = (await git(subject.worktreeDir, "rev-parse", "HEAD"));
      expect(await publishPipelineBranch(subject, realExec, { acceptedSha: accepted })).toEqual({ ok: true, sha: accepted, remote: "published" });
      expect((await git(repo, "ls-remote", "--heads", "origin", subject.delivery!.target.branch)).split(/\s+/)[0]).toBe(accepted);
      expect((await git(repo, "ls-remote", "--heads", "origin", `refs/heads/${subject.branch}`))).toBe("");
      // The remote can advance after publication's head probe and before push.
      (await git(writer, "fetch", "origin", deliveryBranch));
      (await git(writer, "merge", "--ff-only", "FETCH_HEAD"));
      (await git(writer, "commit", "--allow-empty", "-m", "concurrent remote work"));
      const remoteNext = (await git(writer, "rev-parse", "HEAD"));
      (await git(subject.worktreeDir, "commit", "--allow-empty", "-m", "next accepted stage"));
      const localNext = (await git(subject.worktreeDir, "rev-parse", "HEAD"));
      let raced = false;
      const racing: ExecPort = async (command, args, cwd) => {
        if (command === "git" && args[0] === "push") {
          raced = true;
          (await git(writer, "push", "origin", deliveryBranch));
        }
        return (await realExec(command, args, cwd));
      };
      const refused = await publishPipelineBranch(subject, racing, { acceptedSha: localNext });
      expect(raced).toBe(true);
      expect(refused.ok).toBe(false);
      expect((await git(repo, "ls-remote", "--heads", "origin", subject.delivery!.target.branch)).split(/\s+/)[0]).toBe(remoteNext);
      expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(localNext);
      expect((await git(builder, "branch", "--show-current"))).toBe(deliveryBranch);
      expect((await git(builder, "rev-parse", "HEAD"))).toBe(base);
      expect((await git(builder, "status", "--porcelain"))).toBe(status);
      expect(fs.readFileSync(path.join(builder, "pr.txt"), "utf8")).toBe("uncommitted builder work\n");
      expect(fs.readFileSync(path.join(builder, "keep.txt"), "utf8")).toBe("untracked builder work\n");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const held of [false, true]) {
  test(`a successor preserves a closed lane's unpublished delivery tip and starts at the published head (held: ${held})`, async () => {
    const { root, repo } = (await isolatedIdentityRepo());
    try {
      (await git(repo, "config", "user.name", "Fixture"));
      (await git(repo, "config", "user.email", "noreply"));
      (await git(repo, "config", "commit.gpgSign", "false"));
      const origin = path.join(root, "origin.git");
      (await git(root, "init", "--bare", "--initial-branch=main", origin));
      (await git(repo, "remote", "add", "origin", origin));
      (await git(repo, "push", "origin", "main"));
      const published = (await git(repo, "rev-parse", "HEAD"));
      const deliveryBranch = "feature/successor";
      const closedDir = path.join(root, "repo-pipeline-12345678");
      (await git(repo, "worktree", "add", "-b", deliveryBranch, closedDir));
      (await git(closedDir, "push", "origin", deliveryBranch));
      fs.writeFileSync(path.join(closedDir, "unpublished.txt"), "closed lane work\n");
      (await git(closedDir, "add", "unpublished.txt"));
      (await git(closedDir, "commit", "-m", "unpublished closed lane work"));
      const unpublished = (await git(closedDir, "rev-parse", "HEAD"));
      const predecessor = { ...pipeline(), state: "closed" as const, closedAt: "now",
        repoDir: repo, worktreeDir: closedDir };
      predecessor.delivery!.active = false;
      predecessor.delivery!.publish = "disabled";
      predecessor.delivery!.target.branch = `refs/heads/${deliveryBranch}`;
      savePipelines([predecessor]);
      if (!held) (await git(repo, "worktree", "remove", closedDir));
      const successor = { ...pipeline(), id: "87654321", task: "successor", branch: "pipeline/successor-87654321",
        repoDir: repo, worktreeDir: path.join(root, "repo-pipeline-87654321"), baseBranch: "main", baseRef: published };
      await createPipelineWithDelivery(successor, predecessor.delivery!.target);

      const result = await provisionPipelineWorktreeAsync(successor, realProvisionExec);
      expect(result).toMatchObject({ ok: true, sha: published,
        preservedLocalRef: { sha: unpublished, unpublishedCommits: 1 } });
      if (!result.ok || !result.preservedLocalRef) throw new Error("expected preservation evidence");
      expect(result.preservedLocalRef.ref).toStartWith("refs/backup/provision-unpublished/");
      expect((await git(repo, "rev-parse", result.preservedLocalRef.ref))).toBe(unpublished);
      expect((await git(repo, "rev-parse", deliveryBranch))).toBe(unpublished);
      if (held) expect((await git(closedDir, "rev-parse", "HEAD"))).toBe(unpublished);
      expect((await git(successor.worktreeDir, "rev-parse", "HEAD"))).toBe(published);
      expect(fs.existsSync(path.join(successor.worktreeDir, "unpublished.txt"))).toBe(false);
      (await git(successor.worktreeDir, "commit", "--allow-empty", "-m", "successor work"));
      const accepted = (await git(successor.worktreeDir, "rev-parse", "HEAD"));
      expect(await publishPipelineBranch(successor, realExec, { acceptedSha: accepted })).toMatchObject({ ok: true });
      expect((await realExec("git", ["merge-base", "--is-ancestor", unpublished, accepted], repo)).code).toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

async function deliveryProvisionFixture() {
  const box = (await isolatedIdentityRepo());
  (await git(box.repo, "config", "user.name", "Fixture"));
  (await git(box.repo, "config", "user.email", "noreply"));
  (await git(box.repo, "config", "commit.gpgSign", "false"));
  const origin = path.join(box.root, "origin.git");
  (await git(box.root, "init", "--bare", "--initial-branch=main", origin));
  (await git(box.repo, "remote", "add", "origin", origin));
  (await git(box.repo, "push", "origin", "main"));
  const subject = { ...pipeline(), repoDir: box.repo, worktreeDir: path.join(box.root, "repo-pipeline-12345678"),
    baseBranch: "main", baseRef: (await git(box.repo, "rev-parse", "HEAD")) };
  subject.delivery!.target.branch = "refs/heads/feature/resume";
  (await git(box.repo, "worktree", "add", "-b", "feature/resume", subject.worktreeDir));
  (await git(subject.worktreeDir, "push", "origin", "feature/resume"));
  (await git(subject.worktreeDir, "commit", "--allow-empty", "-m", "unpublished work"));
  const local = (await git(subject.worktreeDir, "rev-parse", "HEAD"));
  (await git(box.repo, "worktree", "remove", subject.worktreeDir));
  return { ...box, subject, local };
}

test("the same owner and epoch resumes its in-flight local publication after losing the checkout", async () => {
  const { root, repo, subject, local } = (await deliveryProvisionFixture());
  try {
    subject.delivery!.operation = { id: "own-publication", epoch: 1, sha: local, state: "pending" };
    savePipelines([subject]);
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: local, baseBranch: "main" });
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(local);
    expect((await git(repo, "for-each-ref", "--format=%(refname)", "refs/backup/provision-unpublished"))).toBe("");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an explicit baseRef pin wins over both the published delivery head and local leftovers", async () => {
  const box = (await deliveryProvisionFixture());
  try {
    (await git(box.repo, "push", "origin", "feature/resume"));
    const leftover = (await git(box.repo, "commit-tree", `${box.local}^{tree}`, "-p", box.local, "-m", "later unpublished work"));
    (await git(box.repo, "update-ref", "refs/heads/feature/resume", leftover));
    const subject = { ...box.subject, baseRefPinned: true };
    savePipelines([subject]);
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: subject.baseRef,
      preservedLocalRef: { sha: leftover, unpublishedCommits: 1 } });
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(subject.baseRef);
    expect((await git(box.repo, "rev-parse", "feature/resume"))).toBe(leftover);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a superseded publication epoch cannot adopt the former owner's unpublished tip", async () => {
  const { root, repo, subject, local } = (await deliveryProvisionFixture());
  try {
    subject.delivery!.operation = { id: "old-publication", epoch: 1, sha: local, state: "pending" };
    savePipelines([subject]);
    expect((await takeoverPipelineDelivery(subject.id, subject.id, 1, "new epoch", null)).pipeline?.delivery?.epoch).toBe(2);
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: subject.baseRef,
      preservedLocalRef: { sha: local, unpublishedCommits: 1 } });
    expect((await git(repo, "rev-parse", "feature/resume"))).toBe(local);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a pin equal to the local delivery tip stays pinned when the remote has advanced", async () => {
  const { root, repo, subject, local } = (await deliveryProvisionFixture());
  try {
    (await git(repo, "push", "origin", "feature/resume"));
    (await git(repo, "update-ref", "refs/heads/feature/resume", subject.baseRef, local));
    const pinned = { ...subject, baseRefPinned: true };
    savePipelines([pinned]);
    expect(await provisionPipelineWorktreeAsync(pinned, realProvisionExec)).toEqual({ ok: true, sha: subject.baseRef, baseBranch: "main" });
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(subject.baseRef);
    expect(await provisionPipelineWorktreeAsync(pinned, realProvisionExec)).toEqual({ ok: true, sha: subject.baseRef, baseBranch: "main" });
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(subject.baseRef);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the same owner's in-flight publication resumes on its lane ref after checkout loss", async () => {
  const { root, repo, subject, local } = (await deliveryProvisionFixture());
  try {
    (await git(repo, "branch", subject.branch, local));
    subject.delivery!.operation = { id: "own-lane-publication", epoch: 1, sha: local, state: "pending" };
    savePipelines([subject]);
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: local, baseBranch: "main" });
    expect((await git(subject.worktreeDir, "branch", "--show-current"))).toBe(subject.branch);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an explicit pin from a separate history remains the provisioning base on retry", async () => {
  const { root, repo, subject } = (await deliveryProvisionFixture());
  try {
    const baseRef = (await git(repo, "commit-tree", `${subject.baseRef}^{tree}`, "-m", "independent pinned base"));
    const pinned = { ...subject, baseRef, baseRefPinned: true };
    savePipelines([pinned]);
    expect(await provisionPipelineWorktreeAsync(pinned, realProvisionExec)).toMatchObject({ ok: true, sha: baseRef });
    expect(await provisionPipelineWorktreeAsync(pinned, realProvisionExec)).toMatchObject({ ok: true, sha: baseRef });
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(baseRef);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("backup creation is repeatable after checkout failure and never overwrites an existing backup", async () => {
  const { root, repo, subject, local } = (await deliveryProvisionFixture());
  try {
    savePipelines([subject]);
    const failed = await provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal) =>
      args[0] === "worktree" && args[1] === "add"
        ? { code: 1, stdout: "", stderr: "injected checkout failure" }
        : (await realProvisionExec(command, args, cwd, signal)));
    expect(failed).toMatchObject({ ok: false, preservedLocalRef: { sha: local } });
    const retry = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(retry).toMatchObject({ ok: true, sha: subject.baseRef, preservedLocalRef: failed.preservedLocalRef });
    expect((await git(repo, "rev-parse", retry.preservedLocalRef!.ref))).toBe(local);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an unrelated existing lane ref refuses instead of becoming the PR base", async () => {
  const box = (await isolatedIdentityRepo());
  const { root, repo } = box;
  const origin = path.join(root, "origin.git");
  const builder = path.join(root, "builder");
  const writer = path.join(root, "writer");
  const deliveryBranch = "feature/held-pr";
  try {
    (await git(repo, "config", "user.name", "Fixture"));
    (await git(repo, "config", "user.email", "noreply"));
    (await git(repo, "config", "commit.gpgSign", "false"));
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(repo, "remote", "add", "origin", origin));
    (await git(repo, "push", "origin", "main"));
    (await git(repo, "worktree", "add", "-b", deliveryBranch, builder));
    fs.writeFileSync(path.join(builder, "pr.txt"), "existing PR work\n");
    (await git(builder, "add", "pr.txt"));
    (await git(builder, "commit", "-m", "existing PR work"));
    (await git(builder, "push", "origin", deliveryBranch));
    const base = (await git(builder, "rev-parse", "HEAD"));
    fs.writeFileSync(path.join(builder, "pr.txt"), "uncommitted builder work\n");
    fs.writeFileSync(path.join(builder, "keep.txt"), "untracked builder work\n");
    const builderStatus = (await git(builder, "status", "--porcelain"));

    (await git(root, "clone", origin, writer));
    (await git(writer, "config", "user.name", "Fixture"));
    (await git(writer, "config", "user.email", "noreply"));
    (await git(writer, "config", "commit.gpgSign", "false"));
    (await git(writer, "checkout", deliveryBranch));
    fs.writeFileSync(path.join(writer, "foreign.txt"), "unrelated lane history\n");
    (await git(writer, "add", "foreign.txt"));
    (await git(writer, "commit", "-m", "unrelated lane history"));
    const dormantTip = (await git(writer, "rev-parse", "HEAD"));

    const subject = { ...pipeline(), repoDir: repo, worktreeDir: path.join(root, "lane"),
      baseBranch: deliveryBranch, baseRef: base };
    subject.delivery!.target.branch = `refs/heads/${deliveryBranch}`;
    (await git(repo, "fetch", writer, `${dormantTip}:refs/heads/${subject.branch}`));
    expect((await git(repo, "show", `${subject.branch}:foreign.txt`))).toBe("unrelated lane history");

    const result = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the unowned lane ref to be refused");
    expect(result.error).toContain(subject.branch);
    expect(result.error).toContain("no registered lane worktree");
    expect((await git(repo, "rev-parse", subject.branch))).toBe(dormantTip);
    expect(fs.existsSync(subject.worktreeDir)).toBe(false);
    expect((await git(builder, "branch", "--show-current"))).toBe(deliveryBranch);
    expect((await git(builder, "rev-parse", "HEAD"))).toBe(base);
    expect((await git(builder, "status", "--porcelain"))).toBe(builderStatus);
    expect(fs.readFileSync(path.join(builder, "pr.txt"), "utf8")).toBe("uncommitted builder work\n");
    expect(fs.readFileSync(path.join(builder, "keep.txt"), "utf8")).toBe("untracked builder work\n");
    expect((await git(repo, "ls-remote", "--heads", "origin", `refs/heads/${deliveryBranch}`)).split(/\s+/)[0]).toBe(base);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a pipeline branch held by another worktree refuses with the branch, holder and recovery action", async () => {
  const { root, repo } = (await isolatedIdentityRepo());
  try {
    const subject = { ...pipeline(), repoDir: repo, worktreeDir: path.join(root, "repo-pipeline-12345678"),
      baseBranch: "main", baseRef: (await git(repo, "rev-parse", "HEAD")) };
    const holder = path.join(root, "holding lane");
    (await git(repo, "worktree", "add", "-b", subject.branch, holder));
    fs.writeFileSync(path.join(holder, "keep.txt"), "preserve\n");
    const result = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a held pipeline branch refusal");
    expect(result.error).toContain(subject.branch);
    expect(result.error).toContain(holder);
    expect(result.error).toContain("resume its owning lane");
    expect((await git(holder, "branch", "--show-current"))).toBe(subject.branch);
    expect((await git(holder, "rev-parse", "HEAD"))).toBe(subject.baseRef);
    expect(fs.readFileSync(path.join(holder, "keep.txt"), "utf8")).toBe("preserve\n");
    expect(fs.existsSync(subject.worktreeDir)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("provisioning through a symlinked parent adopts its own checkout on retry", async () => {
  const { root, repo } = (await isolatedIdentityRepo());
  try {
    const alias = path.join(root, "alias");
    fs.symlinkSync(root, alias, "dir");
    const subject = { ...pipeline(), repoDir: path.join(alias, "repo"),
      worktreeDir: path.join(alias, "repo-pipeline-12345678"),
      baseBranch: "main", baseRef: (await git(repo, "rev-parse", "HEAD")) };
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(subject.worktreeDir, "keep.txt"), "preserve\n");
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: subject.baseRef });
    expect((await git(subject.worktreeDir, "branch", "--show-current"))).toBe(subject.branch);
    expect(fs.readFileSync(path.join(subject.worktreeDir, "keep.txt"), "utf8")).toBe("preserve\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("new owner checkout starts from an existing delivery head and keeps a divergent remote", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-checkout-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const other = path.join(root, "other");
  try {
    fs.mkdirSync(repo);
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(repo, "init", "--initial-branch=main"));
    (await git(repo, "config", "user.name", "Fixture"));
    (await git(repo, "config", "user.email", "noreply@example.com"));
    (await git(repo, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    (await git(repo, "add", "base.txt"));
    (await git(repo, "commit", "-m", "base"));
    (await git(repo, "remote", "add", "origin", origin));
    (await git(repo, "push", "origin", "main"));
    const base = (await git(repo, "rev-parse", "HEAD"));
    (await git(root, "clone", origin, other));
    (await git(other, "config", "user.name", "Fixture"));
    (await git(other, "config", "user.email", "noreply@example.com"));
    (await git(other, "config", "commit.gpgSign", "false"));
    (await git(other, "checkout", "-b", "feature/shared"));
    fs.writeFileSync(path.join(other, "earlier.txt"), "earlier work\n");
    (await git(other, "add", "earlier.txt"));
    (await git(other, "commit", "-m", "earlier work"));
    (await git(other, "push", "origin", "feature/shared"));
    const earlier = (await git(other, "rev-parse", "HEAD"));

    const subject = pipeline();
    Object.assign(subject, { repoDir: repo, worktreeDir: path.join(root, "repo-pipeline-12345678"), baseBranch: "main", baseRef: base, lastPassedCommit: base });
    subject.delivery!.target = { repository: "repo-fixture", remote: origin, branch: "refs/heads/feature/shared" };
    savePipelines([subject]);
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: earlier });
    expect((await git(subject.worktreeDir, "branch", "--show-current"))).toBe("feature/shared");
    expect(fs.existsSync(path.join(subject.worktreeDir, "earlier.txt"))).toBe(true);
    expect((await realExec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${subject.branch}`], repo)).code).not.toBe(0);

    (await git(repo, "worktree", "remove", subject.worktreeDir));
    fs.writeFileSync(path.join(other, "remote-next.txt"), "next accepted head\n");
    (await git(other, "add", "remote-next.txt"));
    (await git(other, "commit", "-m", "advance delivery"));
    (await git(other, "push", "origin", "feature/shared"));
    const advanced = (await git(other, "rev-parse", "HEAD"));
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: advanced });
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(advanced);

    fs.writeFileSync(path.join(subject.worktreeDir, "local.txt"), "local work\n");
    (await git(subject.worktreeDir, "add", "local.txt"));
    (await git(subject.worktreeDir, "commit", "-m", "local work"));
    const local = (await git(subject.worktreeDir, "rev-parse", "HEAD"));
    fs.writeFileSync(path.join(other, "remote.txt"), "remote work\n");
    (await git(other, "add", "remote.txt"));
    (await git(other, "commit", "-m", "remote work"));
    (await git(other, "push", "origin", "feature/shared"));
    const remote = (await git(other, "rev-parse", "HEAD"));
    const published = await publishPipelineBranch(subject, realExec, { acceptedSha: local });
    expect(published.ok).toBe(false);
    expect(!published.ok && published.error).toContain("fetch and merge the remote commits");
    expect((await git(origin, "rev-parse", "refs/heads/feature/shared"))).toBe(remote);
    expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(local);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provisioning preserves an ignored declared output when the delivery branch starts tracking it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-ignored-collision-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const other = path.join(root, "other");
  const worktree = path.join(root, "lane");
  try {
    fs.mkdirSync(repo);
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(repo, "init", "--initial-branch=main"));
    (await git(repo, "config", "user.name", "Fixture"));
    (await git(repo, "config", "user.email", "noreply"));
    (await git(repo, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(repo, ".gitignore"), "report.md\n");
    (await git(repo, "add", ".gitignore"));
    (await git(repo, "commit", "-m", "base"));
    const base = (await git(repo, "rev-parse", "HEAD"));
    (await git(repo, "remote", "add", "origin", origin));
    (await git(repo, "push", "origin", "main"));
    (await git(repo, "branch", "feature/shared"));
    (await git(repo, "push", "origin", "feature/shared"));
    (await git(repo, "worktree", "add", worktree, "feature/shared"));
    fs.writeFileSync(path.join(worktree, "report.md"), "local declared output\n");
    expect((await git(worktree, "status", "--porcelain"))).toBe("");

    (await git(root, "clone", origin, other));
    (await git(other, "config", "user.name", "Fixture"));
    (await git(other, "config", "user.email", "noreply"));
    (await git(other, "config", "commit.gpgSign", "false"));
    (await git(other, "checkout", "feature/shared"));
    fs.writeFileSync(path.join(other, "report.md"), "remote report\n");
    (await git(other, "add", "-f", "report.md"));
    (await git(other, "commit", "-m", "publish report"));
    (await git(other, "push", "origin", "feature/shared"));

    const subject = pipeline();
    Object.assign(subject, { repoDir: repo, worktreeDir: worktree, baseBranch: "main", baseRef: base, lastPassedCommit: base });
    subject.delivery!.target = { repository: "repo-fixture", remote: origin, branch: "refs/heads/feature/shared" };
    const result = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(worktree, "report.md"), "utf8")).toBe("local declared output\n");
    expect((await git(worktree, "rev-parse", "HEAD"))).toBe(base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("async provisioning preserves the synchronous base and adoption decisions", async () => {
  const sha = "a".repeat(40);
  for (const input of [{}, { baseBranch: "release" }, { baseBranch: "release", baseRef: sha }, { baseBranch: "../bad" }]) {
    for (const fetchCode of [0, 1, 124, 137]) {
      const commands: string[] = [];
      const exec: ExecPort = (command, args) => {
        commands.push([command, ...args].join(" "));
        return args.includes("fetch") ? { code: fetchCode, stdout: "", stderr: "fetch error" }
          : { code: 0, stdout: sha, stderr: "" };
      };
      const expected = (await resolvePipelineBase("/repo", input, exec));
      const expectedCommands = commands.splice(0);
      expect(await resolvePipelineBaseAsync("/repo", input, async (command, args, cwd) => (await exec(command, args, cwd)))).toEqual(expected);
      expect(commands).toEqual(expectedCommands);
    }
  }
  const subject = { ...pipeline(), baseBranch: "main", baseRef: sha };
  for (const addCode of [0, 1]) {
    for (const head of [sha, "b".repeat(40)]) {
      const exec: ExecPort = (_command, args) => args[0] === "worktree" && args[1] === "list"
        ? { code: 0, stdout: `worktree ${subject.worktreeDir}\0HEAD ${head}\0branch refs/heads/${subject.branch}\0\0`, stderr: "" }
        : args[0] === "worktree" ? { code: addCode, stdout: "", stderr: "exists" }
        : { code: 0, stdout: args.includes("--abbrev-ref") ? subject.branch : head, stderr: "" };
      expect(await provisionPipelineWorktreeAsync(subject, async (command, args, cwd) => (await exec(command, args, cwd))))
        .toEqual((await provisionPipelineWorktree(subject, exec)));
    }
  }
});

test("async Git fetch and checkout pin a real advanced remote and adopt only that head", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-async-base-"));
  try {
    const origin = path.join(root, "origin.git");
    const source = path.join(root, "source");
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(root, "clone", origin, source));
    (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "base"));
    (await git(source, "push", "origin", "main"));
    const previous = (await git(source, "rev-parse", "HEAD"));
    (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "advance"));
    (await git(source, "push", "origin", "main"));
    const current = (await git(source, "rev-parse", "HEAD"));
    (await git(source, "checkout", "--detach", previous));
    fs.writeFileSync(path.join(source, "dirty.txt"), "preserve");
    const base = await resolvePipelineBaseAsync(source, {}, realProvisionExec);
    expect(base).toEqual({ ok: true, baseBranch: "main", baseRef: current });
    const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: current };
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: current, baseBranch: "main" });
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: current, baseBranch: "main" });
    expect((await provisionPipelineWorktreeAsync({ ...subject, baseRef: previous }, realProvisionExec)).ok).toBe(false);
    expect((await git(source, "rev-parse", "HEAD"))).toBe(previous);
    expect(fs.readFileSync(path.join(source, "dirty.txt"), "utf8")).toBe("preserve");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("async exec reports launch errors, pre-abort, and a killed timeout without continuing", async () => {
  expect((await realProvisionExec("missing-provision-command", [], publicationState)).code).not.toBe(0);
  const abort = new AbortController();
  abort.abort();
  const marker = path.join(publicationState, "must-not-exist");
  const result = await realProvisionExec("touch", [marker], publicationState, abort.signal);
  expect(result.stderr).toBe("command cancelled");
  expect(fs.existsSync(marker)).toBe(false);
  const calls: string[] = [];
  const base = await resolvePipelineBaseAsync(publicationState, {}, async (command, args, cwd) => {
    calls.push(args.join(" "));
    return (await realProvisionExec(command, [args[0]!, "0.05s", process.execPath, "-e", "setTimeout(() => {}, 5000)"], cwd));
  });
  expect(base).toEqual({ ok: false, error: "fetching origin/main: git fetch timed out after 60s" });
  expect(calls).toHaveLength(1);
});

for (const interruption of ["timeout", "cancellation"] as const) {
  test(`async checkout rejects ${interruption}, and the retry finishes the checkout it began (#2176)`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interrupted-checkout-"));
    const source = path.join(root, "source");
    const marker = path.join(root, "smudge-started");
    const abort = new AbortController();
    let pending: ReturnType<typeof provisionPipelineWorktreeAsync> | undefined;
    try {
      fs.mkdirSync(source);
      (await git(source, "init", "--initial-branch=main"));
      fs.writeFileSync(path.join(source, ".gitattributes"), "tracked.txt filter=slow\n");
      fs.writeFileSync(path.join(source, "tracked.txt"), "complete file\n");
      (await git(source, "add", "."));
      (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base"));
      (await git(source, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`));
      (await git(source, "config", "filter.slow.required", "true"));
      const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: (await git(source, "rev-parse", "HEAD")) };
      pending = provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal) => {
        // Exercise a real killed checkout without making this regression wait
        // sixty seconds. All probes still use the production asynchronous port.
        if (interruption === "timeout" && args[0] === "worktree" && args[1] === "add") {
          return (await realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal));
        }
        return (await realProvisionExec(command, args, cwd, signal));
      }, abort.signal);
      for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt += 1) await Bun.sleep(10);
      expect(fs.existsSync(marker)).toBe(true);
      if (interruption === "cancellation") abort.abort();
      const result = await pending;
      expect((await git(subject.worktreeDir, "branch", "--show-current"))).toBe(subject.branch);
      expect((await git(subject.worktreeDir, "rev-parse", "HEAD"))).toBe(subject.baseRef);
      expect((await git(source, "worktree", "list", "--porcelain"))).toContain("locked initializing");
      expect(fs.existsSync(path.join(subject.worktreeDir, "tracked.txt"))).toBe(false);
      fs.writeFileSync(path.join(subject.worktreeDir, "keep.txt"), "preserve partial checkout\n");
      expect(result.ok).toBe(false);
      // No Git process is left on the checkout: the retry does what the killed add had left to do.
      (await git(source, "config", "filter.slow.smudge", "cat"));
      (await git(source, "config", "filter.slow.clean", "cat"));
      const retry = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
      expect(retry).toEqual({ ok: true, sha: subject.baseRef, baseBranch: "main" });
      expect(fs.readFileSync(path.join(subject.worktreeDir, "tracked.txt"), "utf8")).toBe("complete file\n");
      expect(fs.readFileSync(path.join(subject.worktreeDir, "keep.txt"), "utf8")).toBe("preserve partial checkout\n");
      expect((await git(source, "worktree", "list", "--porcelain"))).not.toContain("locked");
    } finally {
      abort.abort();
      await pending;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
}

test("interrupted checkout recovery preserves whitespace paths and symlinks across target states", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interrupted-checkout-paths-"));
  const source = path.join(root, "source");
  const marker = path.join(root, "smudge-started");
  try {
    fs.mkdirSync(source);
    (await git(source, "init", "--initial-branch=main"));
    fs.writeFileSync(path.join(source, ".gitattributes"), "zzslow filter=slow\n");
    fs.writeFileSync(path.join(source, "my file.txt"), "space path content\n");
    fs.writeFileSync(path.join(source, "my\tfile.txt"), "tab path content\n");
    fs.writeFileSync(path.join(source, "00-target"), "existing target\n");
    fs.symlinkSync("00-target", path.join(source, "link-existing"));
    fs.symlinkSync("zzz-target", path.join(source, "link-missing"));
    fs.writeFileSync(path.join(source, "zzslow"), "slow checkout trigger\n");
    fs.writeFileSync(path.join(source, "zzz-target"), "late target\n");
    (await git(source, "add", "."));
    (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base"));
    (await git(source, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`));
    (await git(source, "config", "filter.slow.required", "true"));
    const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: (await git(source, "rev-parse", "HEAD")) };
    const interrupted = await provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal) => {
      if (args[0] === "worktree" && args[1] === "add") return (await realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal));
      return (await realProvisionExec(command, args, cwd, signal));
    });
    expect(interrupted.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(path.join(subject.worktreeDir, "zzz-target"))).toBe(false);
    expect(fs.lstatSync(path.join(subject.worktreeDir, "link-missing")).isSymbolicLink()).toBe(true);
    (await git(source, "config", "filter.slow.smudge", "cat"));
    (await git(source, "config", "filter.slow.clean", "cat"));

    const retry = await provisionPipelineWorktreeAsync(subject, realProvisionExec);

    expect(retry).toEqual({ ok: true, sha: subject.baseRef, baseBranch: "main" });
    expect(fs.readFileSync(path.join(subject.worktreeDir, "my file.txt"), "utf8")).toBe("space path content\n");
    expect(fs.readFileSync(path.join(subject.worktreeDir, "my\tfile.txt"), "utf8")).toBe("tab path content\n");
    expect(fs.readlinkSync(path.join(subject.worktreeDir, "link-existing"))).toBe("00-target");
    expect(fs.readlinkSync(path.join(subject.worktreeDir, "link-missing"))).toBe("zzz-target");
    expect(fs.readFileSync(path.join(subject.worktreeDir, "link-missing"), "utf8")).toBe("late target\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("interrupted checkout recovery rejects and preserves a changed tracked symlink", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interrupted-checkout-symlink-"));
  const source = path.join(root, "source");
  const marker = path.join(root, "smudge-started");
  try {
    fs.mkdirSync(source);
    (await git(source, "init", "--initial-branch=main"));
    fs.writeFileSync(path.join(source, ".gitattributes"), "zzslow filter=slow\n");
    fs.writeFileSync(path.join(source, "target"), "target\n");
    fs.symlinkSync("target", path.join(source, "link"));
    fs.writeFileSync(path.join(source, "zzslow"), "slow checkout trigger\n");
    (await git(source, "add", "."));
    (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base"));
    (await git(source, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`));
    (await git(source, "config", "filter.slow.required", "true"));
    const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: (await git(source, "rev-parse", "HEAD")) };
    const interrupted = await provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal) => {
      if (args[0] === "worktree" && args[1] === "add") return (await realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal));
      return (await realProvisionExec(command, args, cwd, signal));
    });
    expect(interrupted.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(path.join(subject.worktreeDir, "link"));
    fs.symlinkSync("changed-target", path.join(subject.worktreeDir, "link"));
    (await git(source, "config", "filter.slow.smudge", "cat"));
    (await git(source, "config", "filter.slow.clean", "cat"));

    const retry = await provisionPipelineWorktreeAsync(subject, realProvisionExec);

    expect(retry).toMatchObject({ ok: false, error: "the interrupted pipeline checkout contains a modified tracked path (link); preserve it, move it aside, then retry-stage" });
    expect(fs.readlinkSync(path.join(subject.worktreeDir, "link"))).toBe("changed-target");
    expect((await git(source, "worktree", "list", "--porcelain"))).toContain("locked initializing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("async adoption preserves untracked files and edits made after its safety scan", async () => {
  const source = path.join(publicationState, "source");
  fs.mkdirSync(source);
  (await git(source, "init", "--initial-branch=main"));
  fs.writeFileSync(path.join(source, "tracked.txt"), "complete file\n");
  (await git(source, "add", "."));
  (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base"));
  const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(publicationState, "lane"), baseBranch: "main", baseRef: (await git(source, "rev-parse", "HEAD")) };
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  fs.writeFileSync(path.join(subject.worktreeDir, "keep.txt"), "preserve\n");
  (await git(source, "worktree", "lock", "--reason", "initializing", subject.worktreeDir));
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  expect((await git(source, "worktree", "list", "--porcelain"))).not.toContain("locked");
  (await git(source, "worktree", "lock", "--reason", "initializing", subject.worktreeDir));
  const tracked = path.join(subject.worktreeDir, "tracked.txt");
  const changedAfterScan = "concurrent operator edit\n";
  let injected = false;
  const racingExec = async (command: string, args: string[], cwd: string, signal?: AbortSignal) => {
    const result = await realProvisionExec(command, args, cwd, signal);
    if (!injected && command === "git" && args[0] === "rev-parse" && args.includes("--git-dir")) {
      injected = true;
      fs.writeFileSync(tracked, changedAfterScan);
    }
    return result;
  };
  const recovered = await provisionPipelineWorktreeAsync(subject, racingExec);
  expect(injected).toBe(true);
  expect(recovered.ok).toBe(false);
  expect(fs.readFileSync(tracked, "utf8")).toBe(changedAfterScan);
  expect((await git(source, "worktree", "list", "--porcelain"))).toContain("locked initializing");
  fs.writeFileSync(tracked, "complete file\n");
  (await git(source, "worktree", "unlock", subject.worktreeDir));
  (await git(source, "worktree", "lock", "--reason", "preserve checkout", subject.worktreeDir));
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  fs.unlinkSync(path.join(subject.worktreeDir, "tracked.txt"));
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(false);
  expect(fs.readFileSync(path.join(subject.worktreeDir, "keep.txt"), "utf8")).toBe("preserve\n");
});

test.skipIf(process.platform === "win32")("an initialization a live Git process still holds is left alone and reported as held (#2176)", async () => {
  const source = path.join(publicationState, "source");
  fs.mkdirSync(source);
  (await git(source, "init", "--initial-branch=main"));
  fs.writeFileSync(path.join(source, "tracked.txt"), "complete file\n");
  (await git(source, "add", "."));
  (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base"));
  const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(publicationState, "lane"), baseBranch: "main", baseRef: (await git(source, "rev-parse", "HEAD")) };
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  (await git(source, "worktree", "lock", "--reason", "initializing", subject.worktreeDir));
  fs.unlinkSync(path.join(subject.worktreeDir, "tracked.txt"));
  // A Git process still working inside the checkout, as a slow add's checkout would be.
  const owner = Bun.spawn(["git", "-C", subject.worktreeDir, "-c", "alias.hold=!sleep 5", "hold"], { stdout: "ignore", stderr: "ignore" });
  try {
    await Bun.sleep(200);
    const held = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(held).toEqual({ ok: false, error: `the pipeline worktree is still being initialized by git process ${owner.pid}` });
    expect((await git(source, "worktree", "list", "--porcelain"))).toContain("locked initializing");
    expect(fs.existsSync(path.join(subject.worktreeDir, "tracked.txt"))).toBe(false);
  } finally { owner.kill("SIGKILL"); await owner.exited; }
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  expect(fs.readFileSync(path.join(subject.worktreeDir, "tracked.txt"), "utf8")).toBe("complete file\n");
});

test("default base fetches and resolves origin/main without inspecting a dirty stale checkout", async () => {
  const calls: string[] = [];
  const expectedBase = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "rev-parse") return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect((await resolvePipelineBase("/repo", {}, exec))).toEqual({ ok: true, baseBranch: "main", baseRef: expectedBase });
  expect(calls).toEqual([
    "timeout --signal=KILL 60s git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    "git rev-parse --verify --end-of-options origin/main^{commit}",
  ]);
});

test("a base fetch the network never answers is killed at its bound and reported as a timeout (#1692)", async () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return command === "timeout" ? { code: null, stdout: "", stderr: "", signal: "SIGKILL" } : { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  };

  expect((await resolvePipelineBase("/repo", {}, exec))).toEqual({ ok: false, error: "fetching origin/main: git fetch timed out after 60s" });
  expect(calls).toEqual(["timeout --signal=KILL 60s git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main"]);
});

test("an explicit base resolves to an exact SHA without fetching", async () => {
  const calls: string[] = [];
  const expectedBase = "1234567890abcdef1234567890abcdef12345678";
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
  };

  expect((await resolvePipelineBase("/repo", { baseBranch: "release", baseRef: "release-candidate" }, exec)))
    .toEqual({ ok: true, baseBranch: "release", baseRef: expectedBase });
  expect(calls).toEqual(["git rev-parse --verify --end-of-options release-candidate^{commit}"]);
});

test("an unavailable origin fails base resolution before worktree provisioning", async () => {
  const exec: ExecPort = () => ({ code: 128, stdout: "", stderr: "could not read from remote" });

  expect((await resolvePipelineBase("/repo", {}, exec))).toEqual({
    ok: false,
    error: "fetching origin/main: could not read from remote",
  });
});

test("an unsafe base branch is rejected before git receives it", async () => {
  let calls = 0;
  const exec: ExecPort = () => {
    calls += 1;
    return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  };

  expect((await resolvePipelineBase("/repo", { baseBranch: "../escaped" }, exec))).toEqual({
    ok: false,
    error: "the pipeline base branch is invalid",
  });
  expect(calls).toBe(0);
});

test("worktree provision uses the persisted exact base without reading a detached source HEAD", async () => {
  const calls: string[] = [];
  const expectedBase = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const subject = pipeline();
  subject.baseBranch = "main";
  subject.baseRef = expectedBase;
  subject.lastPassedCommit = expectedBase;
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "HEAD\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect((await provisionPipelineWorktree(subject, exec))).toEqual({ ok: true, sha: expectedBase, baseBranch: "main" });
  expect(calls).toContain(`git worktree add -b pipeline/task-12345678 /repo-pipeline-12345678 ${expectedBase}`);
  expect(calls).not.toContain("git rev-parse --abbrev-ref HEAD");
});

test("worktree provision recovers an existing branch only at the persisted exact base", async () => {
  const expectedBase = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const subject = pipeline();
  subject.baseBranch = "main";
  subject.baseRef = expectedBase;
  subject.lastPassedCommit = expectedBase;
  const exec: ExecPort = (_command, args) => {
    if (args[0] === "worktree") return { code: 128, stdout: "", stderr: "already exists" };
    if (args[1] === "--abbrev-ref") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
  };

  expect((await provisionPipelineWorktree(subject, exec))).toEqual({ ok: true, sha: expectedBase, baseBranch: "main" });

  const wrongHead: ExecPort = (_command, args) => {
    if (args[0] === "worktree") return { code: 128, stdout: "", stderr: "already exists" };
    if (args[1] === "--abbrev-ref") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    return { code: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" };
  };
  expect((await provisionPipelineWorktree(subject, wrongHead))).toEqual({
    ok: false,
    error: "the pipeline worktree does not match its persisted base",
  });
});
test("pass commits a dirty stage and retry resets plus cleans", async () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: " M src/x.ts\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "stage-sha\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect((await commitPipelineStage(pipeline(), "build", true, exec))).toEqual({ ok: true, sha: "stage-sha" });
  expect((await resetPipelineStage(pipeline(), exec))).toEqual({ ok: true, sha: "base" });
  expect(calls).toContain(`git reset --quiet HEAD -- ${CONTROLLER_ARTIFACT_GIT_PATHS.join(" ")}`);
  expect(calls).toContain(`git add -A -- . ${CONTROLLER_ARTIFACT_PATHSPECS.join(" ")}`);
  expect(calls).toContain("git reset --hard base");
  expect(calls).toContain("git clean -fd");
});

test.each(["missing", "malformed", "nonce", "tree", "newer-changes"] as const)("owned output recovery refuses %s proof and preserves the checkout", async (change) => {
  const box = await isolatedIdentityRepo();
  try {
    const subject = pipeline(); subject.worktreeDir = box.repo;
    subject.lastPassedCommit = await box.run("rev-parse", "HEAD");
    fs.writeFileSync(path.join(box.repo, "report.md"), "owned output\n");
    const receiptFile = path.join(box.root, "stage-commit.json");
    const committed = await commitPipelineStage(subject, "audit", false, box.exec, ["report.md"], subject.lastPassedCommit, receiptFile);
    expect(committed.ok).toBe(true);
    if (change === "missing") fs.unlinkSync(receiptFile);
    if (change === "malformed") fs.writeFileSync(receiptFile, "{torn receipt");
    const identity = ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid"];
    if (change === "nonce") await box.run(...identity, "commit", "--amend", "-m", "unowned replacement");
    if (change === "tree") {
      fs.writeFileSync(path.join(box.repo, "report.md"), "different output\n");
      await box.run("add", "report.md"); await box.run(...identity, "commit", "--amend", "--no-edit");
    }
    if (change === "newer-changes") fs.writeFileSync(path.join(box.repo, "report.md"), "newer output\n");
    const head = await box.run("rev-parse", "HEAD");
    const content = fs.readFileSync(path.join(box.repo, "report.md"), "utf8");
    expect(await commitPipelineStage(subject, "audit", false, box.exec, ["report.md"], subject.lastPassedCommit, receiptFile)).toMatchObject({ ok: false });
    expect(await box.run("rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(box.repo, "report.md"), "utf8")).toBe(content);
    if (change === "malformed") expect(fs.readFileSync(receiptFile, "utf8")).toBe("{torn receipt");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("artifact protection uses the supplied asynchronous executor and refuses cancellation", async () => {
  const box = await isolatedIdentityRepo();
  const subject = pipeline(); subject.worktreeDir = box.repo;
  subject.lastPassedCommit = await box.run("rev-parse", "HEAD");
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const exec: ExecPort = async (command, args, cwd, env, options) => {
    if (args.includes("--show-toplevel")) {
      entered(); await held;
      expect(options?.timeoutMs).toBe(10_000);
      return { code: null, stdout: "", stderr: "command cancelled" };
    }
    return await box.exec(command, args, cwd, env);
  };
  const work = commitPipelineStage(subject, "audit", false, exec);
  try {
    expect(await Promise.race([checking.then(() => "checking"), work.then(() => "completed")])).toBe("checking");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    release(); expect(await work).toMatchObject({ ok: false, error: expect.stringContaining("controller artifact") });
    expect(await box.run("rev-parse", "HEAD")).toBe(subject.lastPassedCommit);
  } finally { release(); await work; fs.rmSync(box.root, { recursive: true, force: true }); }
});

async function allowMarkdownArtifacts(box: Awaited<ReturnType<typeof isolatedIdentityRepo>>) {
  fs.writeFileSync(path.join(box.repo, ".gitignore"), "!*/\n!*.md\n");
  fs.mkdirSync(path.join(box.repo, ".artifacts", "pipeline-stage-inputs"), { recursive: true });
  fs.writeFileSync(path.join(box.repo, ".artifacts", "pipeline-stage-inputs", ".gitignore"), "!*.md\n");
  (await box.run("add", ".gitignore", ".artifacts/pipeline-stage-inputs/.gitignore"));
  (await box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "allow markdown files"));
}

async function stagePrivateHandoffs(box: Awaited<ReturnType<typeof isolatedIdentityRepo>>) {
  const handoffs = path.join(box.repo, ".artifacts", "pipeline-stage-inputs");
  const output = path.join(handoffs, "previous-output-digest.md");
  const specification = path.join(handoffs, "specification-digest.md");
  fs.writeFileSync(output, "previous stage output\n".repeat(2000));
  fs.writeFileSync(specification, "private stage specification\n".repeat(2000));
  (await box.run("add", "-A"));
  expect((await box.run("diff", "--cached", "--name-only"))).toContain(".artifacts/pipeline-stage-inputs/previous-output-digest.md");
  return { output, specification };
}

test("read-write settlement removes pre-staged controller artifacts from the commit and keeps stage work", async () => {
  const box = await isolatedIdentityRepo();
  try {
    (await allowMarkdownArtifacts(box));
    const handoffs = (await stagePrivateHandoffs(box));
    fs.writeFileSync(path.join(box.repo, "source.ts"), "export const value = 2;\n");
    (await box.run("add", "-A"));

    const subject = pipeline();
    subject.worktreeDir = box.repo;
    expect((await commitPipelineStage(subject, "build", true, box.exec)).ok).toBe(true);

    expect((await box.run("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).split("\n")).toEqual(["source.ts"]);
    expect((await box.run("diff", "--cached", "--name-only"))).toBe("");
    expect(fs.readFileSync(handoffs.output, "utf8")).toBe("previous stage output\n".repeat(2000));
    expect(fs.readFileSync(handoffs.specification, "utf8")).toBe("private stage specification\n".repeat(2000));
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test.each([
  { label: "read-write changes", allowCommit: true, output: false, changed: true },
  { label: "read-write no change", allowCommit: true, output: false, changed: false },
  { label: "read-only no outputs", allowCommit: false, output: false, changed: false },
  { label: "read-only unchanged output", allowCommit: false, output: true, changed: false },
  { label: "read-only changed output", allowCommit: false, output: true, changed: true },
].flatMap((mode) => [true, false].map((staged) => ({ ...mode, staged }))))("$label settlement protects nested structured handoffs (staged=$staged) before stage and ordinary worker commits", async ({ allowCommit, output, changed, staged }) => {
  const box = await isolatedIdentityRepo();
  try {
    (await box.run("config", "user.name", "Fixture"));
    (await box.run("config", "user.email", "noreply@example.invalid"));
    if (output) {
      fs.mkdirSync(path.join(box.repo, "reports"));
      fs.writeFileSync(path.join(box.repo, "reports/audit.md"), "baseline audit\n");
      (await box.run("add", "reports/audit.md"));
      (await box.run("commit", "-m", "baseline audit"));
    }
    const cwd = path.join(box.repo, "package");
    fs.mkdirSync(cwd);
    const { composeStructuredFirstMessage } = await import("@/lib/runtime/structuredFirstMessage");
    const input = "PRIVATE_NESTED_SETTLEMENT_SENTINEL\n" + "Full context\n".repeat(3_000);
    const delivered = (await composeStructuredFirstMessage(input, cwd));
    const file = delivered.match(/Full structured first message file: (.+)\n/)?.[1];
    if (staged) (await box.run("add", "-f", path.relative(box.repo, file!)));
    else fs.unlinkSync(path.join(path.dirname(file!), ".gitignore"));
    const head = (await box.run("rev-parse", "HEAD"));
    const work = output ? "reports/audit.md" : "source.ts";
    if (changed) fs.writeFileSync(path.join(box.repo, work), "worker result\n");
    const subject = pipeline();
    subject.worktreeDir = box.repo;
    const result = (await commitPipelineStage(subject, "build", allowCommit, box.exec, output ? [work] : [], head));
    expect(result).toMatchObject({ ok: true });
    expect((await box.run("diff", "--cached", "--name-only"))).toBe("");
    expect((await box.run("ls-files", "--", "package/.artifacts/pipeline-stage-inputs"))).toBe("");
    expect(fs.readFileSync(file!, "utf8")).toBe(input);
    if (changed) expect((await box.run("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))).toBe(work);
    else expect((await box.run("rev-parse", "HEAD"))).toBe(head);
    fs.writeFileSync(path.join(box.repo, "source.ts"), "ordinary worker result\n");
    (await box.run("add", "-A"));
    (await box.run("commit", "-m", "ordinary worker change"));
    expect((await box.run("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))).toBe("source.ts");
    expect((await box.run("show", "--format=", "HEAD"))).not.toContain("PRIVATE_NESTED_SETTLEMENT_SENTINEL");
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test.each([
  { label: "read-write", allowCommit: true, declaredOutputs: [] as string[] },
  { label: "read-only without outputs", allowCommit: false, declaredOutputs: [] as string[] },
  { label: "read-only with an unchanged declared output", allowCommit: false, declaredOutputs: ["reports/audit.md"] },
])("a successful no-change $label settlement unstages private handoffs before ordinary worker commits", async ({ allowCommit, declaredOutputs }) => {
  const box = await isolatedIdentityRepo();
  try {
    (await allowMarkdownArtifacts(box));
    if (declaredOutputs.length > 0) {
      fs.mkdirSync(path.join(box.repo, "reports"), { recursive: true });
      fs.writeFileSync(path.join(box.repo, "reports/audit.md"), "unchanged audit\n");
      (await box.run("add", "reports/audit.md"));
      (await box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "add audit output"));
    }
    (await stagePrivateHandoffs(box));

    const subject = pipeline();
    subject.worktreeDir = box.repo;
    const head = (await box.run("rev-parse", "HEAD"));
    expect((await commitPipelineStage(subject, "build", allowCommit, box.exec, declaredOutputs, head))).toEqual({ ok: true, sha: head });
    expect((await box.run("diff", "--cached", "--name-only"))).toBe("");

    fs.writeFileSync(path.join(box.repo, ".artifacts", "pipeline-stage-inputs", ".gitignore"), "*\n");
    fs.writeFileSync(path.join(box.repo, "source.ts"), "export const value = 2;\n");
    (await box.run("add", "-A"));
    (await box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "ordinary worker commit"));
    const committed = (await box.run("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).split("\n");
    expect(committed).toContain("source.ts");
    expect(committed).not.toContain(".artifacts/pipeline-stage-inputs/previous-output-digest.md");
    expect(committed).not.toContain(".artifacts/pipeline-stage-inputs/specification-digest.md");
    expect((await box.run("diff", "--cached", "--name-only"))).toBe("");
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("read-only settlement commits its declared output without pre-staged controller artifacts", async () => {
  const box = await isolatedIdentityRepo();
  try {
    (await allowMarkdownArtifacts(box));
    const handoffs = (await stagePrivateHandoffs(box));
    fs.mkdirSync(path.join(box.repo, "reports"));
    fs.writeFileSync(path.join(box.repo, "reports", "audit.md"), "audited\n");
    (await box.run("add", "-A"));

    const subject = pipeline();
    subject.worktreeDir = box.repo;
    subject.lastPassedCommit = (await box.run("rev-parse", "HEAD"));
    expect((await commitPipelineStage(subject, "audit", false, box.exec, ["reports/audit.md"])).ok).toBe(true);

    expect((await box.run("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).split("\n")).toEqual(["reports/audit.md"]);
    expect((await box.run("diff", "--cached", "--name-only"))).toBe("");
    expect(fs.readFileSync(handoffs.output, "utf8")).toBe("previous stage output\n".repeat(2000));
    expect(fs.readFileSync(handoffs.specification, "utf8")).toBe("private stage specification\n".repeat(2000));
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("read-only declared output commits with no host Git identity and leaves config untouched", async () => {
  const box = (await isolatedIdentityRepo());
  try {
    const subject = pipeline();
    subject.worktreeDir = box.repo;
    subject.lastPassedCommit = (await box.run("rev-parse", "HEAD"));
    expect((await box.exec("git", ["var", "GIT_AUTHOR_IDENT"], box.repo)).code).not.toBe(0);
    expect((await box.exec("git", ["var", "GIT_COMMITTER_IDENT"], box.repo)).code).not.toBe(0);
    fs.mkdirSync(path.join(box.repo, "reports"));
    fs.writeFileSync(path.join(box.repo, "reports", "audit.md"), "audited\n");

    const result = (await commitPipelineStage(subject, "audit", false, box.exec, ["reports/audit.md"]));
    expect(result.ok).toBe(true);
    expect((await box.run("show", "--name-only", "--format=", "HEAD"))).toBe("reports/audit.md");
    const fallbackEmail = ["noreply", "delegatus.invalid"].join("@");
    expect((await box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce"))).toBe(
      ["Delegatus", fallbackEmail, "Delegatus", fallbackEmail].join("\n"),
    );
    expect((await box.exec("git", ["config", "--local", "--get", "user.name"], box.repo)).code).not.toBe(0);
    expect((await box.exec("git", ["config", "--local", "--get", "user.email"], box.repo)).code).not.toBe(0);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test.each([false, true])("read-only output uses the controller identity despite personal Git config (role-specific: %s) and passes publication", async (roleSpecific) => {
  const box = (await isolatedIdentityRepo());
  try {
    const email = ["configured", "example.invalid"].join("@");
    (await box.run("config", "--local", "user.name", "Configured Test"));
    (await box.run("config", "--local", "user.email", email));
    if (roleSpecific) {
      for (const role of ["author", "committer"]) {
        (await box.run("config", "--local", `${role}.name`, `Configured ${role}`));
        (await box.run("config", "--local", `${role}.email`, [role, "example.invalid"].join("@")));
      }
    }
    const configBefore = (await box.run("config", "--local", "--list"));
    const subject = pipeline();
    subject.worktreeDir = box.repo;
    subject.lastPassedCommit = (await box.run("rev-parse", "HEAD"));
    fs.mkdirSync(path.join(box.repo, "reports"));
    fs.writeFileSync(path.join(box.repo, "reports", "audit.md"), "audited\n");

    expect((await commitPipelineStage(subject, "audit", false, box.exec, ["reports/audit.md"])).ok).toBe(true);
    const controllerEmail = ["noreply", "delegatus.invalid"].join("@");
    expect((await box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce"))).toBe(
      ["Delegatus", controllerEmail, "Delegatus", controllerEmail].join("\n"),
    );
    expect((await box.run("config", "--local", "--get", "user.email"))).toBe(email);
    expect((await box.run("config", "--local", "--get", "user.name"))).toBe("Configured Test");
    expect((await box.run("config", "--local", "--list"))).toBe(configBefore);
    const publication = (await box.exec(process.execPath, [
      path.resolve("scripts/privacy-publication-gate.ts"), "--repository", box.repo,
      "--base", subject.lastPassedCommit, "--check-commits",
    ], box.repo));
    expect(publication.stdout + publication.stderr).toContain("PRIVACY GATE: PASS");
    expect(publication.code).toBe(0);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("controller stage commit overrides inherited identities and leaves agent commits untouched", async () => {
  const box = (await isolatedIdentityRepo());
  try {
    const authorEmail = ["author", "example.invalid"].join("@");
    const committerEmail = ["committer", "example.invalid"].join("@");
    Object.assign(box.env, {
      GIT_AUTHOR_NAME: "Environment Author", GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: "Environment Committer", GIT_COMMITTER_EMAIL: committerEmail,
    });
    fs.writeFileSync(path.join(box.repo, "source.ts"), "export const value = 2;\n");
    const subject = pipeline();
    subject.worktreeDir = box.repo;

    expect((await commitPipelineStage(subject, "build", true, box.exec)).ok).toBe(true);
    const controllerEmail = ["noreply", "delegatus.invalid"].join("@");
    expect((await box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce"))).toBe(
      ["Delegatus", controllerEmail, "Delegatus", controllerEmail].join("\n"),
    );
    (await box.run("commit", "--allow-empty", "-m", "agent work"));
    expect((await box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce"))).toBe(
      ["Environment Author", authorEmail, "Environment Committer", committerEmail].join("\n"),
    );
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("read-only stage records a declared report without granting source commits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-output-"));
  try {
    (await git(root, "init", "--initial-branch=main"));
    (await git(root, "config", "user.email", "pipeline-test"));
    (await git(root, "config", "user.name", "Pipeline Test"));
    (await git(root, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    (await git(root, "add", "source.ts"));
    (await git(root, "commit", "-m", "initial"));

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = (await git(root, "rev-parse", "HEAD"));
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");

    expect(fs.readFileSync(path.join(root, "reports", "audit.md"), "utf8")).toBe("audited\n");
    const result = (await commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"]));
    expect(result.ok).toBeTrue();
    expect((await git(root, "show", "--name-only", "--format=", "HEAD"))).toBe("reports/audit.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage records an ignored declared report", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-ignored-output-"));
  try {
    (await git(root, "init", "--initial-branch=main"));
    (await git(root, "config", "user.email", "pipeline-test"));
    (await git(root, "config", "user.name", "Pipeline Test"));
    (await git(root, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(root, ".gitignore"), "reports/\n");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    (await git(root, "add", ".gitignore", "source.ts"));
    (await git(root, "commit", "-m", "initial"));

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = (await git(root, "rev-parse", "HEAD"));
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");

    expect((await git(root, "status", "--porcelain"))).toBe("");
    const result = (await commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"]));
    expect(result.ok).toBeTrue();
    expect(result.ok && result.sha).not.toBe(subject.lastPassedCommit);
    expect((await git(root, "show", "HEAD:reports/audit.md"))).toBe("audited");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a declared output directory leaves ignored descendants alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-output-directory-"));
  try {
    (await git(root, "init", "--initial-branch=main"));
    (await git(root, "config", "user.email", "pipeline-test"));
    (await git(root, "config", "user.name", "Pipeline Test"));
    (await git(root, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(root, ".gitignore"), "reports/private/\n");
    (await git(root, "add", ".gitignore"));
    (await git(root, "commit", "-m", "initial"));
    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = (await git(root, "rev-parse", "HEAD"));
    fs.mkdirSync(path.join(root, "reports", "private"), { recursive: true });
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    fs.writeFileSync(path.join(root, "reports", "private", "sentinel.txt"), "leave alone\n");

    expect((await commitPipelineStage(subject, "audit", false, realExec, ["reports"]))).toMatchObject({ ok: true });
    expect((await git(root, "show", "--name-only", "--format=", "HEAD"))).toBe("reports/audit.md");
    expect(fs.readFileSync(path.join(root, "reports", "private", "sentinel.txt"), "utf8")).toBe("leave alone\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage refuses source edits beside a declared report", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-source-"));
  try {
    (await git(root, "init", "--initial-branch=main"));
    (await git(root, "config", "user.email", "pipeline-test"));
    (await git(root, "config", "user.name", "Pipeline Test"));
    (await git(root, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    (await git(root, "add", "source.ts"));
    (await git(root, "commit", "-m", "initial"));

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = (await git(root, "rev-parse", "HEAD"));
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 2;\n");

    expect((await commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"]))).toEqual({
      ok: false,
      error: "read-only stage audit modified undeclared worktree paths",
    });
    expect((await git(root, "rev-parse", "HEAD"))).toBe(subject.lastPassedCommit);
    expect((await git(root, "status", "--porcelain"))).toContain("source.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage refuses an agent-created commit even when it contains only a declared report", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-commit-"));
  try {
    (await git(root, "init", "--initial-branch=main"));
    (await git(root, "config", "user.email", "pipeline-test"));
    (await git(root, "config", "user.name", "Pipeline Test"));
    (await git(root, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    (await git(root, "add", "source.ts"));
    (await git(root, "commit", "-m", "initial"));

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = (await git(root, "rev-parse", "HEAD"));
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    (await git(root, "add", "reports/audit.md"));
    (await git(root, "commit", "-m", "agent commit"));

    expect((await commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"]))).toEqual({
      ok: false,
      error: "read-only stage audit created a commit",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review retry preserves a local additive repair that is ahead of origin (#522)", async () => {
  const subject = pipeline();
  const remoteHead = "a".repeat(40);
  const localRepair = "b".repeat(40);
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${remoteHead}\trefs/heads/${subject.branch}\n`, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localRepair}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${remoteHead}\n`, stderr: "" };
    if (args[0] === "merge-base" && args[2] === remoteHead) return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect((await synchronizePipelineRetryHead(subject, exec))).toEqual({ ok: true, sha: localRepair });
  expect(calls.some((call) => call.startsWith("git merge --ff-only"))).toBe(false);
  expect(calls.some((call) => call.includes("reset --hard"))).toBe(false);
});

test("issue 533: manual review retry never resets clean remote 8232d71 to stale a88ddee", async () => {
  const subject = pipeline();
  const synchronizedHead = "8232d71c8f1fb62f972d5f68163f15c244e0f358";
  subject.lastPassedCommit = "a88ddeeef4c2f173be867c775994997e22ab2c5b";
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${synchronizedHead}\trefs/heads/${subject.branch}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${synchronizedHead}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect((await synchronizePipelineRetryHead(subject, exec))).toEqual({ ok: true, sha: synchronizedHead });
  expect(calls.some((call) => call.includes("reset --hard"))).toBe(false);
  expect(calls.some((call) => call.startsWith("git merge "))).toBe(false);
});

test("review retry preserves an ignored declared output when the remote repair starts tracking it", async () => {
  const box = (await publishSandbox());
  const other = path.join(box.root, "other");
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, ".gitignore"), "report.md\n");
    (await git(box.subject.worktreeDir, "add", ".gitignore"));
    (await git(box.subject.worktreeDir, "commit", "-m", "ignore report"));
    const local = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: local })).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(box.subject.worktreeDir, "report.md"), "local declared output\n");
    expect((await git(box.subject.worktreeDir, "status", "--porcelain"))).toBe("");

    (await git(box.root, "clone", box.origin, other));
    (await git(other, "config", "user.name", "Fixture"));
    (await git(other, "config", "user.email", "noreply"));
    (await git(other, "config", "commit.gpgSign", "false"));
    (await git(other, "checkout", box.subject.branch));
    fs.writeFileSync(path.join(other, "report.md"), "remote repair\n");
    (await git(other, "add", "-f", "report.md"));
    (await git(other, "commit", "-m", "publish repair"));
    (await git(other, "push", "origin", box.subject.branch));

    const result = (await synchronizePipelineRetryHead(box.subject, realExec));
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(box.subject.worktreeDir, "report.md"), "utf8")).toBe("local declared output\n");
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(local);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("a real dirty worktree reports its uncommitted paths and keeps every one of them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-close-"));
  const repo = path.join(root, "repo");
  try {
    fs.mkdirSync(repo);
    (await git(repo, "init", "--initial-branch=main"));
    (await git(repo, "config", "user.email", "pipeline-test@example.com"));
    (await git(repo, "config", "user.name", "Pipeline Test"));
    (await git(repo, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "renamed.txt"), "moved\n");
    (await git(repo, "add", "-A"));
    (await git(repo, "commit", "-m", "base"));

    fs.writeFileSync(path.join(repo, "tracked.txt"), "stage work in progress\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "never discard me\n");
    (await git(repo, "mv", "renamed.txt", "moved.txt"));

    const subject = pipeline();
    subject.worktreeDir = repo;
    const changes = (await pipelineWorktreeChanges(subject, realExec));

    expect(changes).toEqual({ ok: true, paths: ["moved.txt", "tracked.txt", "untracked.txt"], truncated: false });
    /* Reading the worktree must never mutate it: the close preserves the work. */
    expect(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8")).toBe("never discard me\n");
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("stage work in progress\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree change reporting truncates long lists and surfaces an unreadable worktree", async () => {
  const many: ExecPort = () => ({
    code: 0,
    stdout: Array.from({ length: 22 }, (_, index) => `?? file-${index}.txt`).join("\n"),
    stderr: "",
  });
  const reported = (await pipelineWorktreeChanges(pipeline(), many, 20));
  expect(reported).toMatchObject({ ok: true, truncated: true });
  expect(reported.ok && reported.paths).toHaveLength(20);

  const missing: ExecPort = () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
  expect((await pipelineWorktreeChanges(pipeline(), missing))).toEqual({
    ok: false,
    error: "checking the pipeline worktree: fatal: not a git repository",
  });
});

/* --- publishPipelineBranch (#729): the orchestrator owns publication ------- */

interface PublishSandbox {
  root: string;
  origin: string;
  repo: string;
  subject: Pipeline;
  commit: (name: string, body: string) => Promise<string>;
  originHead: () => Promise<string>;
}

async function publishSandbox(withOrigin = true): Promise<PublishSandbox> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-publish-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  (await git(repo, "init", "--initial-branch=main"));
  (await git(repo, "config", "user.email", "pipeline-test@example.com"));
  (await git(repo, "config", "user.name", "Pipeline Test"));
  (await git(repo, "config", "commit.gpgSign", "false"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  (await git(repo, "add", "base.txt"));
  (await git(repo, "commit", "-m", "base"));
  if (withOrigin) {
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(repo, "remote", "add", "origin", origin));
    (await git(repo, "push", "-u", "origin", "main"));
  }

  const subject = pipeline();
  subject.repoDir = repo;
  subject.worktreeDir = path.join(root, "repo-pipeline-12345678");
  subject.baseBranch = "main";
  subject.baseRef = (await git(repo, "rev-parse", "HEAD"));
  subject.lastPassedCommit = subject.baseRef;
  const provisioned = (await provisionPipelineWorktree(subject, realExec));
  if (!provisioned.ok) throw new Error(provisioned.error);
  subject.delivery!.target.remote = withOrigin ? origin : "";
  savePipelines([subject]);

  return {
    root,
    origin,
    repo,
    subject,
    commit: async (name, body) => {
      fs.writeFileSync(path.join(subject.worktreeDir, name), body);
      (await git(subject.worktreeDir, "add", "-A"));
      (await git(subject.worktreeDir, "commit", "-m", `stage ${name}`));
      return (await git(subject.worktreeDir, "rev-parse", "HEAD"));
    },
    originHead: async () => {
      const listed = (await git(subject.worktreeDir, "ls-remote", "--heads", "origin", `refs/heads/${subject.branch}`));
      return listed.split(/\s+/)[0] ?? "";
    },
  };
}

async function rebasedStageSandbox(prepare?: (box: PublishSandbox) => void | Promise<void>, acceptedBody = "accepted work\n") {
  const box = (await publishSandbox());
  await prepare?.(box);
  const accepted = (await box.commit("accepted.txt", acceptedBody));
  box.subject.lastPassedCommit = accepted;
  savePipelines([box.subject]);
  fs.writeFileSync(path.join(box.repo, "main.txt"), "new main\n");
  (await git(box.repo, "add", "main.txt"));
  (await git(box.repo, "commit", "-m", "advance main"));
  (await git(box.repo, "push", "origin", "main"));
  (await git(box.subject.worktreeDir, "rebase", "origin/main"));
  const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
  return { ...box, accepted, head };
}

async function sameHunkRebaseSandbox(initialPrefixLines = 0, rebasedPrefixLines = 1) {
  const box = (await publishSandbox());
  const repeatedComments = Array.from({ length: 4 }, () => "    # same context");
  const spacerComments = Array.from({ length: 8 }, () => "    # same context");
  const policy = (first: number, second: number) => [
    "def policy(admin):",
    ...repeatedComments,
    `    value = ${first}`,
    ...spacerComments,
    `    value = ${second}`,
    ...repeatedComments,
    "    return value",
    "",
  ].join("\n");
  const withPrefix = (first: number, second: number, lines: number) => [
    ...Array.from({ length: lines }, (_, index) => `# prefix ${index + 1}`),
    policy(first, second),
  ].filter(Boolean).join("\n");
  fs.writeFileSync(path.join(box.repo, "policy.py"), withPrefix(1, 1, initialPrefixLines));
  (await git(box.repo, "add", "policy.py"));
  (await git(box.repo, "commit", "-m", "add policy functions"));
  (await git(box.repo, "push", "origin", "main"));
  (await git(box.subject.worktreeDir, "fetch", "origin"));
  (await git(box.subject.worktreeDir, "rebase", "origin/main"));

  fs.writeFileSync(path.join(box.subject.worktreeDir, "policy.py"), policy(1, 2));
  (await git(box.subject.worktreeDir, "add", "policy.py"));
  (await git(box.subject.worktreeDir, "commit", "-m", "change first policy"));
  const accepted = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
  box.subject.lastPassedCommit = accepted;
  savePipelines([box.subject]);

  fs.writeFileSync(path.join(box.repo, "policy.py"), withPrefix(1, 1, rebasedPrefixLines));
  (await git(box.repo, "add", "policy.py"));
  (await git(box.repo, "commit", "-m", "advance main above policy"));
  (await git(box.repo, "push", "origin", "main"));
  (await git(box.subject.worktreeDir, "fetch", "origin"));
  (await git(box.subject.worktreeDir, "rebase", "origin/main"));
  const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
  return { ...box, accepted, head, policy: (first: number, second: number) => withPrefix(first, second, rebasedPrefixLines) };
}

async function siblingHunkRebaseSandbox(targetPath: string, siblingPath: string) {
  const box = (await publishSandbox());
  const comments = Array.from({ length: 4 }, () => "    # same context");
  const spacer = Array.from({ length: 8 }, () => "    # same context");
  const policy = (first: number, second: number) => [
    "def policy(admin):",
    ...comments,
    `    value = ${first}`,
    ...spacer,
    `    value = ${second}`,
    ...comments,
    "    return value",
    "",
  ].join("\n");
  const target = (first: number, second: number, prefixLines = 0) => [
    ...Array.from({ length: prefixLines }, (_, index) => `# prefix ${index + 1}`),
    policy(first, second),
  ].join("\n");
  const sibling = (lines: number) => Array.from({ length: lines }, (_, index) => `sibling ${index + 1}`).join("\n") + "\n";
  fs.mkdirSync(path.dirname(path.join(box.repo, targetPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(box.repo, siblingPath)), { recursive: true });
  fs.writeFileSync(path.join(box.repo, targetPath), target(1, 1));
  fs.writeFileSync(path.join(box.repo, siblingPath), sibling(10));
  (await git(box.repo, "add", targetPath, siblingPath));
  (await git(box.repo, "commit", "-m", "add policy files"));
  (await git(box.repo, "push", "origin", "main"));
  (await git(box.subject.worktreeDir, "fetch", "origin"));
  (await git(box.subject.worktreeDir, "rebase", "origin/main"));

  fs.writeFileSync(path.join(box.subject.worktreeDir, targetPath), target(1, 2));
  (await git(box.subject.worktreeDir, "add", targetPath));
  (await git(box.subject.worktreeDir, "commit", "-m", "change second policy"));
  const accepted = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
  box.subject.lastPassedCommit = accepted;
  savePipelines([box.subject]);

  fs.writeFileSync(path.join(box.repo, targetPath), target(1, 1, 11));
  fs.writeFileSync(path.join(box.repo, siblingPath), sibling(1));
  (await git(box.repo, "add", targetPath, siblingPath));
  (await git(box.repo, "commit", "-m", "advance target and sibling"));
  (await git(box.repo, "push", "origin", "main"));
  (await git(box.subject.worktreeDir, "fetch", "origin"));
  (await git(box.subject.worktreeDir, "rebase", "origin/main"));
  const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
  return { ...box, accepted, head, target: (first: number, second: number) => target(first, second, 11) };
}

test.each(["update", "revert"])("stage reconciliation retains accepted history followed by a builder %s", async (operation) => {
  const box = (await rebasedStageSandbox());
  try {
    if (operation === "revert") (await git(box.subject.worktreeDir, "revert", "--no-edit", box.head));
    else (await box.commit("accepted.txt", "updated builder behavior\n"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    expect((await git(box.subject.worktreeDir, "cherry", head, box.accepted))).toBe(`- ${box.accepted}`);
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
    expect((await git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha))).toBe(`${result.sha} ${head} ${box.accepted}`);
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation rejects an amended replay moved to an identical hunk in the same function", async () => {
  const box = (await sameHunkRebaseSandbox(0, 11));
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, "policy.py"), box.policy(2, 1));
    (await git(box.subject.worktreeDir, "add", "policy.py"));
    (await git(box.subject.worktreeDir, "commit", "--amend", "--no-edit"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const main = (await git(box.subject.worktreeDir, "ls-remote", "--heads", "origin", "refs/heads/main")).split(/\s+/)[0];
    const cherry = (await git(box.subject.worktreeDir, "cherry", head, box.accepted));
    expect(cherry).toBe(`- ${box.accepted}`);

    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect(box.subject.lastPassedCommit).toBe(box.accepted);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
    expect((await git(box.subject.worktreeDir, "ls-remote", "--heads", "origin", "refs/heads/main")).split(/\s+/)[0]).toBe(main);
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation retains nested multi-file replay paths", async () => {
  const box = (await publishSandbox());
  try {
    fs.mkdirSync(path.join(box.subject.worktreeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(box.subject.worktreeDir, "src", "one.py"), "one = 1\n");
    fs.writeFileSync(path.join(box.subject.worktreeDir, "src", "two.py"), "two = 1\n");
    (await git(box.subject.worktreeDir, "add", "src/one.py", "src/two.py"));
    (await git(box.subject.worktreeDir, "commit", "-m", "accepted nested policy files"));
    const accepted = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    box.subject.lastPassedCommit = accepted;
    savePipelines([box.subject]);

    fs.writeFileSync(path.join(box.repo, "main.txt"), "new main\n");
    (await git(box.repo, "add", "main.txt"));
    (await git(box.repo, "commit", "-m", "advance main"));
    (await git(box.repo, "push", "origin", "main"));
    (await git(box.subject.worktreeDir, "rebase", "origin/main"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));

    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", `${result.sha}^{tree}`)))
      .toBe((await git(box.subject.worktreeDir, "rev-parse", `${head}^{tree}`)));
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation skips unrelated large main-only patches and still publishes the preserved tree", async () => {
  const box = (await publishSandbox());
  try {
    const accepted = (await box.commit("accepted.txt", "accepted work\n"));
    box.subject.lastPassedCommit = accepted;
    savePipelines([box.subject]);

    fs.writeFileSync(path.join(box.repo, "asset.bin"), crypto.randomBytes(1_200_000));
    (await git(box.repo, "add", "asset.bin"));
    (await git(box.repo, "commit", "-m", "add large unrelated main asset"));
    (await git(box.repo, "push", "origin", "main"));
    (await git(box.subject.worktreeDir, "fetch", "origin"));
    (await git(box.subject.worktreeDir, "rebase", "origin/main"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    expect((await git(box.subject.worktreeDir, "cherry", head, accepted))).toBe(`- ${accepted}`);

    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", `${result.sha}^{tree}`))).toBe(tree);
    expect((await git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha))).toBe(`${result.sha} ${head} ${accepted}`);
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: result.sha })).toEqual({
      ok: true, sha: result.sha, remote: "published",
    });
    expect((await box.originHead())).toBe(result.sha);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation reads a large relevant binary replay without truncation", async () => {
  const box = (await publishSandbox());
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, "accepted.bin"), crypto.randomBytes(1_200_000));
    (await git(box.subject.worktreeDir, "add", "accepted.bin"));
    (await git(box.subject.worktreeDir, "commit", "-m", "accept a large binary asset"));
    const accepted = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    box.subject.lastPassedCommit = accepted;
    savePipelines([box.subject]);

    fs.writeFileSync(path.join(box.repo, "main.txt"), "new main work\n");
    (await git(box.repo, "add", "main.txt"));
    (await git(box.repo, "commit", "-m", "advance main beside the binary replay"));
    (await git(box.repo, "push", "origin", "main"));
    (await git(box.subject.worktreeDir, "fetch", "origin"));
    (await git(box.subject.worktreeDir, "rebase", "origin/main"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));

    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", `${result.sha}^{tree}`))).toBe(tree);
    expect((await git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha))).toBe(`${result.sha} ${head} ${accepted}`);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation rejects a same-function hunk relocation despite sibling file deltas", async () => {
  const box = (await siblingHunkRebaseSandbox("src/policy.py", "src/other.py"));
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, "src/policy.py"), box.target(2, 1));
    (await git(box.subject.worktreeDir, "add", "src/policy.py"));
    (await git(box.subject.worktreeDir, "commit", "--amend", "--no-edit"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const main = (await git(box.subject.worktreeDir, "ls-remote", "--heads", "origin", "refs/heads/main")).split(/\s+/)[0];

    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect(box.subject.lastPassedCommit).toBe(box.accepted);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
    expect((await git(box.subject.worktreeDir, "ls-remote", "--heads", "origin", "refs/heads/main")).split(/\s+/)[0]).toBe(main);
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation treats bracketed tracked filenames literally when mapping replay hunks", async () => {
  const box = (await siblingHunkRebaseSandbox("policy[12].py", "policy1.py"));
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, "policy[12].py"), box.target(2, 1));
    (await git(box.subject.worktreeDir, "add", "policy[12].py"));
    (await git(box.subject.worktreeDir, "commit", "--amend", "--no-edit"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const main = (await git(box.subject.worktreeDir, "ls-remote", "--heads", "origin", "refs/heads/main")).split(/\s+/)[0];

    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
    expect((await git(box.subject.worktreeDir, "ls-remote", "--heads", "origin", "refs/heads/main")).split(/\s+/)[0]).toBe(main);
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([
  ["one-line insertion with omitted new count", "@@ -0,0 +1 @@\n", 13, 12],
  ["multi-line insertion", "@@ -0,0 +1,11 @@\n", 23, 12],
  ["one-line deletion with omitted old count", "@@ -3 +2,0 @@\n", 2, 3],
  ["multi-line deletion", "@@ -12,11 +12,0 @@\n", 12, 23],
])("replay location mapping handles %s", async (_case, diffHunk, replayStart, expectedAcceptedStart) => {
  const subject = pipeline();
  const accepted = "a".repeat(40);
  const replay = "b".repeat(40);
  const mappingExec: ExecPort = (_command, args) => {
    if (args[0] === "rev-parse") {
      return { code: 0, stdout: args[1] === `${accepted}^` ? "c".repeat(40) : "d".repeat(40), stderr: "" };
    }
    return { code: 0, stdout: diffHunk, stderr: "" };
  };

  expect((await mapReplayPatchLocation(subject, accepted, replay, { path: "policy.py", start: replayStart }, mappingExec)))
    .toBe(expectedAcceptedStart);
});

test.each([
  ["single-line insertion with omitted counts", 0, 1],
  ["multi-line insertion", 0, 11],
])("stage reconciliation maps a location-preserving replay after %s and later builder edits", async (_case, initialPrefixLines, rebasedPrefixLines) => {
  const box = (await sameHunkRebaseSandbox(initialPrefixLines, rebasedPrefixLines));
  try {
    const builderHead = (await box.commit("builder.txt", "later builder work\n"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    expect((await git(box.subject.worktreeDir, "cherry", builderHead, box.accepted))).toBe(`- ${box.accepted}`);

    const result = (await reconcilePipelineStageHead(box.subject, builderHead, realExec));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
    expect((await git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha))).toBe(`${result.sha} ${builderHead} ${box.accepted}`);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation accepts squashed content, preserves the tree, and uses the controller identity", async () => {
  const box = (await rebasedStageSandbox());
  try {
    (await box.commit("build.txt", "new builder work\n"));
    (await git(box.subject.worktreeDir, "reset", "--soft", "origin/main"));
    (await git(box.subject.worktreeDir, "commit", "-m", "squashed builder work"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
    expect((await git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha))).toBe(`${result.sha} ${head} ${box.accepted}`);
    const identity = controllerCommitIdentityEnv();
    expect((await git(box.subject.worktreeDir, "show", "-s", "--format=%an|%ae|%cn|%ce", result.sha)))
      .toBe(`${identity.GIT_AUTHOR_NAME}|${identity.GIT_AUTHOR_EMAIL}|${identity.GIT_COMMITTER_NAME}|${identity.GIT_COMMITTER_EMAIL}`);
    expect((await git(box.subject.worktreeDir, "status", "--porcelain"))).toBe("");
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["ours", "union"])("stage reconciliation ignores repository %s merge policies when checking dropped accepted content", async (policy) => {
  let deleted = "";
  const box = (await rebasedStageSandbox(async (fixture) => {
    (await fixture.commit(".gitattributes", `base.txt merge=${policy}\n`));
    deleted = (await fixture.commit("base.txt", "accepted replacement\n"));
  }));
  try {
    (await git(box.subject.worktreeDir, "config", "merge.ours.driver", "true"));
    (await box.commit("base.txt", "base\nbuilder extra\n"));
    (await git(box.subject.worktreeDir, "reset", "--soft", "origin/main"));
    (await git(box.subject.worktreeDir, "commit", "-m", "rewrite dropping accepted replacement"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(deleted);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([
  ["Python indentation", "def deliver(allowed):\n    sent = []\n    if allowed:\n        pass\n        sent.append('sent')\n    return sent\n", "def deliver(allowed):\n    sent = []\n    if allowed:\n        pass\n    sent.append('sent')\n    return sent\n"],
  ["significant token spacing", "value = 'a b'\n", "value = 'ab'\n"],
])("stage reconciliation parks a whitespace-only loss in accepted %s work", async (_case, acceptedContent, rewrittenContent) => {
  const box = (await rebasedStageSandbox(async (fixture) => {
    fs.writeFileSync(path.join(fixture.subject.worktreeDir, "policy.py"), acceptedContent);
    (await git(fixture.subject.worktreeDir, "add", "policy.py"));
  }));
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, "policy.py"), rewrittenContent);
    (await git(box.subject.worktreeDir, "add", "policy.py"));
    (await git(box.subject.worktreeDir, "commit", "--amend", "--no-edit"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    expect((await git(box.subject.worktreeDir, "cherry", head, box.accepted))).toBe(`- ${box.accepted}`);

    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation parks when an amended replay drops a plus-prefixed code line", async () => {
  const acceptedBody = "++counter; console.log('a b');\n";
  const box = (await rebasedStageSandbox(undefined, acceptedBody));
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, "accepted.txt"), "++counter; console.log('ab');\n");
    (await git(box.subject.worktreeDir, "add", "accepted.txt"));
    (await git(box.subject.worktreeDir, "commit", "--amend", "--no-edit"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));

    expect((await git(box.subject.worktreeDir, "cherry", head, box.accepted))).toBe(`- ${box.accepted}`);
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation retains accepted replacements when the builder extends an existing file", async () => {
  const box = (await rebasedStageSandbox(async (fixture) => { (await fixture.commit("base.txt", "accepted replacement\n")); }));
  try {
    const head = (await box.commit("base.txt", "accepted replacement\nbuilder extra\n"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
    expect((await git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha))).toBe(`${result.sha} ${head} ${box.accepted}`);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([false, true])("stage reconciliation checks unique accepted merge content (preserved: %s)", async (preserved) => {
  let acceptedMerge = "";
  const box = (await rebasedStageSandbox(async (fixture) => {
    const base = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await fixture.commit("side.txt", "accepted side\n"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", base));
    const firstParent = (await fixture.commit("first-parent.txt", "accepted first parent\n"));
    (await fixture.commit("resolution.txt", "unique merge content\n"));
    const tree = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    acceptedMerge = (await git(fixture.subject.worktreeDir, "commit-tree", tree, "-p", firstParent, "-p", side, "-m", "accepted merge resolution"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", acceptedMerge));
  }));
  try {
    // Ordinary rebase drops merge commits, including their unique resolution.
    expect((await git(box.subject.worktreeDir, "cherry", box.head, box.accepted)).split("\n").every((line) => line.startsWith("- "))).toBe(true);
    if (preserved) {
      (await git(box.subject.worktreeDir, "rm", "side.txt"));
      (await box.commit("resolution.txt", "unique merge content\n"));
    }
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(preserved);
    if (result.ok) expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
    else {
      expect(result.error).toContain(acceptedMerge);
      expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
    }
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation retains an automatic accepted merge followed by builder edits", async () => {
  const box = (await rebasedStageSandbox(async (fixture) => {
    const base = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await fixture.commit("side.txt", "accepted side\n"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", base));
    (await fixture.commit("first-parent.txt", "accepted first parent\n"));
    (await git(fixture.subject.worktreeDir, "merge", "--no-ff", "--no-edit", side));
  }));
  try {
    const head = (await box.commit("side.txt", "updated builder behavior\n"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["merge", "linear"])("stage reconciliation retains an accepted merge resolution replayed in %s history before builder edits", async (history) => {
  const box = (await rebasedStageSandbox(async (fixture) => {
    const base = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await fixture.commit("side.txt", "accepted side\n"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", base));
    const firstParent = (await fixture.commit("first-parent.txt", "accepted first parent\n"));
    (await fixture.commit("resolution.txt", "unique merge resolution\n"));
    const tree = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const merge = (await git(fixture.subject.worktreeDir, "commit-tree", tree, "-p", firstParent, "-p", side, "-m", "accepted resolution"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", merge));
  }));
  try {
    (await git(box.subject.worktreeDir, "rm", "side.txt"));
    (await box.commit("resolution.txt", "unique merge resolution\n"));
    if (history === "merge") {
      const replayTree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
      const replay = (await git(box.subject.worktreeDir, "commit-tree", replayTree, "-p", box.head, "-p", "origin/main", "-m", "replayed merge resolution"));
      (await git(box.subject.worktreeDir, "reset", "--hard", replay));
    }
    const head = (await box.commit("resolution.txt", "updated builder behavior\n"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation retains an accepted octopus merge followed by builder edits", async () => {
  const box = (await rebasedStageSandbox(async (fixture) => {
    const base = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await fixture.commit("side.txt", "accepted side\n"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", base));
    const other = (await fixture.commit("other-side.txt", "accepted other side\n"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", base));
    (await fixture.commit("first-parent.txt", "accepted first parent\n"));
    (await git(fixture.subject.worktreeDir, "merge", "--no-ff", "--no-edit", side, other));
  }));
  try {
    const head = (await box.commit("side.txt", "updated builder behavior\n"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    expect((await reconcilePipelineStageHead(box.subject, head, realExec)).ok).toBe(true);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation names a dropped merge resolution that restored common-base content", async () => {
  const box = (await publishSandbox());
  try {
    const base = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await box.commit("base.txt", "side change\n"));
    (await git(box.subject.worktreeDir, "reset", "--hard", base));
    const first = (await box.commit("base.txt", "first change\n"));
    (await box.commit("base.txt", "base\n"));
    const acceptedTree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const accepted = (await git(box.subject.worktreeDir, "commit-tree", acceptedTree, "-p", first, "-p", side, "-m", "accepted base restoration"));
    box.subject.lastPassedCommit = accepted;
    (await box.commit("main.txt", "new main\n"));
    (await git(box.repo, "cherry-pick", (await git(box.subject.worktreeDir, "rev-parse", "HEAD"))));
    (await git(box.repo, "push", "origin", "main"));
    (await git(box.subject.worktreeDir, "reset", "--hard", "origin/main"));
    (await git(box.subject.worktreeDir, "cherry-pick", first));
    const newFirst = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const wrongTree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    (await git(box.subject.worktreeDir, "reset", "--hard", "origin/main"));
    (await git(box.subject.worktreeDir, "cherry-pick", side));
    const newSide = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const head = (await git(box.subject.worktreeDir, "commit-tree", wrongTree, "-p", newFirst, "-p", newSide, "-m", "rewrite drops accepted resolution"));
    (await git(box.subject.worktreeDir, "reset", "--hard", head));
    expect((await git(box.subject.worktreeDir, "cherry", head, accepted)).split("\n").every((line) => line.startsWith("- "))).toBe(true);
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(accepted);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([false, true])("stage reconciliation detects accepted merge exclusions (extra resolution: %s)", async (extraResolution) => {
  let acceptedMerge = "";
  const box = (await rebasedStageSandbox(async (fixture) => {
    const base = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await fixture.commit("excluded.txt", "excluded side change\n"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", base));
    const first = (await fixture.commit("first.txt", "accepted first parent\n"));
    if (extraResolution) (await fixture.commit("resolution.txt", "unique resolution\n"));
    const tree = (await git(fixture.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    acceptedMerge = (await git(fixture.subject.worktreeDir, "commit-tree", tree, "-p", first, "-p", side, "-m", "accepted exclusion"));
    (await git(fixture.subject.worktreeDir, "reset", "--hard", acceptedMerge));
  }));
  try {
    if (extraResolution) (await box.commit("resolution.txt", "unique resolution\n"));
    const head = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(acceptedMerge);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(head);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation preserves accepted conflict resolution with newer main content in the same file", async () => {
  const box = (await publishSandbox());
  try {
    fs.writeFileSync(path.join(box.repo, "base.txt"), "keep\noriginal\ntail\n");
    (await git(box.repo, "add", "base.txt"));
    (await git(box.repo, "commit", "-m", "common content"));
    (await git(box.repo, "push", "origin", "main"));
    (await git(box.subject.worktreeDir, "rebase", "origin/main"));
    const base = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await box.commit("base.txt", "keep\nside\ntail\n"));
    (await git(box.subject.worktreeDir, "reset", "--hard", base));
    const first = (await box.commit("base.txt", "keep\nfirst\ntail\n"));
    (await box.commit("base.txt", "keep\nresolved\ntail\n"));
    const acceptedTree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const accepted = (await git(box.subject.worktreeDir, "commit-tree", acceptedTree, "-p", first, "-p", side, "-m", "accepted conflict resolution"));
    box.subject.lastPassedCommit = accepted;
    fs.writeFileSync(path.join(box.repo, "base.txt"), "keep\noriginal\ntail\nnew main\n");
    (await git(box.repo, "add", "base.txt"));
    (await git(box.repo, "commit", "-m", "advance main in resolved file"));
    (await git(box.repo, "push", "origin", "main"));
    (await git(box.subject.worktreeDir, "reset", "--hard", "origin/main"));
    (await git(box.subject.worktreeDir, "cherry-pick", first));
    const newFirst = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    (await git(box.subject.worktreeDir, "reset", "--hard", "origin/main"));
    (await git(box.subject.worktreeDir, "cherry-pick", side));
    const newSide = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    (await box.commit("base.txt", "keep\nresolved\ntail\nnew main\n"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const head = (await git(box.subject.worktreeDir, "commit-tree", tree, "-p", newFirst, "-p", newSide, "-m", "replayed resolution with main content"));
    (await git(box.subject.worktreeDir, "reset", "--hard", head));
    expect((await reconcilePipelineStageHead(box.subject, head, realExec)).ok).toBe(true);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(tree);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([true, false])("stage reconciliation uses the final accepted resolution after a squash (preserved: %s)", async (preserved) => {
  const box = (await publishSandbox());
  try {
    const base = (await git(box.subject.worktreeDir, "rev-parse", "HEAD"));
    const side = (await box.commit("side.txt", "accepted side\n"));
    (await git(box.subject.worktreeDir, "reset", "--hard", base));
    const first = (await box.commit("first.txt", "accepted first parent\n"));
    (await box.commit("resolution.txt", "initial resolution\n"));
    const tree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const merge = (await git(box.subject.worktreeDir, "commit-tree", tree, "-p", first, "-p", side, "-m", "accepted resolution"));
    (await git(box.subject.worktreeDir, "reset", "--hard", merge));
    const accepted = (await box.commit("resolution.txt", "final accepted resolution\n"));
    box.subject.lastPassedCommit = accepted;
    fs.writeFileSync(path.join(box.repo, "main.txt"), "new main\n");
    (await git(box.repo, "add", "main.txt"));
    (await git(box.repo, "commit", "-m", "advance main"));
    (await git(box.repo, "push", "origin", "main"));
    (await git(box.subject.worktreeDir, "reset", "--soft", "origin/main"));
    if (!preserved) fs.writeFileSync(path.join(box.subject.worktreeDir, "resolution.txt"), "initial resolution\n");
    const head = (await box.commit("main.txt", "new main\n"));
    const selectedTree = (await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"));
    const result = (await reconcilePipelineStageHead(box.subject, head, realExec));
    expect(result.ok).toBe(preserved);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}"))).toBe(selectedTree);
    if (!result.ok) expect(result.error).toContain(accepted);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation cannot overwrite a head that advances at the ref update", async () => {
  const box = (await rebasedStageSandbox());
  try {
    let advanced: string | null = null;
    const racing: ExecPort = async (command, args, cwd, env) => {
      if (command === "git" && args[0] === "update-ref") advanced = (await box.commit("concurrent.txt", "concurrent work\n"));
      return (await realExec(command, args, cwd, env));
    };
    const result = (await reconcilePipelineStageHead(box.subject, box.head, racing));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("fencing the stage reconciliation merge");
    expect(advanced).not.toBeNull();
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(advanced!);
    expect(fs.readFileSync(path.join(box.subject.worktreeDir, "concurrent.txt"), "utf8")).toBe("concurrent work\n");
    expect((await box.originHead())).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("reconciled delivery remains fenced against a foreign publisher", async () => {
  const box = (await rebasedStageSandbox());
  try {
    (await git(box.subject.worktreeDir, "push", "origin", `${box.accepted}:refs/heads/${box.subject.branch}`));
    const result = (await reconcilePipelineStageHead(box.subject, box.head, realExec));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const foreign = { ...box.subject, id: "foreign-publisher" };
    expect(await publishPipelineBranch(foreign, realExec, { acceptedSha: result.sha })).toMatchObject({ ok: false });
    expect((await box.originHead())).toBe(box.accepted);
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: result.sha })).toMatchObject({ ok: true, sha: result.sha, remote: "published" });
    expect((await box.originHead())).toBe(result.sha);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("publishPipelineBranch pushes the passed commit and confirms origin carries it", async () => {
  const box = (await publishSandbox());
  try {
    const passed = (await box.commit("stage.txt", "stage work\n"));
    expect((await box.originHead())).toBe("");

    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({ ok: true, sha: passed, remote: "published" });
    expect((await box.originHead())).toBe(passed);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch fast-forwards a branch it already published", async () => {
  const box = (await publishSandbox());
  try {
    const first = (await box.commit("one.txt", "one\n"));
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: first })).toMatchObject({ ok: true, sha: first });
    const second = (await box.commit("two.txt", "two\n"));

    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: second, publishedSha: first })).toEqual({ ok: true, sha: second, remote: "published" });
    expect((await box.originHead())).toBe(second);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("an independent internal lane cannot publish a fast-forward to another lane's target", async () => {
  const box = (await publishSandbox());
  try {
    const ownerHead = (await box.commit("owner.txt", "owner work\n"));
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: ownerHead })).toMatchObject({ ok: true });
    const comparisonDirectory = path.join(box.root, "repo-pipeline-comparison-lane");
    (await git(box.root, "clone", "--branch", box.subject.branch, box.origin, comparisonDirectory));
    (await git(comparisonDirectory, "checkout", "-b", "pipeline/task-comparison-lane"));
    (await git(comparisonDirectory, "config", "user.name", "Comparison Test"));
    (await git(comparisonDirectory, "config", "user.email", "comparison-test"));
    (await git(comparisonDirectory, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(comparisonDirectory, "comparison.txt"), "local comparison\n");
    (await git(comparisonDirectory, "add", "comparison.txt"));
    (await git(comparisonDirectory, "commit", "-m", "local comparison"));
    const comparisonHead = (await git(comparisonDirectory, "rev-parse", "HEAD"));
    const comparison: Pipeline = {
      ...box.subject,
      id: "comparison-lane",
      publication: "internal",
      repoDir: box.repo,
      branch: "pipeline/task-comparison-lane",
      worktreeDir: comparisonDirectory,
    };
    await createPipelineWithDelivery(comparison, box.subject.delivery!.target);

    // Ancestry alone admits this write. Delivery ownership must refuse it.
    (await git(comparisonDirectory, "merge-base", "--is-ancestor", ownerHead, comparisonHead));
    const result = await publishPipelineBranch(comparison, realExec, { acceptedSha: comparisonHead });
    expect({ allowed: result.ok, remoteHead: (await box.originHead()) }).toEqual({ allowed: false, remoteHead: ownerHead });
    expect((await git(comparisonDirectory, "rev-parse", "HEAD"))).toBe(comparisonHead);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch refuses a diverged remote and leaves both revisions intact", async () => {
  const box = (await publishSandbox());
  try {
    const shared = (await box.commit("shared.txt", "shared\n"));
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: shared })).toMatchObject({ ok: true, sha: shared });

    /* Someone else's repair lands on the remote branch; the local head does not
       contain it. Publishing it away would destroy that work. */
    const other = path.join(box.root, "other");
    (await git(box.root, "clone", "--branch", box.subject.branch, box.origin, other));
    (await git(other, "config", "user.email", "pipeline-test@example.com"));
    (await git(other, "config", "user.name", "Pipeline Test"));
    (await git(other, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(other, "repair.txt"), "remote repair\n");
    (await git(other, "add", "-A"));
    (await git(other, "commit", "-m", "remote repair"));
    (await git(other, "push", "origin", box.subject.branch));
    const remoteRepair = (await git(other, "rev-parse", "HEAD"));

    const local = (await box.commit("local.txt", "local\n"));
    const refused = await publishPipelineBranch(box.subject, realExec, { acceptedSha: local, publishedSha: shared });

    expect(refused).toEqual({
      ok: false,
      error: "the local and remote pipeline branches diverged; fetch and merge the remote commits into this worktree, then retry publication; both tips are preserved",
    });
    expect((await box.originHead())).toBe(remoteRepair);
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(local);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publication releases the SQLite lease during Git and refuses an in-flight takeover", async () => {
  const box = (await publishSandbox());
  try {
    const comparison = { ...box.subject, id: "comparison", branch: "pipeline/task-comparison", worktreeDir: path.join(box.root, "repo-pipeline-comparison") };
    await createPipelineWithDelivery(comparison, box.subject.delivery!.target);
    const head = (await box.commit("reserved.txt", "accepted\n"));
    let takeover: ReturnType<typeof takeoverPipelineDelivery> | undefined;
    const racing: ExecPort = async (command, args, cwd) => {
      if (command === "git" && args[0] === "push") {
        const db = new Database(path.join(publicationState, "state.sqlite"), { readonly: true });
        try { expect(db.query("SELECT count(*) AS n FROM state_leases WHERE collection='pipelines'").get()).toEqual({ n: 0 }); }
        finally { db.close(); }
        expect(findPipelineRecord(box.subject.id)?.delivery?.operation?.state).toBe("running");
        const lock = findPipelineRecord(box.subject.id)!.delivery!.operation!.executor!.lock;
        expect((await realExec("flock", ["-n", lock, "true"], cwd)).code).not.toBe(0);
        takeover = takeoverPipelineDelivery(comparison.id, box.subject.id, 1, "select comparison", "conversation_builder");
      }
      return (await realExec(command, args, cwd));
    };
    expect(await publishPipelineBranch(box.subject, racing, { acceptedSha: head })).toMatchObject({ ok: true, sha: head });
    expect((await takeover)?.error).toContain("in flight");
    expect((await box.originHead())).toBe(head);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a same-owner adapter retry waits on its running reservation without executing Git (#1939)", async () => {
  const subject = pipeline();
  const head = "7".repeat(40);
  await publishPipelineBranch(subject, (_command, args) => {
    if (args[0] === "push") throw new Error("lost publication reply");
    return { code: 0, stdout: args[0] === "rev-parse" ? head : args[0] === "branch" ? subject.branch : "", stderr: "" };
  }, { acceptedSha: head });
  const running = findPipelineRecord(subject.id)!;
  const descriptor = fs.openSync(running.delivery!.operation!.executor!.lock, "a");
  let execCalls = 0;
  try {
    expect(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] }).status).toBe(0);
    expect(await publishPipelineBranch(running, () => { execCalls++; throw new Error("duplicate Git call"); }, { acceptedSha: head }))
      .toMatchObject({ ok: true, remote: "unreachable", detail: expect.stringContaining("in progress since") });
    expect(findPipelineRecord(subject.id)!.delivery!.operation!.id).toBe(running.delivery!.operation!.id);
    const staleEpoch = { ...running, delivery: { ...running.delivery!, epoch: 0 } };
    expect(await publishPipelineBranch(staleEpoch, () => { execCalls++; throw new Error("foreign Git call"); }, { acceptedSha: head }))
      .toMatchObject({ ok: false, error: "publication owner or epoch changed" });
    expect(execCalls).toBe(0);
  } finally { fs.closeSync(descriptor); }
  const result = await publishPipelineBranch(running, () => { throw new Error("must not reserve or execute again"); }, { acceptedSha: head });
  expect(result).toMatchObject({ ok: true, remote: "unreachable", detail: expect.stringContaining("in progress since") });
  expect(findPipelineRecord(subject.id)!.delivery!.operation!.id).toBe(running.delivery!.operation!.id);
  const stale = new Date(Date.now() - 120_000);
  fs.utimesSync(running.delivery!.operation!.executor!.lock, stale, stale);
  expect(await publishPipelineBranch(running, () => { throw new Error("must not execute stale publication"); }, { acceptedSha: head }))
    .toMatchObject({ ok: false, error: expect.stringContaining(`publication ${running.delivery!.operation!.id} has no progress for 120s`) });
});

test("a lost push reply is reconciled before explicit takeover and stale owner publication is refused", async () => {
  const box = (await publishSandbox());
  try {
    const comparison = { ...box.subject, id: "comparison", branch: "pipeline/task-comparison", worktreeDir: path.join(box.root, "repo-pipeline-comparison") };
    await createPipelineWithDelivery(comparison, box.subject.delivery!.target);
    const head = (await box.commit("reply.txt", "accepted\n"));
    let pushed = false;
    const lostReply: ExecPort = async (command, args, cwd) => {
      if (pushed && command === "timeout") return { code: 124, stdout: "", stderr: "reply lost" };
      const result = (await realExec(command, args, cwd));
      if (command === "git" && args[0] === "push") pushed = true;
      return result;
    };
    expect(await publishPipelineBranch(box.subject, lostReply, { acceptedSha: head })).toMatchObject({ remote: "unreachable", uncertain: true });
    expect((await takeoverPipelineDelivery(comparison.id, box.subject.id, 1, "select comparison", "conversation_builder")).error).toContain("uncertain");
    expect(await reconcilePipelinePublication(box.subject.id, 1, realExec, "conversation_builder")).toBeNull();
    expect((await takeoverPipelineDelivery(comparison.id, box.subject.id, 1, "select comparison", "conversation_builder")).pipeline?.delivery?.epoch).toBe(2);
    const denied = await publishPipelineBranch(box.subject, realExec, { acceptedSha: head, publishedSha: head });
    expect(denied).toMatchObject({ ok: false });
    expect(!denied.ok && denied.error).toContain(comparison.id);
    expect((await box.originHead())).toBe(head);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([false, true])("a Git child retains the publication fence after its Viewer executor dies (inherited advice: %s)", async (inheritedAdvice) => {
  const box = (await publishSandbox());
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const release = path.join(box.root, "release-push");
  const ready = path.join(box.root, "push-ready");
  try {
    const head = (await box.commit("orphan.txt", "accepted\n"));
    await git(box.repo, "config", "advice.graftFileDeprecated", "true");
    const hooks = path.join(box.root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-push"), '#!/bin/sh\nif [ "$DELIVERY_EXPECT_CONFIG" = 1 ] && [ "$(git config --get publication.fixture)" != preserved ]; then exit 91; fi\nprintf ready > "$DELIVERY_READY"\nwhile [ ! -f "$DELIVERY_RELEASE" ]; do sleep 0.02; done\n', { mode: 0o700 });
    (await git(box.repo, "config", "core.hooksPath", hooks));
    const script = `import { publishPipelineBranch } from ${JSON.stringify(path.join(import.meta.dir, "git.ts"))};
      import { findPipelineRecord } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))};
      import { realExec } from ${JSON.stringify(path.join(import.meta.dir, "../workflows/provision.ts"))};
      await publishPipelineBranch(findPipelineRecord(process.env.DELIVERY_ID), realExec, { acceptedSha: process.env.DELIVERY_HEAD });`;
    child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, DELIVERY_ID: box.subject.id,
      DELIVERY_HEAD: head, DELIVERY_READY: ready, DELIVERY_RELEASE: release, DELIVERY_EXPECT_CONFIG: inheritedAdvice ? "1" : "",
      ...(inheritedAdvice ? { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "advice.graftFileDeprecated", GIT_CONFIG_VALUE_0: "true",
        GIT_CONFIG_KEY_1: "publication.fixture", GIT_CONFIG_VALUE_1: "preserved" } : {}) }, stdout: "pipe", stderr: "pipe" });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(fs.existsSync(ready)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    expect(await reconcilePipelinePublication(box.subject.id, 1, realExec, "conversation_recovery")).toContain("child is still in flight");
    fs.writeFileSync(release, "continue");
    let reconciled: string | null = "waiting";
    while (reconciled !== null && Date.now() < deadline) {
      await Bun.sleep(10);
      reconciled = await reconcilePipelinePublication(box.subject.id, 1, realExec, "conversation_recovery");
    }
    expect(reconciled).toBeNull();
    expect((await box.originHead())).toBe(head);
    expect(findPipelineRecord(box.subject.id)?.delivery?.operation?.state).toBe("settled");
  } finally {
    fs.writeFileSync(release, "continue");
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    if (child) await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
}, 15_000);

test("post-push settlement contention stays recoverable in the same live Viewer", async () => {
  const box = (await publishSandbox());
  const previousWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "20";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held: Promise<void> | undefined;
  try {
    const head = (await box.commit("contention.txt", "accepted\n"));
    const racing: ExecPort = async (command, args, cwd) => {
      const result = (await realExec(command, args, cwd));
      if (command === "git" && args[0] === "push") held = withPipelineMutation(async () => { await gate; });
      return result;
    };
    const result = await publishPipelineBranch(box.subject, racing, { acceptedSha: head });
    expect(result).toMatchObject({ ok: true, remote: "unreachable", uncertain: true });
    expect((await box.originHead())).toBe(head);
    expect(findPipelineRecord(box.subject.id)?.delivery?.operation).toMatchObject({ state: "running", executor: { pid: process.pid } });
    release();
    await held;
    expect(await reconcilePipelinePublication(box.subject.id, 1, realExec, "conversation_recovery")).toBeNull();
    expect(findPipelineRecord(box.subject.id)?.delivery?.operation?.state).toBe("settled");
  } finally {
    release();
    await held;
    if (previousWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
    else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previousWait;
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch reports a repo with no origin as unavailable rather than a failure", async () => {
  const box = (await publishSandbox(false));
  try {
    const passed = (await box.commit("stage.txt", "stage work\n"));
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({ ok: true, sha: passed, remote: "unavailable" });
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("adding an origin cannot redirect a delivery claim made without a remote", async () => {
  const box = (await publishSandbox(false));
  try {
    const head = (await box.commit("local.txt", "local work\n"));
    (await git(box.root, "init", "--bare", "--initial-branch=main", box.origin));
    (await git(box.repo, "remote", "add", "origin", box.origin));
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: head })).toEqual({ ok: true, sha: head, remote: "unavailable" });
    expect((await box.originHead())).toBe("");
    expect(findPipelineRecord(box.subject.id)?.delivery?.target.remote).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("publishPipelineBranch refuses a dirty worktree and preserves the uncommitted work", async () => {
  const box = (await publishSandbox());
  try {
    const passed = (await box.commit("stage.txt", "stage work\n"));
    fs.writeFileSync(path.join(box.subject.worktreeDir, "in-progress.txt"), "unfinished\n");

    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({
      ok: false,
      error: "the pipeline worktree has uncommitted changes; choose whether to commit or discard them before retrying review",
    });
    expect((await git(box.subject.worktreeDir, "status", "--porcelain"))).toBe("?? in-progress.txt");
    expect(fs.readFileSync(path.join(box.subject.worktreeDir, "in-progress.txt"), "utf8")).toBe("unfinished\n");
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("a head already recorded as published costs no remote probe at all", async () => {
  const head = "a".repeat(40);
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: `${pipeline().branch}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  const subject = pipeline();
  subject.publishedCommit = head;
  savePipelines([subject]);
  expect(await publishPipelineBranch(subject, exec, { acceptedSha: head, publishedSha: head })).toEqual({ ok: true, sha: head, remote: "published" });
  expect(calls.some((call) => call.includes("ls-remote"))).toBe(false);
  expect(calls.some((call) => call.includes("push"))).toBe(false);
  expect(calls.some((call) => call.includes("remote get-url"))).toBe(false);
});

test("an unreachable remote gets one time-bounded read per publication call (#999)", async () => {
  const head = "a".repeat(40);
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch") return { code: 0, stdout: `${pipeline().branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
    if (command === "git" && args[0] === "remote") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
    if (command === "timeout") return { code: 124, stdout: "", stderr: "" };
    return { code: 128, stdout: "", stderr: "remote read must be bounded" };
  };

  expect(await publishPipelineBranch(pipeline(), exec, { acceptedSha: head })).toEqual({
    ok: true,
    sha: head,
    remote: "unreachable",
    detail: "checking the remote pipeline branch: git remote read timed out after 5s",
  });
  expect(calls.filter((call) => call.includes("ls-remote"))).toEqual([
    `timeout --signal=KILL 5s git ls-remote --heads origin refs/heads/${pipeline().branch}`,
  ]);
  expect(calls.some((call) => call.startsWith("sleep "))).toBe(false);
});

test("the approval's remote head read is time-bounded and tells transport failures from the rest (#1692)", async () => {
  const head = "a".repeat(40);
  const answer = async (result: { code: number | null; stdout?: string; stderr?: string }) => {
    const calls: string[] = [];
    const exec: ExecPort = (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "timeout") return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      return { code: 128, stdout: "", stderr: "remote read must be bounded" };
    };
    return { result: (await currentPipelineRemoteBranchHead(pipeline(), exec)), calls };
  };
  const unreachable = "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";

  const answered = (await answer({ code: 0, stdout: `${head}\trefs/heads/${pipeline().branch}\n` }));
  expect(answered.result).toEqual({ ok: true, sha: head });
  expect(answered.calls).toEqual([`timeout --signal=KILL 5s git ls-remote --heads origin refs/heads/${pipeline().branch}`]);

  expect((await answer({ code: 124 })).result).toEqual({
    ok: false,
    transient: true,
    error: "checking the remote pipeline branch: git remote read timed out after 5s",
  });
  for (const stderr of [
    `ssh: connect to host example.invalid port 22: Connection timed out\r\n${unreachable}`,
    `ssh: Could not resolve hostname example.invalid: Temporary failure in name resolution\r\n${unreachable}`,
    "fatal: unable to access 'https://example.invalid/owner/repo.git/': Failed to connect to example.invalid port 443: Connection refused",
  ]) {
    expect((await answer({ code: 128, stderr })).result).toMatchObject({ ok: false, transient: true });
  }
  for (const stderr of [
    `git@example.invalid: Permission denied (publickey).\r\n${unreachable}`,
    `Connection closed by 192.0.2.1 port 22\r\nHost key verification failed.\r\n${unreachable}`,
    "remote: Repository not found.\nfatal: repository 'https://example.invalid/owner/repo.git/' not found",
    "fatal: 'origin' does not appear to be a git repository",
  ]) {
    expect((await answer({ code: 128, stderr })).result).toMatchObject({ ok: false, transient: false });
  }
  expect((await answer({ code: 0, stdout: "" })).result).toEqual({ ok: false, transient: false, error: "the remote pipeline branch has no exact commit SHA" });
});

test("a real remote read that hangs is killed at the bound and reads as a network timeout (#1692)", async () => {
  /* `timeout --signal=KILL` takes itself down with the command, so the child
     ends on a signal with no exit status. An SSH transport that never answers
     is the incident's shape, reproduced here without a network. */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-remote-hang-"));
  try {
    (await git(root, "init", "--initial-branch=main"));
    (await git(root, "config", "core.sshCommand", "sh -c 'sleep 30' fake-ssh"));
    (await git(root, "remote", "add", "origin", "ssh://git@example.invalid/owner/repo.git"));
    const subject = pipeline();
    subject.worktreeDir = root;

    const read = (await currentPipelineRemoteBranchHead(subject, realExec));

    /* Only a read killed at its bound answers this way; the fake transport
       would otherwise have run its thirty seconds and exited. */
    expect(read).toEqual({ ok: false, transient: true, error: "checking the remote pipeline branch: git remote read timed out after 5s" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("publication pushes only the immutable accepted revision when the branch advances mid-publish", async () => {
  const box = (await publishSandbox());
  try {
    const accepted = (await box.commit("accepted.txt", "accepted\n"));
    let racy: string | null = null;

    /* The branch advances in the window between the publisher capturing the
       accepted revision and the push running — here on the remote probe, which
       sits exactly in that window. Pushing `refs/heads/<branch>` would carry
       this unaccepted commit to origin and leave review fenced on a target that
       never passed; pushing the accepted object cannot. */
    const racing: ExecPort = async (command, args, cwd) => {
      if (command === "timeout" && args.includes("ls-remote") && racy === null) {
        racy = (await box.commit("racy.txt", "never accepted\n"));
      }
      return (await realExec(command, args, cwd));
    };

    const published = await publishPipelineBranch(box.subject, racing, { acceptedSha: accepted });

    expect(racy).not.toBeNull();
    expect(racy).not.toBe(accepted);
    /* The local branch really did move on mid-publish ... */
    expect((await git(box.subject.worktreeDir, "rev-parse", "HEAD"))).toBe(racy!);
    /* ... and origin carries exactly the accepted revision, never the racy one. */
    expect(published).toEqual({ ok: true, sha: accepted, remote: "published" });
    expect((await box.originHead())).toBe(accepted);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("a worktree that has moved past the accepted revision publishes nothing", async () => {
  const box = (await publishSandbox());
  try {
    const accepted = (await box.commit("accepted.txt", "accepted\n"));
    const advanced = (await box.commit("later.txt", "later\n"));

    const result = await publishPipelineBranch(box.subject, realExec, { acceptedSha: accepted });

    expect(result).toEqual({
      ok: false,
      error: `the pipeline worktree is at ${advanced}, not the accepted revision ${accepted}; nothing was published`,
    });
    expect((await box.originHead())).toBe("");
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publication refuses an accepted revision that is not an exact commit SHA", async () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  };

  expect(await publishPipelineBranch(pipeline(), exec, { acceptedSha: "HEAD" })).toEqual({
    ok: false,
    error: "the accepted pipeline revision is not an exact commit SHA: HEAD",
  });
  expect(calls).toEqual([]);
});

test("interrupted checkout recovery refuses a locked same-branch worktree owned by another clone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-foreign-initializing-"));
  const repoA = path.join(root, "repo-a");
  const repoB = path.join(root, "repo-b");
  const worktree = path.join(root, "lane-worktree");
  try {
    fs.mkdirSync(repoA);
    (await git(repoA, "init", "--initial-branch=main"));
    (await git(repoA, "config", "user.name", "Fixture"));
    (await git(repoA, "config", "user.email", "noreply@example.com"));
    (await git(repoA, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(repoA, "tracked.txt"), "foreign lane work\n");
    (await git(repoA, "add", "tracked.txt"));
    (await git(repoA, "commit", "-m", "shared base"));
    const base = (await git(repoA, "rev-parse", "HEAD"));
    const subject = pipeline();
    const branch = subject.branch;
    (await git(repoA, "branch", branch, base));
    (await git(root, "clone", repoA, repoB));
    (await git(repoB, "branch", branch, base));
    (await git(repoB, "worktree", "add", worktree, branch));
    (await git(repoB, "worktree", "lock", "--reason=initializing", worktree));
    const foreignGitDir = (await git(worktree, "rev-parse", "--path-format=absolute", "--git-dir"));
    fs.writeFileSync(path.join(foreignGitDir, "index.lock"), "foreign lock\n");

    subject.repoDir = repoA;
    subject.worktreeDir = worktree;
    subject.baseBranch = "main";
    subject.baseRef = base;
    const result = await provisionPipelineWorktreeAsync(subject, realProvisionExec);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("not registered to this lane");
    expect(fs.readFileSync(path.join(worktree, "tracked.txt"), "utf8")).toBe("foreign lane work\n");
    expect(fs.readFileSync(path.join(foreignGitDir, "index.lock"), "utf8")).toBe("foreign lock\n");
    expect((await git(repoB, "worktree", "list", "--porcelain"))).toContain("locked initializing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
