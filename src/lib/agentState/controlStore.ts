import type { AgentRegistry, AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import type { AntigravityAgentStatesView } from "@/lib/agent/sqliteRegistryStore";
import { entryRevision, subjectId } from "./store";

/** Read from the same registry backend as the recipient. The serving
 * reconciler's process-wide cache also serves other registries. */
export function controlProjectionForEntry(
  file: Pick<RegistryFile, "agentStates" | "conversations">,
  entry: AgentRegistryEntry,
  conversationId: string | null,
  antigravityStates?: AntigravityAgentStatesView,
) {
  if (conversationId === null) return null;
  const conversation = file.conversations?.[conversationId];
  if (!conversation || conversation.engine !== entry.key.engine
    || conversation.generations.at(-1)?.id !== entry.key.sessionId) return null;
  const subject = subjectId(entry);
  const row = file.agentStates?.[subject] ?? (entry.key.engine === "antigravity" ? antigravityStates?.get(subject) : undefined);
  if (!row || row.entryKey !== sessionKeyId(entry.key) || row.conversationId !== conversationId
    || row.facts.revision !== entryRevision(entry) || !row.facts.turn.determined) return null;
  /* A conversation-only writer can advance the turn without changing
     the host entry revision. Require agreement with the current turn. */
  const projectedBusy = row.facts.turn.value.state === "open";
  if ((conversation.turn.state === "busy") !== projectedBusy || conversation.turn.state === "unknown") return null;
  return row;
}

export function readControlProjection(registry: AgentRegistry, entry: AgentRegistryEntry, conversationId: string | null) {
  return registry.agentStateRead((file, antigravityStates) => controlProjectionForEntry(file, entry, conversationId, antigravityStates));
}
