import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { settleStageAttemptPush } from "./stageAttemptPush";
import type { Pipeline, PipelineStageAttempt } from "./types";

const START = "2026-10-16T08:00:00.000Z", NOW = "2026-10-16T12:00:00.000Z";
let nextFixture = 0;
async function fixture(legacy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-proof-"));
  const lane = path.join(root, "lane"), remote = path.join(root, "remote.git"), foreign = path.join(root, "foreign");
  const baseEnv = { ...process.env, GIT_AUTHOR_DATE: "2026-10-16T09:00:00Z", GIT_COMMITTER_DATE: "2026-10-16T09:00:00Z" };
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
