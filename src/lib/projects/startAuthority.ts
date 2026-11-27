import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { agentRegistry, type AgentRegistry, type SpawnReceipt } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { hasRequesterRelayCustody } from "@/lib/externalRelay/ownerAuthority";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { orchestratorSeatForOrUnknown } from "@/lib/orchestrator/seats";
import { processIdentityStatus } from "@/lib/processIdentity";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";
import { existingTeamStore } from "@/lib/team/store";
import { conversationWorkspacePrincipal, workspacePrincipalAllows } from "@/lib/team/workspacePrincipal";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { canonicalProject } from "./aliases";
import { boundedTarget } from "./directorySuggestions";
import { suggestionRoots } from "./suggestionRoots";
import { directoryProjectId, projectIdentityFromRepositoryRoot, repositoryRootForPath } from "./identity";
import { PROJECT_START_ROLE, projectStartKey, projectStartSeatOperation, type ProjectStartCheckpoint, type ProjectStartNative, type ProjectStartSource } from "./startContract";
import { readProjectStartLink } from "./startReceipt";

export class ProjectStartRefusal extends Error {
  constructor(readonly code: string, readonly status = 409, readonly field?: string, readonly retryable = false) {
    super(code);
  }
}

export function projectStartRuntime() {
  const runtime = resolveSpawnRole({ role: "orchestrator", roleParams: PROJECT_START_ROLE });
  if (!runtime.ok || !runtime.value) throw new ProjectStartRefusal("role_unavailable");
  return { engine: runtime.value.config.engine, digest: createHash("sha256").update(JSON.stringify(runtime.value.config)).digest("hex") };
}

export function projectStartNative(conversationId: string, project: string, registry = agentRegistry()): ProjectStartNative | null {
  const snapshot = registry.livenessConversationSnapshot(conversationId);
  const conversation = snapshot.conversations[conversationId];
  const generation = conversation?.generations.at(-1);
  if (!conversation || conversation.supersededBy || !generation || generation.archivedAt != null
    || canonicalProject(conversationProjectKey(conversation.projectOwnership, generation.launchProfile) ?? "") !== project) return null;
  const entry = snapshot.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
  const host = entry?.structuredHost;
  if (!entry?.claimOwner || !host?.process || host.writerClaimEpoch !== entry.claimEpoch
    || entry.artifactPath !== generation.path || processIdentityStatus(host.process) !== "alive") return null;
  return { conversationId, generation: generation.id, owner: entry.claimOwner, epoch: entry.claimEpoch, process: JSON.stringify(host.process) };
}

export function projectStartAuthority(conversationId: string, registry = agentRegistry()): ProjectStartSource {
  if (hasRequesterRelayCustody(conversationId)) throw new ProjectStartRefusal("caller_forbidden", 403);
  const seat = authorizedManagerSeats(productionManagerAuthoritySources(registry), conversationId)
    .find(row => row.conversationId === conversationId);
  const project = seat?.project;
  const active = project && orchestratorSeatForOrUnknown(project)?.active;
  const native = project && projectStartNative(conversationId, project, registry);
  if (!project || !native || !active || active.conversationId !== conversationId) throw new ProjectStartRefusal("caller_forbidden", 403);
  const store = existingTeamStore();
  if (active.workspace && !store) throw new ProjectStartRefusal("workspace_forbidden", 403);
  const workspace = conversationWorkspacePrincipal(id => registry.conversation(id as ViewerConversationId), conversationId, store);
  if (workspace && (!workspace.workspaceId || !workspacePrincipalAllows(workspace, project, store)))
    throw new ProjectStartRefusal("workspace_forbidden", 403);
  return { ...native, project, seatEpoch: active.seatEpoch, workspace: workspace?.workspaceId ? { ...workspace, workspaceId: workspace.workspaceId } : null };
}

export function assertProjectStartSource(source: ProjectStartSource, registry = agentRegistry()): void {
  if (!viewerReleaseOwnsTraffic()) throw new ProjectStartRefusal("release_changed", 503, undefined, true);
  let current: ProjectStartSource;
  try { current = projectStartAuthority(source.conversationId, registry); }
  catch (error) {
    if (error instanceof ProjectStartRefusal && error.code === "workspace_forbidden") throw error;
    throw new ProjectStartRefusal("authority_changed", 403);
  }
  if (JSON.stringify(current) !== JSON.stringify(source)) throw new ProjectStartRefusal("authority_changed", 403);
}

export const sameDirectory = (a: { dev: number; ino: number } | null, b: { dev: number; ino: number } | null) =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

export function projectStartDirectory(value: string): { dev: number; ino: number } | null {
  try {
    const row = fs.lstatSync(value);
    if (!row.isDirectory()) throw new ProjectStartRefusal("INVALID_ROOT", 400);
    return { dev: row.dev, ino: row.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function projectStartIdentity(root: string): string {
  const repository = repositoryRootForPath(root);
  if (repository && repository !== root) throw new ProjectStartRefusal("PARENT_IN_REPOSITORY", 400);
  if (!repository) return directoryProjectId(root);
  const identity = projectIdentityFromRepositoryRoot(root);
  if (!identity) throw new ProjectStartRefusal("initialization_refused");
  return identity.project;
}

export function assertProjectStartRoot(checkpoint: ProjectStartCheckpoint): void {
  if (boundedTarget(checkpoint.root, suggestionRoots()) !== checkpoint.root
    || !sameDirectory(checkpoint.parent.identity, projectStartDirectory(checkpoint.parent.path))
    || (checkpoint.directory && !sameDirectory(checkpoint.directory, projectStartDirectory(checkpoint.root))))
    throw new ProjectStartRefusal("target_changed");
  if (checkpoint.project && (canonicalProject(checkpoint.project) !== checkpoint.project
    || projectStartIdentity(checkpoint.root) !== checkpoint.project)) throw new ProjectStartRefusal("target_changed");
}

export function assertProjectStartTarget(checkpoint: ProjectStartCheckpoint): void {
  assertProjectStartRoot(checkpoint);
  if (!checkpoint.project) throw new ProjectStartRefusal("target_changed");
  if (checkpoint.source.workspace && !workspacePrincipalAllows(checkpoint.source.workspace, checkpoint.project))
    throw new ProjectStartRefusal("workspace_forbidden", 403);
}

export function assertProjectStartSeat(checkpoint: ProjectStartCheckpoint, registry = agentRegistry()): void {
  const { seat, project } = checkpoint;
  const active = project && orchestratorSeatForOrUnknown(project)?.active;
  const native = seat && project && projectStartNative(seat.conversationId, project, registry);
  if (!seat || !active || active.conversationId !== seat.conversationId || active.seatEpoch !== seat.seatEpoch
    || !native || native.generation !== seat.generation || native.owner !== seat.owner
    || native.epoch !== seat.epoch || native.process !== seat.process) throw new ProjectStartRefusal("target_changed");
}

const messageKey = /^project-start-message-([a-f0-9]{64})$/;

function authorizedCheckpoint(id: string, registry: AgentRegistry): ProjectStartCheckpoint {
  const checkpoint = readProjectStartLink(id)?.checkpoint;
  if (!checkpoint || checkpoint.nextAt === null || checkpoint.deadline <= Date.now()) throw new ProjectStartRefusal("project_start_custody_unavailable");
  assertProjectStartSource(checkpoint.source, registry);
  assertProjectStartTarget(checkpoint);
  return checkpoint;
}

/** The exact downstream key is recorded by the seat and spawn writers. It
 * restores the original operation's guard for both foreground and recovery. */
export function assertProjectStartLaunch(receipt: SpawnReceipt, registry: AgentRegistry): void {
  const id = projectStartSeatOperation(receipt.clientAttemptId);
  if (!id) return;
  const checkpoint = authorizedCheckpoint(id, registry);
  const slot = orchestratorSeatForOrUnknown(checkpoint.project!);
  const intent = slot?.pending ?? slot?.active;
  if (checkpoint.effects.seat !== "dispatching" || !intent
    || slot?.active && slot.active.intent.clientRequestId !== receipt.clientAttemptId
    || intent.intent.clientRequestId !== projectStartKey("seat", id)
    || intent.triggeredBy?.conversationId !== checkpoint.source.conversationId
    || intent.triggeredBy?.seatEpoch !== checkpoint.source.seatEpoch
    || path.resolve(receipt.cwd) !== checkpoint.root
    || (intent.intent.launchId && intent.intent.launchId !== receipt.launchId)
    || (checkpoint.launchId && checkpoint.launchId !== receipt.launchId))
    throw new ProjectStartRefusal("project_start_custody_unavailable");
  const runtime = projectStartRuntime();
  if (runtime.digest !== checkpoint.runtimeDigest || runtime.engine !== receipt.engine)
    throw new ProjectStartRefusal("role_changed");
}

export function assertProjectStartActivation(project: string, requestId: string, conversationId: string, launchId?: string | null): void {
  if (!projectStartSeatOperation(requestId)) return;
  const registry = agentRegistry();
  const receipt = registry.spawnReceiptForClientAttempt(requestId);
  if (!receipt || receipt.conversationId !== conversationId || (launchId && launchId !== receipt.launchId)
    || projectStartIdentity(receipt.cwd) !== project) throw new ProjectStartRefusal("project_start_custody_unavailable");
  assertProjectStartLaunch(receipt, registry);
}

export function assertProjectStartSend(key: string | null | undefined, conversationId: string, registry: AgentRegistry): void {
  const id = messageKey.exec(key ?? "")?.[1];
  if (!id) return;
  const checkpoint = authorizedCheckpoint(id, registry);
  if (checkpoint.effects.delivery !== "dispatching" || checkpoint.seat?.conversationId !== conversationId)
    throw new ProjectStartRefusal("project_start_custody_unavailable");
  const retained = lookupOriginalSend(registry.deliverySnapshotForMessageKey(conversationId, key!),
    { ...checkpoint.relay, clientMessageId: key!, conversationId });
  if (retained.kind !== "found" || retained.operationId !== key)
    throw new ProjectStartRefusal("project_start_custody_unavailable");
  assertProjectStartSeat(checkpoint, registry);
}
