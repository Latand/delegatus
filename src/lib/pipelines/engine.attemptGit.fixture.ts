import "./engineEnvironment.fixture";
import { expect, crypto, fs, path, realExec, engineModule, tickPipelines, loadPipelines, savePipelines, finishReported, realWorktreeLane } from "./engine.fixture";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";

export async function detachedAttemptFixture(name: string) {
  const f = await realWorktreeLane(name, [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch");
  const lane = loadPipelines().find(p => p.id === f.id)!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.launchId = `launch-${lane.id}`;
  savePipelines([lane]);
  const receipt = path.join(process.env.LLV_STATE_DIR!, "pipeline-git-attempts",
    crypto.createHash("sha256").update(attempt.launchId!).digest("hex"));
  fs.mkdirSync(receipt, { recursive: true });
  fs.writeFileSync(path.join(receipt, "base"), f.base);
  fs.writeFileSync(path.join(receipt, "start.json"), JSON.stringify({ launchId: attempt.launchId,
    worktree: f.worktree, head: f.base, startedAt: attempt.startedAt }));
  const { agentPublicationIdentityEnv } = await import("@/lib/git/agentPublicationIdentity");
  const source = { ...process.env, HOME: f.root, LLV_STAGE_GIT_RECEIPT: receipt, LLV_STAGE_GIT_WORKTREE: f.worktree };
  const env: NodeJS.ProcessEnv = { ...source, ...agentPublicationIdentityEnv(source),
    GIT_AUTHOR_DATE: new Date(Date.parse(attempt.startedAt!) + 1000).toISOString(),
    GIT_COMMITTER_DATE: new Date(Date.parse(attempt.startedAt!) + 1000).toISOString() };
  const detached = path.join(f.root, "detached");
  await f.git(f.worktree, "worktree", "add", "--detach", detached, f.base);
  const run = async (...args: string[]) => {
    const r = await realExec("git", args, detached, env);
    expect(r.code, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const commit = async (content = "attempt fix\n") => {
    fs.writeFileSync(path.join(detached, "fix.txt"), content);
    await run("add", "fix.txt");
    await run("commit", "-m", "attempt fix");
    return await run("rev-parse", "HEAD");
  };
  const finish = async () => {
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", "Fixed")], f.h.ports);
    return loadPipelines().find(p => p.id === f.id)!;
  };
  return { ...f, lane, attempt, receipt, env, detached, run, commit, finish };
}
