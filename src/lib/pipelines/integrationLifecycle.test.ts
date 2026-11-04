import { expect, test, spyOn, crypto, fs, path, realWorktreeLane, loadPipelines, savePipelines, tickPipelines, finishReported } from "./engine.fixture";
import { reportStageCompletion, startPipelineIntegration } from "./engine";
import { mergeAdmission } from "@/lib/forge/autoMerge";
import { setMergeOnReview, mergeOnReviewSetting } from "@/lib/projects/settings";
import { refreshReservation } from "@/lib/forge/autoRefresh";
import { integrationRecord } from "./integration";

// Real synthetic Git, the real controller and publisher, fake model/forge ports.
// Every agent handle in this fixture belongs to this test.
test("integration real stages report and publish the existing outcome, reconciling a lost push answer", async () => {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `94000001-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
  const box = await realWorktreeLane("durable-integration-lifecycle", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null, onFail: { to: "build", maxRounds: 1, onExhausted: "park" } },
  ], "remote-branch");
  const { h, git, worktree, repo } = box;
  const lookup = h.ports.roleLookup!;
  h.ports.roleLookup = id => lookup(id === "merger" ? "builder" : id);
  const current = () => loadPipelines().find(p => p.id === box.id)!;
  async function finishCurrent() {
    const p = current(), id = p.cursor!.stageId;
    const a = p.runs.find(r => r.stageId === id)!.attempts.at(-1)!;
    expect(a.state, JSON.stringify({ state: p.state, detail: p.stateDetail, cursor: p.cursor })).toBe("running");
    const answer = await reportStageCompletion({ verdict: "pass", summary: "Fixture checks passed" },
      { kind: "agent", role: id.includes("review") ? "reviewer" : "merger", conversationId: a.conversationId! }, h.ports);
    expect(answer.error).toBeUndefined();
    const ended = finishReported(h, a.agentPath!, "pass", "Fixture checks passed");
    for (let n = 0; n < 16; n++) {
      await tickPipelines([ended], h.ports);
      const next = current();
      if (next.state === "completed" || next.state === "needs_decision" || next.cursor?.stageId !== id) break;
    }
    expect(current().state, current().stateDetail ?? "").not.toBe("needs_decision");
    if (current().state !== "completed") {
      for (let n = 0; n < 4; n++) {
        const p = current();
        if (p.runs.find(r => r.stageId === p.cursor?.stageId)?.attempts.at(-1)?.state === "running") break;
        await tickPipelines([], h.ports);
      }
    }
  }
  try {
    await finishCurrent(); await finishCurrent();
    expect(current().state).toBe("completed");
    const history = structuredClone(current().runs);
    const featureHead = current().lastPassedCommit;
    fs.writeFileSync(path.join(repo, "base-config.json"), '{"contract":"object-result"}\n');
    await git(repo, "add", "base-config.json"); await git(repo, "commit", "-m", "Change base configuration"); await git(repo, "push", "origin", "main");
    const base = await git(repo, "rev-parse", "HEAD");
    const p = current();
    p.delivery!.target.pr = 11;
    const at = h.ports.now();
    setMergeOnReview(p.project, true, "operator", new Date(Date.parse(at) - 60_000).toISOString());
    const admission = mergeAdmission(p, Date.parse(at), {
      setting: mergeOnReviewSetting, pullRequestOf: () => ({ repository: "acme/widgets", number: 11 }), hasPublishedPrototype: () => false,
    });
    expect("merge" in admission).toBe(true);
    if (!("merge" in admission)) throw new Error(admission.reason);
    p.merge = admission.merge; p.merge.state = "refreshing";
    p.merge.refresh = refreshReservation(p, base, featureHead, Date.parse(at), "main");
    p.merge.integration = integrationRecord(p, at); savePipelines([p]);
    const admitted = await startPipelineIntegration(p, h.ports);
    expect(admitted.error).toBeUndefined();
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    expect(current().cursor?.stageId).toBe("integration-resolve");
    await git(worktree, "merge", "--no-edit", "origin/main");
    const integratedHead = await git(worktree, "rev-parse", "HEAD");
    let pushes = 0;
    let losePushAnswer = true;
    const exec = h.ports.exec;
    h.ports.exec = async (...args) => {
      const result = await exec(...args);
      if (args[0] === "git" && args[1][0] === "push" && current().cursor?.stageId === "integration-resolve") {
        pushes++;
        if (losePushAnswer) { losePushAnswer = false; return { ...result, code: 1, stderr: "fixture lost push acknowledgement" }; }
      }
      return result;
    };
    await finishCurrent();
    expect(pushes).toBe(1);
    expect(current().cursor?.stageId).toBe("integration-review");
    await finishCurrent();
    expect(current().state).toBe("completed");
    expect(current().lastPassedCommit).toBe(integratedHead);
    expect(current().merge!.integration).toMatchObject({ state: "checking", integratedHead, reviewedHead: integratedHead,
      binding: { stageId: "integration-review", launchId: expect.any(String), conversationId: expect.any(String) } });
    expect(current().merge!.refresh).toBeUndefined();
    expect(current().runs.slice(0, history.length)).toEqual(history);
    expect(loadPipelines()).toHaveLength(1);
    expect(await git(repo, "ls-remote", box.origin, current().delivery!.target.branch)).toContain(integratedHead);
    // Exercise the same stage graph after its previous attempts became history.
    fs.writeFileSync(path.join(repo, "next-base.json"), '{"revision":2}\n');
    await git(repo, "add", "next-base.json"); await git(repo, "commit", "-m", "Advance base again"); await git(repo, "push", "origin", "main");
    const nextBase = await git(repo, "rev-parse", "HEAD");
    const again = current(); again.merge!.state = "refreshing";
    again.merge!.refresh = refreshReservation(again, nextBase, integratedHead, Date.parse(h.ports.now()), "main");
    again.merge!.integration = integrationRecord(again, h.ports.now()); savePipelines([again]);
    expect((await startPipelineIntegration(again, h.ports)).error).toBeUndefined();
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    expect(current().runs.find(r => r.stageId === "integration-resolve")!.attempts.at(-1)!.n).toBe(2);
    await git(worktree, "merge", "--no-edit", "origin/main");
    await finishCurrent(); await finishCurrent();
    expect(current().state).toBe("completed");
    expect(current().merge!.integration!.cycles).toBe(2);
    expect(current().runs.find(r => r.stageId === "integration-resolve")!.attempts[0]!.historical).toBe(true);
    expect(current().runs.slice(0, history.length)).toEqual(history);
    expect(pushes).toBe(2);
    expect(loadPipelines()).toHaveLength(1);
  } finally {
    ids.mockRestore(); savePipelines([]); fs.rmSync(box.root, { recursive: true, force: true });
  }
}, 60_000);
