import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import * as stageGuard from "@/lib/git/stageAttemptGuard";
import { agentCodexPublicationPolicy } from "@/lib/git/agentPublicationIdentity";
import { settleStageAttemptPush } from "./stageAttemptPush";
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
import { START, NOW, nextFixture, fixture, commitThenDie } from "./stageAttemptPush.fixture";

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
