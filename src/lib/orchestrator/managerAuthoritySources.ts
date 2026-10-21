import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import fs from "node:fs";
import { projectSuccessionFor } from "@/lib/projects/succession";

import { authorizedManagerSeats, type ManagerAuthoritySources } from "./authority";
import { canonicalOrchestratorProject, orchestratorRevocations } from "./seats";
import { activeSeatsByCurrentProject } from "./seatProjectIdentity";

/** Durable designation and registry evidence used by every manager grant. */
export function productionManagerAuthoritySources(registry: AgentRegistry = agentRegistry()): ManagerAuthoritySources {
  const launchCwd = (id: string) => registry.conversationAuthorityFacts(id)?.directories.find(directory => {
    try { return fs.statSync(directory).isDirectory(); } catch { return false; }
  }) ?? null;
  return {
    activeSeats: () => activeSeatsByCurrentProject(launchCwd),
    revocations: orchestratorRevocations,
    conversationFacts: (conversationId) => {
      const conversation = registry.conversationAuthorityFacts(conversationId);
      if (!conversation) return null;
      return {
        superseded: conversation.superseded,
        hasGeneration: conversation.hasGeneration,
        project: conversation.project
          ? canonicalOrchestratorProject(projectSuccessionFor(conversation.project, launchCwd(conversationId))?.target
            ?? conversation.project)
          : null,
      };
    },
    resolveAlias: (conversationId) => registry.canonicalConversationId(conversationId as `conversation_${string}`),
  };
}

export function isCurrentOperatorSeat(conversationId: string, registry: AgentRegistry): boolean {
  return authorizedManagerSeats(productionManagerAuthoritySources(registry))
    .some((seat) => seat.conversationId === conversationId);
}
