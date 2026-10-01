import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { commitPipelineStage, currentPipelineRemoteBranchHead, pipelineWorktreeChanges, provisionPipelineWorktree, provisionPipelineWorktreeAsync, realProvisionExec, resolvePipelineBaseAsync, publishPipelineBranch, reconcilePipelinePublication, reconcilePipelineStageHead, resetPipelineStage, resolvePipelineBase, synchronizePipelineRetryHead } from "./git";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import type { Pipeline } from "./types";
import { createPipelineWithDelivery, findPipelineRecord, savePipelines, takeoverPipelineDelivery, withPipelineMutation } from "./store";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

let previousState: string | undefined;
let publicationState: string;
beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  publicationState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-git-state-"));
  process.env.LLV_STATE_DIR = publicationState;
});
afterEach(() => {
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

function git(cwd: string, ...args: string[]): string {
  const result = realExec("git", args, cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function isolatedIdentityRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-identity-"));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const repo = path.join(root, "repo");
  for (const directory of [home, xdg, repo]) fs.mkdirSync(directory);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:AUTHOR_|COMMITTER_|CONFIG_)/.test(key)) delete env[key];
  }
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") });
  const exec: ExecPort = (command, args, cwd, overrides) => {
    const result = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
  };
  const run = (...args: string[]) => {
    const result = exec("git", args, repo);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  run("init", "--initial-branch=main");
  fs.writeFileSync(path.join(repo, "source.ts"), "export const value = 1;\n");
  run("add", "source.ts");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "initial");
  return { root, repo, env, exec, run };
}

test("a real stale dirty checkout provisions from the freshly fetched origin/main tip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-base-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const source = path.join(root, "source");
  try {
    fs.mkdirSync(seed);
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(seed, "init", "--initial-branch=main");
    git(seed, "config", "user.email", "pipeline-test@example.com");
    git(seed, "config", "user.name", "Pipeline Test");
    git(seed, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(seed, "tracked.txt"), "old\n");
    git(seed, "add", "tracked.txt");
    git(seed, "commit", "-m", "old base");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-u", "origin", "main");
    git(root, "clone", origin, source);
    const staleHead = git(source, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(seed, "tracked.txt"), "new\n");
    git(seed, "commit", "-am", "advance main");
    git(seed, "push", "origin", "main");
    const currentMain = git(seed, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(source, "dirty.txt"), "preserve me\n");

    const subject = pipeline();
    subject.repoDir = source;
    subject.worktreeDir = path.join(root, "source-pipeline-12345678");
    const resolved = resolvePipelineBase(source, {}, realExec);
    expect(resolved).toEqual({ ok: true, baseBranch: "main", baseRef: currentMain });
    if (!resolved.ok) throw new Error(resolved.error);
    subject.baseBranch = resolved.baseBranch;
    subject.baseRef = resolved.baseRef;
    subject.lastPassedCommit = resolved.baseRef;

    expect(provisionPipelineWorktree(subject, realExec)).toEqual({ ok: true, sha: currentMain, baseBranch: "main" });
    expect(git(subject.worktreeDir, "rev-parse", "HEAD")).toBe(currentMain);
    expect(git(source, "rev-parse", "HEAD")).toBe(staleHead);
    expect(git(source, "status", "--porcelain")).toBe("?? dirty.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const advanceRemote of [false, true]) {
  test(`a held PR branch provisions on the lane branch and publishes only to the delivery ref (stale local: ${advanceRemote})`, async () => {
    const box = isolatedIdentityRepo();
    const { root, repo } = box;
    const origin = path.join(root, "origin.git");
    const builder = path.join(root, "builder with spaces");
    const deliveryBranch = "feature/held-pr";
    try {
      git(repo, "config", "user.name", "Fixture");
      git(repo, "config", "user.email", "noreply");
      git(repo, "config", "commit.gpgSign", "false");
      git(root, "init", "--bare", "--initial-branch=main", origin);
      git(repo, "remote", "add", "origin", origin);
      git(repo, "push", "origin", "main");
      git(repo, "worktree", "add", "-b", deliveryBranch, builder);
      fs.writeFileSync(path.join(builder, "pr.txt"), "existing PR work\n");
      git(builder, "add", "pr.txt");
      git(builder, "commit", "-m", "existing PR work");
      git(builder, "push", "origin", deliveryBranch);
      const base = git(builder, "rev-parse", "HEAD");
      const writer = path.join(root, "writer");
      git(root, "clone", origin, writer);
      git(writer, "config", "user.name", "Fixture");
      git(writer, "config", "user.email", "noreply");
      git(writer, "config", "commit.gpgSign", "false");
      git(writer, "checkout", deliveryBranch);
      if (advanceRemote) {
        git(writer, "commit", "--allow-empty", "-m", "newer remote work");
        git(writer, "push", "origin", deliveryBranch);
      }
      const current = git(writer, "rev-parse", "HEAD");
      fs.writeFileSync(path.join(builder, "pr.txt"), "uncommitted builder work\n");
      fs.writeFileSync(path.join(builder, "keep.txt"), "untracked builder work\n");
      const status = git(builder, "status", "--porcelain");
      const subject = { ...pipeline(), repoDir: repo, worktreeDir: path.join(root, "repo-pipeline-12345678"),
        baseBranch: deliveryBranch, baseRef: base, lastPassedCommit: base };
      subject.delivery!.target.branch = `refs/heads/${deliveryBranch}`;
      savePipelines([subject]);

      expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: current, baseBranch: deliveryBranch });
      expect(git(subject.worktreeDir, "branch", "--show-current")).toBe(subject.branch);
      expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: current });
      fs.writeFileSync(path.join(subject.worktreeDir, "stage.txt"), "accepted work\n");
      git(subject.worktreeDir, "add", "stage.txt");
      git(subject.worktreeDir, "commit", "-m", "accepted stage");
      const accepted = git(subject.worktreeDir, "rev-parse", "HEAD");
      expect(await publishPipelineBranch(subject, realExec, { acceptedSha: accepted })).toEqual({ ok: true, sha: accepted, remote: "published" });
      expect(git(repo, "ls-remote", "--heads", "origin", subject.delivery!.target.branch).split(/\s+/)[0]).toBe(accepted);
      expect(git(repo, "ls-remote", "--heads", "origin", `refs/heads/${subject.branch}`)).toBe("");
      // The remote can advance after publication's head probe and before push.
      git(writer, "fetch", "origin", deliveryBranch);
      git(writer, "merge", "--ff-only", "FETCH_HEAD");
      git(writer, "commit", "--allow-empty", "-m", "concurrent remote work");
      const remoteNext = git(writer, "rev-parse", "HEAD");
      git(subject.worktreeDir, "commit", "--allow-empty", "-m", "next accepted stage");
      const localNext = git(subject.worktreeDir, "rev-parse", "HEAD");
      let raced = false;
      const racing: ExecPort = (command, args, cwd) => {
        if (command === "git" && args[0] === "push") {
          raced = true;
          git(writer, "push", "origin", deliveryBranch);
        }
        return realExec(command, args, cwd);
      };
      const refused = await publishPipelineBranch(subject, racing, { acceptedSha: localNext });
      expect(raced).toBe(true);
      expect(refused.ok).toBe(false);
      expect(git(repo, "ls-remote", "--heads", "origin", subject.delivery!.target.branch).split(/\s+/)[0]).toBe(remoteNext);
      expect(git(subject.worktreeDir, "rev-parse", "HEAD")).toBe(localNext);
      expect(git(builder, "branch", "--show-current")).toBe(deliveryBranch);
      expect(git(builder, "rev-parse", "HEAD")).toBe(base);
      expect(git(builder, "status", "--porcelain")).toBe(status);
      expect(fs.readFileSync(path.join(builder, "pr.txt"), "utf8")).toBe("uncommitted builder work\n");
      expect(fs.readFileSync(path.join(builder, "keep.txt"), "utf8")).toBe("untracked builder work\n");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("an unrelated existing lane ref refuses instead of becoming the PR base", async () => {
  const box = isolatedIdentityRepo();
  const { root, repo } = box;
  const origin = path.join(root, "origin.git");
  const builder = path.join(root, "builder");
  const writer = path.join(root, "writer");
  const deliveryBranch = "feature/held-pr";
  try {
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "noreply");
    git(repo, "config", "commit.gpgSign", "false");
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", "main");
    git(repo, "worktree", "add", "-b", deliveryBranch, builder);
    fs.writeFileSync(path.join(builder, "pr.txt"), "existing PR work\n");
    git(builder, "add", "pr.txt");
    git(builder, "commit", "-m", "existing PR work");
    git(builder, "push", "origin", deliveryBranch);
    const base = git(builder, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(builder, "pr.txt"), "uncommitted builder work\n");
    fs.writeFileSync(path.join(builder, "keep.txt"), "untracked builder work\n");
    const builderStatus = git(builder, "status", "--porcelain");

    git(root, "clone", origin, writer);
    git(writer, "config", "user.name", "Fixture");
    git(writer, "config", "user.email", "noreply");
    git(writer, "config", "commit.gpgSign", "false");
    git(writer, "checkout", deliveryBranch);
    fs.writeFileSync(path.join(writer, "foreign.txt"), "unrelated lane history\n");
    git(writer, "add", "foreign.txt");
    git(writer, "commit", "-m", "unrelated lane history");
    const dormantTip = git(writer, "rev-parse", "HEAD");

    const subject = { ...pipeline(), repoDir: repo, worktreeDir: path.join(root, "lane"),
      baseBranch: deliveryBranch, baseRef: base };
    subject.delivery!.target.branch = `refs/heads/${deliveryBranch}`;
    git(repo, "fetch", writer, `${dormantTip}:refs/heads/${subject.branch}`);
    expect(git(repo, "show", `${subject.branch}:foreign.txt`)).toBe("unrelated lane history");

    const result = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the unowned lane ref to be refused");
    expect(result.error).toContain(subject.branch);
    expect(result.error).toContain("no registered lane worktree");
    expect(git(repo, "rev-parse", subject.branch)).toBe(dormantTip);
    expect(fs.existsSync(subject.worktreeDir)).toBe(false);
    expect(git(builder, "branch", "--show-current")).toBe(deliveryBranch);
    expect(git(builder, "rev-parse", "HEAD")).toBe(base);
    expect(git(builder, "status", "--porcelain")).toBe(builderStatus);
    expect(fs.readFileSync(path.join(builder, "pr.txt"), "utf8")).toBe("uncommitted builder work\n");
    expect(fs.readFileSync(path.join(builder, "keep.txt"), "utf8")).toBe("untracked builder work\n");
    expect(git(repo, "ls-remote", "--heads", "origin", `refs/heads/${deliveryBranch}`).split(/\s+/)[0]).toBe(base);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a pipeline branch held by another worktree refuses with the branch, holder and recovery action", async () => {
  const { root, repo } = isolatedIdentityRepo();
  try {
    const subject = { ...pipeline(), repoDir: repo, worktreeDir: path.join(root, "repo-pipeline-12345678"),
      baseBranch: "main", baseRef: git(repo, "rev-parse", "HEAD") };
    const holder = path.join(root, "holding lane");
    git(repo, "worktree", "add", "-b", subject.branch, holder);
    fs.writeFileSync(path.join(holder, "keep.txt"), "preserve\n");
    const result = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a held pipeline branch refusal");
    expect(result.error).toContain(subject.branch);
    expect(result.error).toContain(holder);
    expect(result.error).toContain("resume its owning lane");
    expect(git(holder, "branch", "--show-current")).toBe(subject.branch);
    expect(git(holder, "rev-parse", "HEAD")).toBe(subject.baseRef);
    expect(fs.readFileSync(path.join(holder, "keep.txt"), "utf8")).toBe("preserve\n");
    expect(fs.existsSync(subject.worktreeDir)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("provisioning through a symlinked parent adopts its own checkout on retry", async () => {
  const { root, repo } = isolatedIdentityRepo();
  try {
    const alias = path.join(root, "alias");
    fs.symlinkSync(root, alias, "dir");
    const subject = { ...pipeline(), repoDir: path.join(alias, "repo"),
      worktreeDir: path.join(alias, "repo-pipeline-12345678"),
      baseBranch: "main", baseRef: git(repo, "rev-parse", "HEAD") };
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(subject.worktreeDir, "keep.txt"), "preserve\n");
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: subject.baseRef });
    expect(git(subject.worktreeDir, "branch", "--show-current")).toBe(subject.branch);
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
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "noreply@example.com");
    git(repo, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", "base.txt");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", "main");
    const base = git(repo, "rev-parse", "HEAD");
    git(root, "clone", origin, other);
    git(other, "config", "user.name", "Fixture");
    git(other, "config", "user.email", "noreply@example.com");
    git(other, "config", "commit.gpgSign", "false");
    git(other, "checkout", "-b", "feature/shared");
    fs.writeFileSync(path.join(other, "earlier.txt"), "earlier work\n");
    git(other, "add", "earlier.txt");
    git(other, "commit", "-m", "earlier work");
    git(other, "push", "origin", "feature/shared");
    const earlier = git(other, "rev-parse", "HEAD");

    const subject = pipeline();
    Object.assign(subject, { repoDir: repo, worktreeDir: path.join(root, "repo-pipeline-12345678"), baseBranch: "main", baseRef: base, lastPassedCommit: base });
    subject.delivery!.target = { repository: "repo-fixture", remote: origin, branch: "refs/heads/feature/shared" };
    savePipelines([subject]);
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: earlier });
    expect(git(subject.worktreeDir, "branch", "--show-current")).toBe("feature/shared");
    expect(fs.existsSync(path.join(subject.worktreeDir, "earlier.txt"))).toBe(true);
    expect(realExec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${subject.branch}`], repo).code).not.toBe(0);

    git(repo, "worktree", "remove", subject.worktreeDir);
    fs.writeFileSync(path.join(other, "remote-next.txt"), "next accepted head\n");
    git(other, "add", "remote-next.txt");
    git(other, "commit", "-m", "advance delivery");
    git(other, "push", "origin", "feature/shared");
    const advanced = git(other, "rev-parse", "HEAD");
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toMatchObject({ ok: true, sha: advanced });
    expect(git(subject.worktreeDir, "rev-parse", "HEAD")).toBe(advanced);

    fs.writeFileSync(path.join(subject.worktreeDir, "local.txt"), "local work\n");
    git(subject.worktreeDir, "add", "local.txt");
    git(subject.worktreeDir, "commit", "-m", "local work");
    const local = git(subject.worktreeDir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(other, "remote.txt"), "remote work\n");
    git(other, "add", "remote.txt");
    git(other, "commit", "-m", "remote work");
    git(other, "push", "origin", "feature/shared");
    const remote = git(other, "rev-parse", "HEAD");
    const published = await publishPipelineBranch(subject, realExec, { acceptedSha: local });
    expect(published.ok).toBe(false);
    expect(!published.ok && published.error).toContain("fetch and merge the remote commits");
    expect(git(origin, "rev-parse", "refs/heads/feature/shared")).toBe(remote);
    expect(git(subject.worktreeDir, "rev-parse", "HEAD")).toBe(local);
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
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "noreply");
    git(repo, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(repo, ".gitignore"), "report.md\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", "main");
    git(repo, "branch", "feature/shared");
    git(repo, "push", "origin", "feature/shared");
    git(repo, "worktree", "add", worktree, "feature/shared");
    fs.writeFileSync(path.join(worktree, "report.md"), "local declared output\n");
    expect(git(worktree, "status", "--porcelain")).toBe("");

    git(root, "clone", origin, other);
    git(other, "config", "user.name", "Fixture");
    git(other, "config", "user.email", "noreply");
    git(other, "config", "commit.gpgSign", "false");
    git(other, "checkout", "feature/shared");
    fs.writeFileSync(path.join(other, "report.md"), "remote report\n");
    git(other, "add", "-f", "report.md");
    git(other, "commit", "-m", "publish report");
    git(other, "push", "origin", "feature/shared");

    const subject = pipeline();
    Object.assign(subject, { repoDir: repo, worktreeDir: worktree, baseBranch: "main", baseRef: base, lastPassedCommit: base });
    subject.delivery!.target = { repository: "repo-fixture", remote: origin, branch: "refs/heads/feature/shared" };
    const result = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(worktree, "report.md"), "utf8")).toBe("local declared output\n");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(base);
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
      const expected = resolvePipelineBase("/repo", input, exec);
      const expectedCommands = commands.splice(0);
      expect(await resolvePipelineBaseAsync("/repo", input, async (command, args, cwd) => exec(command, args, cwd))).toEqual(expected);
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
      expect(await provisionPipelineWorktreeAsync(subject, async (command, args, cwd) => exec(command, args, cwd)))
        .toEqual(provisionPipelineWorktree(subject, exec));
    }
  }
});

test("async Git fetch and checkout pin a real advanced remote and adopt only that head", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-async-base-"));
  try {
    const origin = path.join(root, "origin.git");
    const source = path.join(root, "source");
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(root, "clone", origin, source);
    git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "base");
    git(source, "push", "origin", "main");
    const previous = git(source, "rev-parse", "HEAD");
    git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "advance");
    git(source, "push", "origin", "main");
    const current = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "--detach", previous);
    fs.writeFileSync(path.join(source, "dirty.txt"), "preserve");
    const base = await resolvePipelineBaseAsync(source, {}, realProvisionExec);
    expect(base).toEqual({ ok: true, baseBranch: "main", baseRef: current });
    const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: current };
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: current, baseBranch: "main" });
    expect(await provisionPipelineWorktreeAsync(subject, realProvisionExec)).toEqual({ ok: true, sha: current, baseBranch: "main" });
    expect((await provisionPipelineWorktreeAsync({ ...subject, baseRef: previous }, realProvisionExec)).ok).toBe(false);
    expect(git(source, "rev-parse", "HEAD")).toBe(previous);
    expect(fs.readFileSync(path.join(source, "dirty.txt"), "utf8")).toBe("preserve");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("async exec reports launch errors, pre-abort, and a killed timeout without continuing", async () => {
  expect((await realProvisionExec("missing-provision-command", [], publicationState)).code).not.toBe(0);
  const abort = new AbortController();
  abort.abort();
  const marker = path.join(publicationState, "must-not-exist");
  const result = await realProvisionExec("touch", [marker], publicationState, abort.signal);
  expect(result.stderr).toBe("pipeline provisioning cancelled");
  expect(fs.existsSync(marker)).toBe(false);
  const calls: string[] = [];
  const base = await resolvePipelineBaseAsync(publicationState, {}, async (command, args, cwd) => {
    calls.push(args.join(" "));
    return realProvisionExec(command, [args[0]!, "0.05s", process.execPath, "-e", "setTimeout(() => {}, 5000)"], cwd);
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
      git(source, "init", "--initial-branch=main");
      fs.writeFileSync(path.join(source, ".gitattributes"), "tracked.txt filter=slow\n");
      fs.writeFileSync(path.join(source, "tracked.txt"), "complete file\n");
      git(source, "add", ".");
      git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base");
      git(source, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`);
      git(source, "config", "filter.slow.required", "true");
      const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: git(source, "rev-parse", "HEAD") };
      pending = provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal) => {
        // Exercise a real killed checkout without making this regression wait
        // sixty seconds. All probes still use the production asynchronous port.
        if (interruption === "timeout" && args[0] === "worktree" && args[1] === "add") {
          return realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal);
        }
        return realProvisionExec(command, args, cwd, signal);
      }, abort.signal);
      for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt += 1) await Bun.sleep(10);
      expect(fs.existsSync(marker)).toBe(true);
      if (interruption === "cancellation") abort.abort();
      const result = await pending;
      expect(git(subject.worktreeDir, "branch", "--show-current")).toBe(subject.branch);
      expect(git(subject.worktreeDir, "rev-parse", "HEAD")).toBe(subject.baseRef);
      expect(git(source, "worktree", "list", "--porcelain")).toContain("locked initializing");
      expect(fs.existsSync(path.join(subject.worktreeDir, "tracked.txt"))).toBe(false);
      fs.writeFileSync(path.join(subject.worktreeDir, "keep.txt"), "preserve partial checkout\n");
      expect(result.ok).toBe(false);
      // No Git process is left on the checkout: the retry does what the killed add had left to do.
      git(source, "config", "filter.slow.smudge", "cat");
      git(source, "config", "filter.slow.clean", "cat");
      const retry = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
      expect(retry).toEqual({ ok: true, sha: subject.baseRef, baseBranch: "main" });
      expect(fs.readFileSync(path.join(subject.worktreeDir, "tracked.txt"), "utf8")).toBe("complete file\n");
      expect(fs.readFileSync(path.join(subject.worktreeDir, "keep.txt"), "utf8")).toBe("preserve partial checkout\n");
      expect(git(source, "worktree", "list", "--porcelain")).not.toContain("locked");
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
    git(source, "init", "--initial-branch=main");
    fs.writeFileSync(path.join(source, ".gitattributes"), "zzslow filter=slow\n");
    fs.writeFileSync(path.join(source, "my file.txt"), "space path content\n");
    fs.writeFileSync(path.join(source, "my\tfile.txt"), "tab path content\n");
    fs.writeFileSync(path.join(source, "00-target"), "existing target\n");
    fs.symlinkSync("00-target", path.join(source, "link-existing"));
    fs.symlinkSync("zzz-target", path.join(source, "link-missing"));
    fs.writeFileSync(path.join(source, "zzslow"), "slow checkout trigger\n");
    fs.writeFileSync(path.join(source, "zzz-target"), "late target\n");
    git(source, "add", ".");
    git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base");
    git(source, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`);
    git(source, "config", "filter.slow.required", "true");
    const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: git(source, "rev-parse", "HEAD") };
    const interrupted = await provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal) => {
      if (args[0] === "worktree" && args[1] === "add") return realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal);
      return realProvisionExec(command, args, cwd, signal);
    });
    expect(interrupted.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(path.join(subject.worktreeDir, "zzz-target"))).toBe(false);
    expect(fs.lstatSync(path.join(subject.worktreeDir, "link-missing")).isSymbolicLink()).toBe(true);
    git(source, "config", "filter.slow.smudge", "cat");
    git(source, "config", "filter.slow.clean", "cat");

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
    git(source, "init", "--initial-branch=main");
    fs.writeFileSync(path.join(source, ".gitattributes"), "zzslow filter=slow\n");
    fs.writeFileSync(path.join(source, "target"), "target\n");
    fs.symlinkSync("target", path.join(source, "link"));
    fs.writeFileSync(path.join(source, "zzslow"), "slow checkout trigger\n");
    git(source, "add", ".");
    git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base");
    git(source, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`);
    git(source, "config", "filter.slow.required", "true");
    const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(root, "lane"), baseBranch: "main", baseRef: git(source, "rev-parse", "HEAD") };
    const interrupted = await provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal) => {
      if (args[0] === "worktree" && args[1] === "add") return realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal);
      return realProvisionExec(command, args, cwd, signal);
    });
    expect(interrupted.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(path.join(subject.worktreeDir, "link"));
    fs.symlinkSync("changed-target", path.join(subject.worktreeDir, "link"));
    git(source, "config", "filter.slow.smudge", "cat");
    git(source, "config", "filter.slow.clean", "cat");

    const retry = await provisionPipelineWorktreeAsync(subject, realProvisionExec);

    expect(retry).toMatchObject({ ok: false, error: "the interrupted pipeline checkout contains a modified tracked path (link); preserve it, move it aside, then retry-stage" });
    expect(fs.readlinkSync(path.join(subject.worktreeDir, "link"))).toBe("changed-target");
    expect(git(source, "worktree", "list", "--porcelain")).toContain("locked initializing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("async adoption preserves untracked files and edits made after its safety scan", async () => {
  const source = path.join(publicationState, "source");
  fs.mkdirSync(source);
  git(source, "init", "--initial-branch=main");
  fs.writeFileSync(path.join(source, "tracked.txt"), "complete file\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base");
  const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(publicationState, "lane"), baseBranch: "main", baseRef: git(source, "rev-parse", "HEAD") };
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  fs.writeFileSync(path.join(subject.worktreeDir, "keep.txt"), "preserve\n");
  git(source, "worktree", "lock", "--reason", "initializing", subject.worktreeDir);
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  expect(git(source, "worktree", "list", "--porcelain")).not.toContain("locked");
  git(source, "worktree", "lock", "--reason", "initializing", subject.worktreeDir);
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
  expect(git(source, "worktree", "list", "--porcelain")).toContain("locked initializing");
  fs.writeFileSync(tracked, "complete file\n");
  git(source, "worktree", "unlock", subject.worktreeDir);
  git(source, "worktree", "lock", "--reason", "preserve checkout", subject.worktreeDir);
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  fs.unlinkSync(path.join(subject.worktreeDir, "tracked.txt"));
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(false);
  expect(fs.readFileSync(path.join(subject.worktreeDir, "keep.txt"), "utf8")).toBe("preserve\n");
});

test.skipIf(process.platform === "win32")("an initialization a live Git process still holds is left alone and reported as held (#2176)", async () => {
  const source = path.join(publicationState, "source");
  fs.mkdirSync(source);
  git(source, "init", "--initial-branch=main");
  fs.writeFileSync(path.join(source, "tracked.txt"), "complete file\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "-m", "base");
  const subject = { ...pipeline(), repoDir: source, worktreeDir: path.join(publicationState, "lane"), baseBranch: "main", baseRef: git(source, "rev-parse", "HEAD") };
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  git(source, "worktree", "lock", "--reason", "initializing", subject.worktreeDir);
  fs.unlinkSync(path.join(subject.worktreeDir, "tracked.txt"));
  // A Git process still working inside the checkout, as a slow add's checkout would be.
  const owner = Bun.spawn(["git", "-C", subject.worktreeDir, "-c", "alias.hold=!sleep 5", "hold"], { stdout: "ignore", stderr: "ignore" });
  try {
    await Bun.sleep(200);
    const held = await provisionPipelineWorktreeAsync(subject, realProvisionExec);
    expect(held).toEqual({ ok: false, error: `the pipeline worktree is still being initialized by git process ${owner.pid}` });
    expect(git(source, "worktree", "list", "--porcelain")).toContain("locked initializing");
    expect(fs.existsSync(path.join(subject.worktreeDir, "tracked.txt"))).toBe(false);
  } finally { owner.kill("SIGKILL"); await owner.exited; }
  expect((await provisionPipelineWorktreeAsync(subject, realProvisionExec)).ok).toBe(true);
  expect(fs.readFileSync(path.join(subject.worktreeDir, "tracked.txt"), "utf8")).toBe("complete file\n");
});

test("default base fetches and resolves origin/main without inspecting a dirty stale checkout", () => {
  const calls: string[] = [];
  const expectedBase = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "rev-parse") return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect(resolvePipelineBase("/repo", {}, exec)).toEqual({ ok: true, baseBranch: "main", baseRef: expectedBase });
  expect(calls).toEqual([
    "timeout --signal=KILL 60s git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    "git rev-parse --verify --end-of-options origin/main^{commit}",
  ]);
});

test("a base fetch the network never answers is killed at its bound and reported as a timeout (#1692)", () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return command === "timeout" ? { code: null, stdout: "", stderr: "", signal: "SIGKILL" } : { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  };

  expect(resolvePipelineBase("/repo", {}, exec)).toEqual({ ok: false, error: "fetching origin/main: git fetch timed out after 60s" });
  expect(calls).toEqual(["timeout --signal=KILL 60s git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main"]);
});

test("an explicit base resolves to an exact SHA without fetching", () => {
  const calls: string[] = [];
  const expectedBase = "1234567890abcdef1234567890abcdef12345678";
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
  };

  expect(resolvePipelineBase("/repo", { baseBranch: "release", baseRef: "release-candidate" }, exec))
    .toEqual({ ok: true, baseBranch: "release", baseRef: expectedBase });
  expect(calls).toEqual(["git rev-parse --verify --end-of-options release-candidate^{commit}"]);
});

test("an unavailable origin fails base resolution before worktree provisioning", () => {
  const exec: ExecPort = () => ({ code: 128, stdout: "", stderr: "could not read from remote" });

  expect(resolvePipelineBase("/repo", {}, exec)).toEqual({
    ok: false,
    error: "fetching origin/main: could not read from remote",
  });
});

test("an unsafe base branch is rejected before git receives it", () => {
  let calls = 0;
  const exec: ExecPort = () => {
    calls += 1;
    return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  };

  expect(resolvePipelineBase("/repo", { baseBranch: "../escaped" }, exec)).toEqual({
    ok: false,
    error: "the pipeline base branch is invalid",
  });
  expect(calls).toBe(0);
});

test("worktree provision uses the persisted exact base without reading a detached source HEAD", () => {
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
  expect(provisionPipelineWorktree(subject, exec)).toEqual({ ok: true, sha: expectedBase, baseBranch: "main" });
  expect(calls).toContain(`git worktree add -b pipeline/task-12345678 /repo-pipeline-12345678 ${expectedBase}`);
  expect(calls).not.toContain("git rev-parse --abbrev-ref HEAD");
});

test("worktree provision recovers an existing branch only at the persisted exact base", () => {
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

  expect(provisionPipelineWorktree(subject, exec)).toEqual({ ok: true, sha: expectedBase, baseBranch: "main" });

  const wrongHead: ExecPort = (_command, args) => {
    if (args[0] === "worktree") return { code: 128, stdout: "", stderr: "already exists" };
    if (args[1] === "--abbrev-ref") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    return { code: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" };
  };
  expect(provisionPipelineWorktree(subject, wrongHead)).toEqual({
    ok: false,
    error: "the pipeline worktree does not match its persisted base",
  });
});
test("pass commits a dirty stage and retry resets plus cleans", () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: " M src/x.ts\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "stage-sha\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(commitPipelineStage(pipeline(), "build", true, exec)).toEqual({ ok: true, sha: "stage-sha" });
  expect(resetPipelineStage(pipeline(), exec)).toEqual({ ok: true, sha: "base" });
  expect(calls).toContain("git add -A");
  expect(calls).toContain("git reset --hard base");
  expect(calls).toContain("git clean -fd");
});

test("read-only declared output commits with no host Git identity and leaves config untouched", () => {
  const box = isolatedIdentityRepo();
  try {
    const subject = pipeline();
    subject.worktreeDir = box.repo;
    subject.lastPassedCommit = box.run("rev-parse", "HEAD");
    expect(box.exec("git", ["var", "GIT_AUTHOR_IDENT"], box.repo).code).not.toBe(0);
    expect(box.exec("git", ["var", "GIT_COMMITTER_IDENT"], box.repo).code).not.toBe(0);
    fs.mkdirSync(path.join(box.repo, "reports"));
    fs.writeFileSync(path.join(box.repo, "reports", "audit.md"), "audited\n");

    const result = commitPipelineStage(subject, "audit", false, box.exec, ["reports/audit.md"]);
    expect(result.ok).toBe(true);
    expect(box.run("show", "--name-only", "--format=", "HEAD")).toBe("reports/audit.md");
    const fallbackEmail = ["noreply", "delegatus.invalid"].join("@");
    expect(box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce")).toBe(
      ["Delegatus", fallbackEmail, "Delegatus", fallbackEmail].join("\n"),
    );
    expect(box.exec("git", ["config", "--local", "--get", "user.name"], box.repo).code).not.toBe(0);
    expect(box.exec("git", ["config", "--local", "--get", "user.email"], box.repo).code).not.toBe(0);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test.each([false, true])("read-only output uses the controller identity despite personal Git config (role-specific: %s) and passes publication", (roleSpecific) => {
  const box = isolatedIdentityRepo();
  try {
    const email = ["configured", "example.invalid"].join("@");
    box.run("config", "--local", "user.name", "Configured Test");
    box.run("config", "--local", "user.email", email);
    if (roleSpecific) {
      for (const role of ["author", "committer"]) {
        box.run("config", "--local", `${role}.name`, `Configured ${role}`);
        box.run("config", "--local", `${role}.email`, [role, "example.invalid"].join("@"));
      }
    }
    const configBefore = box.run("config", "--local", "--list");
    const subject = pipeline();
    subject.worktreeDir = box.repo;
    subject.lastPassedCommit = box.run("rev-parse", "HEAD");
    fs.mkdirSync(path.join(box.repo, "reports"));
    fs.writeFileSync(path.join(box.repo, "reports", "audit.md"), "audited\n");

    expect(commitPipelineStage(subject, "audit", false, box.exec, ["reports/audit.md"]).ok).toBe(true);
    const controllerEmail = ["noreply", "delegatus.invalid"].join("@");
    expect(box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce")).toBe(
      ["Delegatus", controllerEmail, "Delegatus", controllerEmail].join("\n"),
    );
    expect(box.run("config", "--local", "--get", "user.email")).toBe(email);
    expect(box.run("config", "--local", "--get", "user.name")).toBe("Configured Test");
    expect(box.run("config", "--local", "--list")).toBe(configBefore);
    const publication = box.exec(process.execPath, [
      path.resolve("scripts/privacy-publication-gate.ts"), "--repository", box.repo,
      "--base", subject.lastPassedCommit, "--check-commits",
    ], box.repo);
    expect(publication.stdout + publication.stderr).toContain("PRIVACY GATE: PASS");
    expect(publication.code).toBe(0);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("controller stage commit overrides inherited identities and leaves agent commits untouched", () => {
  const box = isolatedIdentityRepo();
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

    expect(commitPipelineStage(subject, "build", true, box.exec).ok).toBe(true);
    const controllerEmail = ["noreply", "delegatus.invalid"].join("@");
    expect(box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce")).toBe(
      ["Delegatus", controllerEmail, "Delegatus", controllerEmail].join("\n"),
    );
    box.run("commit", "--allow-empty", "-m", "agent work");
    expect(box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce")).toBe(
      ["Environment Author", authorEmail, "Environment Committer", committerEmail].join("\n"),
    );
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("read-only stage records a declared report without granting source commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-output-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    git(root, "add", "source.ts");
    git(root, "commit", "-m", "initial");

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");

    expect(fs.readFileSync(path.join(root, "reports", "audit.md"), "utf8")).toBe("audited\n");
    const result = commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"]);
    expect(result.ok).toBeTrue();
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("reports/audit.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage records an ignored declared report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-ignored-output-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, ".gitignore"), "reports/\n");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    git(root, "add", ".gitignore", "source.ts");
    git(root, "commit", "-m", "initial");

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");

    expect(git(root, "status", "--porcelain")).toBe("");
    const result = commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"]);
    expect(result.ok).toBeTrue();
    expect(result.ok && result.sha).not.toBe(subject.lastPassedCommit);
    expect(git(root, "show", "HEAD:reports/audit.md")).toBe("audited");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a declared output directory leaves ignored descendants alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-output-directory-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, ".gitignore"), "reports/private/\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-m", "initial");
    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports", "private"), { recursive: true });
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    fs.writeFileSync(path.join(root, "reports", "private", "sentinel.txt"), "leave alone\n");

    expect(commitPipelineStage(subject, "audit", false, realExec, ["reports"])).toMatchObject({ ok: true });
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("reports/audit.md");
    expect(fs.readFileSync(path.join(root, "reports", "private", "sentinel.txt"), "utf8")).toBe("leave alone\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage refuses source edits beside a declared report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-source-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    git(root, "add", "source.ts");
    git(root, "commit", "-m", "initial");

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 2;\n");

    expect(commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"])).toEqual({
      ok: false,
      error: "read-only stage audit modified undeclared worktree paths",
    });
    expect(git(root, "rev-parse", "HEAD")).toBe(subject.lastPassedCommit);
    expect(git(root, "status", "--porcelain")).toContain("source.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage refuses an agent-created commit even when it contains only a declared report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-commit-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    git(root, "add", "source.ts");
    git(root, "commit", "-m", "initial");

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    git(root, "add", "reports/audit.md");
    git(root, "commit", "-m", "agent commit");

    expect(commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"])).toEqual({
      ok: false,
      error: "read-only stage audit created a commit",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review retry preserves a local additive repair that is ahead of origin (#522)", () => {
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

  expect(synchronizePipelineRetryHead(subject, exec)).toEqual({ ok: true, sha: localRepair });
  expect(calls.some((call) => call.startsWith("git merge --ff-only"))).toBe(false);
  expect(calls.some((call) => call.includes("reset --hard"))).toBe(false);
});

test("issue 533: manual review retry never resets clean remote 8232d71 to stale a88ddee", () => {
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

  expect(synchronizePipelineRetryHead(subject, exec)).toEqual({ ok: true, sha: synchronizedHead });
  expect(calls.some((call) => call.includes("reset --hard"))).toBe(false);
  expect(calls.some((call) => call.startsWith("git merge "))).toBe(false);
});

test("review retry preserves an ignored declared output when the remote repair starts tracking it", async () => {
  const box = publishSandbox();
  const other = path.join(box.root, "other");
  try {
    fs.writeFileSync(path.join(box.subject.worktreeDir, ".gitignore"), "report.md\n");
    git(box.subject.worktreeDir, "add", ".gitignore");
    git(box.subject.worktreeDir, "commit", "-m", "ignore report");
    const local = git(box.subject.worktreeDir, "rev-parse", "HEAD");
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: local })).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(box.subject.worktreeDir, "report.md"), "local declared output\n");
    expect(git(box.subject.worktreeDir, "status", "--porcelain")).toBe("");

    git(box.root, "clone", box.origin, other);
    git(other, "config", "user.name", "Fixture");
    git(other, "config", "user.email", "noreply");
    git(other, "config", "commit.gpgSign", "false");
    git(other, "checkout", box.subject.branch);
    fs.writeFileSync(path.join(other, "report.md"), "remote repair\n");
    git(other, "add", "-f", "report.md");
    git(other, "commit", "-m", "publish repair");
    git(other, "push", "origin", box.subject.branch);

    const result = synchronizePipelineRetryHead(box.subject, realExec);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(box.subject.worktreeDir, "report.md"), "utf8")).toBe("local declared output\n");
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(local);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("a real dirty worktree reports its uncommitted paths and keeps every one of them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-close-"));
  const repo = path.join(root, "repo");
  try {
    fs.mkdirSync(repo);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.email", "pipeline-test@example.com");
    git(repo, "config", "user.name", "Pipeline Test");
    git(repo, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "renamed.txt"), "moved\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");

    fs.writeFileSync(path.join(repo, "tracked.txt"), "stage work in progress\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "never discard me\n");
    git(repo, "mv", "renamed.txt", "moved.txt");

    const subject = pipeline();
    subject.worktreeDir = repo;
    const changes = pipelineWorktreeChanges(subject, realExec);

    expect(changes).toEqual({ ok: true, paths: ["moved.txt", "tracked.txt", "untracked.txt"], truncated: false });
    /* Reading the worktree must never mutate it: the close preserves the work. */
    expect(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8")).toBe("never discard me\n");
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("stage work in progress\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree change reporting truncates long lists and surfaces an unreadable worktree", () => {
  const many: ExecPort = () => ({
    code: 0,
    stdout: Array.from({ length: 22 }, (_, index) => `?? file-${index}.txt`).join("\n"),
    stderr: "",
  });
  const reported = pipelineWorktreeChanges(pipeline(), many, 20);
  expect(reported).toMatchObject({ ok: true, truncated: true });
  expect(reported.ok && reported.paths).toHaveLength(20);

  const missing: ExecPort = () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
  expect(pipelineWorktreeChanges(pipeline(), missing)).toEqual({
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
  commit: (name: string, body: string) => string;
  originHead: () => string;
}

function publishSandbox(withOrigin = true): PublishSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-publish-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "pipeline-test@example.com");
  git(repo, "config", "user.name", "Pipeline Test");
  git(repo, "config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  if (withOrigin) {
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
  }

  const subject = pipeline();
  subject.repoDir = repo;
  subject.worktreeDir = path.join(root, "repo-pipeline-12345678");
  subject.baseBranch = "main";
  subject.baseRef = git(repo, "rev-parse", "HEAD");
  subject.lastPassedCommit = subject.baseRef;
  const provisioned = provisionPipelineWorktree(subject, realExec);
  if (!provisioned.ok) throw new Error(provisioned.error);
  subject.delivery!.target.remote = withOrigin ? origin : "";
  savePipelines([subject]);

  return {
    root,
    origin,
    repo,
    subject,
    commit: (name, body) => {
      fs.writeFileSync(path.join(subject.worktreeDir, name), body);
      git(subject.worktreeDir, "add", "-A");
      git(subject.worktreeDir, "commit", "-m", `stage ${name}`);
      return git(subject.worktreeDir, "rev-parse", "HEAD");
    },
    originHead: () => {
      const listed = git(subject.worktreeDir, "ls-remote", "--heads", "origin", `refs/heads/${subject.branch}`);
      return listed.split(/\s+/)[0] ?? "";
    },
  };
}

function rebasedStageSandbox(prepare?: (box: PublishSandbox) => void) {
  const box = publishSandbox();
  prepare?.(box);
  const accepted = box.commit("accepted.txt", "accepted work\n");
  box.subject.lastPassedCommit = accepted;
  savePipelines([box.subject]);
  fs.writeFileSync(path.join(box.repo, "main.txt"), "new main\n");
  git(box.repo, "add", "main.txt");
  git(box.repo, "commit", "-m", "advance main");
  git(box.repo, "push", "origin", "main");
  git(box.subject.worktreeDir, "rebase", "origin/main");
  const head = git(box.subject.worktreeDir, "rev-parse", "HEAD");
  return { ...box, accepted, head };
}

test("stage reconciliation rejects a patch-equivalent change that was subsequently reverted", () => {
  const box = rebasedStageSandbox();
  try {
    git(box.subject.worktreeDir, "revert", "--no-edit", box.head);
    const head = git(box.subject.worktreeDir, "rev-parse", "HEAD");
    expect(git(box.subject.worktreeDir, "cherry", head, box.accepted)).toBe(`- ${box.accepted}`);
    const result = reconcilePipelineStageHead(box.subject, head, realExec);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(head);
    expect(box.originHead()).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation accepts squashed content, preserves the tree, and uses the controller identity", () => {
  const box = rebasedStageSandbox();
  try {
    box.commit("accepted.txt", "accepted work\nadditional builder work\n");
    box.commit("build.txt", "new builder work\n");
    git(box.subject.worktreeDir, "reset", "--soft", "origin/main");
    git(box.subject.worktreeDir, "commit", "-m", "squashed builder work");
    const head = git(box.subject.worktreeDir, "rev-parse", "HEAD");
    const tree = git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}");
    const result = reconcilePipelineStageHead(box.subject, head, realExec);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha)).toBe(`${result.sha} ${head} ${box.accepted}`);
    const identity = controllerCommitIdentityEnv();
    expect(git(box.subject.worktreeDir, "show", "-s", "--format=%an|%ae|%cn|%ce", result.sha))
      .toBe(`${identity.GIT_AUTHOR_NAME}|${identity.GIT_AUTHOR_EMAIL}|${identity.GIT_COMMITTER_NAME}|${identity.GIT_COMMITTER_EMAIL}`);
    expect(git(box.subject.worktreeDir, "status", "--porcelain")).toBe("");
    expect(box.originHead()).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation refuses a lost accepted deletion alongside preserved added-file content", () => {
  let deleted = "";
  const box = rebasedStageSandbox((fixture) => { deleted = fixture.commit("base.txt", ""); });
  try {
    box.commit("base.txt", "base\nbuilder extra\n");
    const head = box.commit("accepted.txt", "accepted work\nbuilder extra\n");
    const result = reconcilePipelineStageHead(box.subject, head, realExec);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(deleted);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(head);
    expect(box.originHead()).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation refuses an undone accepted deletion inside a file added by earlier accepted history", () => {
  const box = rebasedStageSandbox((fixture) => { fixture.commit("accepted.txt", "accepted work\nremove\n"); });
  try {
    const head = box.commit("accepted.txt", "accepted work\nremove\nbuilder extra\n");
    const result = reconcilePipelineStageHead(box.subject, head, realExec);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(head);
    expect(box.originHead()).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["ours", "union"])("stage reconciliation ignores repository %s merge policies when checking lost accepted content", (policy) => {
  const box = rebasedStageSandbox((fixture) => {
    fixture.commit(".gitattributes", `base.txt merge=${policy}\n`);
    fixture.commit("base.txt", "");
  });
  try {
    git(box.subject.worktreeDir, "config", "merge.ours.driver", "true");
    const head = box.commit("base.txt", "base\nbuilder extra\n");
    const result = reconcilePipelineStageHead(box.subject, head, realExec);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("dropped accepted commits");
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(head);
    expect(box.originHead()).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation retains accepted replacements when the builder extends an existing file", () => {
  const box = rebasedStageSandbox((fixture) => { fixture.commit("base.txt", "accepted replacement\n"); });
  try {
    const head = box.commit("base.txt", "accepted replacement\nbuilder extra\n");
    const tree = git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}");
    const result = reconcilePipelineStageHead(box.subject, head, realExec);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git(box.subject.worktreeDir, "rev-list", "--parents", "-n", "1", result.sha)).toBe(`${result.sha} ${head} ${box.accepted}`);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation cannot hide accepted deletions through binary diff attributes", () => {
  const box = rebasedStageSandbox((fixture) => {
    fixture.commit(".gitattributes", "*.txt -diff\n");
    fixture.commit("accepted.txt", "accepted work\nremove\n");
  });
  try {
    const head = box.commit("accepted.txt", "accepted work\nremove\nbuilder extra\n");
    const result = reconcilePipelineStageHead(box.subject, head, realExec);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(box.accepted);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(head);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("stage reconciliation cannot overwrite a head that advances at the ref update", () => {
  const box = rebasedStageSandbox();
  try {
    let advanced: string | null = null;
    const racing: ExecPort = (command, args, cwd, env) => {
      if (command === "git" && args[0] === "update-ref") advanced = box.commit("concurrent.txt", "concurrent work\n");
      return realExec(command, args, cwd, env);
    };
    const result = reconcilePipelineStageHead(box.subject, box.head, racing);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("fencing the stage reconciliation merge");
    expect(advanced).not.toBeNull();
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(advanced!);
    expect(fs.readFileSync(path.join(box.subject.worktreeDir, "concurrent.txt"), "utf8")).toBe("concurrent work\n");
    expect(box.originHead()).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("reconciled delivery remains fenced against a foreign publisher", async () => {
  const box = rebasedStageSandbox();
  try {
    git(box.subject.worktreeDir, "push", "origin", `${box.accepted}:refs/heads/${box.subject.branch}`);
    const result = reconcilePipelineStageHead(box.subject, box.head, realExec);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const foreign = { ...box.subject, id: "foreign-publisher" };
    expect(await publishPipelineBranch(foreign, realExec, { acceptedSha: result.sha })).toMatchObject({ ok: false });
    expect(box.originHead()).toBe(box.accepted);
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: result.sha })).toMatchObject({ ok: true, sha: result.sha, remote: "published" });
    expect(box.originHead()).toBe(result.sha);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("publishPipelineBranch pushes the passed commit and confirms origin carries it", async () => {
  const box = publishSandbox();
  try {
    const passed = box.commit("stage.txt", "stage work\n");
    expect(box.originHead()).toBe("");

    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({ ok: true, sha: passed, remote: "published" });
    expect(box.originHead()).toBe(passed);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch fast-forwards a branch it already published", async () => {
  const box = publishSandbox();
  try {
    const first = box.commit("one.txt", "one\n");
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: first })).toMatchObject({ ok: true, sha: first });
    const second = box.commit("two.txt", "two\n");

    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: second, publishedSha: first })).toEqual({ ok: true, sha: second, remote: "published" });
    expect(box.originHead()).toBe(second);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("an independent internal lane cannot publish a fast-forward to another lane's target", async () => {
  const box = publishSandbox();
  try {
    const ownerHead = box.commit("owner.txt", "owner work\n");
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: ownerHead })).toMatchObject({ ok: true });
    const comparisonDirectory = path.join(box.root, "repo-pipeline-comparison-lane");
    git(box.root, "clone", "--branch", box.subject.branch, box.origin, comparisonDirectory);
    git(comparisonDirectory, "checkout", "-b", "pipeline/task-comparison-lane");
    git(comparisonDirectory, "config", "user.name", "Comparison Test");
    git(comparisonDirectory, "config", "user.email", "comparison-test");
    git(comparisonDirectory, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(comparisonDirectory, "comparison.txt"), "local comparison\n");
    git(comparisonDirectory, "add", "comparison.txt");
    git(comparisonDirectory, "commit", "-m", "local comparison");
    const comparisonHead = git(comparisonDirectory, "rev-parse", "HEAD");
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
    git(comparisonDirectory, "merge-base", "--is-ancestor", ownerHead, comparisonHead);
    const result = await publishPipelineBranch(comparison, realExec, { acceptedSha: comparisonHead });
    expect({ allowed: result.ok, remoteHead: box.originHead() }).toEqual({ allowed: false, remoteHead: ownerHead });
    expect(git(comparisonDirectory, "rev-parse", "HEAD")).toBe(comparisonHead);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch refuses a diverged remote and leaves both revisions intact", async () => {
  const box = publishSandbox();
  try {
    const shared = box.commit("shared.txt", "shared\n");
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: shared })).toMatchObject({ ok: true, sha: shared });

    /* Someone else's repair lands on the remote branch; the local head does not
       contain it. Publishing it away would destroy that work. */
    const other = path.join(box.root, "other");
    git(box.root, "clone", "--branch", box.subject.branch, box.origin, other);
    git(other, "config", "user.email", "pipeline-test@example.com");
    git(other, "config", "user.name", "Pipeline Test");
    git(other, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(other, "repair.txt"), "remote repair\n");
    git(other, "add", "-A");
    git(other, "commit", "-m", "remote repair");
    git(other, "push", "origin", box.subject.branch);
    const remoteRepair = git(other, "rev-parse", "HEAD");

    const local = box.commit("local.txt", "local\n");
    const refused = await publishPipelineBranch(box.subject, realExec, { acceptedSha: local, publishedSha: shared });

    expect(refused).toEqual({
      ok: false,
      error: "the local and remote pipeline branches diverged; fetch and merge the remote commits into this worktree, then retry publication; both tips are preserved",
    });
    expect(box.originHead()).toBe(remoteRepair);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(local);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publication releases the SQLite lease during Git and refuses an in-flight takeover", async () => {
  const box = publishSandbox();
  try {
    const comparison = { ...box.subject, id: "comparison", branch: "pipeline/task-comparison", worktreeDir: path.join(box.root, "repo-pipeline-comparison") };
    await createPipelineWithDelivery(comparison, box.subject.delivery!.target);
    const head = box.commit("reserved.txt", "accepted\n");
    let takeover: ReturnType<typeof takeoverPipelineDelivery> | undefined;
    const racing: ExecPort = (command, args, cwd) => {
      if (command === "git" && args[0] === "push") {
        const db = new Database(path.join(publicationState, "state.sqlite"), { readonly: true });
        try { expect(db.query("SELECT count(*) AS n FROM state_leases WHERE collection='pipelines'").get()).toEqual({ n: 0 }); }
        finally { db.close(); }
        expect(findPipelineRecord(box.subject.id)?.delivery?.operation?.state).toBe("running");
        const lock = findPipelineRecord(box.subject.id)!.delivery!.operation!.executor!.lock;
        expect(realExec("flock", ["-n", lock, "true"], cwd).code).not.toBe(0);
        takeover = takeoverPipelineDelivery(comparison.id, box.subject.id, 1, "select comparison", "conversation_builder");
      }
      return realExec(command, args, cwd);
    };
    expect(await publishPipelineBranch(box.subject, racing, { acceptedSha: head })).toMatchObject({ ok: true, sha: head });
    expect((await takeover)?.error).toContain("in flight");
    expect(box.originHead()).toBe(head);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a same-owner adapter retry waits on its running reservation without executing Git (#1939)", async () => {
  const subject = pipeline();
  const head = "7".repeat(40);
  await publishPipelineBranch(subject, () => { throw new Error("lost publication reply"); }, { acceptedSha: head });
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
  const box = publishSandbox();
  try {
    const comparison = { ...box.subject, id: "comparison", branch: "pipeline/task-comparison", worktreeDir: path.join(box.root, "repo-pipeline-comparison") };
    await createPipelineWithDelivery(comparison, box.subject.delivery!.target);
    const head = box.commit("reply.txt", "accepted\n");
    let pushed = false;
    const lostReply: ExecPort = (command, args, cwd) => {
      if (pushed && command === "timeout") return { code: 124, stdout: "", stderr: "reply lost" };
      const result = realExec(command, args, cwd);
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
    expect(box.originHead()).toBe(head);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a Git child retains the publication fence after its Viewer executor dies", async () => {
  const box = publishSandbox();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const release = path.join(box.root, "release-push");
  const ready = path.join(box.root, "push-ready");
  try {
    const head = box.commit("orphan.txt", "accepted\n");
    const hooks = path.join(box.root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-push"), '#!/bin/sh\nprintf ready > "$DELIVERY_READY"\nwhile [ ! -f "$DELIVERY_RELEASE" ]; do sleep 0.02; done\n', { mode: 0o700 });
    git(box.repo, "config", "core.hooksPath", hooks);
    const script = `import { publishPipelineBranch } from ${JSON.stringify(path.join(import.meta.dir, "git.ts"))};
      import { findPipelineRecord } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))};
      import { realExec } from ${JSON.stringify(path.join(import.meta.dir, "../workflows/provision.ts"))};
      await publishPipelineBranch(findPipelineRecord(process.env.DELIVERY_ID), realExec, { acceptedSha: process.env.DELIVERY_HEAD });`;
    child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, DELIVERY_ID: box.subject.id,
      DELIVERY_HEAD: head, DELIVERY_READY: ready, DELIVERY_RELEASE: release }, stdout: "pipe", stderr: "pipe" });
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
    expect(box.originHead()).toBe(head);
    expect(findPipelineRecord(box.subject.id)?.delivery?.operation?.state).toBe("settled");
  } finally {
    fs.writeFileSync(release, "continue");
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    if (child) await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
}, 15_000);

test("post-push settlement contention stays recoverable in the same live Viewer", async () => {
  const box = publishSandbox();
  const previousWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "20";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held: Promise<void> | undefined;
  try {
    const head = box.commit("contention.txt", "accepted\n");
    const racing: ExecPort = (command, args, cwd) => {
      const result = realExec(command, args, cwd);
      if (command === "git" && args[0] === "push") held = withPipelineMutation(async () => { await gate; });
      return result;
    };
    const result = await publishPipelineBranch(box.subject, racing, { acceptedSha: head });
    expect(result).toMatchObject({ ok: true, remote: "unreachable", uncertain: true });
    expect(box.originHead()).toBe(head);
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
  const box = publishSandbox(false);
  try {
    const passed = box.commit("stage.txt", "stage work\n");
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({ ok: true, sha: passed, remote: "unavailable" });
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("adding an origin cannot redirect a delivery claim made without a remote", async () => {
  const box = publishSandbox(false);
  try {
    const head = box.commit("local.txt", "local work\n");
    git(box.root, "init", "--bare", "--initial-branch=main", box.origin);
    git(box.repo, "remote", "add", "origin", box.origin);
    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: head })).toEqual({ ok: true, sha: head, remote: "unavailable" });
    expect(box.originHead()).toBe("");
    expect(findPipelineRecord(box.subject.id)?.delivery?.target.remote).toBe("");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("publishPipelineBranch refuses a dirty worktree and preserves the uncommitted work", async () => {
  const box = publishSandbox();
  try {
    const passed = box.commit("stage.txt", "stage work\n");
    fs.writeFileSync(path.join(box.subject.worktreeDir, "in-progress.txt"), "unfinished\n");

    expect(await publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({
      ok: false,
      error: "the pipeline worktree has uncommitted changes; choose whether to commit or discard them before retrying review",
    });
    expect(git(box.subject.worktreeDir, "status", "--porcelain")).toBe("?? in-progress.txt");
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
  const answer = (result: { code: number | null; stdout?: string; stderr?: string }) => {
    const calls: string[] = [];
    const exec: ExecPort = (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "timeout") return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      return { code: 128, stdout: "", stderr: "remote read must be bounded" };
    };
    return { result: currentPipelineRemoteBranchHead(pipeline(), exec), calls };
  };
  const unreachable = "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";

  const answered = answer({ code: 0, stdout: `${head}\trefs/heads/${pipeline().branch}\n` });
  expect(answered.result).toEqual({ ok: true, sha: head });
  expect(answered.calls).toEqual([`timeout --signal=KILL 5s git ls-remote --heads origin refs/heads/${pipeline().branch}`]);

  expect(answer({ code: 124 }).result).toEqual({
    ok: false,
    transient: true,
    error: "checking the remote pipeline branch: git remote read timed out after 5s",
  });
  for (const stderr of [
    `ssh: connect to host example.invalid port 22: Connection timed out\r\n${unreachable}`,
    `ssh: Could not resolve hostname example.invalid: Temporary failure in name resolution\r\n${unreachable}`,
    "fatal: unable to access 'https://example.invalid/owner/repo.git/': Failed to connect to example.invalid port 443: Connection refused",
  ]) {
    expect(answer({ code: 128, stderr }).result).toMatchObject({ ok: false, transient: true });
  }
  for (const stderr of [
    `git@example.invalid: Permission denied (publickey).\r\n${unreachable}`,
    `Connection closed by 192.0.2.1 port 22\r\nHost key verification failed.\r\n${unreachable}`,
    "remote: Repository not found.\nfatal: repository 'https://example.invalid/owner/repo.git/' not found",
    "fatal: 'origin' does not appear to be a git repository",
  ]) {
    expect(answer({ code: 128, stderr }).result).toMatchObject({ ok: false, transient: false });
  }
  expect(answer({ code: 0, stdout: "" }).result).toEqual({ ok: false, transient: false, error: "the remote pipeline branch has no exact commit SHA" });
});

test("a real remote read that hangs is killed at the bound and reads as a network timeout (#1692)", async () => {
  /* `timeout --signal=KILL` takes itself down with the command, so the child
     ends on a signal with no exit status. An SSH transport that never answers
     is the incident's shape, reproduced here without a network. */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-remote-hang-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "core.sshCommand", "sh -c 'sleep 30' fake-ssh");
    git(root, "remote", "add", "origin", "ssh://git@example.invalid/owner/repo.git");
    const subject = pipeline();
    subject.worktreeDir = root;

    const read = currentPipelineRemoteBranchHead(subject, realExec);

    /* Only a read killed at its bound answers this way; the fake transport
       would otherwise have run its thirty seconds and exited. */
    expect(read).toEqual({ ok: false, transient: true, error: "checking the remote pipeline branch: git remote read timed out after 5s" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("publication pushes only the immutable accepted revision when the branch advances mid-publish", async () => {
  const box = publishSandbox();
  try {
    const accepted = box.commit("accepted.txt", "accepted\n");
    let racy: string | null = null;

    /* The branch advances in the window between the publisher capturing the
       accepted revision and the push running — here on the remote probe, which
       sits exactly in that window. Pushing `refs/heads/<branch>` would carry
       this unaccepted commit to origin and leave review fenced on a target that
       never passed; pushing the accepted object cannot. */
    const racing: ExecPort = (command, args, cwd) => {
      if (command === "timeout" && args.includes("ls-remote") && racy === null) {
        racy = box.commit("racy.txt", "never accepted\n");
      }
      return realExec(command, args, cwd);
    };

    const published = await publishPipelineBranch(box.subject, racing, { acceptedSha: accepted });

    expect(racy).not.toBeNull();
    expect(racy).not.toBe(accepted);
    /* The local branch really did move on mid-publish ... */
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(racy!);
    /* ... and origin carries exactly the accepted revision, never the racy one. */
    expect(published).toEqual({ ok: true, sha: accepted, remote: "published" });
    expect(box.originHead()).toBe(accepted);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("a worktree that has moved past the accepted revision publishes nothing", async () => {
  const box = publishSandbox();
  try {
    const accepted = box.commit("accepted.txt", "accepted\n");
    const advanced = box.commit("later.txt", "later\n");

    const result = await publishPipelineBranch(box.subject, realExec, { acceptedSha: accepted });

    expect(result).toEqual({
      ok: false,
      error: `the pipeline worktree is at ${advanced}, not the accepted revision ${accepted}; nothing was published`,
    });
    expect(box.originHead()).toBe("");
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
    git(repoA, "init", "--initial-branch=main");
    git(repoA, "config", "user.name", "Fixture");
    git(repoA, "config", "user.email", "noreply@example.com");
    git(repoA, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(repoA, "tracked.txt"), "foreign lane work\n");
    git(repoA, "add", "tracked.txt");
    git(repoA, "commit", "-m", "shared base");
    const base = git(repoA, "rev-parse", "HEAD");
    const subject = pipeline();
    const branch = subject.branch;
    git(repoA, "branch", branch, base);
    git(root, "clone", repoA, repoB);
    git(repoB, "branch", branch, base);
    git(repoB, "worktree", "add", worktree, branch);
    git(repoB, "worktree", "lock", "--reason=initializing", worktree);
    const foreignGitDir = git(worktree, "rev-parse", "--path-format=absolute", "--git-dir");
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
    expect(git(repoB, "worktree", "list", "--porcelain")).toContain("locked initializing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
