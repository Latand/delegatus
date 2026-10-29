import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import * as stageGuard from "@/lib/git/stageAttemptGuard";
import { agentCodexPublicationPolicy, agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { commitAndAdoptStageBranch } from "./stageBranch";
import { adoptStructuredHostsAtStartup } from "@/lib/runtime/startup";
import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";
import { AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { emptyLaunchProfile, type ProviderReceipt } from "@/lib/accounts/migration/contracts";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import { ClaudeStreamBrokerHost } from "@/lib/runtime/claudeStreamBrokerHost";
import { CodexAppServerHost } from "@/lib/runtime/codexAppServerHost";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import { buildPipeline, loadPipelines, savePipelines } from "./store";
import type { Pipeline, PipelineStageAttempt } from "./types";

const START = "2026-10-16T08:00:00.000Z", NOW = "2026-10-16T12:00:00.000Z";
let nextFixture = 0;
async function fixture(legacy = false, successor = false, prBase?: { mainBeforeCreation?: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-proof-"));
  const lane = path.join(root, "lane"), remote = path.join(root, "remote.git"), foreign = path.join(root, "foreign");
  const baseEnv = { ...process.env, ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined])),
    HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent-git-config"), GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_DATE: "2026-10-16T09:00:00Z", GIT_COMMITTER_DATE: "2026-10-16T09:00:00Z" };
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const git = async (cwd: string, ...args: string[]) => {
    const r = await realExec("git", args, cwd, cwd === lane ? env : baseEnv);
    expect(r.code, r.stderr).toBe(0); return r.stdout.trim();
  };
  await fs.mkdir(lane);
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(lane, "init", "--initial-branch=main");
  await git(lane, "config", "user.name", "Fixture");
  await git(lane, "config", "user.email", ["noreply", "example.invalid"].join("@"));
  await git(lane, "config", "commit.gpgSign", "false");
  // These historical machine-identity cases model a privacy-bound project.
  await fs.mkdir(path.join(lane, "scripts"));
  await fs.writeFile(path.join(lane, "package.json"), JSON.stringify({ scripts: { "privacy:check": "bun scripts/privacy-publication-gate.ts" } }));
  await fs.writeFile(path.join(lane, "scripts/privacy-known-value-fingerprints.json"), "{}");
  await git(lane, "add", "package.json", "scripts");
  await git(lane, "commit", "--allow-empty", "-m", "base");
  let base = await git(lane, "rev-parse", "HEAD");
  await git(lane, "remote", "add", "origin", remote);
  await git(lane, "push", "origin", "main");
  if (successor) {
    await git(lane, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await git(lane, "commit", "--allow-empty", "-m", "reviewed successor base");
    base = await git(lane, "rev-parse", "HEAD");
  }
  await git(lane, "checkout", "-b", "pipeline/proof");
  await git(root, "clone", remote, foreign);
  await git(foreign, "config", "user.name", "Fixture");
  await git(foreign, "config", "user.email", ["noreply", "example.invalid"].join("@"));
  await git(foreign, "config", "commit.gpgSign", "false");
  if (prBase) await git(lane, "push", "origin", "HEAD:refs/heads/pipeline/proof");
  if (prBase?.mainBeforeCreation) {
    await git(foreign, "commit", "--allow-empty", "-m", "main before lane creation");
    await git(foreign, "push", "origin", "main");
  }
  const launchId = `stage-proof-fixture-${++nextFixture}`;
  const attempt = { launchId, startedAt: START, completedAt: null } as PipelineStageAttempt;
  const pipeline = { id: "proof", worktreeDir: lane, branch: "pipeline/proof", baseBranch: prBase ? "pipeline/proof" : "main", baseRef: base, lastPassedCommit: base,
    delivery: { active: true, disposition: "owner", ownerId: "proof", publish: "enabled",
      target: { remote, repository: projectIdentityFromRemote(remote, lane)!.project, branch: "refs/heads/pipeline/proof" } } } as Pipeline;
  if (!legacy) {
    Object.assign(env, await prepareStageGitGuard(launchId, lane, realExec, START, async () => {}));
  }
  Object.assign(env, agentPublicationIdentityEnv({ ...env, HOME: root }));
  const own = async (...args: string[]) => await git(lane, ...args);
  const commit = async (label: string) => { await own("commit", "--allow-empty", "-m", label); return own("rev-parse", "HEAD"); };
  const push = async () => own("push", "origin", "HEAD:refs/heads/pipeline/proof");
  const settle = () => settleStageAttemptPush(pipeline, attempt, realExec, NOW);
  return { root, lane, remote, foreign, env, git, own, commit, push, settle, pipeline, attempt, receipt: stageGitReceiptDirectory(launchId),
    close: async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(stageGitReceiptDirectory(launchId), { recursive: true, force: true }); } };
}

test.each(["commit", "push"] as const)("a superseded producer cannot %s; an explicit fix stage restores publication", async action => {
  const f = await fixture();
  const review = `stage-proof-review-${nextFixture}`, fix = `stage-proof-fix-${nextFixture}`;
  try {
    await f.push();
    const remoteBefore = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    const reviewed = await f.commit("producer output ready for review");
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
    // Each command is a fresh Git process using the old producer's environment.
    const command = action === "commit" ? ["commit", "--no-verify", "--allow-empty", "-m", "late producer output"]
      : ["push", "origin", "HEAD:refs/heads/pipeline/proof"];
    const denied = await realExec("git", command, f.lane, f.env);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("a successor owns this worktree");
    expect(await f.own("rev-parse", "HEAD")).toBe(reviewed);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(remoteBefore);
    // Opening a fix stage grants its own binding; the old one stays revoked.
    Object.assign(f.env, await prepareStageGitGuard(fix, f.lane, realExec, "2026-10-16T11:00:00.000Z", async () => {}));
    const fixed = await f.commit("fix requested by a new stage");
    await f.push();
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(fixed);
  } finally {
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await fs.rm(stageGitReceiptDirectory(fix), { recursive: true, force: true });
    await f.close();
  }
});

test("a restarted preparation cannot reclaim its superseded worktree binding", async () => {
  const f = await fixture();
  const review = `stage-proof-review-restart-${nextFixture}`;
  try {
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
    const child = Bun.spawn([process.execPath, "--eval", `
      const {prepareStageGitGuard}=await import("./src/lib/git/stageAttemptGuard.ts");
      const {realExec}=await import("./src/lib/workflows/provision.ts");
      await prepareStageGitGuard(process.env.PROOF_LAUNCH,process.env.PROOF_LANE,realExec,process.env.PROOF_START, async () => {});
    `], { cwd: process.cwd(), env: { ...process.env, PROOF_LAUNCH: f.attempt.launchId!, PROOF_LANE: f.lane, PROOF_START: START }, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("superseded by another attempt");
    const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
    expect(await fs.readFile(owner, "utf8")).toBe(stageGitReceiptDirectory(review));
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
  } finally {
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["rev-parse --absolute-git-dir", "rev-parse HEAD"])("a successor admitted during %s keeps its worktree fence", async lookup => {
  const f = await fixture();
  const seam = lookup === "rev-parse HEAD" ? "head" : "git-directory";
  const delayed = `stage-proof-delayed-${seam}`, review = `stage-proof-racing-review-${seam}`;
  try {
    const activation = path.join(f.root, "active-launch");
    await fs.writeFile(activation, delayed);
    let successor: Record<string, string> = {};
    const exec: typeof realExec = async (...args) => {
      const result = await realExec(...args);
      if (args[0] === "git" && args[1].join(" ") === lookup) {
        await fs.writeFile(activation, review);
        successor = await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
      }
      return result;
    };
    await expect(prepareStageGitGuard(delayed, f.lane, exec, "2026-10-16T09:00:00.000Z", async () => {
      if (await fs.readFile(activation, "utf8") !== delayed) throw new Error("superseded by another attempt");
    }))
      .rejects.toThrow("superseded by another attempt");
    const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
    expect(await fs.readFile(owner, "utf8")).toBe(stageGitReceiptDirectory(review));
    expect(await fs.access(owner + ".lock").then(() => true, () => false)).toBe(false);
    Object.assign(f.env, successor);
    const made = await f.commit("successor retains commit authority");
    await f.push();
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(made);
  } finally {
    await fs.rm(stageGitReceiptDirectory(delayed), { recursive: true, force: true });
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

// These probes intercept Git through a POSIX executable and use native symlinks.
test.skipIf(process.platform === "win32").each([
  ["commit", "absent"], ["push", "absent"],
  ["commit", "self"], ["push", "self"],
  ["commit", "chained"], ["push", "chained"],
] as const)("ownership is rechecked after guard work: %s / %s", async (action, forwarding) => {
  const f = await fixture();
  const review = `stage-proof-no-hook-${action}-${forwarding}`;
  try {
    await f.push();
    const remoteBefore = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    if (action === "push") await f.commit("producer output awaiting publication");
    const before = await f.own("rev-parse", "HEAD");
    const hook = action === "commit" ? "reference-transaction" : "pre-push";
    let chained: string | undefined;
    if (forwarding !== "absent") {
      const hooks = path.join(f.lane, ".githooks");
      await fs.mkdir(hooks);
      const target = path.join(hooks, hook);
      if (forwarding === "self") await fs.symlink(path.join(f.env.LLV_AGENT_GIT_GUARD_DIR!, hook), target);
      else {
        await fs.writeFile(target, "#!/bin/sh\nexit 91\n", { mode: 0o700 });
        chained = target;
      }
      await f.own("config", "core.hooksPath", hooks);
    }
    const originalGit = Bun.which("git")!;
    const bin = path.join(f.root, "bin");
    await fs.mkdir(bin);
    const marker = path.join(f.root, "handoff");
    const successor = stageGitReceiptDirectory(review);
    const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
    const script = path.join(f.root, "admit-successor.ts");
    await fs.writeFile(script, `
      const {prepareStageGitGuard} = await import(${JSON.stringify(path.resolve("src/lib/git/stageAttemptGuard.ts"))});
      const {realExec} = await import(${JSON.stringify(path.resolve("src/lib/workflows/provision.ts"))});
      await prepareStageGitGuard(process.env.PROOF_REVIEW, process.env.PROOF_LANE, realExec, ${JSON.stringify(NOW)}, async () => {});
    `);
    await fs.writeFile(path.join(bin, "git"), `#!/bin/sh
if { [ "$PROOF_ACTION" = commit ] && [ "$*" = "show -s --no-show-signature --format=%T %P $5" ]; } ||
   { [ "$PROOF_ACTION" = push ] && [ "$*" = "-C $PROOF_LANE remote get-url --push origin" ]; }; then
  if mkdir "$PROOF_MARKER" 2>/dev/null; then
    (cd "$PROOF_PROJECT" && "$PROOF_BUN" "$PROOF_SCRIPT") || exit 1
  fi
fi
exec "$PROOF_GIT" "$@"
`, { mode: 0o700 });
    const env = { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}`, GIT_EXEC_PATH: bin, PROOF_GIT: originalGit,
      LLV_AGENT_GIT_CHAINED_HOOK: chained, PROOF_ACTION: action, PROOF_REVIEW: review, PROOF_LANE: f.lane, PROOF_MARKER: marker,
      PROOF_PROJECT: process.cwd(), PROOF_BUN: process.execPath, PROOF_SCRIPT: script };
    const args = action === "commit" ? ["commit", "--allow-empty", "-m", "superseded during guard work"]
      : ["push", "origin", "HEAD:refs/heads/pipeline/proof"];
    const denied = await realExec("git", args, f.lane, env);
    expect(await fs.readFile(owner, "utf8"), denied.stderr).toBe(successor);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("a successor owns this worktree");
    expect(await f.own("rev-parse", "HEAD")).toBe(before);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(remoteBefore);
  } finally {
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["binding", "handoff"] as const)("disk exhaustion during the owner %s keeps the previous owner and permits a retry", async phase => {
  const f = await fixture();
  const review = `stage-proof-disk-${phase}-${nextFixture}`;
  const owner = await fs.readFile(path.join(f.receipt, "owner"), "utf8");
  const noSpace = () => { throw Object.assign(new Error("fixture disk is full"), { code: "ENOSPC" }); };
  const write = fs.writeFile, rename = fs.rename;
  const fault = phase === "binding"
    ? spyOn(fs, "writeFile").mockImplementation((...args) => String(args[0]) === path.join(stageGitReceiptDirectory(review), "owner") ? noSpace() : write(...args))
    : spyOn(fs, "rename").mockImplementation((...args) => String(args[1]) === owner ? noSpace() : rename(...args));
  try {
    await expect(prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}))
      .rejects.toMatchObject({ code: "ENOSPC" });
    expect(await fs.readFile(owner, "utf8")).toBe(f.receipt);
    expect(await fs.access(owner + ".lock").then(() => true, () => false)).toBe(false);
    fault.mockRestore();
    await prepareStageGitGuard(review, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {});
    expect(await fs.readFile(owner, "utf8")).toBe(stageGitReceiptDirectory(review));
  } finally {
    fault.mockRestore();
    await fs.rm(stageGitReceiptDirectory(review), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["pre-push", "reference-transaction"] as const)("ownership is rechecked after a repository %s hook", async hook => {
  const f = await fixture();
  try {
    await f.push();
    const remoteBefore = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    if (hook === "pre-push") await f.commit("producer output awaiting publication");
    const before = await f.own("rev-parse", "HEAD");
    const hooks = path.join(f.root, "repository-hooks");
    await fs.mkdir(hooks);
    await f.own("config", "core.hooksPath", hooks);
    await fs.writeFile(path.join(hooks, hook), `#!/bin/sh
printf '%s\\n' "$@" > "$PROOF_ARGS"
cat > "$PROOF_INPUT"
if [ "${hook}" = pre-push ] || [ "$1" = prepared ]; then
  printf '%s' successor > "$PROOF_OWNER"
fi
`, { mode: 0o700 });
    const env = { ...f.env, PROOF_OWNER: await fs.readFile(path.join(f.receipt, "owner"), "utf8"),
      PROOF_INPUT: path.join(f.root, "input"), PROOF_ARGS: path.join(f.root, "args") };
    const args = hook === "pre-push" ? ["push", "origin", "HEAD:refs/heads/pipeline/proof"]
      : ["commit", "--allow-empty", "-m", "superseded inside repository hook"];
    const denied = await realExec("git", args, f.lane, env);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("a successor owns this worktree");
    expect(await f.own("rev-parse", "HEAD")).toBe(before);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(remoteBefore);
    if (hook === "pre-push") {
      expect(await fs.readFile(env.PROOF_ARGS, "utf8")).toBe(`origin\n${f.remote}\n`);
      expect(await fs.readFile(env.PROOF_INPUT, "utf8")).toBe(`HEAD ${before} refs/heads/pipeline/proof ${remoteBefore}\n`);
    }
  } finally { await f.close(); }
});

test.each(["before", "after"] as const)("PR-base successor settles a merge of main advanced %s lane creation", async timing => {
  const f = await fixture(false, true, { mainBeforeCreation: timing === "before" });
  try {
    // A successor's explicit base branch can be its PR branch. Main remains
    // independent of that branch, even when main moved before provisioning.
    f.pipeline.delivery!.target.pr = 1;
    if (timing === "after") {
      await f.git(f.foreign, "commit", "--allow-empty", "-m", "main after lane creation");
      await f.git(f.foreign, "push", "origin", "main");
    }
    const main = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "integrate main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    // Reproduce the controller's stale cache as well as the PR-base mismatch.
    await f.own("update-ref", "refs/remotes/origin/main", await f.own("rev-parse", `${main}^`));
    f.pipeline.repoDir = f.lane;
    expect(await commitAndAdoptStageBranch(f.pipeline, "build", realExec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW)).toEqual({ ok: true, sha: head });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
  } finally { await f.close(); }
});

test("a pushed stage head is proved before controller staging can sweep scratch files or name an ignored artifact directory (#2631)", async () => {
  const f = await fixture();
  try {
    f.pipeline.repoDir = f.lane;
    await fs.writeFile(path.join(f.lane, ".gitignore"), ".artifacts/\n");
    await fs.mkdir(path.join(f.lane, ".artifacts"));
    await fs.writeFile(path.join(f.lane, ".artifacts", "kept.txt"), "tracked despite the directory ignore\n");
    await f.own("add", ".gitignore");
    await f.own("add", "-f", ".artifacts/kept.txt");
    await f.own("commit", "-m", "stage result");
    const head = await f.own("rev-parse", "HEAD");
    await f.push();
    await fs.writeFile(path.join(f.lane, "stage.log"), "scratch output\n");
    const calls: string[][] = [];
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      calls.push([command, ...args]);
      return realExec(command, args, cwd, env, options);
    };

    const settled = await commitAndAdoptStageBranch(f.pipeline, "build", exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW);

    expect(calls.some(([command, action]) => command === "git" && action === "add")).toBe(false);
    expect(settled).toEqual({ ok: false,
      error: "settling the stage push: adoption requires a clean owned lane branch; both tips are preserved" });
    expect(await f.own("diff", "--cached", "--name-only")).toBe("");
    expect(await fs.readFile(path.join(f.lane, "stage.log"), "utf8")).toBe("scratch output\n");
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(head);
  } finally { await f.close(); }
});

test.each(["local", "pushed", "repair"] as const)("PR-base successor refuses a foreign merge parent during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign branch work");
    const foreign = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.own("fetch", f.foreign, "HEAD");
    await f.own("update-ref", "refs/remotes/origin/main", foreign);
    await f.own("merge", "--no-ff", "-m", "own merge of foreign work", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    if (mode === "pushed") await f.push();
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${foreign} was not created`) });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
  } finally { await f.close(); }
});

test.each(["local", "pushed", "repair"] as const)("PR-base successor rejects redirected-origin ancestry during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign main work");
    const foreign = await f.git(f.foreign, "rev-parse", "HEAD");
    // The lane's origin alias is editable. Keep delivery pointed at the
    // original bare remote, and merge the foreign main through the alias.
    await f.own("remote", "set-url", "origin", f.foreign);
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "merge redirected origin main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    const originalTip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    if (mode === "pushed") {
      const pushed = await f.own("push", f.remote, "HEAD:refs/heads/pipeline/proof");
      expect(pushed).toBe("");
    }
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${foreign} was not created`) });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
    if (mode !== "pushed") expect(tip).toBe(originalTip);
  } finally { await f.close(); }
});

test.each(["local", "pushed", "repair"] as const)("PR-base successor rejects main ancestry redirected by a URL-shaped push alias during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    const foreignUrl = "file://" + f.foreign;
    await f.own("config", "remote." + foreignUrl + ".url", f.remote);
    await f.own("config", "remote." + foreignUrl + ".pushurl", f.foreign);
    f.pipeline.delivery!.target.remote = foreignUrl;

    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign main work");
    const foreign = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.own("fetch", f.foreign, "main");
    await f.own("merge", "--no-ff", "-m", "merge foreign main", "FETCH_HEAD");
    const head = await f.own("rev-parse", "HEAD");

    if (mode === "pushed") {
      await f.own("push", f.remote, "HEAD:" + f.pipeline.delivery!.target.branch);
      await fs.writeFile(path.join(f.receipt, "pushes", head),
        f.pipeline.delivery!.target.branch + "\n" + f.foreign + "\n");
    }
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("commit " + foreign + " was not created") });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    if (mode === "pushed") expect(await f.git(f.remote, "rev-parse", f.pipeline.delivery!.target.branch)).toBe(head);
  } finally { await f.close(); }
});

test.each(["local", "repair"] as const)("PR-base successor rejects URL-named fetch alias ancestry during %s settlement", async mode => {
  const f = await fixture(false, true, {});
  try {
    f.pipeline.delivery!.target.pr = 1;
    const trustedUrl = "file://" + f.remote;
    const foreignUrl = "file://" + f.foreign;
    f.pipeline.delivery!.target.remote = trustedUrl;
    await f.own("config", "remote." + trustedUrl + ".url", foreignUrl);
    await f.own("config", "remote." + trustedUrl + ".pushurl", trustedUrl);

    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign main work");
    await f.own("fetch", foreignUrl, "main");
    await f.own("merge", "--no-ff", "-m", "merge foreign main", "FETCH_HEAD");
    const head = await f.own("rev-parse", "HEAD");
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("delivery fetch URL does not match the persisted repository") });
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(f.pipeline.baseRef);
  } finally { await f.close(); }
});

test.each(["pushed", "repair"] as const)("PR-base successor verifies current origin main during %s settlement", async mode => {
  const f = await fixture(false, true, { mainBeforeCreation: true });
  try {
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "integrate main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    if (mode === "pushed") await f.push();
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, realExec, NOW,
      mode === "repair" ? { acceptedHead: f.pipeline.baseRef } : undefined)).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});

test.each(["lookup timeout", "fetch timeout", "missing main", "malformed tip"] as const)("PR-base successor preserves tips on %s", async fault => {
  const f = await fixture(false, true, { mainBeforeCreation: true });
  try {
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "integrate main", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    let reads = 0, fetches = 0;
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      if (command === "git" && args.join(" ") === `ls-remote --refs ${f.remote} refs/heads/main`) {
        reads++;
        expect(options?.timeoutMs).toBe(5000);
        if (fault === "lookup timeout") return { code: 124, stdout: "", stderr: "fixture timeout" };
        if (fault === "missing main") return { code: 0, stdout: "", stderr: "" };
        if (fault === "malformed tip") return { code: 0, stdout: `${head}\trefs/heads/other\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "fetch" && args[2] === f.remote) {
        fetches++;
        expect(options?.timeoutMs).toBe(10000);
        if (fault === "fetch timeout") return { code: 124, stdout: "", stderr: "fixture timeout" };
      }
      return realExec(command, args, cwd, env, options);
    };
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, exec, NOW);
    expect(result?.ok).toBe(false);
    if (fault.endsWith("timeout")) expect(result).toMatchObject({ deferred: true });
    expect(reads).toBe(1);
    expect(fetches).toBe(fault === "fetch timeout" ? 1 : 0);
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
  } finally { await f.close(); }
});

for (const divergent of [false, true]) test(`successor settlement preserves an older delivery tip (divergent: ${divergent})`, async () => {
  const f = await fixture(false, true);
  try {
    const head = await f.commit("passed successor output");
    if (divergent) {
      await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign delivery output");
      await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    }
    const tip = await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof");
    f.pipeline.repoDir = f.lane;
    const result = await commitAndAdoptStageBranch(f.pipeline, "build", realExec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW);
    if (divergent) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("settling the stage push:");
    } else {
      expect(await f.own("merge-base", "--is-ancestor", tip, f.pipeline.baseRef)).toBe("");
      expect(result).toEqual({ ok: true, sha: head });
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(tip);
  } finally { await f.close(); }
});

test("B: a controller-created replacement link proves a completed parent without restartRecovery", async () => {
  const f = await fixture();
  let childLaunch: string | null = null;
  try {
    const inherited = await f.commit("completed parent output");
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: NOW, agentPath: "/stage/parent.jsonl" } as PipelineStageAttempt;
    childLaunch = `stage-proof-generic-replacement-${nextFixture}`;
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, START, async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: START, completedAt: NOW, state: "passed",
      agentPath: "/stage/child.jsonl", restartContext: { previousAttempt: 1, transcriptPath: parent.agentPath } } as PipelineStageAttempt;
    const head = await f.commit("replacement output");
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
    await f.push();
    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
    expect(inherited).not.toBe(head);
  } finally { if (childLaunch) await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true }); await f.close(); }
});

// A predecessor's own commit whose host died before post-commit is proved by
// the receipt its commit invocation wrote before moving the branch; one it
// reached by reset, or made with the launch hooks overridden, stays unproved.
test.each(["own commit, receipt lost", "own hooks-off commit", "imported commit"] as const)("review safety: manual silent retry preserves predecessor commit custody (%s)", async predecessor => {
  const f = await fixture();
  let childLaunch: string | null = null;
  try {
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: NOW, agentPath: "/stage/silent.jsonl" } as PipelineStageAttempt;
    if (predecessor === "own commit, receipt lost") {
      await commitThenDie(f, "unreceipted predecessor");
    } else if (predecessor === "own hooks-off commit") {
      const made = await realExec("git", ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "unreceipted predecessor"],
        f.lane, { ...f.env, PATH: process.env.PATH });
      expect(made.code, made.stderr).toBe(0);
    } else {
      await f.git(f.foreign, "commit", "--allow-empty", "-m", "unreceipted predecessor");
      await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
      await f.own("fetch", "origin", "pipeline/proof");
      await f.own("reset", "--hard", "FETCH_HEAD");
    }
    const inherited = await f.own("rev-parse", "HEAD");

    childLaunch = `stage-proof-manual-silent-retry-${nextFixture}`;
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, START, async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: START, completedAt: NOW, state: "passed",
      agentPath: "/stage/manual-retry.jsonl", restartContext: { previousAttempt: 1, transcriptPath: parent.agentPath } } as PipelineStageAttempt;
    const head = await f.commit("manual retry output");
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
    await f.push();

    const expected = predecessor === "own commit, receipt lost" ? { ok: true, sha: head }
      : { ok: false, error: expect.stringContaining(`commit ${inherited} was not created in the attempt worktree`) };
    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toMatchObject(expected);
    const unlinked = structuredClone(f.pipeline);
    delete unlinked.runs![0]!.attempts[1]!.restartContext;
    expect(await settleStageAttemptPush(unlinked, unlinked.runs![0]!.attempts[1]!, realExec, NOW)).toMatchObject(expected);
  } finally {
    if (childLaunch) await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["none", "foreign", "unrecorded"] as const)("the custody-to-committer handoff fences a %s head change", async race => {
  const f = await fixture();
  try {
    await f.push();
    await fs.rm(path.join(f.receipt, "pushes", f.pipeline.baseRef));
    const proved = await f.commit("proved stage output");
    let head = proved;
    let verified = false;
    let raced = false;
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, options);
      if (command === "git" && args[0] === "rev-list" && args.includes("--max-count=128")) verified = true;
      if (race !== "none" && verified && !raced && command === "git" && args[0] === "status" && args[1] === "--porcelain") {
        raced = true;
        if (race === "foreign") {
          const foreign = path.join(f.root, "handoff-foreign");
          await f.own("worktree", "add", "--detach", foreign, head);
          await f.git(foreign, "commit", "--allow-empty", "-m", "foreign handoff output");
          head = await f.git(foreign, "rev-parse", "HEAD");
          await f.own("merge", "--ff-only", head);
        } else {
          head = await f.commit("unrecorded handoff output");
          await fs.rm(path.join(f.receipt, "commits", head));
        }
      }
      return result;
    };
    f.pipeline.repoDir = f.lane;
    const result = await commitAndAdoptStageBranch(f.pipeline, "build", exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW);
    if (race === "none") expect(result).toEqual({ ok: true, sha: proved });
    else {
      expect(raced).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("settling the stage push:");
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
  } finally { await f.close(); }
});

test.each((["accepted", "accepted replacement", "published"] as const).flatMap(proof =>
  (["valid", "host death", "foreign suffix", "unrecorded suffix", "dropped history", "remote race", "head race"] as const).map(suffix => ({ proof, suffix }))))
("recorded ancestry survives a later attempt ($proof, $suffix)", async ({ proof, suffix }) => {
  const f = await fixture();
  const childLaunch = `stage-proof-recorded-ancestry-${nextFixture}`;
  let lostLaunch: string | null = null;
  try {
    const inherited = await f.commit("earlier passed output");
    await f.push();
    const parent = { ...f.attempt, n: 1, state: "passed", verdict: { status: "pass" },
      completedAt: "2026-10-16T09:30:00.000Z", agentPath: "/stage/earlier.jsonl" } as PipelineStageAttempt;
    // Controller-accepted output can lack a native agent creation receipt.
    await fs.rm(path.join(f.receipt, "commits", inherited));
    let accepted = inherited;
    if (proof !== "published") {
      accepted = await f.commit("later accepted output");
      f.pipeline.lastPassedCommit = accepted;
      await fs.rm(path.join(f.receipt, "commits", accepted));
      // A refused rewrite was the next launch's starting head. The repair
      // merges back the accepted head, including its published ancestors.
      await f.own("reset", "--hard", f.pipeline.baseRef);
      await f.commit("refused rewrite");
    } else f.pipeline.publishedCommit = inherited;
    let lost: PipelineStageAttempt | null = null;
    if (proof === "accepted replacement") {
      const launchId = `${childLaunch}-lost`;
      Object.assign(f.env, await prepareStageGitGuard(launchId, f.lane, realExec, "2026-10-16T09:45:00.000Z", async () => {}));
      lostLaunch = launchId;
      lost = { ...parent, n: 2, launchId, startedAt: "2026-10-16T09:45:00.000Z", completedAt: "2026-10-16T09:55:00.000Z",
        state: "failed", verdict: null, agentPath: "/stage/lost.jsonl", restartRecovery: { bootId: "lost-host", requestedAt: "2026-10-16T09:55:00.000Z",
          lastRecordAt: null, replacementAttempt: 3 } };
      await f.commit("lost attempt output");
    }
    const startedAt = "2026-10-16T10:00:00.000Z";
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, startedAt, async () => {}));
    const previous = lost ?? parent;
    const child = { ...f.attempt, n: lost ? 3 : 2, launchId: childLaunch, startedAt, state: "passed",
      agentPath: "/stage/later.jsonl", ...(proof !== "accepted" ? {
        restartContext: { previousAttempt: previous.n, transcriptPath: previous.agentPath, cause: "host-lost" },
      } : {}) } as PipelineStageAttempt;
    if (proof !== "published") await f.own("merge", "--no-ff", "-m", "restore accepted history", accepted);
    // A host that dies after the ref update skips post-commit; the receipt
    // its commit invocation wrote before the update proves it.
    let head = suffix === "host death" ? await commitThenDie(f, "later attempt output") : await f.commit("later attempt output");
    if (suffix === "unrecorded suffix") {
      // No receipt and no creation entry: the object is written outside a
      // commit command and HEAD reaches it by reset.
      const made = await realExec("git", ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "unrecorded suffix"], f.lane, f.env);
      expect(made.code, made.stderr).toBe(0);
      head = made.stdout.trim();
      await f.own("reset", "--hard", head);
    }
    if (suffix === "foreign suffix") {
      const foreign = path.join(f.root, "foreign-suffix");
      await f.own("worktree", "add", "--detach", foreign, head);
      await f.git(foreign, "commit", "--allow-empty", "-m", "unproved foreign suffix");
      head = await f.git(foreign, "rev-parse", "HEAD");
      await f.own("merge", "--ff-only", head);
    }
    if (suffix === "dropped history") {
      await f.own("reset", "--hard", f.pipeline.baseRef);
      head = await f.commit("dropped accepted history");
    }
    f.pipeline.repoDir = f.lane;
    f.pipeline.runs = [{ stageId: "build", attempts: lost ? [parent, lost, child] : [parent, child] }] as never;
    let raced = false;
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, options);
      if ((suffix === "remote race" || suffix === "head race") && !raced && command === "git" && args[0] === "rev-list") {
        raced = true;
        if (suffix === "remote race") await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", f.pipeline.baseRef);
        else {
          const foreign = path.join(f.root, "raced-suffix");
          await f.own("worktree", "add", "--detach", foreign, head);
          await f.git(foreign, "commit", "--allow-empty", "-m", "raced foreign suffix");
          head = await f.git(foreign, "rev-parse", "HEAD");
          await f.own("merge", "--ff-only", head);
        }
      }
      return result;
    };
    const result = await commitAndAdoptStageBranch(f.pipeline, "build", exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, child, NOW);
    if (suffix === "valid" || suffix === "host death") {
      expect(result).toEqual({ ok: true, sha: head });
      expect(await f.own("merge-base", "--is-ancestor", inherited, "HEAD")).toBe("");
      expect(await f.own("ls-remote", "--refs", "origin", "refs/heads/pipeline/proof")).toBe(`${inherited}\trefs/heads/pipeline/proof`);
    } else {
      expect(result.ok).toBe(false);
      if (suffix === "remote race" || suffix === "head race") expect(raced).toBe(true);
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    if (lostLaunch) await fs.rm(stageGitReceiptDirectory(lostLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test.each(["another worktree", "hooks off", "missing receipt"] as const)(
  "a replacement cannot hide an unproved divergent starting prefix (%s)", async origin => {
    const f = await fixture();
    const lostLaunch = `stage-proof-divergent-lost-${nextFixture}`;
    const childLaunch = `stage-proof-divergent-child-${nextFixture}`;
    try {
      const accepted = await f.commit("accepted stage output");
      f.pipeline.lastPassedCommit = accepted;
      await fs.rm(path.join(f.receipt, "commits", accepted));
      await f.own("reset", "--hard", f.pipeline.baseRef);

      let divergent: string;
      if (origin === "another worktree") {
        const foreign = path.join(f.root, "divergent-worktree");
        await f.own("worktree", "add", "--detach", foreign, f.pipeline.baseRef);
        await f.git(foreign, "commit", "--allow-empty", "-m", "divergent prelaunch rewrite");
        divergent = await f.git(foreign, "rev-parse", "HEAD");
        await f.own("fetch", foreign, divergent);
        await f.own("reset", "--hard", divergent);
      } else {
        const args = ["commit", "--allow-empty", "-m", "divergent prelaunch rewrite"];
        const made = await realExec("git", origin === "hooks off" ? ["-c", "core.hooksPath=", ...args] : args,
          f.lane, origin === "hooks off" ? { ...f.env, PATH: process.env.PATH } : f.env);
        expect(made.code, made.stderr).toBe(0);
        divergent = await f.own("rev-parse", "HEAD");
        if (origin === "missing receipt") await fs.rm(path.join(f.receipt, "commits", divergent));
      }

      const lostStartedAt = "2026-10-16T09:30:00.000Z";
      Object.assign(f.env, await prepareStageGitGuard(lostLaunch, f.lane, realExec, lostStartedAt, async () => {}));
      const lost = { ...f.attempt, n: 1, launchId: lostLaunch, startedAt: lostStartedAt, completedAt: "2026-10-16T09:45:00.000Z",
        state: "failed", agentPath: "/stage/divergent-lost.jsonl", restartRecovery: { bootId: "lost-host",
          requestedAt: "2026-10-16T09:45:00.000Z", lastRecordAt: null, replacementAttempt: 2 } } as PipelineStageAttempt;
      const childStartedAt = "2026-10-16T10:00:00.000Z";
      Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, childStartedAt, async () => {}));
      const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: childStartedAt, completedAt: NOW,
        state: "passed", agentPath: "/stage/divergent-child.jsonl",
        restartContext: { previousAttempt: 1, transcriptPath: lost.agentPath, cause: "host-lost" } } as PipelineStageAttempt;
      await f.own("merge", "--no-ff", "-m", "restore accepted history", accepted);
      const head = await f.commit("replacement output");
      const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, f.env);
      expect(pushed.code, pushed.stderr).toBe(0);
      f.pipeline.runs = [{ stageId: "build", attempts: [lost, child] }] as never;
      expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toMatchObject({ ok: false });
      expect(await f.own("rev-parse", "HEAD")).toBe(head);
    } finally {
      await fs.rm(stageGitReceiptDirectory(lostLaunch), { recursive: true, force: true });
      await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
      await f.close();
    }
  });

test.each(["another worktree", "hooks off", "missing receipt"] as const)(
  "an ordinary retry cannot publish an unproved starting prefix (%s)", async origin => {
    const f = await fixture();
    const childLaunch = `stage-proof-ordinary-retry-${nextFixture}`;
    try {
      const accepted = await f.commit("accepted output before retry");
      f.pipeline.lastPassedCommit = accepted;
      f.pipeline.publishedCommit = accepted;
      await f.push();
      await fs.rm(path.join(f.receipt, "commits", accepted));
      await f.own("reset", "--hard", f.pipeline.baseRef);

      let divergent: string;
      if (origin === "another worktree") {
        const foreign = path.join(f.root, "ordinary-retry-foreign");
        await f.own("worktree", "add", "--detach", foreign, f.pipeline.baseRef);
        await f.git(foreign, "commit", "--allow-empty", "-m", "ordinary retry foreign start");
        divergent = await f.git(foreign, "rev-parse", "HEAD");
        await f.own("fetch", foreign, divergent);
        await f.own("reset", "--hard", divergent);
      } else {
        const args = ["commit", "--allow-empty", "-m", "ordinary retry divergent start"];
        const made = await realExec("git", origin === "hooks off" ? ["-c", "core.hooksPath=", ...args] : args,
          f.lane, origin === "hooks off" ? { ...f.env, PATH: process.env.PATH } : f.env);
        expect(made.code, made.stderr).toBe(0);
        divergent = await f.own("rev-parse", "HEAD");
        if (origin === "missing receipt") await fs.rm(path.join(f.receipt, "commits", divergent));
      }

      Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
      await f.own("merge", "--no-ff", "-m", "restore the accepted boundary", accepted);
      const head = await f.commit("ordinary retry output");
      const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, f.env);
      expect(pushed.code, pushed.stderr).toBe(0);
      const parent = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:30:00.000Z",
        agentPath: "/stage/ordinary-retry-parent.jsonl" } as PipelineStageAttempt;
      const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z",
        completedAt: NOW, state: "passed", agentPath: "/stage/ordinary-retry-child.jsonl" } as PipelineStageAttempt;
      f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;

      expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toMatchObject({ ok: false });
      expect(await f.own("ls-remote", "--refs", "origin", "refs/heads/pipeline/proof"))
        .toBe(`${head}\trefs/heads/pipeline/proof`);
    } finally {
      await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
      await f.close();
    }
  });

test("an ordinary retry settles a recorded prefix from its failed predecessor", async () => {
  const f = await fixture();
  const childLaunch = `stage-proof-ordinary-recorded-retry-${nextFixture}`;
  try {
    const inherited = await f.commit("recorded predecessor output");
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:30:00.000Z",
      agentPath: "/stage/recorded-retry-parent.jsonl" } as PipelineStageAttempt;
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z",
      completedAt: NOW, state: "passed", agentPath: "/stage/recorded-retry-child.jsonl" } as PipelineStageAttempt;
    const head = await f.commit("ordinary retry continuation");
    await f.push();
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;

    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
    expect(await f.own("merge-base", "--is-ancestor", inherited, "HEAD")).toBe("");
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test("an ordinary retry settles unpublished history receipted by an earlier passed attempt", async () => {
  const f = await fixture();
  const childLaunch = `stage-proof-passed-predecessor-retry-${nextFixture}`;
  try {
    const inherited = await f.commit("passed predecessor output");
    const parent = { ...f.attempt, n: 1, state: "passed", completedAt: "2026-10-16T09:30:00.000Z",
      verdict: { status: "pass", summary: "accepted by review" }, agentPath: "/stage/passed-predecessor.jsonl" } as PipelineStageAttempt;
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z",
      completedAt: NOW, state: "passed", agentPath: "/stage/passed-predecessor-retry.jsonl" } as PipelineStageAttempt;
    const head = await f.commit("retry output");
    await f.push();
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;

    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
    expect(await f.own("merge-base", "--is-ancestor", inherited, head)).toBe("");
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test("four host-loss attempts preserve their receipt ancestry", async () => {
  const f = await fixture();
  const attempts: PipelineStageAttempt[] = [];
  const launches: string[] = [];
  try {
    for (let n = 1; n <= 4; n += 1) {
      const launchId = n === 1 ? f.attempt.launchId! : `stage-proof-chain-${nextFixture}-${n}`;
      const startedAt = n === 1 ? START : `2026-10-16T${String(8 + n).padStart(2, "0")}:00:00.000Z`;
      if (n > 1) {
        launches.push(launchId);
        Object.assign(f.env, await prepareStageGitGuard(launchId, f.lane, realExec, startedAt, async () => {}));
      }
      const attempt = { ...f.attempt, n, launchId, startedAt, completedAt: `2026-10-16T${String(8 + n).padStart(2, "0")}:30:00.000Z`,
        state: n === 4 ? "passed" : "failed", agentPath: `/stage/chain-${n}.jsonl`,
        ...(n === 1 ? {} : { restartContext: { previousAttempt: n - 1, transcriptPath: attempts[n - 2]!.agentPath, cause: "host-lost" } })
      } as PipelineStageAttempt;
      if (n < 4) attempt.restartRecovery = { bootId: `lost-host-${n}`, requestedAt: attempt.completedAt!, lastRecordAt: null,
        replacementAttempt: n + 1 };
      attempts.push(attempt);
      await f.commit(`attempt ${n} output`);
    }
    const head = await f.own("rev-parse", "HEAD");
    f.pipeline.runs = [{ stageId: "build", attempts }] as never;
    await f.push();
    expect(await settleStageAttemptPush(f.pipeline, attempts[3]!, realExec, NOW)).toEqual({ ok: true, sha: head });
  } finally {
    for (const launchId of launches) await fs.rm(stageGitReceiptDirectory(launchId), { recursive: true, force: true });
    await f.close();
  }
});

// Issue #3158: an account usage guard failed a replacement whose launch had
// been refused for capacity, so it never reserved a launch, and replaced it.
// Pin both a short chain and the observed attempt-72 scale. Every skipped
// attempt must preserve lineage without authorizing unreceipted commits.
test.each([1, 70].flatMap(count =>
  (["settles", "forged transcript edge", "unreceipted commit"] as const).map(variant => [count, variant] as const),
))("a usage-guard chain through %i never-launched attempts: %s", async (refusedCount, variant) => {
  const f = await fixture();
  const childLaunch = `stage-proof-guard-chain-${nextFixture}`;
  try {
    await f.commit("first attempt output");
    const first = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:00:00.000Z",
      agentPath: "/stage/guard-1.jsonl", error: "the stage account reached its usage or paid-credit guard" } as PipelineStageAttempt;
    const refused = { ...f.attempt, n: 2, state: "failed", launchId: null, conversationId: null, agentPath: null, paneId: null,
      startedAt: "2026-10-16T09:05:00.000Z", completedAt: "2026-10-16T09:06:00.000Z",
      error: "the stage account reached its usage or paid-credit guard",
      restartContext: { previousAttempt: 1, transcriptPath: first.agentPath } } as PipelineStageAttempt;
    if (variant === "unreceipted commit") {
      // This writer lacks the launch guard entirely. A guard that still runs
      // with missing bindings is refused and diagnosed by the cases below.
      const outside: NodeJS.ProcessEnv = { ...f.env, GIT_CONFIG_COUNT: "0", PATH: process.env.PATH };
      delete outside.LLV_STAGE_GIT_RECEIPT;
      delete outside.LLV_STAGE_GIT_WORKTREE;
      const made = await realExec("git", ["commit", "--allow-empty", "-m", "made while no attempt ran"], f.lane, outside);
      expect(made.code, made.stderr).toBe(0);
    }
    const foreign = await f.own("rev-parse", "HEAD");
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
    const refusedAttempts = Array.from({ length: refusedCount }, (_, index) => ({
      ...refused, n: index + 2,
      restartContext: index === 0 ? refused.restartContext : { previousAttempt: index + 1, transcriptPath: null },
      restartRecovery: { bootId: "guard-stop", requestedAt: refused.completedAt!, lastRecordAt: null,
        replacementAttempt: index + 3 },
    } as PipelineStageAttempt));
    const child = { ...f.attempt, n: refusedCount + 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z", completedAt: NOW,
      state: "passed", agentPath: "/stage/guard-3.jsonl",
      restartContext: { previousAttempt: refusedCount + 1, transcriptPath: variant === "forged transcript edge" ? first.agentPath : null } } as PipelineStageAttempt;
    const head = await f.commit("replacement output after the reset");
    f.pipeline.runs = [{ stageId: "build", attempts: [first, ...refusedAttempts, child] }] as never;
    await f.push();
    const result = await settleStageAttemptPush(f.pipeline, child, realExec, NOW);
    if (variant === "settles") expect(result).toEqual({ ok: true, sha: head });
    else if (variant === "forged transcript edge") expect(result).toMatchObject({ ok: false, error: expect.stringContaining("creation lineage is invalid") });
    else expect(result).toMatchObject({ ok: false, error: expect.stringContaining(foreign) });
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});

test.each([1, 3])("A: main fast-forward plus %i own commits settles after an in-worktree push", async count => {
  const f = await fixture();
  try {
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "new main");
    await f.git(f.foreign, "push", "origin", "main");
    await f.own("fetch", "origin", "main"); await f.own("merge", "--ff-only", "origin/main");
    let head = ""; for (let i = 0; i < count; i++) head = await f.commit(`own ${i}`);
    await f.push();
    expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});

test("B: every commit remains provable beyond the former 256 limit", async () => {
  const f = await fixture();
  try {
    let head = ""; for (let i = 0; i < 260; i++) head = await f.commit(`own ${i}`);
    await f.push(); expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
}, 60000);

test("B: a merge created in the attempt has proof, including imported current main", async () => {
  const f = await fixture();
  try {
    await f.commit("own first");
    // Main is advanced in an unrelated clone, outside the attempt.
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "new main");
    await f.git(f.foreign, "push", "origin", "main");
    await f.own("fetch", "origin", "main"); await f.own("merge", "--no-ff", "-m", "merge main", "origin/main");
    const head = await f.own("rev-parse", "HEAD"); await f.push();
    expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});

test.each(["2025-01-01T00:00:00Z", "2027-01-01T00:00:00Z"])("B: a native receipt proves creation with an agent-supplied date %s", async date => {
  const f = await fixture();
  try {
    f.env.GIT_AUTHOR_DATE = f.env.GIT_COMMITTER_DATE = date;
    const head = await f.commit("own backdated"); await f.push();
    expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});

test.each([{ legacy: false }, { legacy: true }])("B: a foreign commit is refused by exact hash (legacy=$legacy)", async ({ legacy }) => {
  const f = await fixture(legacy);
  try {
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign");
    const head = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await f.own("fetch", "origin", "pipeline/proof"); await f.own("merge", "--ff-only", "FETCH_HEAD");
    const result = await f.settle();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("foreign commit accepted");
    expect(result.error).toContain(head);
    expect(result.error).toContain("not created in the attempt worktree");
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
  } finally { await f.close(); }
});

test("B: a commit made without the launch receipt variables is refused", async () => {
  const f = await fixture();
  try {
    const secondEnvironment: NodeJS.ProcessEnv = { ...f.env, GIT_AUTHOR_NAME: "Operator",
      GIT_AUTHOR_EMAIL: ["operator", "example.invalid"].join("@"),
      GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: ["operator", "example.invalid"].join("@"), GIT_CONFIG_COUNT: "0" };
    delete secondEnvironment.LLV_STAGE_GIT_RECEIPT;
    delete secondEnvironment.LLV_STAGE_GIT_WORKTREE;
    const made = await realExec("git", ["commit", "--allow-empty", "-m", "second environment"], f.lane, secondEnvironment);
    expect(made.code, made.stderr).toBe(0);
    const head = await f.own("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const result = await f.settle();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("commit without the launch receipt was accepted");
    expect(result.error).toContain(head);
  } finally { await f.close(); }
});

test("B: a commit from another agent machine identity is refused", async () => {
  const f = await fixture();
  try {
    const secondEnvironment: NodeJS.ProcessEnv = { ...f.env, DELEGATUS_PUBLICATION_NAME: "Other Machine",
      DELEGATUS_PUBLICATION_EMAIL: ["noreply", "other.machine.example"].join("@") };
    Object.assign(secondEnvironment, agentPublicationIdentityEnv({ ...secondEnvironment, HOME: f.root }));
    delete secondEnvironment.LLV_STAGE_GIT_RECEIPT;
    delete secondEnvironment.LLV_STAGE_GIT_WORKTREE;
    secondEnvironment.GIT_CONFIG_COUNT = "0";
    secondEnvironment.PATH = process.env.PATH;
    const made = await realExec("git", ["commit", "--allow-empty", "-m", "other machine"], f.lane, secondEnvironment);
    expect(made.code, made.stderr).toBe(0);
    const head = await f.own("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const result = await f.settle();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("another machine's commit was accepted");
    expect(result.error).toContain(head);
  } finally { await f.close(); }
});

test("B: a reset with GIT_REFLOG_ACTION=commit cannot prove foreign creation", async () => {
  const f = await fixture();
  try {
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "existing foreign commit");
    const head = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await f.own("fetch", "origin", "pipeline/proof");
    const reset = await realExec("git", ["reset", "--hard", "FETCH_HEAD"], f.lane, { ...f.env, GIT_REFLOG_ACTION: "commit" });
    expect(reset.code, reset.stderr).toBe(0);
    const result = await f.settle();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("a caller-controlled reflog message proved a reset");
    expect(result.error).toContain(head);
  } finally { await f.close(); }
});

test.each([{ pushed: false }, { pushed: true }])("B: legacy native creation is recovered without hooks (push=$pushed)", async ({ pushed }) => {
  const f = await fixture(true);
  try {
    const head = await f.commit("legacy own"); if (pushed) await f.push();
    expect(await f.settle()).toEqual(pushed ? { ok: true, sha: head } : null);
  } finally { await f.close(); }
});

test("B: legacy reflog recovery refuses a commit made under an operator identity", async () => {
  const f = await fixture(true);
  try {
    const secondEnvironment: NodeJS.ProcessEnv = { ...f.env, GIT_AUTHOR_NAME: "Operator",
      GIT_AUTHOR_EMAIL: ["operator", "example.invalid"].join("@"),
      GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: ["operator", "example.invalid"].join("@") };
    delete secondEnvironment.LLV_AGENT_GIT_GUARD_DIR;
    for (const key of Object.keys(secondEnvironment)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete secondEnvironment[key as keyof typeof secondEnvironment];
    const made = await realExec("git", ["commit", "--allow-empty", "-m", "operator commit"], f.lane, secondEnvironment);
    expect(made.code, made.stderr).toBe(0);
    const head = await f.own("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const result = await f.settle();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("legacy reflog adopted an operator commit");
    expect(result.error).toContain(head);
  } finally { await f.close(); }
});

test.each([{ missing: false }, { missing: true }])("B: a versionless start requires independent receipts for own merges (missing=$missing)", async ({ missing }) => {
  const f = await fixture();
  try {
    await f.commit("own before historical merge");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "main advances");
    await f.git(f.foreign, "push", "origin", "main");
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "historical own merge", "origin/main");
    const head = await f.own("rev-parse", "HEAD");
    const startPath = path.join(f.receipt, "start.json");
    const start = JSON.parse(await fs.readFile(startPath, "utf8"));
    delete start.commitReceiptVersion;
    await fs.writeFile(startPath, JSON.stringify(start));
    if (missing) await fs.rm(path.join(f.receipt, "commits", head), { force: true });
    await f.push();
    const result = await f.settle();
    if (missing) {
      expect(result?.ok).toBe(false);
      if (!result || result.ok) throw new Error("versionless start substituted reflog for a missing receipt");
      expect(result.error).toContain(head);
    } else expect(result).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});


test("B: native merge hooks record creation without attesting a foreign fast-forward", async () => {
  const f = await fixture();
  try {
    await f.commit("own first");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "main advances");
    const imported = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "main"); await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "-m", "merge main", "origin/main");
    const made = await f.own("rev-parse", "HEAD");
    expect(await fs.readFile(path.join(f.receipt, "commits", made), "utf8")).toBe("");
    expect(await fs.access(path.join(f.receipt, "commits", imported)).then(() => true, () => false)).toBe(false);
  } finally { await f.close(); }
});

test("B: a caller-controlled merge reflog action cannot receipt a foreign fast-forward", async () => {
  const f = await fixture();
  try {
    await f.commit("own before foreign fast-forward");
    await f.push();
    await f.git(f.foreign, "fetch", "origin", "pipeline/proof");
    await f.git(f.foreign, "checkout", "-b", "pipeline/proof", "FETCH_HEAD");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign fast-forward");
    const foreign = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await f.own("fetch", "origin", "pipeline/proof");
    const merged = await realExec("git", ["merge", "--ff-only", "FETCH_HEAD"], f.lane,
      { ...f.env, GIT_REFLOG_ACTION: "merge foreign: Merge made by fixture" });
    expect(merged.code, merged.stderr).toBe(0);
    expect(await fs.access(path.join(f.receipt, "commits", foreign)).then(() => true, () => false)).toBe(false);
    const result = await f.settle();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("foreign fast-forward acquired an attempt receipt");
    expect(result.error).toContain(foreign);
  } finally { await f.close(); }
});

test("B: rebase receipts include each rewritten commit and preserve the original hook's input", async () => {
  const f = await fixture();
  try {
    // A nonempty patch ensures rebase rewrites rather than dropping the commit.
    await fs.writeFile(path.join(f.lane, "own.txt"), "own\n"); await f.own("add", "own.txt");
    await f.commit("own patch");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "main advances");
    await f.git(f.foreign, "push", "origin", "main"); await f.own("fetch", "origin", "main");
    const originalHooks = path.join(f.root, "original-hooks"); await fs.mkdir(originalHooks);
    const seen = path.join(f.root, "rewrite-input");
    // Paths are generated by mkdtemp and contain no shell metacharacters.
    await fs.writeFile(path.join(originalHooks, "post-rewrite"), `#!/bin/sh\ncat > '${seen}'\n`, { mode: 0o700 });
    await f.own("config", "core.hooksPath", originalHooks);
    await f.own("rebase", "origin/main");
    const made = await f.own("rev-parse", "HEAD");
    expect(await fs.readFile(path.join(f.receipt, "commits", made), "utf8")).toBe("");
    expect(await fs.readFile(seen, "utf8")).toContain(made);
    await f.push(); expect(await f.settle()).toEqual({ ok: true, sha: made });
  } finally { await f.close(); }
});

// Settlement has no second proof beside the receipts: once a rewritten
// commit's receipt is gone, the commit stays unproved.
test.each(["amend", "rebase"] as const)("B: an own %s whose rewrite receipt was lost stays unproved", async rewrite => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.lane, "own.txt"), "own\n"); await f.own("add", "own.txt");
    await f.commit("own patch");
    if (rewrite === "amend") await f.own("commit", "--amend", "-m", "own patch, amended");
    else {
      await f.git(f.foreign, "commit", "--allow-empty", "-m", "main advances");
      await f.git(f.foreign, "push", "origin", "main"); await f.own("fetch", "origin", "main");
      await f.own("rebase", "origin/main");
    }
    const made = await f.own("rev-parse", "HEAD");
    await fs.rm(path.join(f.receipt, "commits", made));
    await f.push();
    expect(await f.settle()).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${made} was not created in the attempt worktree`) });
  } finally { await f.close(); }
});

test("B: applied patch creation is attested by the native hook", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.lane, "own.txt"), "own\n"); await f.own("add", "own.txt");
    const original = await f.commit("own patch");
    const patch = await f.own("format-patch", "-1", "--stdout");
    const patchFile = path.join(f.root, "change.patch"); await fs.writeFile(patchFile, patch + "\n");
    await f.own("reset", "--hard", f.pipeline.baseRef);
    f.env.GIT_COMMITTER_DATE = "2026-10-16T09:01:00Z";
    await f.own("am", patchFile);
    const made = await f.own("rev-parse", "HEAD"); expect(made).not.toBe(original);
    expect(await fs.readFile(path.join(f.receipt, "commits", made), "utf8")).toBe("");
    await f.push(); expect(await f.settle()).toEqual({ ok: true, sha: made });
  } finally { await f.close(); }
});


test("B: a forged tracking-main ref cannot prove a foreign parent of an own merge", async () => {
  const f = await fixture();
  try {
    await f.commit("own before foreign");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign");
    const imported = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/foreign");
    await f.own("fetch", "origin", "foreign");
    await f.own("update-ref", "refs/remotes/origin/main", imported);
    await f.own("merge", "--no-ff", "-m", "own merge", "origin/main"); await f.push();
    const result = await f.settle();
    expect(result?.ok).toBe(false); if (!result || result.ok) throw new Error("foreign parent accepted");
    expect(result.error).toContain(imported); expect(result.error).toContain("not created in the attempt worktree");
  } finally { await f.close(); }
});


test("B: a proved local suffix after an earlier push is left for controller publication", async () => {
  const f = await fixture();
  try {
    const pushed = await f.commit("own pushed first"); await f.push();
    const head = await f.commit("own local follow-up");
    expect(await f.settle()).toBeNull();
    expect(await f.own("rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(pushed);
  } finally { await f.close(); }
});


test("B: native commit proof can adopt a scratch push whose pre-push hook was bypassed", async () => {
  const f = await fixture();
  try {
    const scratch = path.join(f.root, "detached");
    await f.own("worktree", "add", "--detach", scratch, f.pipeline.baseRef);
    const committed = await realExec("git", ["commit", "--allow-empty", "-m", "owned scratch fix"], scratch, f.env);
    expect(committed.code, committed.stderr).toBe(0);
    const made = await f.git(scratch, "rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/pipeline/proof"], scratch, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(await f.settle()).toEqual({ ok: true, sha: made });
  } finally { await f.close(); }
});


test.each(["native", "forged"])("B: an imported merge stays unreceipted with a %s reflog action", async action => {
  const f = await fixture();
  try {
    const own = await f.commit("own before imported merge");
    await f.push();
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "advance main");
    await f.git(f.foreign, "push", "origin", "main");
    await f.git(f.foreign, "fetch", "origin", "pipeline/proof");
    await f.git(f.foreign, "checkout", "-b", "pipeline/proof", own);
    await f.git(f.foreign, "merge", "--no-ff", "-m", "foreign merge", "main");
    const imported = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await f.own("fetch", "origin", "pipeline/proof");
    const result = await realExec("git", ["merge", "--ff-only", "FETCH_HEAD"], f.lane,
      { ...f.env, ...(action === "forged" ? { GIT_REFLOG_ACTION: "merge foreign: Merge made by fixture" } : {}) });
    expect(result.code, result.stderr).toBe(0);
    expect(await fs.access(path.join(f.receipt, "commits", imported)).then(() => true, () => false)).toBe(false);
    const settled = await f.settle();
    expect(settled?.ok).toBe(false);
    if (!settled || settled.ok) throw new Error("imported merge was accepted");
    expect(settled.error).toContain(imported);
    expect(await f.own("rev-parse", "HEAD")).toBe(imported);
  } finally { await f.close(); }
});

// `GIT_REFLOG_ACTION=commit git reset` writes `commit: updating HEAD`; a
// foreign commit with that subject matches it word for word.
test.each((["versioned", "versionless"] as const).flatMap(version => (["shared identity outside lane", "updating HEAD"] as const)
  .map(subject => ({ version, subject }))))("B: a $version start refuses an imported shared-identity commit with forged reflog creation ($subject)", async ({ version, subject }) => {
  const f = await fixture();
  try {
    const startPath = path.join(f.receipt, "start.json");
    const start = JSON.parse(await fs.readFile(startPath, "utf8"));
    if (version === "versionless") delete start.commitReceiptVersion;
    await fs.writeFile(startPath, JSON.stringify(start));
    const foreignEnv: NodeJS.ProcessEnv = { ...f.env, GIT_CONFIG_COUNT: "0",
      LLV_STAGE_GIT_RECEIPT: undefined, LLV_STAGE_GIT_WORKTREE: undefined };
    const made = await realExec("git", ["commit", "--allow-empty", "-m", subject], f.foreign, foreignEnv);
    expect(made.code, made.stderr).toBe(0);
    const imported = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await f.own("fetch", "origin", "pipeline/proof");
    const reset = await realExec("git", ["reset", "--hard", "FETCH_HEAD"], f.lane,
      { ...f.env, GIT_REFLOG_ACTION: "commit" });
    expect(reset.code, reset.stderr).toBe(0);
    if (subject === "updating HEAD") expect(await f.own("reflog", "-1", "--format=%gs")).toBe("commit: updating HEAD");
    expect(await fs.access(path.join(f.receipt, "commits", imported)).then(() => true, () => false)).toBe(false);
    const settled = await f.settle();
    expect(settled?.ok).toBe(false);
    if (!settled || settled.ok) throw new Error("versionless start trusted forged creation");
    expect(settled.error).toContain(imported);
  } finally { await f.close(); }
});

test("B: a foreign shared-identity merge reached by update-ref with a merge reflog message stays unproved", async () => {
  const f = await fixture();
  try {
    const own = await f.commit("own before the foreign merge");
    await f.push();
    const foreignEnv: NodeJS.ProcessEnv = { ...f.env, GIT_CONFIG_COUNT: "0",
      LLV_STAGE_GIT_RECEIPT: undefined, LLV_STAGE_GIT_WORKTREE: undefined };
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "advance main");
    await f.git(f.foreign, "push", "origin", "main");
    await f.git(f.foreign, "fetch", "origin", "pipeline/proof");
    await f.git(f.foreign, "checkout", "-b", "pipeline/proof", own);
    const merged = await realExec("git", ["merge", "--no-ff", "--no-edit", "main"], f.foreign, foreignEnv);
    expect(merged.code, merged.stderr).toBe(0);
    const imported = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await f.own("fetch", "origin", "pipeline/proof");
    const message = "merge origin/main: Merge made by the 'ort' strategy.";
    await f.own("update-ref", "-m", message, "HEAD", imported, own);
    await f.own("read-tree", "--reset", "-u", "HEAD");
    expect(await f.own("reflog", "-1", "--format=%gs")).toBe(message);
    expect(await f.own("log", "-1", "--format=%cn <%ce> %ct", imported)).toBe(await f.own("log", "-1", "--format=%cn <%ce> %ct", own));
    expect(await fs.access(path.join(f.receipt, "commits", imported)).then(() => true, () => false)).toBe(false);
    const settled = await f.settle();
    expect(settled?.ok).toBe(false);
    if (!settled || settled.ok) throw new Error("a foreign merge was accepted from its reflog message");
    expect(settled.error).toContain(`commit ${imported} was not created in the attempt worktree`);
  } finally { await f.close(); }
});

// A refresh of current main mid-attempt is a fast-forward onto verified base
// history; the attempt's own commit after it settles even when its host died
// before post-commit, while a foreign one reached by reset does not.
test.each(["host death", "forged reset"] as const)("A: main fast-forward followed by an own commit (%s)", async shape => {
  const f = await fixture();
  try {
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "new main");
    await f.git(f.foreign, "push", "origin", "main");
    await f.own("fetch", "origin", "main"); await f.own("merge", "--ff-only", "origin/main");
    expect(await f.own("reflog", "-1", "--format=%gs")).toBe("merge origin/main: Fast-forward");
    let head: string;
    if (shape === "host death") {
      head = await commitThenDie(f, "own after the refresh");
    } else {
      const foreignEnv: NodeJS.ProcessEnv = { ...f.env, GIT_CONFIG_COUNT: "0",
        LLV_STAGE_GIT_RECEIPT: undefined, LLV_STAGE_GIT_WORKTREE: undefined };
      await f.git(f.foreign, "fetch", "origin", "main");
      await f.git(f.foreign, "checkout", "-B", "pipeline/proof", await f.own("rev-parse", "HEAD"));
      const made = await realExec("git", ["commit", "--allow-empty", "-m", "updating HEAD"], f.foreign, foreignEnv);
      expect(made.code, made.stderr).toBe(0);
      head = await f.git(f.foreign, "rev-parse", "HEAD");
      await f.git(f.foreign, "push", "-f", "origin", "HEAD:refs/heads/pipeline/proof");
      await f.own("fetch", "origin", "pipeline/proof");
      const reset = await realExec("git", ["reset", "--hard", "FETCH_HEAD"], f.lane, { ...f.env, GIT_REFLOG_ACTION: "commit" });
      expect(reset.code, reset.stderr).toBe(0);
    }
    await f.push();
    const settled = await f.settle();
    if (shape === "host death") expect(settled).toEqual({ ok: true, sha: head });
    else expect(settled).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${head} was not created in the attempt worktree`) });
  } finally { await f.close(); }
});

test.each(["merge", "no-verify", "fast-forward", "squash"])("B: original post-merge arguments survive a %s", async mode => {
  const f = await fixture();
  try {
    if (mode !== "fast-forward") await f.commit("own before merge");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "main advances");
    await f.git(f.foreign, "push", "origin", "main");
    await f.own("fetch", "origin", "main");
    const originalHooks = path.join(f.root, "original-hooks"); await fs.mkdir(originalHooks);
    const seen = path.join(f.root, "merge-arguments");
    Object.assign(f.env, { STAGE_PROOF_MERGE_ARGS: seen });
    await fs.writeFile(path.join(originalHooks, "post-merge"),
      `#!/bin/sh\nprintf '%s\\n%s\\n' "$#" "$1" > "$STAGE_PROOF_MERGE_ARGS"\n`, { mode: 0o700 });
    await f.own("config", "core.hooksPath", originalHooks);
    await f.own("merge", ...(mode === "fast-forward" ? ["--ff-only"]
      : mode === "squash" ? ["--squash"] : ["--no-ff", ...(mode === "no-verify" ? ["--no-verify"] : []), "-m", "merge main"]), "origin/main");
    expect(await fs.readFile(seen, "utf8")).toBe(`1\n${mode === "squash" ? "1" : "0"}\n`);
    const head = await f.own("rev-parse", "HEAD");
    if (mode === "merge" || mode === "no-verify") {
      expect(await fs.readFile(path.join(f.receipt, "commits", head), "utf8")).toBe("");
      await f.push(); expect(await f.settle()).toEqual({ ok: true, sha: head });
    } else if (mode === "fast-forward") {
      expect(await fs.access(path.join(f.receipt, "commits", head)).then(() => true, () => false)).toBe(false);
    }
  } finally { await f.close(); }
});


test.each(["completes", "host dies after the ref update"] as const)(
  "B: an octopus merge can prove creation when Git omits the ancestral lane head and %s", async ending => {
  const f = await fixture();
  try {
    const side = path.join(f.root, "own-side");
    await f.own("worktree", "add", "-b", "own-side", side, f.pipeline.baseRef);
    await fs.writeFile(path.join(side, "side.txt"), "own side\n");
    for (const args of [["add", "side.txt"], ["commit", "-m", "own side"]]) {
      const result = await realExec("git", args, side, f.env);
      expect(result.code, result.stderr).toBe(0);
    }
    await fs.writeFile(path.join(f.foreign, "main.txt"), "main\n");
    await f.git(f.foreign, "add", "main.txt");
    await f.git(f.foreign, "commit", "-m", "new main");
    await f.git(f.foreign, "push", "origin", "main");
    await f.own("fetch", "origin", "main");
    const octopus = ["merge", "-m", "octopus merge", "origin/main", "own-side"];
    if (ending === "completes") await f.own(...octopus);
    else await dieAfterRefUpdate(f, octopus);
    const head = await f.own("rev-parse", "HEAD");
    const parents = await f.own("show", "-s", "--format=%P", head);
    expect(parents.split(" ")).toEqual([await f.own("rev-parse", "origin/main"), await f.own("rev-parse", "own-side")]);
    expect(parents.split(" ")).not.toContain(f.pipeline.baseRef);
    expect(await fs.readFile(path.join(f.receipt, "commits", head), "utf8")).toBe("");
    await f.push(); expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});


// A refresh starts from reviewed lane work; the remote merge has no stage receipt.
async function foreignIntegration(local: boolean) {
  const f = await fixture();
  f.pipeline.delivery!.target.repository = projectIdentityFromRemote("https://github.com/example/project.git", f.lane)!.project;
  await fs.writeFile(path.join(f.lane, "lane.txt"), "reviewed content\n");
  await f.own("add", "lane.txt");
  const reviewed = await f.commit("reviewed lane work"); await f.push();
  f.pipeline.lastPassedCommit = reviewed;
  const startFile = path.join(f.receipt, "start.json");
  await fs.writeFile(startFile, JSON.stringify({ ...JSON.parse(await fs.readFile(startFile, "utf8")), head: reviewed }));
  await fs.rm(path.join(f.receipt, "commits", reviewed));
  await fs.rm(path.join(f.receipt, "pushes", reviewed));
  await fs.writeFile(path.join(f.foreign, "main.txt"), "main content\n");
  await f.git(f.foreign, "add", "main.txt");
  await f.git(f.foreign, "commit", "-m", "advance main");
  await f.git(f.foreign, "push", "origin", "main");
  await f.git(f.foreign, "fetch", "origin", "pipeline/proof");
  await f.git(f.foreign, "checkout", "-b", "pipeline/proof", reviewed);
  await f.git(f.foreign, "merge", "--no-ff", "-m", "foreign clean integration", "main");
  const head = await f.git(f.foreign, "rev-parse", "HEAD");
  await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
  if (local) {
    await f.own("fetch", "origin", "pipeline/proof");
    await f.own("merge", "--ff-only", "FETCH_HEAD");
  }
  const checks: { headRefOid: string; baseRefName: string; state: string; isDraft: boolean;
    statusCheckRollup: Array<Record<string, unknown>> } = { headRefOid: head, baseRefName: "main", state: "OPEN", isDraft: false,
    statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }] };
  let required: unknown = { protected: true, protection: { required_status_checks: { contexts: ["ci"] } } };
  let checkPages: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }[] = [
    { nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }],
      pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  let checksCode = 0;
  const commands: string[][] = [];
  const exec: typeof realExec = async (command, args, cwd, env, options) => {
    commands.push([command, ...args]);
    if (command === "git" && args.slice(0, 3).join(" ") === "remote get-url --push"
      && args[3] === f.pipeline.delivery?.target.remote) {
      return { code: 0, stdout: "https://github.com/example/project.git\n", stderr: "" };
    }
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { code: 0, stdout: "https://github.com/example/project.git\n", stderr: "" };
    }
    if (command === "gh") {
      if (args[0] === "api" && args.includes("graphql")) {
        const after = args.find(part => part.startsWith("endCursor="))?.slice("endCursor=".length);
        const index = after === undefined ? 0 : checkPages.findIndex(page => page.pageInfo.endCursor === after) + 1;
        const page = checkPages[index];
        return { code: checksCode, stdout: JSON.stringify(page ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }) + "\n", stderr: "" };
      }
      return { code: checksCode, stdout: JSON.stringify(args[0] === "api" ? required : checks), stderr: "" };
    }
    if (command === "git" && args[0] === "ls-remote" && args[2] === "https://github.com/example/project.git") {
      return realExec(command, [args[0]!, args[1]!, f.remote, ...args.slice(3)], cwd, env, options);
    }
    if (command === "git" && args[0] === "fetch" && args[2] === "https://github.com/example/project.git") {
      return realExec(command, [args[0]!, args[1]!, f.remote, ...args.slice(3)], cwd, env, options);
    }
    return realExec(command, args, cwd, env, options);
  };
  return { ...f, head, reviewed, checks, exec, commands,
    setRequired(value: unknown) { required = value; },
    setCheckRuns(value: unknown[]) { checkPages = [{ nodes: value, pageInfo: { hasNextPage: false, endCursor: null } }]; },
    setCheckPages(value: typeof checkPages) { checkPages = value; }, setChecksCode(code: number) { checksCode = code; } };
}

test.each([false, true])("published clean main integration is adopted without creation receipts (local=%s)", async local => {
  const f = await foreignIntegration(local);
  try {
    f.pipeline.repoDir = f.lane;
    f.attempt.report = { provenance: { head: f.reviewed } } as PipelineStageAttempt["report"];
    expect(await commitAndAdoptStageBranch(f.pipeline, "refresh", f.exec, () => [f.pipeline], undefined,
      () => {}, null, undefined, undefined, f.attempt, NOW)).toEqual({ ok: true, sha: f.head });
    expect(f.attempt.report?.provenance.head).toBe(f.head);
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
    expect(await fs.readFile(path.join(f.lane, "lane.txt"), "utf8")).toBe("reviewed content\n");
    expect(await fs.readFile(path.join(f.lane, "main.txt"), "utf8")).toBe("main content\n");
    expect(f.commands.some(([command]) => command === "gh")).toBe(true);
    expect(f.commands.some(([command, action]) => command === "git" && action === "push")).toBe(false);
    // Replaying settlement after the fast-forward needs no remembered in-process proof.
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toEqual({ ok: true, sha: f.head });
    if (!local) {
      const replay = await realExec(process.execPath, ["-e", `
        const { commitAndAdoptStageBranch } = await import("./src/lib/pipelines/stageBranch");
        const { realExec } = await import("./src/lib/workflows/provision");
        const { pipeline, attempt, checks, now } = JSON.parse(process.env.INTEGRATION_FIXTURE);
        const exec = async (command, args, cwd, env, options) => {
          if (command === "git" && args[0] === "remote" && args[1] === "get-url")
            return { code: 0, stdout: "https://github.com/example/project.git", stderr: "" };
          if (command === "git" && (args[0] === "ls-remote" || args[0] === "fetch")
            && args[2] === "https://github.com/example/project.git") {
            return realExec(command, [args[0], args[1], pipeline.delivery.target.remote, ...args.slice(3)], cwd, env, options);
          }
          if (command === "gh") return { code: 0, stdout: JSON.stringify(args[0] === "api"
            ? args.includes("graphql") ? { nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }], pageInfo: { hasNextPage: false, endCursor: null } }
              : { protected: true, protection: { required_status_checks: { contexts: ["ci"] } } } : checks), stderr: "" };
          return realExec(command, args, cwd, env, options);
        };
        const result = await commitAndAdoptStageBranch(pipeline, "refresh", exec, () => [pipeline], undefined,
          () => {}, null, undefined, undefined, attempt, now);
        process.stdout.write(JSON.stringify({ result, head: attempt.report.provenance.head }));
      `], process.cwd(), { ...f.env, INTEGRATION_FIXTURE: JSON.stringify({ pipeline: f.pipeline, attempt: f.attempt, checks: f.checks, now: NOW }) }, { timeoutMs: 30000 });
      expect(replay.code, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual({ result: { ok: true, sha: f.head }, head: f.head });
    }
    expect(await fs.access(path.join(f.receipt, "commits", f.head)).then(() => true, () => false)).toBe(false);
  } finally { await f.close(); }
});

test.each(["extra commit", "amended merge", "non-main parent", "unpublished"])("foreign integration refuses %s even with green checks", async mode => {
  const f = await foreignIntegration(false);
  try {
    if (mode === "extra commit") await f.git(f.foreign, "commit", "--allow-empty", "-m", "extra work");
    if (mode === "amended merge") {
      await fs.writeFile(path.join(f.foreign, "extra.txt"), "unreviewed\n"); await f.git(f.foreign, "add", "extra.txt");
      await f.git(f.foreign, "commit", "--amend", "--no-edit");
    }
    if (mode === "non-main parent") {
      await f.git(f.remote, "update-ref", "refs/heads/main", f.pipeline.baseRef);
    }
    const target = await f.git(f.foreign, "rev-parse", "HEAD");
    // Fixture refs model an already-published bad candidate without rewriting a real branch.
    await f.own("fetch", f.foreign, "HEAD");
    if (mode === "non-main parent") await f.own("update-ref", "refs/remotes/origin/main", f.head);
    if (mode === "unpublished") await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", f.reviewed);
    else {
      await f.git(f.remote, "fetch", f.foreign, target);
      await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", target);
    }
    await f.own("merge", "--ff-only", target);
    f.checks.headRefOid = target;
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    expect(await f.own("rev-parse", "HEAD")).toBe(target);
  } finally { await f.close(); }
});

test.each(["pending", "red", "empty", "malformed rollup", "stale head", "wrong base", "missing required", "malformed protection", "malformed protection body", "malformed contexts", "unavailable"])("published clean integration waits or refuses when checks are %s", async mode => {
  const f = await foreignIntegration(true);
  try {
    if (mode === "pending") f.setCheckRuns([{ __typename: "StatusContext", context: "ci", state: "PENDING", createdAt: "2026-10-16T10:01:00Z" }]);
    if (mode === "red") f.setCheckRuns([{ __typename: "StatusContext", context: "ci", state: "FAILURE", createdAt: "2026-10-16T10:01:00Z" }]);
    if (mode === "empty") f.setCheckRuns([]);
    if (mode === "malformed rollup") f.checks.statusCheckRollup.push(null as never);
    if (mode === "stale head") f.checks.headRefOid = f.reviewed;
    if (mode === "wrong base") f.checks.baseRefName = "other";
    if (mode === "missing required") f.setRequired({ protected: true, protection: { required_status_checks: { contexts: ["ci", "missing"] } } });
    if (mode === "malformed protection") f.setRequired({});
    if (mode === "malformed protection body") f.setRequired({ protected: true, protection: true });
    if (mode === "malformed contexts") f.setRequired({ protected: true, protection: { required_status_checks: { contexts: null } } });
    if (mode === "unavailable") f.setChecksCode(1);
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
    if (["pending", "empty", "missing required", "unavailable"].includes(mode)) {
      expect(result).toMatchObject({ deferred: true });
      f.setCheckRuns([{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }]);
      f.setRequired({ protected: true, protection: { required_status_checks: { contexts: ["ci"] } } });
      f.setChecksCode(0);
      expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toEqual({ ok: true, sha: f.head });
    }
  } finally { await f.close(); }
});

test.each(["FAILURE", "PENDING"] as const)("a green check run cannot hide an independent %s status context", async state => {
  const f = await foreignIntegration(true);
  try {
    f.setCheckRuns([
      { __typename: "StatusContext", context: "ci", state, createdAt: "2026-10-16T10:00:00Z" },
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "tests" } } } },
    ]);
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    if (state === "PENDING") expect(result).toMatchObject({ deferred: true });
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
  } finally { await f.close(); }
});

test.each(["FAILURE", "IN_PROGRESS"] as const)("a namesake run in another workflow cannot hide required %s", async state => {
  const f = await foreignIntegration(true);
  try {
    f.setRequired({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "ci", app_id: 123 }] } } });
    f.setCheckRuns([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "optional-format" } } } },
      { __typename: "CheckRun", name: "ci", status: state === "FAILURE" ? "COMPLETED" : state,
        conclusion: state === "FAILURE" ? "FAILURE" : null, startedAt: "2026-10-16T10:00:00Z",
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "required-tests" } } } },
    ]);
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    expect(result?.ok).toBe(false);
    if (state === "IN_PROGRESS") expect(result).toMatchObject({ deferred: true });
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
  } finally { await f.close(); }
});

test.each(["status only", "wrong app", "missing app identity", "required app", "unrestricted source", "legacy unrestricted source"] as const)("required check source app is enforced (%s)", async mode => {
  const f = await foreignIntegration(true);
  try {
    const appId = mode === "unrestricted source" ? null : mode === "legacy unrestricted source" ? -1 : 123;
    f.setRequired({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "ci", app_id: appId }] } } });
    if (mode === "status only") {
      f.checks.statusCheckRollup = [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }];
    } else {
      f.setCheckRuns([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
        checkSuite: { ...(mode === "missing app identity" ? {} : { app: { databaseId: mode === "wrong app" || mode === "unrestricted source" ? 456 : 123 } }),
          workflowRun: { workflow: { name: "tests" } } } }]);
    }
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW);
    if (mode === "required app" || mode === "unrestricted source" || mode === "legacy unrestricted source") expect(result).toEqual({ ok: true, sha: f.head });
    else {
      expect(result?.ok).toBe(false);
      expect(result).toMatchObject({ deferred: true });
    }
  } finally { await f.close(); }
});

test("the actual gh PR shape adopts an app-bound green check using exact-head GraphQL provenance", async () => {
  const f = await foreignIntegration(true);
  try {
    f.setRequired({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "ci", app_id: 123 }] } } });
    // gh 2.45.0 statusCheckRollup exports workflowName but no app identity.
    f.checks.statusCheckRollup = [{ __typename: "CheckRun", name: "ci", workflowName: "tests",
      status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z" }];
    f.setCheckRuns([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
      checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "tests" } } } }]);
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toEqual({ ok: true, sha: f.head });
    expect(f.commands.some(command => command[0] === "gh" && command.includes("graphql") && command.includes("--jq"))).toBe(true);
  } finally { await f.close(); }
});

test("exact-head check pagination retains pending evidence from the next page", async () => {
  const f = await foreignIntegration(true);
  try {
    f.setCheckPages([
      { nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-16T10:01:00Z" }],
        pageInfo: { hasNextPage: true, endCursor: "checks-page-one" } },
      { nodes: [{ __typename: "CheckRun", name: "other", status: "IN_PROGRESS", conclusion: null, startedAt: null,
        checkSuite: { app: { databaseId: 123 }, workflowRun: { workflow: { name: "tests" } } } }],
        pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toMatchObject({ ok: false, deferred: true });
    expect(f.commands.some(command => command.includes("endCursor=checks-page-one"))).toBe(true);
  } finally { await f.close(); }
});

test("an unknown exact-head check kind cannot authorize a published integration", async () => {
  const f = await foreignIntegration(true);
  try {
    f.setCheckRuns([{ __typename: "FutureCheckContext" }]);
    expect(await settleStageAttemptPush(f.pipeline, f.attempt, f.exec, NOW)).toMatchObject({ ok: false, deferred: true });
    expect(await f.own("rev-parse", "HEAD")).toBe(f.head);
  } finally { await f.close(); }
});

test.each(["remote", "head", "dirty", "branch", "default race", "default branch", "origin", "refusal"])("published clean integration preserves the %s fence", async mode => {
  const f = await foreignIntegration(false);
  let raced = false;
  try {
    if (mode === "default branch") await f.git(f.remote, "symbolic-ref", "HEAD", "refs/heads/other");
    if (mode === "refusal") await fs.writeFile(path.join(f.receipt, "refused"), "stage push refused");
    const exec: typeof realExec = async (command, args, cwd, env, options) => {
      if (mode === "origin" && command === "git" && args.join(" ") === "remote get-url origin") {
        return { code: 0, stdout: "https://github.com/example/other.git\n", stderr: "" };
      }
      const result = await f.exec(command, args, cwd, env, options);
      if (!raced && command === "gh" && args[0] === "api") {
        raced = true;
        if (mode === "remote") await f.git(f.remote, "update-ref", "refs/heads/pipeline/proof", f.reviewed);
        if (mode === "head") await f.own("merge", "--ff-only", f.head);
        if (mode === "dirty") await fs.writeFile(path.join(f.lane, "unsaved.txt"), "preserve\n");
        if (mode === "branch") await f.own("checkout", "-b", "unowned");
        if (mode === "default race") await f.git(f.remote, "symbolic-ref", "HEAD", "refs/heads/other");
      }
      return result;
    };
    const result = await settleStageAttemptPush(f.pipeline, f.attempt, exec, NOW);
    expect(result?.ok).toBe(false);
    expect(await f.own("rev-parse", "HEAD")).toBe(mode === "head" ? f.head : f.reviewed);
    if (mode === "dirty") expect(await fs.readFile(path.join(f.lane, "unsaved.txt"), "utf8")).toBe("preserve\n");
  } finally { await f.close(); }
});

// Agents committed with `git -c core.hooksPath=.githooks` to "keep hooks on".
// A command-line hooks path beats the guard's GIT_CONFIG_COUNT entry, so the
// guard's receipt hooks never run, while the repository's own hooks still do.
async function repositoryHooks(f: Awaited<ReturnType<typeof fixture>>, referenceTransaction?: string) {
  const hooks = path.join(f.root, "repository-hooks");
  await fs.mkdir(hooks, { recursive: true });
  if (referenceTransaction) await fs.writeFile(path.join(hooks, "reference-transaction"), referenceTransaction, { mode: 0o700 });
  await f.own("config", "core.hooksPath", hooks);
  return async (args: string[], env: Record<string, string> = {}) =>
    await realExec("git", ["-c", `core.hooksPath=${hooks}`, ...args], f.lane, { ...f.env, ...env });
}

async function advanceMain(f: Awaited<ReturnType<typeof fixture>>, file: string, content: string) {
  await fs.writeFile(path.join(f.foreign, file), content);
  await f.git(f.foreign, "add", file);
  await f.git(f.foreign, "commit", "-m", "main advances");
  await f.git(f.foreign, "push", "origin", "main");
  await f.own("fetch", "origin", "main");
}

/** Run one Git command inside its own process group and kill the whole group
 * from the reference-transaction hook once a branch moved, before post-commit
 * or post-merge runs: the same cut an OOM kill of the agent's scope makes. The
 * launch's guard hooks run and forward to the repository's own. */
async function dieAfterRefUpdate(f: Awaited<ReturnType<typeof fixture>>, args: string[]): Promise<string> {
  await repositoryHooks(f, "#!/bin/sh\ninput=$(cat)\n[ \"$1\" = committed ] && [ -n \"${STAGE_PROOF_DIE:-}\" ] "
    + "&& printf '%s\\n' \"$input\" | grep -q ' refs/heads/' && kill -KILL 0\nexit 0\n");
  const { spawn } = await import("node:child_process");
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn("git", args, { cwd: f.lane, detached: true, stdio: "ignore",
      env: { ...f.env, STAGE_PROOF_DIE: "1" } as NodeJS.ProcessEnv });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  expect(status.signal).toBe("SIGKILL");
  await f.own("config", "--unset", "core.hooksPath");
  // The kill also skipped Git's own cleanup of the merge state.
  if ((await realExec("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], f.lane, f.env)).code === 0) await f.own("merge", "--quit");
  return await f.own("rev-parse", "HEAD");
}

async function commitThenDie(f: Awaited<ReturnType<typeof fixture>>, message: string): Promise<string> {
  const head = await dieAfterRefUpdate(f, ["commit", "--allow-empty", "-m", message]);
  expect(await f.own("log", "-1", "--format=%s", head)).toBe(message);
  return head;
}

test.each(["clean merge", "clean merge concluded by commit", "conflicted merge"] as const)(
  "a %s the attempt made just before its host died settles", async shape => {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.lane, "shared.txt"), "lane\n");
      await f.own("add", "shared.txt");
      await f.commit("own work before the merge");
      if (shape === "conflicted merge") await advanceMain(f, "shared.txt", "main\n");
      else await advanceMain(f, "main.txt", "main\n");
      if (shape === "clean merge") await dieAfterRefUpdate(f, ["merge", "--no-ff", "--no-edit", "origin/main"]);
      else {
        const merged = await realExec("git", ["merge", "--no-ff", "--no-commit", "origin/main"], f.lane, f.env);
        expect(merged.code).toBe(shape === "conflicted merge" ? 1 : 0);
        if (shape === "conflicted merge") {
          await fs.writeFile(path.join(f.lane, "shared.txt"), "lane and main\n");
          await f.own("add", "shared.txt");
        }
        const message = path.join(f.root, "merge-message.txt");
        await fs.writeFile(message, "Merge origin/main into the lane\n\nCo-authored-by: Fixture <noreply@example.invalid>\n");
        await dieAfterRefUpdate(f, ["commit", "--cleanup=strip", "--file", message]);
      }
      const merge = await f.own("rev-parse", "HEAD");
      expect((await f.own("show", "-s", "--format=%P", merge)).split(" ")).toHaveLength(2);
      expect(await f.own("status", "--porcelain")).toBe("");
      const head = await f.commit("own fix after the merge");
      await f.push();
      expect(await f.settle()).toEqual({ ok: true, sha: head });
    } finally { await f.close(); }
  });

test.each(["ordinary commit", "clean merge"] as const)("%s under a command-line hooks path override settles with a creation receipt", async shape => {
  const f = await fixture();
  try {
    const withRepositoryHooks = await repositoryHooks(f);
    if (shape === "clean merge") await advanceMain(f, "main.txt", "main\n");
    const made = await withRepositoryHooks(shape === "clean merge" ? ["merge", "--no-ff", "--no-edit", "origin/main"]
      : ["commit", "--allow-empty", "-m", "own work, hooks path overridden"]);
    expect(made.code, made.stderr).toBe(0);
    const head = await f.own("rev-parse", "HEAD");
    expect(await fs.readFile(path.join(f.receipt, "commits", head), "utf8")).toBe("");
    await f.push();
    expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});

test.each((["claude", "codex"] as const).flatMap(engine =>
  (["original operation", "resume operation", "migration operation", "foreign conversation", "foreign worktree", "ambiguous membership", "missing attempt", "missing receipt",
    "superseded owner", "missing pipeline", "settled attempt", "settled during restoration"] as const).map(proof => ({ engine, proof }))))
("a $engine rehost retains stage custody with $proof", async ({ engine, proof }) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stage-rehost-state-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(stateRoot, "state");
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const controller = new AbortController();
  const successor = `stage-proof-rehost-new-owner-${nextFixture}`;
  let restoreGuardRead = () => {};
  try {
    f = await fixture();
    const previousPipelines = loadPipelines();
    const home = path.join(f.root, "account");
    await fs.mkdir(home);
    const registry = new AgentRegistry(path.join(f.root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const entry: AgentRegistryEntry = { key: { engine, sessionId: "stage-rehost" }, cwd: f.lane, artifactPath: path.join(f.root, "stage-rehost.jsonl"),
      structuredHostOperationId: proof === "original operation" ? f.attempt.launchId : "resume-host-operation",
      accountId: null, status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, updatedAt: START,
      launchProfile: emptyLaunchProfile({ cwd: f.lane }) };
    registry.upsert(entry);
    const conversation = registry.ensureForkedConversation(engine, entry.artifactPath, null, entry.launchProfile!);
    const role = { roleId: null, engine, model: null, effort: null, access: "read-write" as const, promptScaffold: null };
    const pipeline = buildPipeline({ id: "rehost-proof", task: "Stage custody", project: "fixture", repoDir: f.lane,
      stages: [{ id: "build", kind: "run", "prompt": "", next: null, effectiveRole: role }], srcPath: null, srcConversationId: null, now: START });
    Object.assign(pipeline, { worktreeDir: proof === "foreign worktree" ? f.foreign : f.lane,
      state: "running", baseBranch: "main", baseRef: f.pipeline.baseRef, lastPassedCommit: f.pipeline.baseRef });
    pipeline.branch = f.pipeline.branch;
    pipeline.cursor!.state = "running";
    pipeline.runs[0]!.attempts = [{ n: 1, state: proof === "settled attempt" ? "passed" : "running", effectiveRole: role, launchId: f.attempt.launchId,
      conversationId: proof === "foreign conversation" ? "conversation_foreign" : conversation.id, agentPath: entry.artifactPath,
      sessionId: entry.key.sessionId, paneId: null, flowId: null, startedAt: START, completedAt: proof === "settled attempt" ? NOW : null,
      input: null, activatedBy: null, output: null, verdict: null, error: null }];
    registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: pipeline.id, role: "builder", slot: "build:1",
      stageId: "build", stageOrder: 0, round: proof === "missing attempt" ? 2 : 1, parentConversationId: null });
    if (proof === "ambiguous membership") registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: "other-pipeline", role: "builder", slot: "build:1",
      stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
    savePipelines(proof === "missing pipeline" ? previousPipelines : [...previousPipelines, pipeline]);
    if (proof === "missing receipt") await fs.rm(path.join(f.receipt, "start.json"));
    if (proof === "superseded owner") await prepareStageGitGuard(successor, f.lane, realExec, START, async () => {});
    if (proof === "settled during restoration") {
      const restore = stageGuard.restoreStageGitGuard;
      const read = spyOn(stageGuard, "restoreStageGitGuard").mockImplementation(async (...args) => {
        const binding = await restore(...args);
        if (binding.LLV_STAGE_GIT_RECEIPT) {
          savePipelines([...previousPipelines, { ...pipeline, runs: pipeline.runs.map(run => ({ ...run,
            attempts: run.attempts.map(attempt => ({ ...attempt, state: "passed" as const })) })) }]);
        }
        return binding;
      });
      restoreGuardRead = () => read.mockRestore();
    }
    let shell: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const configureShell = async (env: NodeJS.ProcessEnv) => {
      if (engine === "codex") shell = agentCodexPublicationPolicy({}, { ...env, HOME: f!.root }).set as NodeJS.ProcessEnv;
      else {
        const policy = applyClaudeSpawnPolicy(home, { publicationEnv: env });
        shell = JSON.parse(await fs.readFile(policy.settingsPath, "utf8")).env;
      }
    };
    const observeCodex = async (store: AgentRegistry, optionsFor: Parameters<NonNullable<import("@/lib/runtime/startup").StructuredStartupDependencies["adopt"]>>[1]) => {
      const options = await optionsFor(store.readOnlySnapshot().entries["codex:stage-rehost"]!);
      try { await configureShell(options.env ?? { NODE_ENV: "test" }); }
      finally { options.releaseCleanup?.(); }
      return [];
    };
    const observeClaude = async (store: AgentRegistry, optionsFor: Parameters<NonNullable<import("@/lib/runtime/startup").StructuredStartupDependencies["adoptClaude"]>>[1]) => {
      const options = await optionsFor(store.readOnlySnapshot().entries["claude:stage-rehost"]!);
      try {
        await configureShell(options.env ?? { NODE_ENV: "test" });
      } finally { options.releaseCleanup?.(); }
      return [];
    };
    const adopt = () => adoptStructuredHostsAtStartup({ registry, client: null, signal: controller.signal, schedule: () => ({ unref() {} }),
      orchestratorSeats: () => [], refreshTranscriptState: async () => {},
      pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
      resolveCodexOwner: () => ({ home, kind: "managed" }),
      resolveClaudeOwner: () => ({ home, kind: "managed", transcriptRoot: f.root, env: { NODE_ENV: "test", HOME: f.root, PATH: process.env.PATH } }),
      adopt: engine === "codex" ? observeCodex : async () => [], adoptClaude: engine === "claude" ? observeClaude : async () => [],
    });
    if (!["original operation", "resume operation", "migration operation"].includes(proof)) {
      await expect(adopt()).rejects.toThrow(/stage Git rehost/);
      expect(shell.LLV_STAGE_GIT_RECEIPT).toBeUndefined();
    } else {
      if (proof === "migration operation") {
        const target = { engine, accountId: "target", kind: "managed" as const, home, transcriptRoot: home,
          env: { NODE_ENV: "test" as const, HOME: f.root, PATH: process.env.PATH } };
        const nativeId = ["aaaaaaaa", "1111", "4111", "8111", "aaaaaaaaaaaa"].join("-");
        const transcript = path.join(home, nativeId + ".jsonl");
        await fs.writeFile(transcript, JSON.stringify({ sessionId: nativeId }) + "\n");
        const receipt: ProviderReceipt = { operationId: "migration-stage-operation", nativeId, path: transcript, continuityPaths: [], historyHash: "fixture",
          host: { kind: engine === "codex" ? "codex-app-server" : "claude-fork", identity: nativeId, epoch: 1, verifiedAt: START } };
        const provider = new RegisteredSuccessorProvider({ registry, accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => target },
          startCodex: async () => { throw new Error("unexpected feature client"); }, claudeStatus: async () => ({ loggedIn: true }) });
        const capture = async (_id: string, options?: { env?: NodeJS.ProcessEnv }) => {
          await configureShell(options?.env ?? { NODE_ENV: "test" });
          throw new Error("captured migration environment");
        };
        const native = engine === "codex" ? spyOn(CodexAppServerHost, "adopt").mockImplementation(capture)
          : spyOn(ClaudeStreamBrokerHost, "adopt").mockImplementation(capture);
        const deliveryController = (process as typeof process & { __llvStructuredDeliveryController: { registerActiveHost: (() => Promise<() => Promise<void>>) | null } }).__llvStructuredDeliveryController;
        const register = deliveryController.registerActiveHost, structured = process.env.LLV_STRUCTURED_HOSTS;
        deliveryController.registerActiveHost = async () => async () => {};
        process.env.LLV_STRUCTURED_HOSTS = "1";
        try {
          await expect(provider.publishHost(receipt, { engine, conversationId: conversation.id, targetAccountId: target.accountId, launchProfile: entry.launchProfile! }))
            .rejects.toThrow("captured migration environment");
        } finally {
          native.mockRestore(); deliveryController.registerActiveHost = register;
          if (structured === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
          else process.env.LLV_STRUCTURED_HOSTS = structured;
        }
      } else await adopt();
      expect(shell.LLV_STAGE_GIT_RECEIPT).toBe(f.receipt);
      expect(shell.LLV_STAGE_GIT_WORKTREE).toBe(f.lane);
      const made = await realExec("git", ["commit", "--allow-empty", "-m", "fix after rehost"], f.lane, { ...f.env, ...shell });
      expect(made.code, made.stderr).toBe(0);
      const head = await f.own("rev-parse", "HEAD");
      expect(await fs.readFile(path.join(f.receipt, "commits", head), "utf8")).toBe("");
      await f.push();
      expect(await f.settle()).toEqual({ ok: true, sha: head });
    }
  } finally {
    controller.abort();
    restoreGuardRead();
    try {
      await bindStructuredDeliveryQueue([]);
      await fs.rm(stageGitReceiptDirectory(successor), { recursive: true, force: true });
      await f?.close();
    } finally {
      if (previousState === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previousState;
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  }
});

test.each(["another launch", "another worktree", "successor owner"])("a rehost refuses to borrow a binding from %s", async mismatch => {
  const f = await fixture();
  const successor = `stage-proof-rehost-successor-${nextFixture}`;
  try {
    if (mismatch === "successor owner") await prepareStageGitGuard(successor, f.lane, realExec, START, async () => {});
    if (mismatch === "another launch") {
      const start = JSON.parse(await fs.readFile(path.join(f.receipt, "start.json"), "utf8"));
      await fs.writeFile(path.join(f.receipt, "start.json"), JSON.stringify({ ...start, launchId: "another-launch" }));
    }
    await expect(stageGuard.restoreStageGitGuard(f.attempt.launchId, mismatch === "another worktree" ? f.foreign : f.lane, realExec)).rejects.toThrow(/stage Git rehost/);
  } finally { await fs.rm(stageGitReceiptDirectory(successor), { recursive: true, force: true }); await f.close(); }
});

test.each(["LLV_STAGE_GIT_RECEIPT", "LLV_STAGE_GIT_WORKTREE", "both"])("a lost %s binding records the hook diagnostic and refuses the mutation", async missing => {
  const f = await fixture();
  try {
    const env = { ...f.env };
    for (const name of ["LLV_STAGE_GIT_RECEIPT", "LLV_STAGE_GIT_WORKTREE"]) if (missing === name || missing === "both") delete env[name];
    const made = await realExec("git", ["commit", "--allow-empty", "-m", "lost binding"], f.lane, env);
    expect(made.code).not.toBe(0);
    const diagnostic = await fs.readFile(path.join(f.receipt, "binding-diagnostics"), "utf8");
    expect(diagnostic).toContain("hook=pre-commit");
    if (missing === "both") for (const name of ["LLV_STAGE_GIT_RECEIPT", "LLV_STAGE_GIT_WORKTREE"]) expect(diagnostic).toContain(name);
    else expect(diagnostic).toContain(missing);
    expect(await f.own("rev-parse", "HEAD")).toBe(f.pipeline.baseRef);
  } finally { await f.close(); }
});

test.each(["host-lost replacement", "operator retry"] as const)(
  "a commit whose host died before post-commit settles in the %s", async lineage => {
    const f = await fixture();
    const childLaunch = `stage-proof-host-death-${nextFixture}`;
    try {
      const lost = await commitThenDie(f, "own work committed just before the kill");
      const parent = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:30:00.000Z",
        agentPath: "/stage/killed.jsonl", ...(lineage === "host-lost replacement" ? { restartRecovery: { bootId: "killed-host",
          requestedAt: "2026-10-16T09:30:00.000Z", lastRecordAt: null, replacementAttempt: 2 } } : {}) } as PipelineStageAttempt;
      await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
      Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
      const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z", completedAt: NOW,
        state: "passed", agentPath: "/stage/after-kill.jsonl",
        ...(lineage === "host-lost replacement" ? { restartContext: { previousAttempt: 1, transcriptPath: parent.agentPath, cause: "host-lost" } } : {}),
      } as PipelineStageAttempt;
      const head = await f.commit("retry output");
      await f.push();
      f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
      expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
      expect(await f.own("merge-base", "--is-ancestor", lost, head)).toBe("");
    } finally {
      await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
      await f.close();
    }
  });

test("a same-identity commit made in the lane after the attempt ended is still refused", async () => {
  const f = await fixture();
  const childLaunch = `stage-proof-after-end-${nextFixture}`;
  try {
    await f.commit("own receipted work");
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: "2026-10-16T09:30:00.000Z",
      agentPath: "/stage/ended.jsonl" } as PipelineStageAttempt;
    // Made through the launch hooks, so only the attempt's end bounds it.
    const late = await realExec("git", ["commit", "--allow-empty", "-m", "another writer after the attempt ended"], f.lane,
      { ...f.env, GIT_COMMITTER_DATE: "2026-10-16T09:45:00Z" });
    expect(late.code, late.stderr).toBe(0);
    const foreign = await f.own("rev-parse", "HEAD");
    await fs.rm(path.join(f.receipt, "commits", foreign));
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, "2026-10-16T10:00:00.000Z", async () => {}));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: "2026-10-16T10:00:00.000Z", completedAt: NOW,
      state: "passed", agentPath: "/stage/after-end.jsonl" } as PipelineStageAttempt;
    await f.commit("retry output");
    await f.push();
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
    const result = await settleStageAttemptPush(f.pipeline, child, realExec, NOW);
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("a commit after the attempt ended was accepted");
    expect(result.error).toContain(foreign);
  } finally {
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    await f.close();
  }
});

// prepare-commit-msg records the tree and parents a commit invocation is about
// to write, and the editor, commit-msg and the author check can still abort
// that invocation. Another writer's later commit with the same tree, parents,
// identity and time, made unguarded in the lane or imported by a reset whose
// reflog message reads like a commit, must not inherit that intent.
test.each((["editor", "commit-msg", "author check"] as const).flatMap(abort =>
  (["unguarded lane commit", "imported by reset"] as const).map(later => ({ abort, later }))))
("an intent from a commit aborted by its $abort proves no $later", async ({ abort, later }) => {
  const f = await fixture();
  try {
    const parent = await f.commit("own work before the abort");
    await f.push();
    const hooks = path.join(f.root, "repository-hooks");
    if (abort === "commit-msg") {
      await fs.mkdir(hooks, { recursive: true });
      await fs.writeFile(path.join(hooks, "commit-msg"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await f.own("config", "core.hooksPath", hooks);
    }
    const aborted = await realExec("git", ["commit", "--allow-empty",
      ...(abort === "editor" ? [] : ["-m", "updating HEAD"]),
      ...(abort === "author check" ? ["--author", "Somebody Else <noreply@elsewhere.invalid>"] : [])],
    f.lane, { ...f.env, GIT_EDITOR: "false" });
    expect(aborted.code).not.toBe(0);
    if (abort === "commit-msg") await f.own("config", "--unset", "core.hooksPath");
    expect(await f.own("rev-parse", "HEAD")).toBe(parent);
    // The aborted invocation did record an intent.
    expect((await fs.readdir(path.join(f.receipt, "intents"))).filter(name => !name.startsWith(".")).length).toBeGreaterThan(0);

    const unguarded: NodeJS.ProcessEnv = { ...f.env, GIT_CONFIG_COUNT: "0",
      LLV_STAGE_GIT_RECEIPT: undefined, LLV_STAGE_GIT_WORKTREE: undefined };
    if (later === "unguarded lane commit") {
      const made = await realExec("git", ["commit", "--allow-empty", "-m", "updating HEAD"], f.lane, unguarded);
      expect(made.code, made.stderr).toBe(0);
    } else {
      const other = path.join(f.root, "other-checkout");
      await f.git(f.foreign, "fetch", "origin", "pipeline/proof");
      await realExec("git", ["worktree", "add", "--detach", other, parent], f.foreign, unguarded);
      const made = await realExec("git", ["commit", "--allow-empty", "-m", "updating HEAD"], other, unguarded);
      expect(made.code, made.stderr).toBe(0);
      await f.git(other, "push", "-f", "origin", "HEAD:refs/heads/pipeline/proof");
      await f.own("fetch", "origin", "pipeline/proof");
      const reset = await realExec("git", ["reset", "--hard", "FETCH_HEAD"], f.lane, { ...f.env, GIT_REFLOG_ACTION: "commit" });
      expect(reset.code, reset.stderr).toBe(0);
      expect(await f.own("reflog", "-1", "--format=%gs")).toBe("commit: updating HEAD");
    }
    const head = await f.own("rev-parse", "HEAD");
    expect(head).not.toBe(parent);
    expect(await f.own("show", "-s", "--format=%T %P", head)).toBe(await f.own("show", "-s", "--format=%T", parent) + " " + parent);
    expect(await fs.access(path.join(f.receipt, "commits", head)).then(() => true, () => false)).toBe(false);
    // The guarded pre-push would refuse the unguarded commit itself; deliver it
    // the way its writer would, so only settlement judges custody.
    if (later === "unguarded lane commit") {
      const pushed = await realExec("git", ["push", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, unguarded);
      expect(pushed.code, pushed.stderr).toBe(0);
    } else await f.push();
    expect(await fs.access(path.join(f.receipt, "refused")).then(() => true, () => false)).toBe(false);
    expect(await f.settle()).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${head} was not created in the attempt worktree`) });
  } finally { await f.close(); }
});
