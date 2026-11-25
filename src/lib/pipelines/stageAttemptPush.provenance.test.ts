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
import type { PipelineStageAttempt } from "./types";
import { commitThenDie, dieAfterRefUpdate, fixture, nextFixture, repositoryHooks, START, NOW } from "./stageAttemptPush.fixture";

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
    const base = f.pipeline.baseRef;
    const count = 260;
    const stream = Array.from({ length: count - 1 }, (_, index) => {
      const message = `own ${index}`;
      return [
        `commit refs/heads/${f.pipeline.branch}`,
        `committer Fixture <noreply@example.invalid> ${Date.parse(f.env.GIT_COMMITTER_DATE!) / 1000} +0000`,
        `data ${Buffer.byteLength(message)}`,
        message,
        ...(index === 0 ? [`from ${base}`] : []),
        "",
      ].join("\n");
    }).join("\n");
    const imported = Bun.spawnSync(["git", "fast-import", "--quiet", "--done"], {
      cwd: f.lane, env: f.env, stdin: Buffer.from(`${stream}\ndone\n`), timeout: 15_000,
    });
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    // One ordinary commit still writes a native receipt. Seed the imported
    // prefix with the same on-disk evidence to exercise settlement's paging.
    const head = await f.commit("own final");
    const commits = (await f.own("rev-list", "--reverse", `${base}..${head}`)).split("\n");
    expect(commits).toHaveLength(count);
    const [oldest, ...rest] = commits;
    for (const sha of rest.slice(0, -1)) {
      await fs.writeFile(path.join(f.receipt, "commits", sha), "", { flag: "wx" });
    }
    await f.push();
    expect(await f.settle()).toMatchObject({ ok: false, error: expect.stringContaining(`commit ${oldest} was not created`) });
    await fs.writeFile(path.join(f.receipt, "commits", oldest!), "", { flag: "wx" });
    expect(await f.settle()).toEqual({ ok: true, sha: head });
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

async function advanceMain(f: Awaited<ReturnType<typeof fixture>>, file: string, content: string) {
  await fs.writeFile(path.join(f.foreign, file), content);
  await f.git(f.foreign, "add", file);
  await f.git(f.foreign, "commit", "-m", "main advances");
  await f.git(f.foreign, "push", "origin", "main");
  await f.own("fetch", "origin", "main");
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
  (["original operation", "resume operation", "migration operation", "unrelated conversation", "foreign conversation", "foreign worktree", "ambiguous membership", "missing attempt", "missing receipt",
    "superseded owner", "missing pipeline", "settled attempt", "settled during restoration", "replaced during restoration"] as const).map(proof => ({ engine, proof }))))
("a $engine rehost retains stage custody with $proof", async ({ engine, proof }) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stage-rehost-state-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(stateRoot, "state");
  let ownedFixture: Awaited<ReturnType<typeof fixture>> | undefined;
  const controller = new AbortController();
  const successor = `stage-proof-rehost-new-owner-${nextFixture}`;
  let restoreGuardRead = () => {};
  try {
    const f = await fixture(false, false, undefined, { id: "rehost-proof", task: "Stage custody" });
    ownedFixture = f;
    const previousPipelines = loadPipelines();
    const home = path.join(f.root, "account");
    await fs.mkdir(home);
    const registry = new AgentRegistry(path.join(f.root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const rehostWorktree = proof === "foreign worktree" ? f.foreign : f.lane;
    const entry: AgentRegistryEntry = { key: { engine, sessionId: "stage-rehost" }, cwd: rehostWorktree, artifactPath: path.join(f.root, "stage-rehost.jsonl"),
      structuredHostOperationId: ["original operation", "unrelated conversation"].includes(proof) ? f.attempt.launchId : "resume-host-operation",
      accountId: null, status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, updatedAt: START,
      launchProfile: emptyLaunchProfile({ cwd: rehostWorktree }) };
    registry.upsert(entry);
    const conversation = registry.ensureForkedConversation(engine, entry.artifactPath, null, entry.launchProfile!);
    const role = { roleId: null, engine, model: null, effort: null, access: "read-write" as const, promptScaffold: null };
    const pipeline = buildPipeline({ id: "rehost-proof", task: "Stage custody", project: "fixture", repoDir: f.repository,
      stages: [{ id: "build", kind: "run", "prompt": "", next: null, effectiveRole: role }], srcPath: null, srcConversationId: null, now: START });
    Object.assign(pipeline, { state: "running", baseBranch: "main", baseRef: f.pipeline.baseRef, lastPassedCommit: f.pipeline.baseRef });
    pipeline.branch = f.pipeline.branch;
    pipeline.cursor!.state = "running";
    pipeline.runs[0]!.attempts = [{ n: 1, state: proof === "settled attempt" ? "passed" : "running", effectiveRole: role, launchId: f.attempt.launchId,
      conversationId: proof === "foreign conversation" ? "conversation_foreign" : conversation.id, agentPath: entry.artifactPath,
      sessionId: entry.key.sessionId, paneId: null, flowId: null, startedAt: START, completedAt: proof === "settled attempt" ? NOW : null,
      input: null, activatedBy: null, output: null, verdict: null, error: null }];
    if (proof !== "unrelated conversation") registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: pipeline.id, role: "builder", slot: "build:1",
      stageId: "build", stageOrder: 0, round: proof === "missing attempt" ? 2 : 1, parentConversationId: null });
    if (proof === "ambiguous membership") registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: "other-pipeline", role: "builder", slot: "build:1",
      stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
    savePipelines(proof === "missing pipeline" ? previousPipelines : [...previousPipelines, pipeline]);
    if (proof === "foreign worktree") await prepareStageGitGuard(successor, f.foreign, realExec, START, async () => {});
    if (proof === "missing receipt") await fs.rm(path.join(f.receipt, "start.json"));
    if (proof === "superseded owner") await prepareStageGitGuard(successor, f.lane, realExec, START, async () => {});
    if (proof === "settled during restoration" || proof === "replaced during restoration") {
      const restore = stageGuard.restoreStageGitGuard;
      const read = spyOn(stageGuard, "restoreStageGitGuard").mockImplementation(async (...args) => {
        const binding = await restore(...args);
        if (binding.LLV_STAGE_GIT_RECEIPT) {
          savePipelines([...previousPipelines, { ...pipeline, runs: pipeline.runs.map(run => ({ ...run,
            attempts: run.attempts.map(attempt => ({ ...attempt, state: proof === "settled during restoration" ? "passed" as const : attempt.state,
              launchId: proof === "replaced during restoration" ? successor : attempt.launchId })) })) }]);
        }
        return binding;
      });
      restoreGuardRead = () => read.mockRestore();
    }
    let shell: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const configureShell = async (env: NodeJS.ProcessEnv) => {
      if (engine === "codex") shell = agentCodexPublicationPolicy({}, { ...env, HOME: f.root }).set as NodeJS.ProcessEnv;
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
          startCodex: async () => { throw new Error("unexpected feature client"); }, claudeStatus: async () => ({ loggedIn: true }), now: () => START });
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
      await ownedFixture?.close();
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
