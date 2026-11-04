import { expect, test, spyOn, crypto, fs, path, realWorktreeLane, loadPipelines, savePipelines, tickPipelines, finishReported } from "./engine.fixture";
import { reportStageCompletion, startPipelineIntegration } from "./engine";
import { mergeAdmission, mergeEligible } from "@/lib/forge/autoMerge";
import { planBaseUpdate } from "@/lib/forge/baseUpdate";
import { setMergeOnReview, mergeOnReviewSetting } from "@/lib/projects/settings";
import { refreshReservation } from "@/lib/forge/autoRefresh";
import { integrationRecord } from "./integration";

type Box = Awaited<ReturnType<typeof realWorktreeLane>>;
const current = (box: Box) => loadPipelines().find(p => p.id === box.id)!;

async function finishCurrent(box: Box) {
  const { h } = box, p = current(box), id = p.cursor!.stageId;
  const a = p.runs.find(r => r.stageId === id)!.attempts.at(-1)!;
  expect(a.state, p.stateDetail ?? "").toBe("running");
  const answer = await reportStageCompletion({ verdict: "pass", summary: "Fixture checks passed" },
    { kind: "agent", role: id.includes("review") ? "reviewer" : "builder", conversationId: a.conversationId! }, h.ports);
  expect(answer.error).toBeUndefined();
  const ended = finishReported(h, a.agentPath!, "pass", "Fixture checks passed");
  for (let n = 0; n < 16; n++) {
    await tickPipelines([ended], h.ports);
    const next = current(box);
    if (next.state === "completed" || next.state === "needs_decision" || next.cursor?.stageId !== id) break;
  }
  expect(current(box).state, current(box).stateDetail ?? "").not.toBe("needs_decision");
  for (let n = 0; n < 4 && current(box).state !== "completed"; n++) {
    const next = current(box);
    if (next.runs.find(r => r.stageId === next.cursor?.stageId)?.attempts.at(-1)?.state === "running") break;
    await tickPipelines([], h.ports);
  }
}

const boundaries = ["clean", "dirty", "ignored", "remote-moved", "revoked", "remote-moved-during-read", "revoked-during-read"] as const;
for (const boundary of boundaries) {
  test(`mechanical integration starts directly at review and preserves ${boundary} boundary`, async () => {
    let sequence = 0;
    const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `9400000${boundaries.indexOf(boundary) + 2}-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
    const box = await realWorktreeLane("mechanical-integration", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null,
        onFail: { to: "build", maxRounds: 1, onExhausted: "park" } },
    ], "remote-branch");
    const { h, git, repo, worktree } = box;
    const lookup = h.ports.roleLookup!;
    h.ports.roleLookup = id => lookup(id === "merger" ? "builder" : id);
    try {
      fs.writeFileSync(path.join(worktree, "feature.ts"), "export const feature = true;\n");
      await git(worktree, "add", "feature.ts"); await git(worktree, "commit", "-m", "Implement feature");
      await finishCurrent(box); await finishCurrent(box);
      const p = current(box), history = structuredClone(p.runs), featureHead = p.lastPassedCommit;
      expect(p.delivery!.target.branch).toBe(`refs/heads/${p.branch}`);
      fs.writeFileSync(path.join(repo, "base-config.json"), '{"contract":"object-result"}\n');
      await git(repo, "add", "base-config.json"); await git(repo, "commit", "-m", "Advance base"); await git(repo, "push", "origin", "main");
      const base = await git(repo, "rev-parse", "HEAD"), at = h.ports.now();
      const planned = await planBaseUpdate({ repoDir: repo, remote: "origin", head: featureHead, base, at }, h.ports.exec);
      expect(planned.kind).toBe("commit");
      if (planned.kind !== "commit") throw new Error("fixture needs a clean mechanical merge");
      await git(repo, "push", "origin", `${planned.commit}:${p.delivery!.target.branch}`);
      setMergeOnReview(p.project, true, "operator", new Date(Date.parse(at) - 60_000).toISOString());
      p.delivery!.target.pr = 11;
      const admission = mergeAdmission(p, Date.parse(at), {
        setting: mergeOnReviewSetting, pullRequestOf: () => ({ repository: "acme/widgets", number: 11 }), hasPublishedPrototype: () => false,
      });
      if (!("merge" in admission)) throw new Error(admission.reason);
      p.merge = admission.merge; p.merge.state = "refreshing";
      p.merge.updates = [{ requestedAt: at, head: planned.commit, commit: planned.commit, base }];
      p.merge.refresh = refreshReservation(p, base, featureHead, Date.parse(at), "main");
      p.merge.integration = integrationRecord(p, at);
      p.merge.integration.expectedRemoteHead = planned.commit;
      p.merge.integration.integratedHead = planned.commit;
      savePipelines([p]);
      const spawnedBefore = h.spawnInputs.length;
      expect((await startPipelineIntegration(p, h.ports)).error).toBeUndefined();
      expect(current(box).cursor?.stageId).toBe("integration-review");
      expect(mergeEligible(current(box))).toBe(false);
      if (boundary === "dirty") fs.writeFileSync(path.join(worktree, "feature.ts"), "operator draft\n");
      if (boundary === "ignored") {
        const exclude = await git(worktree, "rev-parse", "--git-path", "info/exclude");
        fs.mkdirSync(path.dirname(path.resolve(worktree, exclude)), { recursive: true });
        fs.appendFileSync(path.resolve(worktree, exclude), "\nbase-config.json\n");
        fs.writeFileSync(path.join(worktree, "base-config.json"), "operator scratch\n");
      }
      if (boundary === "remote-moved") {
        const moved = await git(repo, "commit-tree", `${planned.commit}^{tree}`, "-p", planned.commit, "-m", "Unrelated remote writer");
        await git(repo, "push", "origin", `${moved}:${p.delivery!.target.branch}`);
      }
      if (boundary === "revoked") setMergeOnReview(p.project, false, "operator", at);
      if (boundary === "remote-moved-during-read" || boundary === "revoked-during-read") {
        const provisionExec = h.ports.provisionExec!;
        let changed = false;
        h.ports.provisionExec = async (...args) => {
          const result = await provisionExec(...args);
          if (!changed && args[0] === "git" && args[1][0] === "ls-remote") {
            changed = true;
            if (boundary === "revoked-during-read") setMergeOnReview(p.project, false, "operator", at);
            else {
              const moved = await git(repo, "commit-tree", `${planned.commit}^{tree}`, "-p", planned.commit, "-m", "Concurrent remote writer");
              await git(repo, "push", "origin", `${moved}:${p.delivery!.target.branch}`);
            }
          }
          return result;
        };
      }
      await tickPipelines([], h.ports); await tickPipelines([], h.ports);
      if (boundary === "clean") {
        expect(await git(worktree, "rev-parse", "HEAD")).toBe(planned.commit);
        expect(fs.readFileSync(path.join(worktree, "base-config.json"), "utf8")).toBe('{"contract":"object-result"}\n');
        expect(h.spawnInputs.slice(spawnedBefore).map(input => input.membership.slot)).toEqual(["integration-review:1"]);
        expect(mergeEligible(current(box))).toBe(false);
        await finishCurrent(box);
        expect(current(box).state).toBe("completed");
        expect(mergeEligible(current(box))).toBe(true);
        expect(current(box).merge!.integration!.reviewedHead).toBe(planned.commit);
      } else {
        expect(h.spawnInputs.length).toBe(spawnedBefore);
        expect(await git(worktree, "rev-parse", "HEAD")).toBe(featureHead);
        if (boundary === "dirty") expect(fs.readFileSync(path.join(worktree, "feature.ts"), "utf8")).toBe("operator draft\n");
        if (boundary === "ignored") expect(fs.readFileSync(path.join(worktree, "base-config.json"), "utf8")).toBe("operator scratch\n");
      }
      expect(current(box).runs.slice(0, history.length)).toEqual(history);
      expect(loadPipelines()).toHaveLength(1);
    } finally {
      ids.mockRestore(); savePipelines([]); fs.rmSync(box.root, { recursive: true, force: true });
    }
  }, 60_000);
}
