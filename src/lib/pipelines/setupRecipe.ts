import { projectSetupRecipe, reviewSetupRecipe } from "@/lib/projects/setupRecipe";
import path from "node:path";
import { redactBounded } from "@/lib/monitor/redact";
import { executeSetupRecipe, type SetupExecution } from "./setupExecution";
import { withdrawStageToolchainForSetup } from "./git";
import { PIPELINE_MEMORY_DEFAULT_ROLE } from "@/lib/runtime/agentMemorySettings";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "./types";

/** Runs in stage activation after CPU admission. An interrupted start is not
 * replayed: it may have produced effects, so retry needs a fresh attempt. */
export async function preparePipelineSetup(pipeline: Pipeline, stage: PipelineStage, attempt: PipelineStageAttempt,
  now: () => string, persist: () => void | Promise<void>, execute: SetupExecution = executeSetupRecipe,
  signal?: AbortSignal, assertCurrent?: () => void): Promise<void> {
  // An omitted role stores null and resolves through the Builder defaults.
  const isBuilder = (item: PipelineStageAttempt) => item.effectiveRole.roleId === "builder" || item.effectiveRole.roleId === null;
  if (!isBuilder(attempt)) return;
  if (pipeline.runs.some(run => run.attempts.some(item => !item.historical && item.setup?.state === "passed"))) return;
  if (pipeline.runs.some(run => run.attempts.some(item => !item.historical && item !== attempt && isBuilder(item)
    && (item.launchId || item.conversationId || item.agentPath)))) return;
  if (attempt.setup) {
    if (attempt.setup.state === "running") {
      attempt.setup.state = "failed";
      attempt.setup.completedAt = now();
      attempt.setup.stderr ||= "Setup was interrupted before its result was checkpointed; inspect its effects before retrying.";
      await persist();
    }
    throw new Error("project setup was interrupted or failed; inspect its output and retry the stage explicitly");
  }
  const approved = projectSetupRecipe(pipeline.project);
  if (!approved) return;
  attempt.setup = { command: approved.command, cwd: path.resolve(pipeline.worktreeDir, approved.cwd), hash: approved.hash,
    state: "running", startedAt: now(), completedAt: null, code: null, stdout: "", stderr: "" };
  await persist();
  let restoreToolchain = () => {};
  try {
    restoreToolchain = withdrawStageToolchainForSetup(pipeline);
    const reviewed = await reviewSetupRecipe(pipeline.worktreeDir, approved);
    if (reviewed.hash !== approved.hash) throw new Error("project setup content changed; the operator must review and approve it again");
    const authorize = () => {
      assertCurrent?.();
      if (signal?.aborted) throw new Error("project setup cancelled before execution");
      if (projectSetupRecipe(pipeline.project)?.hash !== approved.hash) throw new Error("project setup approval changed before execution");
    };
    authorize();
    await persist();
    authorize();
    const definition = attempt.definition;
    const result = await execute(pipeline.worktreeDir, reviewed,
      (definition ? definition.sandbox : stage.sandbox) ?? "full", signal, authorize, {
        cwd: pipeline.worktreeDir, project: pipeline.project,
        role: attempt.effectiveRole.roleId ?? PIPELINE_MEMORY_DEFAULT_ROLE,
        profile: {
          agentMemoryMaxBytes: definition ? definition.agentMemoryMaxBytes : stage.agentMemoryMaxBytes,
          agentMemoryRoleParams: definition ? definition.role?.params : stage.role?.params,
        },
      });
    assertCurrent?.();
    attempt.setup.code = result.code;
    attempt.setup.stdout = redactBounded(result.stdout, 16_000);
    attempt.setup.stderr = redactBounded(result.stderr, 16_000);
    if (result.code !== 0) throw new Error(`project setup failed (exit ${result.code ?? "unavailable"}); inspect setup output and retry the stage`);
    if (signal?.aborted) throw new Error("project setup cancelled; inspect output before retrying");
    restoreToolchain();
    attempt.setup.state = "passed";
    attempt.setup.completedAt = now();
    await persist();
  } catch (error) {
    try { restoreToolchain(); } catch { /* The failure below is the cause the stage reports. */ }
    attempt.setup.state = "failed";
    attempt.setup.completedAt = now();
    attempt.setup.stderr ||= redactBounded(error instanceof Error ? error.message : String(error), 2000);
    await persist();
    throw error;
  }
}
