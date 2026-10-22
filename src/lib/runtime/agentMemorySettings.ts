import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import { projectAgentMemoryMax } from "@/lib/projects/settings";
import { configForParams, listRoles } from "@/lib/roles/registry";
import { projectForCwd } from "@/lib/scanner/describe";
import type { AgentMemoryScopes, AgentMemoryCap } from "./agentMemoryConfig";
import { agentMemoryCeiling, type AgentMemoryPlan } from "./agentMemory";
import { procBackend } from "@/lib/proc";

/** Re-read scoped defaults at the process launch boundary, including resumes. */
export function agentMemoryScopes(input: {
  cwd: string; project?: string | null; role?: string | null;
  profile?: Pick<LaunchProfile, "agentMemoryMaxBytes" | "agentMemoryRoleParams"> | null;
}): AgentMemoryScopes {
  const project = input.project ?? projectForCwd(input.cwd);
  const role = input.role ? listRoles().find(row => row.id === input.role) : null;
  return { project: project ? projectAgentMemoryMax(project) : null,
    role: role ? configForParams(role, input.profile?.agentMemoryRoleParams ?? {}).agentMemoryMaxBytes : null,
    stage: input.profile?.agentMemoryMaxBytes };
}

export function agentMemoryCapForPlan(plan: AgentMemoryPlan | null): AgentMemoryCap {
  return plan?.cap ?? { limitBytes: null, requestedBytes: null, source: "automatic", clamped: false, enforced: false,
    note: "Agent memory containment is off or unavailable." };
}

/** Prediction only: no scope probes, slice mutation or admission on a read. */
export function previewAgentMemoryCap(input: Parameters<typeof agentMemoryScopes>[0], liveAgents: number): AgentMemoryCap {
  const total = procBackend.systemMemory()?.ramTotal;
  const mode = process.env.DELEGATUS_AGENT_MEMORY ?? process.env.LLV_AGENT_MEMORY;
  if (!total || mode === "off" || process.platform === "win32") return agentMemoryCapForPlan(null);
  const limits = agentMemoryCeiling(total, liveAgents, {
    LLV_AGENT_MEMORY_MAX: process.env.DELEGATUS_AGENT_MEMORY_MAX ?? process.env.LLV_AGENT_MEMORY_MAX,
    LLV_AGENT_MEMORY_RESERVE: process.env.DELEGATUS_AGENT_MEMORY_RESERVE ?? process.env.LLV_AGENT_MEMORY_RESERVE,
  }, agentMemoryScopes(input));
  return { limitBytes: limits.limitBytes, requestedBytes: limits.requestedBytes ?? null,
    source: limits.source ?? "automatic", clamped: limits.clamped ?? false, enforced: false,
    note: limits.clamped ? "Preview: requested memory cap clamped to the shared machine budget." : "Preview; the effective cap is recorded at launch." };
}
