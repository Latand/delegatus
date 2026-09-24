import { readOnlyConversationLookupFromSnapshot, type RegistryFile } from "@/lib/agent/registry";
import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { claudeMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { submissionIdentities } from "@/lib/runtime/submissionIdentity";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";

import type { TranscriptContext, UserRecord } from "./humanInput";
import { NO_ROLE } from "./method";
import type { ConversationResolution, TranscriptFacts } from "./transcriptExport";

/**
 * A transcript's conversation context on this host, shared by the exporter
 * and the continuous ingest: the registry's launch record and project
 * ownership, otherwise the conversation's cwd through the scanner's project
 * rules (a worktree groups under its parent repository), and the host's
 * delivery provenance for who sent a delivered message. A null snapshot is a
 * host whose registry is unreadable or skipped: only the cwd decides the
 * project and no conversation is registered.
 */
export function conversationResolver(snapshot: RegistryFile | null): (facts: TranscriptFacts) => ConversationResolution {
  const lookup = snapshot ? readOnlyConversationLookupFromSnapshot(snapshot) : null;
  return (facts) => {
    const conversation = lookup?.conversationForPath(facts.path) ?? null;
    const generation = conversation?.generations.at(-1);
    let project: string | null = null;
    try {
      project = resolveProjectAttribution({
        projectOwnership: conversation?.projectOwnership,
        cwd: facts.cwd ?? generation?.launchProfile.cwd ?? undefined,
        launchProfileProject: generation?.launchProfile.project,
      }).project;
    } catch {
      project = null;
    }
    if (project === UNRESOLVED_PROJECT) project = null;
    if (!conversation || !snapshot) return { project, launch: null, registered: false };
    const memberships = (snapshot.memberships[conversation.id] ?? []).filter((membership) => membership.kind === "pipeline");
    const pipeline = memberships.length > 0;
    const stage = [...memberships].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const delegated = Boolean(snapshot.lineageEdges[conversation.id]) || (conversation.delegationDepth ?? 0) >= 1;
    let claude: ReturnType<typeof claudeMessageProvenance> | null = null;
    let codex: Record<string, string> | null = null;
    const deliveryOrigin: TranscriptContext["deliveryOrigin"] = (rec: UserRecord) => {
      try {
        if (rec.engine === "claude") {
          claude ??= claudeMessageProvenance(facts.path);
          const found = rec.messageId ? claude[rec.messageId] : undefined;
          return found ? { origin: found.origin, ...(found.submissionId ? { idempotencyKey: found.submissionId } : {}) } : null;
        }
        if (!rec.markerOrigin) return null;
        codex ??= submissionIdentities(facts.path);
        const submission = rec.deliveryKey ? codex[rec.deliveryKey] : undefined;
        return { origin: rec.markerOrigin, ...(submission ? { idempotencyKey: submission } : {}) };
      } catch {
        return null;
      }
    };
    return {
      project,
      launch: pipeline ? "pipeline" : delegated ? "agent" : "operator",
      registered: true,
      conversation: conversation.id,
      deliveryOrigin,
      agent: {
        role: conversationAgentRole(snapshot, conversation.id) ?? NO_ROLE,
        pipelineId: stage?.containerId ?? null,
        stageId: stage?.stageId ?? null,
      },
    };
  };
}
