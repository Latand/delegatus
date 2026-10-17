import { expect, test, fs, os, path, harness, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines, pipelineRevision, rawPatchPipeline, entry } from "./engine.fixture";
import { realExec, type ExecPort } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { OPERATOR_PAUSE_RESUME_ACTOR } from "@/lib/pauseResumeActor";
import { beforeEach, afterEach } from "bun:test";

// Literal Git wrappers also read the parent's command configuration. Isolate
// that source as well as each child overlay, then restore the caller exactly.
let inheritedGit: Record<string, string | undefined>;
const gitKey = (key: string) => key.startsWith("GIT_") || key.startsWith("LLV_STAGE_GIT_");
beforeEach(() => {
  inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => gitKey(key)));
  for (const key of Object.keys(process.env).filter(gitKey)) delete process.env[key];
});
afterEach(() => {
  for (const key of Object.keys(process.env).filter(gitKey)) delete process.env[key];
  Object.assign(process.env, inheritedGit);
});

const stages = [
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
];
const current = () => loadPipelines()[0]!;

async function fixture() {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-recovery-"));
  const repo = path.join(root, "repo"), remote = path.join(root, "remote.git"), hooks = path.join(root, "hooks");
  const clean: Partial<NodeJS.ProcessEnv> = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.startsWith("GIT_") || key.startsWith("LLV_STAGE_GIT_")).map(key => [key, undefined]));
  Object.assign(clean, { HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "absent"), GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-16T08:00:00Z", GIT_COMMITTER_DATE: "2026-10-16T08:00:00Z" });
  let agentEnv: Partial<NodeJS.ProcessEnv> = clean;
  let lane = "";
  const execute: ExecPort = (command, args, cwd, env, options) => realExec(command, args, cwd, { ...clean, ...env }, options);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await execute("git", args, cwd, cwd === lane ? agentEnv : clean);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  fs.mkdirSync(repo); fs.mkdirSync(hooks);
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "core.hooksPath", hooks);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "origin", "main");
  const h = harness();
  h.ports.exec = execute;
  h.ports.provisionExec = async (command, args, cwd, signal) => await execute(command, args, cwd, undefined, { signal });
  h.ports.resumeSeveredTurn = undefined;
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    const launchId = `recovery-${input.clientAttemptId}`;
    const result = await spawn(input, async reservation => {
      await reserved({ ...reservation, launchId });
      lane = input.cwd;
      const guard = await prepareStageGitGuard(launchId, lane, execute, h.ports.now());
      agentEnv = { ...clean, ...guard, ...agentPublicationIdentityEnv({ ...process.env, ...clean, ...guard }) };
    });
    return { ...result, launchId, paneId: null };
  };
  const created = await createPipelineFromRequest({ task: "Recover stage publication", repoDir: repo, baseRef: await git(repo, "rev-parse", "HEAD"),
    publication: "remote-branch", stages: stages as never }, h.ports);
  expect(created.error).toBeUndefined();
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(current().cursor, current().stateDetail ?? "").toMatchObject({ stageId: "build", state: "running" });
  const commit = async (text: string) => {
    fs.writeFileSync(path.join(lane, "file.txt"), `${text}\n`);
    await git(lane, "add", "file.txt"); await git(lane, "commit", "-m", text);
    return git(lane, "rev-parse", "HEAD");
  };
  const refuse = () => fs.writeFileSync(path.join(hooks, "pre-push"), '#!/bin/sh\necho "pre-push: touched tests" >&2\necho "NEW file.test.ts: failing assertion" >&2\nexit 1\n', { mode: 0o700 });
  const finish = async (n = 1) => tickPipelines([h.finish(`/codex/stage-${n}.jsonl`, "pass", "implemented")], h.ports);
  return { root, repo, remote, hooks, h, git, commit, finish, refuse, lane: () => lane, execute,
    agentGit: async (cwd: string, ...args: string[]) => {
      const result = await execute("git", args, cwd, agentEnv);
      expect(result.code, result.stderr).toBe(0); return result.stdout.trim();
    },
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test.each([false, true])("a real refused pre-push admits one fresh decision attempt on the current head with refusal output (moved: %s)", async moved => {
  const f = await fixture();
  try {
    let head = await f.commit("implementation"); f.refuse(); await f.finish();
    if (moved) head = await f.commit("producer repair before decision");
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("NEW file.test.ts");
    const original = structuredClone(parked.runs[0]!.attempts[0]!);
    const request = { action: "resolve-decision" as const, clientRequestId: "repair-publication", answer: "Repair the failing test and run the checks again.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) };
    const actor = OPERATOR_PAUSE_RESUME_ACTOR;
    const accepted = await rawPatchPipeline(parked.id, request, f.h.ports, actor);
    expect(accepted.error).toBeUndefined();
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, actor)).replayed).toBe(true);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(current().runs[0]!.attempts[0]).toEqual(original);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(head);
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.prompt).toContain("NEW file.test.ts");
    const repaired = await f.commit("repaired test"); await f.finish(2);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test("a receipted producer commit after acceptance proceeds to review", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    expect(current().state).toBe("needs_decision");
    const repaired = await f.commit("producer repair");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test("a fresh attempt can finish after the controller accepted and committed dirty producer output", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "implementation output\n");
    f.refuse(); await f.finish();
    const accepted = await f.git(f.lane(), "rev-parse", "HEAD");
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(current().runs[0]!.attempts[0]!.launchId!), "commits", accepted))).toBe(false);
    expect(current().state).toBe("needs_decision");
    await rawPatchPipeline(current().id, { action: "resolve-decision", clientRequestId: "dirty-output-retry",
      answer: "Run the stage again.", expectedStageId: "build", expectedAttempt: 1,
      expectedRevision: pipelineRevision(current()) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR);
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await tickPipelines([], f.h.ports);
    const repaired = await f.commit("fresh attempt repair"); await f.finish(2);
    expect(current()).toMatchObject({ state: "running", lastPassedCommit: repaired, publishedCommit: repaired,
      cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test.each(["proved", "unproved"])("a replacement checks the lost attempt's %s commits", async proof => {
  const f = await fixture();
  try {
    const first = await f.commit("lost attempt output");
    const old = current().runs[0]!.attempts[0]!;
    if (proof === "unproved") fs.unlinkSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", first));
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000);
    f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    const head = await f.commit("replacement output"); await f.finish(2);
    if (proof === "proved") {
      expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
    } else {
      expect(current().state).toBe("needs_decision");
      expect(current().stateDetail).toContain(first);
      expect(current().publishedCommit).toBeNull();
    }
  } finally { f.close(); }
});

test("a replacement inherits creation receipts for output adopted from the lost producer's scratch worktree", async () => {
  const f = await fixture();
  try {
    const scratch = path.join(f.root, "scratch-output");
    await f.git(f.lane(), "worktree", "add", "--detach", scratch, "HEAD");
    await f.agentGit(scratch, "commit", "--allow-empty", "-m", "lost producer scratch output");
    const lost = await f.git(scratch, "rev-parse", "HEAD");
    const old = current().runs[0]!.attempts[0]!;
    expect(fs.existsSync(path.join(stageGitReceiptDirectory(old.launchId!), "commits", lost))).toBe(true);
    f.h.durableTurns.set(old.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(old.startedAt!) + 1 });
    f.h.advanceWallClock(600_000); f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([entry(old.agentPath!)], f.h.ports); await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    await f.git(f.lane(), "merge", "--ff-only", lost);
    const head = await f.commit("replacement completes scratch output"); await f.finish(2);
    expect(current().stateDetail).toBeNull();
    expect(current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, cursor: { stageId: "review", state: "pending" } });
  } finally { f.close(); }
});

test.each(["foreign", "main-only", "rewritten", "forged-reflog"])("publication preserves an accepted head when the moved producer head is %s", async shape => {
  const f = await fixture();
  try {
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    let moved: string;
    if (shape === "rewritten") {
      await f.git(f.lane(), "commit", "--amend", "-m", "rewritten implementation");
      moved = await f.git(f.lane(), "rev-parse", "HEAD");
    } else if (shape === "main-only") {
      // A main fast-forward after a previously integrated accepted head must
      // not transfer a producer's pass to a head with no producer receipt.
      await f.git(f.repo, "merge", "--ff-only", accepted);
      await f.git(f.repo, "commit", "--allow-empty", "-m", "main after accepted");
      moved = await f.git(f.repo, "rev-parse", "HEAD");
      await f.git(f.repo, "push", "origin", "main");
      await f.git(f.lane(), "fetch", "origin", "main");
      await f.git(f.lane(), "merge", "--ff-only", moved);
    } else {
      const foreign = path.join(f.root, "foreign");
      await f.git(f.lane(), "worktree", "add", "--detach", foreign, accepted);
      await f.git(foreign, "commit", "--allow-empty", "-m", "foreign suffix");
      moved = await f.git(foreign, "rev-parse", "HEAD");
      const result = await f.execute("git", ["reset", "--hard", moved], f.lane(),
        { GIT_REFLOG_ACTION: shape === "forged-reflog" ? "commit" : undefined });
      expect(result.code).toBe(0);
    }
    expect(moved).not.toBe(accepted);
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    expect(current().lastPassedCommit).toBe(accepted);
    expect(current().publishedCommit).toBeNull();
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(moved);
  } finally { f.close(); }
});

test("a publication decision retains actor, revision, publisher and producer fences", async () => {
  const f = await fixture();
  try {
    await f.commit("implementation"); f.refuse(); await f.finish();
    const parked = current();
    const request = { action: "resolve-decision" as const, clientRequestId: "fenced-repair", answer: "Repair the refusal.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) };
    const before = structuredClone(parked);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports,
      { kind: "agent", role: "builder", conversationId: "conversation_other" })).status).toBe(403);
    expect((await rawPatchPipeline(parked.id, { ...request, expectedRevision: "0".repeat(64) }, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).status).toBe(409);
    f.h.setConversationActive(true);
    expect((await rawPatchPipeline(parked.id, request, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).error).toContain("producer repair turn");
    f.h.setConversationActive(false);
    expect(current()).toEqual(before);
    const publishing = current(); publishing.delivery!.operation!.state = "running"; savePipelines([publishing]);
    const publisherRequest = { ...request, expectedRevision: pipelineRevision(current()) };
    expect((await rawPatchPipeline(parked.id, publisherRequest, f.h.ports, OPERATOR_PAUSE_RESUME_ACTOR)).status).toBe(409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["status", "branch", "head"])("a producer repair head raced at its final %s observation stays unpublished", async observation => {
  const f = await fixture();
  try {
    const accepted = await f.commit("implementation"); f.refuse(); await f.finish();
    const repaired = await f.commit("producer repair");
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    const exec = f.h.ports.exec;
    let finalProof = false, raced = false;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (args[0] === "status" && args[1] === "--porcelain" && args.length === 2) finalProof = true;
      const matches = observation === "status" ? args[0] === "status" && args[1] === "--porcelain" && args.length === 2
        : observation === "branch" ? finalProof && args[0] === "branch" && args[1] === "--show-current"
        : finalProof && args[0] === "rev-parse" && args[1] === "HEAD";
      if (matches && !raced) {
        raced = true;
        await f.git(f.lane(), "reset", "--hard", accepted);
      }
      return exec(command, args, cwd, env, options);
    };
    await tickPipelines([], f.h.ports);
    expect(raced).toBe(true);
    expect(current().lastPassedCommit).toBe(accepted);
    expect(current().publishedCommit).toBeNull();
    expect(current().state).toBe("needs_decision");
    expect(repaired).not.toBe(accepted);
  } finally { f.close(); }
});
