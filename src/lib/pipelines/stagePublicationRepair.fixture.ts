import { seedForgeCommitAccount } from "@/test-helpers/forgeCommitAccount";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { StageTurnEvidence } from "./durableEvidence";
import type { PipelinePorts } from "./engine";

export async function openPublicationRepairFixtures() {
  // Literal-object helpers append to the process's Git configuration. Clear
  // launch identity/configuration here as well as in each fixture's subprocess.
  const inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  for (const key of Object.keys(inheritedGit)) delete process.env[key];
  const previousState = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-publication-repair-state-"));
  process.env.LLV_STATE_DIR = state;
  seedForgeCommitAccount();
  const { defaultPipelinePorts, tickPipelines, settlePendingStageGit } = await import("./engine");
  const { savePipelines, findPipelineRecord } = await import("./store");
  const { pipelineCorpus } = await import("./fixtures/corpus");
  const { realExec } = await import("@/lib/workflows/provision");
  const { registerPipelineTick } = await import("./controllerSignal");
  const restore = registerPipelineTick(async () => {});
  const close = async () => {
    await (await import("@/lib/links/taskPageWorker")).shutdownTaskPageWorker();
    restore();
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, inheritedGit);
    fs.rmSync(state, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  };

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
    const requests: Array<Parameters<NonNullable<PipelinePorts["resumeSeveredTurn"]>>[0]> = [];
    const checkpoints: unknown[] = [];
    let pushes = 0;
    const ports: PipelinePorts = { ...defaultPipelinePorts(),
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
      publicationRepairProducerState: async () => "idle",
      conversationAgentActive: async () => false, stageHostResident: async () => false, paneAgentAlive: async () => false,
      stageRepairDelivery: async (_conversationId: string, _clientMessageId: string, deadline: number) => ({ operationId: null,
        state: wall >= deadline ? "failed" as const : "unavailable" as const, safeToReplace: false }),
      getFlow: () => null, worktreePresent: () => true,
      spawnAgent: async () => { throw new Error("this fixture cannot launch a real agent"); },
      resumeSeveredTurn: async (input) => {
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
  return { close, fixture, reviewedFixture, defaultPipelinePorts, tickPipelines, settlePendingStageGit, savePipelines, findPipelineRecord, realExec };
}
