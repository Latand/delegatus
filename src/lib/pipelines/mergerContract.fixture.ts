import { realExec } from "@/lib/workflows/provision";
import { prepareStageGitGuard, stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { buildPipeline } from "./store";
import { pipelineRoleLookup, resolvePipelineRole } from "./roles";
import { settleStageAttemptPush } from "./stageAttemptPush";
import type { PipelineStage, PipelineStageAttempt } from "./types";

export const MERGER_START = "2026-11-08T12:00:00.000Z";
export const MERGER_END = "2026-11-08T13:00:00.000Z";

export function mergerStage(input: Partial<PipelineStage> = {}): PipelineStage {
  const definition = { id: "merge", kind: "run" as const, role: { roleId: "merger" as const, params: { prs: `13@${"a".repeat(40)}` } },
    ["prompt"]: "Run the repository batch procedure", next: null, ...input };
  const resolved = resolvePipelineRole(definition, definition.kind, pipelineRoleLookup);
  if (!resolved.role) throw new Error(resolved.error);
  return { ...definition, effectiveRole: resolved.role };
}

/** Bind a real fixture checkout exactly as a merger launch does. Callers own
 * the repository and scratch directories; no installation state is used. */
export async function bindMergerContract(lane: string, launchId: string, source: NodeJS.ProcessEnv) {
  const read = async (...args: string[]) => {
    const result = await realExec("git", args, lane, source);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const stage = mergerStage();
  const pipeline = buildPipeline({ id: launchId, task: "Fixture merger", project: "fixture", repoDir: lane,
    stages: [stage], srcPath: null, srcConversationId: null, now: MERGER_START });
  const head = await read("rev-parse", "HEAD"), remote = await read("remote", "get-url", "origin");
  Object.assign(pipeline, { worktreeDir: lane, branch: await read("symbolic-ref", "--short", "HEAD"),
    baseBranch: "main", baseRef: head, lastPassedCommit: head });
  pipeline.delivery = { active: true, disposition: "owner", ownerId: pipeline.id, publish: "enabled", epoch: 1, journal: [],
    target: { remote, repository: projectIdentityFromRemote(remote, lane)!.project, branch: `refs/heads/${pipeline.branch}` } };
  const attempt: PipelineStageAttempt = { n: 1, state: "running", effectiveRole: stage.effectiveRole, launchId,
    conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: MERGER_START, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null };
  pipeline.runs[0]!.attempts.push(attempt);
  const exec: typeof realExec = (command, args, cwd, env, options) => realExec(command, args, cwd, { ...source, ...env }, options);
  const binding = await prepareStageGitGuard(launchId, lane, exec, MERGER_START, async () => {});
  const env = { ...source, GIT_AUTHOR_DATE: MERGER_START, GIT_COMMITTER_DATE: MERGER_START, ...binding };
  Object.assign(env, agentPublicationIdentityEnv(env));
  return { pipeline, attempt, env, receipt: stageGitReceiptDirectory(launchId),
    settle: () => settleStageAttemptPush(pipeline, attempt, exec, MERGER_END) };
}
