import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { projectSuccessionFor } from "@/lib/projects/succession";

import { authorizedManagerSeats, type ManagerAuthoritySources } from "./authority";
import { canonicalOrchestratorProject, orchestratorRevocations } from "./seats";
import { activeSeatsByCurrentProject, seatLaunchCwd } from "./seatProjectIdentity";

/** Durable designation and registry evidence used by every manager grant. */
export function productionManagerAuthoritySources(registry: AgentRegistry = agentRegistry()): ManagerAuthoritySources {
  return {
    activeSeats: () => activeSeatsByCurrentProject(),
    revocations: orchestratorRevocations,
    conversationFacts: (conversationId) => {
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      if (!conversation) return null;
      return {
        superseded: conversation.supersededBy !== null,
        hasGeneration: conversation.generations.length > 0,
        project: conversation.projectOwnership?.project
          ? canonicalOrchestratorProject(projectSuccessionFor(conversation.projectOwnership.project, seatLaunchCwd(conversationId))?.target
            ?? conversation.projectOwnership.project)
          : null,
      };
    },
    resolveAlias: (conversationId) => registry.conversation(conversationId as `conversation_${string}`)?.id ?? conversationId,
  };
}

export function isCurrentOperatorSeat(conversationId: string, registry: AgentRegistry): boolean {
  return authorizedManagerSeats(productionManagerAuthoritySources(registry))
    .some((seat) => seat.conversationId === conversationId);
}
