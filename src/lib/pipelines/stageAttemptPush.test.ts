import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { settleStageAttemptPush } from "./stageAttemptPush";
import { commitAndAdoptStageBranch } from "./stageBranch";
import type { Pipeline, PipelineStageAttempt } from "./types";

const START = "2026-10-16T08:00:00.000Z", NOW = "2026-10-16T12:00:00.000Z";
let nextFixture = 0;
async function fixture(legacy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-proof-"));
  const lane = path.join(root, "lane"), remote = path.join(root, "remote.git"), foreign = path.join(root, "foreign");
  const baseEnv = { ...process.env, ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined])),
    HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent-git-config"), GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_DATE: "2026-10-16T09:00:00Z", GIT_COMMITTER_DATE: "2026-10-16T09:00:00Z" };
  const env = { ...baseEnv };
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
  await git(lane, "commit", "--allow-empty", "-m", "base");
  const base = await git(lane, "rev-parse", "HEAD");
  await git(lane, "remote", "add", "origin", remote);
  await git(lane, "push", "origin", "main");
  await git(lane, "checkout", "-b", "pipeline/proof");
  await git(root, "clone", remote, foreign);
  await git(foreign, "config", "user.name", "Fixture");
  await git(foreign, "config", "user.email", ["noreply", "example.invalid"].join("@"));
  await git(foreign, "config", "commit.gpgSign", "false");
  const launchId = `stage-proof-fixture-${++nextFixture}`;
  const attempt = { launchId, startedAt: START, completedAt: null } as PipelineStageAttempt;
  const pipeline = { id: "proof", worktreeDir: lane, branch: "pipeline/proof", baseBranch: "main", baseRef: base, lastPassedCommit: base,
    delivery: { active: true, disposition: "owner", ownerId: "proof", publish: "enabled",
      target: { remote, branch: "refs/heads/pipeline/proof" } } } as Pipeline;
  if (!legacy) {
    Object.assign(env, await prepareStageGitGuard(launchId, lane, realExec, START));
  }
  Object.assign(env, agentPublicationIdentityEnv({ ...env, HOME: root }));
  const own = async (...args: string[]) => await git(lane, ...args);
  const commit = async (label: string) => { await own("commit", "--allow-empty", "-m", label); return own("rev-parse", "HEAD"); };
  const push = async () => own("push", "origin", "HEAD:refs/heads/pipeline/proof");
  const settle = () => settleStageAttemptPush(pipeline, attempt, realExec, NOW);
  return { root, lane, remote, foreign, env, git, own, commit, push, settle, pipeline, attempt, receipt: stageGitReceiptDirectory(launchId),
    close: async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(stageGitReceiptDirectory(launchId), { recursive: true, force: true }); } };
}

test("B: a controller-created replacement link proves a completed parent without restartRecovery", async () => {
  const f = await fixture();
  let childLaunch: string | null = null;
  try {
    const inherited = await f.commit("completed parent output");
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: NOW, agentPath: "/stage/parent.jsonl" } as PipelineStageAttempt;
    childLaunch = `stage-proof-generic-replacement-${nextFixture}`;
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, START));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: START, completedAt: NOW, state: "passed",
      agentPath: "/stage/child.jsonl", restartContext: { previousAttempt: 1, transcriptPath: parent.agentPath } } as PipelineStageAttempt;
    const head = await f.commit("replacement output");
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
    await f.push();
    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toEqual({ ok: true, sha: head });
    expect(inherited).not.toBe(head);
  } finally { if (childLaunch) await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true }); await f.close(); }
});

test("review safety: manual silent retry preserves predecessor commit custody", async () => {
  const f = await fixture();
  let childLaunch: string | null = null;
  try {
    const parent = { ...f.attempt, n: 1, state: "failed", completedAt: NOW, agentPath: "/stage/silent.jsonl" } as PipelineStageAttempt;
    await f.own("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "unreceipted predecessor");

    childLaunch = `stage-proof-manual-silent-retry-${nextFixture}`;
    await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
    Object.assign(f.env, await prepareStageGitGuard(childLaunch, f.lane, realExec, START));
    const child = { ...f.attempt, n: 2, launchId: childLaunch, startedAt: START, completedAt: NOW, state: "passed",
      agentPath: "/stage/manual-retry.jsonl", restartContext: { previousAttempt: 1, transcriptPath: parent.agentPath } } as PipelineStageAttempt;
    const head = await f.commit("manual retry output");
    f.pipeline.runs = [{ stageId: "build", attempts: [parent, child] }] as never;
    await f.push();

    expect(await settleStageAttemptPush(f.pipeline, child, realExec, NOW)).toMatchObject({
      ok: false, error: expect.stringContaining("was not created in the attempt worktree"),
    });
    const unlinked = structuredClone(f.pipeline);
    delete unlinked.runs![0]!.attempts[1]!.restartContext;
    expect(await settleStageAttemptPush(unlinked, unlinked.runs![0]!.attempts[1]!, realExec, NOW))
      .toEqual({ ok: true, sha: head });
  } finally {
    if (childLaunch) await fs.rm(stageGitReceiptDirectory(childLaunch), { recursive: true, force: true });
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

test.each(["versioned", "versionless"])("B: a %s start refuses imported shared-identity commits with forged reflog creation", async version => {
  const f = await fixture();
  try {
    const startPath = path.join(f.receipt, "start.json");
    const start = JSON.parse(await fs.readFile(startPath, "utf8"));
    if (version === "versionless") delete start.commitReceiptVersion;
    await fs.writeFile(startPath, JSON.stringify(start));
    const foreignEnv: NodeJS.ProcessEnv = { ...f.env, GIT_CONFIG_COUNT: "0",
      LLV_STAGE_GIT_RECEIPT: undefined, LLV_STAGE_GIT_WORKTREE: undefined };
    const made = await realExec("git", ["commit", "--allow-empty", "-m", "shared identity outside lane"], f.foreign, foreignEnv);
    expect(made.code, made.stderr).toBe(0);
    const imported = await f.git(f.foreign, "rev-parse", "HEAD");
    await f.git(f.foreign, "push", "origin", "HEAD:refs/heads/pipeline/proof");
    await f.own("fetch", "origin", "pipeline/proof");
    const reset = await realExec("git", ["reset", "--hard", "FETCH_HEAD"], f.lane,
      { ...f.env, GIT_REFLOG_ACTION: "commit" });
    expect(reset.code, reset.stderr).toBe(0);
    expect(await fs.access(path.join(f.receipt, "commits", imported)).then(() => true, () => false)).toBe(false);
    const settled = await f.settle();
    expect(settled?.ok).toBe(false);
    if (!settled || settled.ok) throw new Error("versionless start trusted forged creation");
    expect(settled.error).toContain(imported);
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


test("B: an octopus merge can prove creation when Git omits the ancestral lane head", async () => {
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
    await f.own("merge", "-m", "octopus merge", "origin/main", "own-side");
    const head = await f.own("rev-parse", "HEAD");
    const parents = await f.own("show", "-s", "--format=%P", head);
    expect(parents.split(" ")).not.toContain(f.pipeline.baseRef);
    expect(await fs.readFile(path.join(f.receipt, "commits", head), "utf8")).toBe("");
    await f.push(); expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});


// A refresh starts from reviewed lane work; the remote merge has no stage receipt.
async function foreignIntegration(local: boolean) {
  const f = await fixture();
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
