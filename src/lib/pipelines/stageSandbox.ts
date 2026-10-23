import type { EffectivePipelineRole, PipelineAccess, PipelineSandbox } from "./types";

export type PipelineStageRuntimeProfile = {
  agentMemoryRoleParams?: Record<string, string | number>;
  agentMemoryMaxBytes?: number | null;
  /** Repository mutation policy enforced by pipeline settlement. */
  access: PipelineAccess;
  /** Engine tool/network boundary applied while the stage runs. */
  sandbox: PipelineSandbox;
};

/** Freeze both independent access axes at the stage-to-host boundary. */
export function pipelineStageRuntimeProfile(stage: {
  role?: { params?: Record<string, string | number> };
  agentMemoryMaxBytes?: number | null;
  sandbox?: PipelineSandbox;
  effectiveRole: Pick<EffectivePipelineRole, "access">;
}): PipelineStageRuntimeProfile {
  return {
    ...(stage.role?.params ? { agentMemoryRoleParams: stage.role.params } : {}),
    ...(stage.agentMemoryMaxBytes !== undefined ? { agentMemoryMaxBytes: stage.agentMemoryMaxBytes } : {}),
    access: stage.effectiveRole.access,
    sandbox: stage.sandbox ?? "full",
  };
}

/** Resolve the host/tool boundary independently from the stage's repository
    mutation policy. Requiring both fields at this seam makes that separation
    explicit: a read-only role still defaults to full host access. */
export function pipelineStageSandbox(stage: {
  sandbox?: PipelineSandbox;
  effectiveRole: Pick<EffectivePipelineRole, "access">;
}): PipelineSandbox {
  return pipelineStageRuntimeProfile(stage).sandbox;
}
