import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { StageTurnEvidence } from "./durableEvidence";
import type { PipelinePorts } from "./engine";

// Literal-object helpers append to the process's Git configuration. Clear
// launch identity/configuration here as well as in each fixture's subprocess.
const inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
for (const key of Object.keys(inheritedGit)) delete process.env[key];
const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-publication-repair-state-"));
process.env.LLV_STATE_DIR = state;
const { defaultPipelinePorts, tickPipelines, settlePendingStageGit } = await import("./engine");
const { savePipelines, findPipelineRecord } = await import("./store");
const { pipelineCorpus } = await import("./fixtures/corpus");
const { realExec } = await import("@/lib/workflows/provision");
const { registerPipelineTick } = await import("./controllerSignal");
const restore = registerPipelineTick(async () => {});
afterAll(() => { restore(); Object.assign(process.env, inheritedGit); fs.rmSync(state, { recursive: true, force: true }); });

function fixture({ emptyAccepted = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-publication-repair-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  let workingRepo = repo;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) env[key] = undefined;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_AUTHOR_DATE: "2026-10-11T04:00:00Z", GIT_COMMITTER_DATE: "2026-10-11T04:00:00Z" });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], { cwd: workingRepo, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("init", "-q", "--bare", remote);
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const deliveryRemote = "https://github.com/example/widgets.git";
  git("config", `url.${remote}.insteadOf`, deliveryRemote);
  git("remote", "add", "origin", deliveryRemote); git("push", "-q", "origin", "main");
  const lane = pipelineCorpus(2, 1)[1]!;
  git("checkout", "-q", "-b", lane.branch);
  fs.mkdirSync(path.join(repo, "src"));
  if (emptyAccepted) git("commit", "-q", "--allow-empty", "-m", "accepted stage");
  else {
    fs.writeFileSync(path.join(repo, "src/work.ts"), "export const work = 1;\n");
    git("add", "."); git("commit", "-q", "-m", "accepted stage");
  }
  const accepted = git("rev-parse", "HEAD");
  const checkout = `${repo}-pipeline-${lane.id}`;
  git("checkout", "-q", "main"); git("worktree", "add", "-q", checkout, lane.branch); workingRepo = checkout;
  Object.assign(lane, { repoDir: repo, worktreeDir: checkout, baseRef: base, baseBranch: "main", state: "running", closedAt: null,
    stateDetail: null, publication: "remote-branch", lastPassedCommit: accepted, publishedCommit: null,
    cursor: { stageId: "build", state: "committing", input: null, activatedBy: null } });
  lane.stages = [lane.stages[0]!]; lane.stages[0]!.next = null; lane.runs = [lane.runs[0]!];
  const attempt = lane.runs[0]!.attempts[0]!;
  Object.assign(attempt, { state: "passed", verdict: { status: "pass", findings: [] },
    conversationId: "conversation_producer", agentPath: "/codex/producer.jsonl", paneId: null,
    startedAt: "2026-10-11T04:00:00.000Z", completedAt: "2026-10-11T04:01:00.000Z" });
  lane.delivery = { target: { repository: "fixture", remote: deliveryRemote, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "enabled", ownerId: lane.id, epoch: 1, active: true, journal: [] };
  savePipelines([lane]);
  let wall = Date.parse("2026-10-11T04:02:00.000Z");
  let turn: StageTurnEvidence = { turn: "terminal", message: { text: "accepted", ts: wall - 60_000 }, lastRecordAt: wall - 60_000 };
  const requests: Array<{ text: string; clientMessageId: string; conversationId: string }> = [];
  const checkpoints: unknown[] = [];
  let pushes = 0;
  const ports = { ...defaultPipelinePorts(),
    exec: async (...args: Parameters<typeof realExec>) => {
      if (args[0] === "git" && args[1][0] === "push") pushes++;
      if (args[0] === "gh") {
        const argv = args[1];
        if (argv[0] !== "pr" || !["list", "view"].includes(argv[1]!)
          || argv[argv.indexOf("--repo") + 1] !== "example/widgets") {
          return { code: 1, stdout: "", stderr: "fixture PR service unavailable" };
        }
        // The verifier reads the head actually published to the bare remote.
        const headRefName = git("symbolic-ref", "--short", "HEAD");
        const headRefOid = git("ls-remote", "origin", `refs/heads/${headRefName}`).split(/\s+/)[0];
        const pr = { number: 17, headRefName, headRefOid, baseRefName: "main", state: "OPEN", isCrossRepository: false };
        return { code: 0, stdout: JSON.stringify(argv[1] === "list" ? [pr] : pr), stderr: "" };
      }
      return realExec(args[0], args[1], args[2], { ...env, ...args[3] }, args[4]);
    },
    now: () => new Date(wall).toISOString(), scheduleTick: () => {},
    durableTurnEvidence: async () => turn, conversationDeliveryOutstanding: () => false,
    conversationAgentActive: async () => false, stageHostResident: async () => false, paneAgentAlive: async () => false,
    stageRepairDelivery: async (_conversationId: string, _clientMessageId: string, deadline: number) => ({ operationId: null,
      state: wall >= deadline ? "failed" as const : "unavailable" as const, safeToReplace: false }),
    getFlow: () => null, worktreePresent: () => true,
    spawnAgent: async () => { throw new Error("this fixture cannot launch a real agent"); },
    resumeSeveredTurn: async (input: { text: string; clientMessageId: string; conversationId: string }) => {
      requests.push(input);
      checkpoints.push(structuredClone(findPipelineRecord(lane.id)!.runs[0]!.attempts[0]));
      turn = { ...turn, turn: "busy" };
      return true;
    },
  };
  return { root, repo: checkout, git, lane, accepted, base, requests, checkpoints, ports,
    hook: path.join(repo, ".git/hooks/pre-push"), pushes: () => pushes,
    current: () => findPipelineRecord(lane.id)!,
    tick: async () => { for (let n = 0; n < 3; n++) await tickPipelines([], ports); },
    endTurn: (text = "repaired") => { wall += 1_000; turn = { turn: "terminal", message: { text, ts: wall }, lastRecordAt: wall }; },
    advance: (ms: number) => { wall += ms; },
    cleanup: () => { savePipelines([]); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("an accepted head refused by pre-push repairs once on its branch, republishes through the hook and completes", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\ngit show HEAD:src/work.ts | grep -q 'work = 2' && exit 0\necho 'src/work.ts:1: the accepted fixture needs repair' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.current().state).toBe("running");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.text).toContain("pre-push: eslint");
    expect(h.checkpoints[0]).toMatchObject({ state: "passed", verdict: { status: "pass" },
      publicationRepair: { sha: h.accepted, detail: expect.stringContaining("src/work.ts:1"), sendingAt: expect.any(String) } });
    expect(h.current().lastPassedCommit).toBe(h.accepted);
    await h.tick();
    expect(h.pushes()).toBe(1);
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.endTurn();
    await h.tick();
    const repaired = h.git("rev-parse", "HEAD");
    expect(repaired).not.toBe(h.accepted);
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: repaired, publishedCommit: repaired });
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.current().runs[0]!.attempts[0]!.verdict).toEqual({ status: "pass", findings: [] });
    expect(h.git("ls-remote", "origin", `refs/heads/${h.lane.branch}`)).toStartWith(repaired);
    expect(h.requests).toHaveLength(1);
    expect(h.pushes()).toBe(2);
  } finally { h.cleanup(); }
});

test.each(["declined", "deadline", "second refusal"])("an unrepairable publication (%s) parks once with the named refusal", async (kind) => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\necho 'PRIVACY GATE: FAIL: fixture content' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.requests).toHaveLength(1);
    if (kind === "deadline") h.advance(20 * 60_000);
    else h.endTurn(kind === "declined" ? '```json\n{"status":"fail","blocked":true,"blockedReason":"outside the producer scope"}\n```' : "no change can answer it");
    await h.tick();
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().runs[0]!.attempts[0]!).toMatchObject({ state: "passed", verdict: { status: "pass" } });
    const detail = h.current().stateDetail!;
    // The first line keeps the cause and the action a person takes.
    expect(detail.split("\n")[0]).toStartWith('publishing the passed stage: the repository\'s pre-push hook failed in its "privacy" phase');
    expect(detail).toContain("PRIVACY GATE: FAIL: fixture content");
    expect(detail).toContain(kind === "declined" ? "outside the producer scope" : kind === "deadline" ? "delivery unknown failed" : "privacy");
    await h.tick();
    expect(h.requests).toHaveLength(1);
    expect(h.pushes()).toBe(kind === "second refusal" ? 2 : 1);
  } finally { h.cleanup(); }
});

test("publication repair can rewrite its own refused metadata without restoring the refused commit as a parent", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\ntest \"$(git log -1 --format=%s)\" = 'safe metadata' && exit 0\necho 'identity check refused the accepted commit message' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.requests).toHaveLength(1);
    h.git("commit", "-q", "--amend", "-m", "safe metadata");
    h.endTurn(); await h.tick();
    expect(h.current().state).toBe("completed");
    expect(h.current().lastPassedCommit).toBe(h.git("rev-parse", "HEAD"));
    expect(h.git("rev-list", "HEAD").split("\n")).not.toContain(h.accepted);
    expect(h.git("rev-parse", "HEAD^" )).toBe(h.base);
    expect(h.pushes()).toBe(2);
  } finally { h.cleanup(); }
});

function reviewedFixture(h: ReturnType<typeof fixture>, budgetRecheck = false) {
  const lane = h.current();
  const review = pipelineCorpus(2, 1)[1]!.stages[1]!;
  review.kind = "run";
  review.onFail = { to: "build", maxRounds: 2, onExhausted: "advance" };
  lane.stages[0]!.next = "review"; lane.stages.push(review);
  const attempt = structuredClone(lane.runs[0]!.attempts[0]!);
  Object.assign(attempt, { effectiveRole: review.effectiveRole, conversationId: "conversation_reviewer", agentPath: "/codex/reviewer.jsonl",
    reviewHeadSha: h.accepted, reviewedHead: h.accepted,
    activatedBy: { stageId: "build", attempt: 1, edge: "pass", ...(budgetRecheck ? { budgetRecheck: true } : {}) } });
  lane.runs.push({ stageId: "review", attempts: [attempt] });
  lane.cursor = { stageId: "review", state: "committing", input: "accepted output", activatedBy: attempt.activatedBy };
  savePipelines([lane]);
}

test.each([false, true])("a repaired reviewed tree returns to its exact-head gate and retains its budget activation (%s)", async (budgetRecheck) => {
  const h = fixture();
  try {
    reviewedFixture(h, budgetRecheck);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\ngit show HEAD:src/work.ts | grep -q 'work = 2' && exit 0\necho 'src/work.ts:1: repair required' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.conversationId).toBe("conversation_producer");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.endTurn();
    // Settle via the public Git executor without launching the pending gate.
    await settlePendingStageGit(h.ports);
    const ready = h.current();
    expect(ready.cursor).toMatchObject({ stageId: "review", state: "committing" });
    const { publishPipelineBranch } = await import("./git");
    expect((await publishPipelineBranch(ready, h.ports.exec, { acceptedSha: ready.lastPassedCommit })).ok).toBe(true);
    await settlePendingStageGit(h.ports);
    const pending = h.current();
    expect(pending.state).toBe("running");
    expect(pending.cursor).toMatchObject({ stageId: "review", state: "pending",
      activatedBy: { stageId: "build", attempt: 1, edge: "pass", ...(budgetRecheck ? { budgetRecheck: true } : {}) } });
    expect(pending.runs[1]!.attempts[0]!).toMatchObject({ state: "passed", reviewHeadSha: h.accepted, reviewedHead: h.accepted });
    expect(pending.lastPassedCommit).not.toBe(h.accepted);
    expect(pending.publishedCommit).toBe(pending.lastPassedCommit);
  } finally { h.cleanup(); }
});

test("a repair commit refusal remains consumed if final park settlement is lost", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    const commitHook = path.join(h.root, "repo/.git/hooks/pre-commit");
    const marker = path.join(h.root, "commit-calls");
    fs.writeFileSync(commitHook, `#!/bin/sh\necho called >> '${marker}'\necho 'pre-commit: repair still invalid' >&2\nexit 1\n`, { mode: 0o700 });
    // Replay this settlement before a controller tick can start a new producer.
    h.endTurn(); await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().runs[0]!.attempts[0]!.publicationRepair?.outcome).toMatchObject({ status: "rejected", reason: expect.stringContaining("repair still invalid") });
    // Bun's toMatchObject writes its matchers into the received object, so clear the park on a fresh read.
    const rejected = h.current();
    rejected.state = "running"; rejected.stateDetail = null;
    rejected.runs[0]!.attempts[0]!.state = "passed";
    savePipelines([rejected]);
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail!.split("\n")[0]).toStartWith('publishing the passed stage: the repository\'s pre-push hook failed in its "eslint" phase');
    expect(h.current().stateDetail).toContain("repair still invalid");
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { h.cleanup(); }
});

test("publication repair refuses a foreign checkout before committing any of its work", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    h.git("checkout", "-q", "-b", "foreign");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    Object.assign(h.ports, { engineReadiness: undefined, resolveProjectSpawn: undefined,
      structuredDeliveryPublication: () => "ready", cpuPressureHold: () => null });
    h.endTurn(); await h.tick();
    expect(h.current().state).toBe("needs_decision");
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
    expect(h.git("status", "--porcelain")).toContain("src/work.ts");
    expect(h.current().stateDetail!.split("\n")[0]).toStartWith('publishing the passed stage: the repository\'s pre-push hook failed in its "eslint" phase');
    expect(h.current().stateDetail).toContain("not on its pipeline or delivery branch");
  } finally { h.cleanup(); }
});

test("an explicit publication retry can recover a declined repair without another repair turn", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"the hook requires an infrastructure fix"}\n```');
    await h.tick();
    expect(h.current().state).toBe("needs_decision");
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: h.accepted, publishedCommit: h.accepted });
    expect(h.requests).toHaveLength(1);
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
  } finally { h.cleanup(); }
});

test("a refusal of an accepted head that changes no files retries three times and parks without a repair turn", async () => {
  const h = fixture({ emptyAccepted: true });
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: Linux tests' >&2\necho '(fail) x' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    for (const minutes of [1, 5, 15]) {
      expect(h.current().state).toBe("running");
      h.advance(minutes * 60_000);
      await h.tick();
    }
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"nothing to repair"}\n```');
    await h.tick();
    const current = h.current();
    expect(current.state).toBe("needs_decision");
    expect(current.stateDetail!.split("\n")[0]).toBe("publishing the passed stage: the repository's pre-push hook failed in its \"Linux tests\" phase"
      + " (exit 1, 1 failing test, first: x). The stage changed no files; retried 3 times, so the cause is on the base branch or in the hook itself: fix it there, then retry-stage.");
    expect(current.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
    expect(h.requests).toHaveLength(0);
    expect(h.pushes()).toBe(4);
  } finally { h.cleanup(); }
});

test.each(["unreserved", "failed", "gone", "unavailable", "completed-gone", "running", "busy", "changed", "conflict"] as const)("retry-stage preserves the accepted head and replaces an unreachable producer: %s", async shape => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\necho 'src/work.ts:1: repair required' >&2\nexit 1\n", { mode: 0o700 });
    h.ports.resumeSeveredTurn = async () => false;
    await h.tick();
    h.advance(21 * 60_000);
    // Stop at the publication park; the next full tick now auto-repairs it.
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    const original = structuredClone(h.current().runs[0]!.attempts[0]!);
    if (shape === "gone") h.git("commit", "-q", "--allow-empty", "-m", "producer repair before host loss");
    const retainedHead = h.git("rev-parse", "HEAD");
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(h.lane.id, { action: "override-stage", stageId: "build", prompt: "Repair the named publication failure using the current instructions." }, h.ports)).error).toBeUndefined();
    const restarted = spawnSync(process.execPath, ["-e", `
      const { defaultPipelinePorts, patchPipeline } = await import("./src/lib/pipelines/engine");
      const ports = { ...defaultPipelinePorts(), now: () => "2026-10-11T04:23:00.000Z",
        conversationAgentActive: async () => ${shape === "running" ? "true" : ["gone", "unavailable", "completed-gone", "conflict"].includes(shape) ? "false" : "null"},
        publicationRepairProducerGone: async () => ${["gone", "unavailable", "completed-gone"].includes(shape) ? "true" : "null"},
        conversationTurnInterrupted: async () => ${["gone", "unavailable"].includes(shape) ? JSON.stringify("dead") : "null"},
        conversationDeliveryOutstanding: () => ${shape === "conflict"},
        durableTurnEvidence: async () => ({ turn: "${shape === "busy" ? "busy" : "terminal"}",
          lastRecordAt: Date.parse("${shape === "busy" ? "2026-10-11T04:23:00.000Z" : "2026-10-11T04:01:00.000Z"}"),
          message: { text: "accepted", ts: Date.parse("2026-10-11T04:01:00.000Z") } }),
        stageRepairDelivery: async () => {
          ${shape === "changed" ? `const { findPipelineRecord, savePipelines } = await import("./src/lib/pipelines/store");
          const lane = findPipelineRecord(${JSON.stringify(h.lane.id)});
          lane.runs[0].attempts[0].startedAt = "2026-10-11T04:00:01.000Z";
          savePipelines([lane]);` : ""}
          return { operationId: ${["failed", "conflict"].includes(shape) ? JSON.stringify("failed-repair") : "null"},
            state: "${["failed", "conflict"].includes(shape) ? "failed" : ["gone", "unavailable"].includes(shape) ? "unavailable" : "unreserved"}", safeToReplace: ${shape !== "conflict"} };
        },
      };
      console.log(JSON.stringify(await patchPipeline(${JSON.stringify(h.lane.id)}, { action: "retry-stage" }, ports)));
    `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(restarted.status, restarted.stderr).toBe(0);
    const answer = JSON.parse(restarted.stdout);
    if (shape === "running" || shape === "busy" || shape === "changed" || shape === "conflict") {
      expect(answer.error).toContain("may still be running");
      expect(h.current().cursor?.state).toBe("committing");
      return;
    }
    expect(answer.error).toBeUndefined();
    const next = h.current();
    expect(next.cursor).toMatchObject({ stageId: "build", state: "pending" });
    expect(next.cursor!.input).toContain("src/work.ts:1: repair required");
    expect(next.stages[0]!.prompt).toContain("current instructions");
    expect(next.runs[0]!.attempts).toHaveLength(2);
    expect(next.runs[0]!.attempts[1]!).toMatchObject({ n: 2, state: "pending", input: next.cursor!.input });
    expect(next.lastPassedCommit).toBe(h.accepted);
    expect(h.git("rev-parse", "HEAD")).toBe(retainedHead);
    expect(h.git("merge-base", h.accepted, retainedHead)).toBe(h.accepted);
    expect(next.runs[0]!.attempts[0]!.report).toEqual(original.report);
    expect(next.runs[0]!.attempts[0]!.verdict).toEqual(original.verdict);
    expect(h.pushes()).toBe(1);
    let spawnedPrompt = "";
    const spawnPorts: PipelinePorts = { ...h.ports, engineReadiness: undefined, resolveProjectSpawn: undefined,
      cpuPressureHold: () => null,
      structuredDeliveryPublication: () => "ready",
      spawnAgent: async (input, onReserved) => {
        spawnedPrompt = input.prompt;
        await onReserved({ launchId: "replacement-launch", conversationId: "conversation_replacement", accountId: null });
        return { launchId: "replacement-launch", conversationId: "conversation_replacement", sessionId: "replacement-session",
          paneId: null, transcript: path.join(h.root, "replacement.jsonl"), accountId: null };
      },
    };
    for (let n = 0; n < 3 && !spawnedPrompt; n++) await tickPipelines([], spawnPorts);
    expect(spawnedPrompt, h.current().stateDetail ?? "replacement was not dispatched").toContain("Repair the named publication failure using the current instructions.");
    expect(spawnedPrompt).toContain("src/work.ts:1: repair required");
    expect(h.current().runs[0]!.attempts).toHaveLength(2);
  } finally { h.cleanup(); }
});

test("the original stage Git binding survives a restart but a passed attempt cannot rehost it", async () => {
  const h = fixture();
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { prepareStageGitGuard } = await import("@/lib/git/stageAttemptGuard");
  const registryFile = path.join(h.root, "registry.json");
  const registry = new AgentRegistry(registryFile);
  try {
    const conversation = registry.ensureForkedConversation("codex", path.join(h.root, "producer.jsonl"), null, emptyLaunchProfile({ cwd: h.repo }));
    registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: h.lane.id, stageId: "build", round: 1,
      role: "builder", slot: "build:1", stageOrder: 0, parentConversationId: null });
    const lane = h.current();
    Object.assign(lane.runs[0]!.attempts[0]!, { state: "running", launchId: "rehost-producer", conversationId: conversation.id });
    savePipelines([lane]);
    await prepareStageGitGuard("rehost-producer", h.repo, h.ports.exec, h.ports.now(), async () => {});
    registry.close();
    for (const stageState of ["running", "passed"] as const) {
      const lane = h.current(); lane.runs[0]!.attempts[0]!.state = stageState; savePipelines([lane]);
      const child = spawnSync(process.execPath, ["-e", `
        const { AgentRegistry } = await import("./src/lib/agent/registry");
        const { stageGitEnvironment } = await import("./src/lib/runtime/stageGitEnvironment");
        const registry = new AgentRegistry(${JSON.stringify(registryFile)});
        try {
          const env = await stageGitEnvironment(registry, ${JSON.stringify(conversation.id)}, "resume-operation", ${JSON.stringify(h.repo)});
          console.log(JSON.stringify({ restored: !!env.LLV_STAGE_GIT_RECEIPT }));
        } catch (error) { console.log(JSON.stringify({ error: error.message })); }
        finally { registry.close(); }
      `], { env: process.env, cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(stageState === "running" ? { restored: true }
        : { error: "stage Git rehost cannot prove its original attempt" });
    }
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
  } finally { registry.close(); h.cleanup(); }
});
