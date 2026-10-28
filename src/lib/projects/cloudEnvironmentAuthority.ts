import type { NextRequest } from "next/server";
import { callerConversationId, requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { agentRegistry } from "@/lib/agent/registry";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { canonicalProject } from "./aliases";
import { requestWorkspaceScope } from "@/lib/team/workspaceRoute";

/** Capability-derived attribution and fresh authority at the storage effect. */
export function cloudEnvironmentActor(request: NextRequest, project: string): string | null {
  const scope = requestWorkspaceScope(request);
  if (scope && !scope.owner && (!scope.canAct(project) || !["owner", "manager"].includes(scope.access(project)))) return null;
  const caller = callerConversationId(request);
  if (!caller) return requireOperatorAuthority(request).ok ? "operator" : null;
  const registry = agentRegistry();
  const root = registry.mcpCallerSnapshot(caller, [], process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null).rootConversationId;
  if (root === caller) return caller;
  return authorizedManagerSeats(productionManagerAuthoritySources(registry)).some(seat => seat.conversationId === caller
    && seat.project && canonicalProject(seat.project) === canonicalProject(project)) ? caller : null;
}
