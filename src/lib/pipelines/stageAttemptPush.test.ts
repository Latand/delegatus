import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { seedForgeCommitAccount } from "@/test-helpers/forgeCommitAccount";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { repositoryPublicationSource } from "@/lib/git/repositoryCommitIdentity";
import { bindMergerContract } from "./mergerContract.fixture";
import { git as batchGit } from "../../../scripts/merge-batch";
import { START, NOW, nextFixture, fixture } from "./stageAttemptPush.fixture";

test.each(["batch", "earlier producer", "pull ref only", "tracking ref"] as const)("merger contract native boundary: %s", async mode => {
  const f = await fixture(true);
  let contract: Awaited<ReturnType<typeof bindMergerContract>> | undefined;
  try {
    // Only main history is present locally. A PR fetch must not accidentally
    // inherit tracking proof from the fixture producer's branch push.
    await f.git(f.foreign, "checkout", "-b", "topic-13");
    await fs.writeFile(path.join(f.foreign, "feature.txt"), "reviewed PR\n");
    await f.git(f.foreign, "add", "feature.txt");
    await f.git(f.foreign, "commit", "-m", "reviewed PR");
    const pr = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", `${pr}:refs/pull/13/head`, `${pr}:refs/heads/topic-13`);
    await f.git(f.foreign, "checkout", "main");
    await f.git(f.foreign, "commit", "--allow-empty", "-m", "main advances");
    await f.git(f.foreign, "push", "origin", "main");
    if (mode === "earlier producer") await f.commit("earlier producing stage");
    const laneHead = await f.own("rev-parse", "HEAD");
    const scratch = path.join(f.root, "merger-scratch");
    await fs.mkdir(scratch);
    contract = await bindMergerContract(f.lane, `merger-native-${mode.replaceAll(" ", "-")}`, { ...f.env, TMPDIR: scratch });
    const env = { ...contract.env, LLV_SKIP_HOOKS: "1" };
    const git = (cwd: string, ...args: string[]) => batchGit(cwd, args, undefined, env);
    git(f.lane, "fetch", "origin", "main");
    const work = path.join(scratch, "checkout");
    const resolution = mode === "pull ref only" || mode === "tracking ref";
    if (resolution) {
      git(f.lane, "fetch", "origin", "refs/pull/13/head");
      expect(git(f.lane, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/topic-13")).toBe("");
      git(f.lane, "worktree", "add", "--detach", work, "FETCH_HEAD");
      git(work, "merge", "--no-commit", "--no-ff", "origin/main");
    } else {
      git(f.lane, "fetch", "origin", "refs/pull/13/head");
      git(f.lane, "worktree", "add", "-b", "merge-batch/fixture", work, "origin/main");
      git(work, "merge", "--squash", pr);
    }
    batchGit(work, ["commit", "-F", "-"], "Fixture batch resolution\n", env);
    const tip = git(work, "rev-parse", "HEAD");
    expect(await fs.access(path.join(contract.receipt, "commits", tip)).then(() => true, () => false)).toBe(true);
    if (mode === "tracking ref") git(work, "fetch", "origin", "+refs/heads/topic-13:refs/remotes/origin/topic-13");
    const ref = resolution ? "refs/heads/topic-13" : "refs/heads/merge-batch/fixture";
    const push = () => git(work, "push", resolution ? f.remote : "origin", `${tip}:${ref}`);
    const refused = mode === "earlier producer" || mode === "pull ref only";
    if (refused) {
      expect(push).toThrow("stage push refused");
      expect(await fs.readFile(path.join(contract.receipt, "refused"), "utf8")).toContain("stage push refused");
      expect(await contract.settle()).toMatchObject({ ok: false, error: expect.stringContaining("stage push refused") });
      expect(await f.git(f.remote, "for-each-ref", "--format=%(objectname)", ref)).toBe(resolution ? pr : "");
    } else {
      push();
      expect(await fs.readFile(path.join(contract.receipt, "pushes", tip), "utf8")).toBe(`${ref}\n${f.remote}\n`);
      expect(await fs.access(path.join(contract.receipt, "refused")).then(() => true, () => false)).toBe(false);
      expect(await contract.settle()).toBeNull();
      expect(await f.git(f.remote, "rev-parse", ref)).toBe(tip);
    }
    expect(await f.own("rev-parse", "HEAD")).toBe(laneHead);
  } finally {
    if (contract) await fs.rm(contract.receipt, { recursive: true, force: true });
    await f.close();
  }
});

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

test("the stage push hook admits safe owner commits and refuses private history or lost account evidence", async () => {
  const f = await fixture();
  const previousState = process.env.LLV_STATE_DIR;
  const stateDir = path.join(f.root, "state");
  process.env.LLV_STATE_DIR = stateDir;
  seedForgeCommitAccount(stateDir);
  const stateFile = path.join(stateDir, "forge-commit-account.json");
  const savedAccount = await fs.readFile(stateFile);
  try {
    const fakeBin = path.join(f.root, "bin");
    await fs.mkdir(fakeBin);
    const gh = path.join(fakeBin, "gh");
    await fs.writeFile(gh, `#!/bin/sh\n[ "${"$"}LLV_TEST_GH_UNAUTHENTICATED" != 1 ] || exit 1\nprintf '%s\\n' '1042+fixture-lane'\n`);
    await fs.chmod(gh, 0o755);
    f.env.PATH = `${fakeBin}:${f.env.PATH}`;
    const source = { ...f.env, HOME: f.root, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
    const identity = await repositoryPublicationSource(f.lane, source, realExec);
    Object.assign(f.env, identity, agentPublicationIdentityEnv({ ...source, ...identity }));
    const safe = await f.commit("safe owner commit");
    await f.push();
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(safe);

    const privateEmail = ["personal", "example.invalid"].join("@");
    const tree = await realExec("git", ["write-tree"], f.lane, f.env);
    expect(tree.code, tree.stderr).toBe(0);
    const privateCommit = await realExec("git", ["commit-tree", tree.stdout.trim(), "-p", safe, "-m", "old private commit"], f.lane, {
      ...f.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: privateEmail, GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: privateEmail,
    });
    expect(privateCommit.code, privateCommit.stderr).toBe(0);
    const unsafeRef = await realExec("git", ["update-ref", "refs/heads/unsafe-fixture", privateCommit.stdout.trim()], f.lane, f.env);
    expect(unsafeRef.code, unsafeRef.stderr).toBe(0);
    const denied = await realExec("git", ["push", "origin", "refs/heads/unsafe-fixture:refs/heads/pipeline/proof"], f.lane, f.env);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("stage push refused");
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(safe);

    await f.commit("authentication disappears after launch");
    const loggedOut = await realExec("git", ["push", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane,
      { ...f.env, LLV_TEST_GH_UNAUTHENTICATED: "1" });
    expect(loggedOut.code).not.toBe(0);
    expect(loggedOut.stderr).toContain("installation owner authentication is unavailable");

    await f.own("reset", "--hard", safe);
    await f.commit("account disappears before another direct push");
    await fs.rm(stateFile);
    const unresolvedSource = await repositoryPublicationSource(f.lane, source, realExec);
    const unresolved = agentPublicationIdentityEnv({ ...source, ...unresolvedSource });
    const noAccount = await realExec("git", ["push", "origin", "HEAD:refs/heads/pipeline/proof"], f.lane, { ...f.env, ...unresolved });
    expect(noAccount.code).not.toBe(0);
    expect(noAccount.stderr).toContain("installation owner identity is unavailable");
  } finally {
    await fs.writeFile(stateFile, savedAccount);
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    await f.close();
  }
});

test("a stage merge of current foreign-identity origin history can push while new private commits remain refused", async () => {
  const f = await fixture();
  const previousState = process.env.LLV_STATE_DIR;
  const stateDir = path.join(f.root, "state");
  process.env.LLV_STATE_DIR = stateDir;
  seedForgeCommitAccount(stateDir);
  try {
    const fakeBin = path.join(f.root, "bin");
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, "gh"), "#!/bin/sh\nprintf '%s\\n' '1042+fixture-lane'\n", { mode: 0o700 });
    f.env.PATH = `${fakeBin}:${f.env.PATH}`;
    const source = { ...f.env, HOME: f.root, LLV_STATE_DIR: stateDir };
    const identity = await repositoryPublicationSource(f.lane, source, realExec, "lane");
    Object.assign(f.env, identity, agentPublicationIdentityEnv({ ...source, ...identity }));

    await f.git(f.foreign, "commit", "--allow-empty", "-m", "foreign main update");
    await f.git(f.foreign, "push", "origin", "main");
    await f.own("fetch", "origin", "main");
    await f.own("merge", "--no-ff", "origin/main", "-m", "merge current main");
    const merged = await f.own("rev-parse", "HEAD");
    await f.push();
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(merged);

    const privateEmail = ["personal", "example.invalid"].join("@");
    const tree = await realExec("git", ["write-tree"], f.lane, f.env);
    expect(tree.code, tree.stderr).toBe(0);
    const privateCommit = await realExec("git", ["commit-tree", tree.stdout.trim(), "-p", merged, "-m", "unpublished private identity"], f.lane, {
      ...f.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: privateEmail, GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: privateEmail,
    });
    expect(privateCommit.code, privateCommit.stderr).toBe(0);
    await f.own("update-ref", "refs/heads/private-probe", privateCommit.stdout.trim());
    const denied = await realExec("git", ["push", "origin", "refs/heads/private-probe:refs/heads/pipeline/proof"], f.lane, f.env);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("stage push refused");
    expect(await f.git(f.remote, "rev-parse", "refs/heads/pipeline/proof")).toBe(merged);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
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
    const originalGit = Bun.which("git", { PATH: process.env.PATH })!;
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
