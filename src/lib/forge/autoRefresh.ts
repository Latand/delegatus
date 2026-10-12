import { createHash } from "node:crypto";
import type { CreatePipelineRequest, Pipeline, PipelineRefresh } from "@/lib/pipelines/types";
import type { MergeOnReviewSetting } from "@/lib/projects/settings";
import { lanePullRequest, mergeEligible } from "./autoMerge";

export type RefreshLineage = { srcPath: string | null; srcConversationId: string | null; srcDeputyConversationId?: string };
export type RefreshOptions = {
  creationRequest: { key: string; digest: string };
  refreshOf: { pipelineId: string; base: string; lineage: RefreshLineage };
};

/** Admission at a fresh conflict read; an old blocked record starts no work. */
export function refreshAdmission(lane: Pipeline, pipelines: readonly Pipeline[], setting: MergeOnReviewSetting): boolean {
  const delivery = lane.delivery;
  const merge = lane.merge;
  if (!setting.enabled || !mergeEligible(lane) || !delivery || delivery.disposition !== "owner" || delivery.active
    || !merge?.prNumber || merge.refresh?.attempt === merge.attempts) return false;
  return !pipelines.some((other) => {
    if (other.id === lane.id || other.hiddenAt || other.state === "completed" || other.state === "closed") return false;
    const target = other.delivery?.target;
    const pr = lanePullRequest(other);
    return (target?.repository === delivery.target.repository && target.branch === delivery.target.branch)
      || (pr?.repository === merge.repository && pr.number === merge.prNumber);
  });
}

export function refreshReservation(lane: Pipeline, base: string, head: string, now: number): PipelineRefresh {
  const attempt = lane.merge!.attempts;
  const key = `auto-refresh:${lane.id}:${attempt}`;
  return { attempt, base, head, key,
    digest: createHash("sha256").update(JSON.stringify([key, base, head, lane.merge!.prNumber])).digest("hex"),
    requestedAt: new Date(now).toISOString(), pipelineId: null };
}

/** Rebuilt solely from the durable reservation so a replay keeps its facts. */
export function refreshRequest(lane: Pipeline): CreatePipelineRequest {
  const merge = lane.merge!;
  const refresh = merge.refresh!;
  const target = lane.delivery!.target;
  const base = lane.baseBranch || "main";
  const facts = `PR #${merge.prNumber}; finished lane ${lane.id}; base ${base} at ${refresh.base}; reviewed head ${refresh.head}; delivery ${target.branch}.`;
  return {
    task: `#${merge.prNumber} ${lane.task.split("\n")[0]!.slice(0, 60)}: merge current ${base}, resolve the conflict, review the resolution only`,
    taskIds: lane.taskIds,
    finishesTask: lane.finishesTaskIds ?? false,
    repoDir: lane.repoDir,
    baseBranch: base,
    delivery: { branch: target.branch, remote: target.remote, pr: merge.prNumber! },
    publication: "remote-branch",
    autoStart: true,
    spec: `Operator authorized automatic refresh: «Что, автообновление? Согласен.»
A content-preserving refresh from main gets one review of the resolution only.
${facts}
Both sides keep their behaviour. Commits use the enforced Delegatus machine identity plus the engine's noreply Co-Authored-By trailer. Never rebase, force-push or call GitHub update-branch. A semantic conflict parks needs_decision with its file:line and @@ hunk. Review only the resolution. The project's checks must pass.`,
    stages: [
      { id: "refresh", kind: "run", role: { roleId: "builder" }, next: "review", onFail: null,
        "prompt": `Merge current origin/${base} into this PR's delivery branch ${target.branch} as a merge commit on top of reviewed head ${refresh.head}. ${facts}
Resolve every conflict so the PR keeps its behaviour and main keeps everything it merged. Never rebase, force-push or call GitHub update-branch. The launch environment enforces the Delegatus machine identity; keep your engine's noreply Co-Authored-By trailer.
Run tests of files the PR touches and files the resolution changed, by explicit path through scripts/gate-slot.sh with isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and a closed LLV_VIEWER_CONTROL_URL.
If resolving a conflict would change either side's behaviour, run git merge --abort and report needs_decision with exactly one finding naming the file:line, the @@ hunk header and the behaviour each resolution would change. This stage has no fail edge. Never guess.` },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, next: null,
        onFail: { to: "fix", maxRounds: 1, onExhausted: "advance" },
        "prompt": `Review only the refresh merge on PR #${merge.prNumber}: git show --remerge-diff of the merge commit on top of ${refresh.head}, plus main's changes to files the PR touches (git diff ${refresh.head}...<merge>^2 -- <those files>). Confirm no hunk of either side was lost or changed in behaviour and focused tests pass on the merged head. The PR's own changes passed review at ${refresh.head}; do not review them again.` },
      { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, next: "review", onFail: null,
        "prompt": `Fix the resolution findings on this PR's delivery branch ${target.branch}. Never rebase, force-push or call update-branch. Your verdict is pass unless blocked.` },
    ],
  };
}
