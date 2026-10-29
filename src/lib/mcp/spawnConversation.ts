import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { canonicalProject } from "@/lib/projects/aliases";
import { spawnParentForCaller } from "@/lib/orchestrator/deputies";
import type { CallerAttribution } from "./bindings";
import { agentRegistry, registryReceiptsForConversation } from "@/lib/agent/registry";

/** A targeted read of accepted launch facts, with no admission or recovery. */
export function spawnConversation(conversationId: string, resolveAccess: () => {
  caller: CallerAttribution;
  project: string | null;
  requestedProject?: string;
}) {
  const snapshot = agentRegistry().livenessConversationSnapshot(conversationId);
  const receipt = registryReceiptsForConversation(snapshot, conversationId)
    .filter(row => !row.rejection)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.launchId.localeCompare(a.launchId))[0];
  if (!receipt) return null;
  const access = resolveAccess();
  if (access.caller.kind === "unidentified") return null;
  const callerParent = access.caller.conversationId === null ? null : spawnParentForCaller(access.caller.conversationId);
  if (receipt.parentConversationId !== null
    ? receipt.parentConversationId !== callerParent
    : access.caller.kind !== "gateway") return null;
  const project = conversationProjectKey({ project: receipt.explicitProject }, receipt.launchProfile, { cwd: receipt.cwd });
  if (access.caller.kind !== "gateway" && (!access.project || canonicalProject(access.project) !== project)) return null;
  if (access.requestedProject && canonicalProject(access.requestedProject) !== project) return null;
  const failed = receipt.state === "failed" || receipt.state === "conflicted";
  const queued = receipt.queuedPinnedSpawn;
  const waiting = !failed && receipt.state === "starting" && queued
    && (!queued.admissionDeadlineAt || !!queued.lastAdmissionError);
  const launched = !failed && (receipt.state === "completed" || receipt.state === "prompt-delivered"
    || receipt.state === "path-pending" || receipt.verifiedHost !== null);
  return {
    conversationId: receipt.conversationId,
    launchId: receipt.launchId,
    transcriptPath: receipt.artifactPath,
    engine: receipt.engine,
    title: receipt.queuedPinnedSpawn?.spec.launchProfile.title ?? receipt.launchProfile.title ?? null,
    project: receipt.explicitProject ?? receipt.launchProfile.project ?? null,
    state: failed ? "failed" : waiting ? "waiting" : launched ? "launched" : "starting",
    reason: failed ? receipt.error : waiting ? queued.lastAdmissionError ?? receipt.launchProfile.title ?? "waiting for account admission" : null,
    ...(waiting ? { retryAt: queued.retryAt } : {}),
    taskIds: receipt.failureReporting?.taskIds ?? [],
    evidence: "spawn-receipt",
  };
}
