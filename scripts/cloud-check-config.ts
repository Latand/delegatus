import path from "node:path";
import type { AccountContext, ProjectSpawnResolution } from "../src/lib/accounts/contracts";
import type { Pipeline } from "../src/lib/pipelines/types";

export interface CloudCheckConfig { account: AccountContext; environmentId: string; assertCurrent?: () => void }
export interface CloudCheckConfigSources {
  lane(id: string): Pipeline | null;
  project(root: string): string | null;
  environment(project: string): string;
  preparedEnvironment?(project: string, accountId: string, lane: Pipeline | null): string;
  hasPreparedEnvironment?(project: string): boolean;
  account(project: string, requestedId: string | null): ProjectSpawnResolution;
}

/** Share stage execution's project environment and account-pool selection.
 * A missing setup never supplies evidence of a service outage. */
export function selectCloudCheckConfig(root: string, laneId: string | undefined, stageId: string | undefined,
  sources: CloudCheckConfigSources): CloudCheckConfig | null {
  const lane = laneId ? sources.lane(laneId) : null;
  if (laneId && (!lane || path.resolve(lane.worktreeDir) !== path.resolve(root))) throw new Error("Cloud checks require the current lane checkout");
  const stage = stageId ? lane?.stages.find(stage => stage.id === stageId) : undefined;
  if (stageId && !stage) throw new Error("Cloud checks require a current lane stage");
  const project = lane?.project ?? sources.project(root);
  if (!project) return null;
  // A Claude producer does not name a Codex account. Codex producers preserve
  // their explicit choice; automatic choices stay within the project's pool.
  const attempt = stage && lane?.runs?.find(run => run.stageId === stage.id)?.attempts.at(-1);
  const frozen = attempt?.cloud?.taskId ? attempt.cloud : null;
  const legacy = sources.environment(project);
  if (!frozen?.environmentId && !legacy && (!sources.preparedEnvironment || sources.hasPreparedEnvironment?.(project) === false)) return null;
  if (!frozen && !sources.preparedEnvironment && legacy && !/^(?:[A-Za-z0-9_-]+~)?asenvcfg_[A-Za-z0-9_-]+$/.test(legacy)) {
    throw new Error("Cloud checks require the project's Codex Cloud environment");
  }
  const requestedId = stage?.effectiveRole.engine === "codex" ? frozen?.accountId ?? attempt?.accountId ?? stage.account ?? null : null;
  const selected = sources.account(project, requestedId);
  if (selected.kind !== "available") throw new Error(`Cloud checks account ${selected.kind}`);
  const environmentId = frozen?.environmentId ?? sources.preparedEnvironment?.(project, selected.account.accountId, lane) ?? legacy;
  if (!environmentId) return null;
  if (!/^(?:[A-Za-z0-9_-]+~)?asenvcfg_[A-Za-z0-9_-]+$/.test(environmentId)) throw new Error("Cloud checks require the project's Codex Cloud environment");
  return { environmentId, account: selected.account, assertCurrent: () => {
    const current = selectCloudCheckConfig(root, laneId, stageId, sources);
    if (!current || current.environmentId !== environmentId || current.account.accountId !== selected.account.accountId
      || current.account.home !== selected.account.home) throw new Error("Cloud checks configuration changed");
  } };
}

export async function cloudCheckConfig(root: string, laneId?: string, stageId?: string): Promise<CloudCheckConfig | null> {
  // This hook reads the installation's managed settings before choosing checks.
  // Claim before importing any module that resolves those settings at load.
  if (process.env.LLV_GATE_STATE_DIR) process.env.LLV_STATE_DIR = process.env.LLV_GATE_STATE_DIR;
  await import("../src/lib/state/owner/tool");
  const [{ findPipelineRecord }, { projectInfoFromCwd }, { codexCloudEnvironmentId, pipelineStageRuntime }, { accountManager }, environments, { githubRepositoryOfRemote }] = await Promise.all([
    import("../src/lib/pipelines/store"), import("../src/lib/scanner/describe"),
    import("../src/lib/projects/settings"), import("../src/lib/accounts/manager"),
    import("../src/lib/projects/codexCloudEnvironments"), import("../src/lib/forge/workLinks"),
  ]);
  return selectCloudCheckConfig(root, laneId, stageId, {
    lane: findPipelineRecord, project: root => projectInfoFromCwd(root)?.project ?? null,
    environment: codexCloudEnvironmentId,
    hasPreparedEnvironment: project => pipelineStageRuntime(project) === "codex-cloud"
      && environments.readCloudEnvironmentBindings(project).bindings.some(row => row.state === "ready" && !!row.environmentId),
    preparedEnvironment: (project, accountId, lane) => {
      const repo = githubRepositoryOfRemote(lane?.delivery?.target.remote);
      if (repo && lane?.baseBranch) return environments.preparedCloudEnvironmentId(project, accountId, repo, lane.baseBranch);
      // A direct check has no frozen lane ref; it may use only a validated saved row.
      const choice = environments.cloudEnvironmentSelection(project, accountId);
      if (choice.environmentId) return choice.environmentId;
      return environments.readCloudEnvironmentBindings(project, { accountId }).bindings.find(row => row.state === "ready" && row.kind === "automatic")?.environmentId ?? "";
    },
    account: (project, requestedId) => accountManager.resolveProjectSpawn("codex", { project, requestedId, model: "gpt-6.1-sol", requireCapacity: false }),
  });
}
