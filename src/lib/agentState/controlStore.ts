import type { AgentRegistry, AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { entryRevision, subjectId } from "./store";

/** Read from the same registry backend as the recipient. The serving
 * reconciler's process-wide cache also serves other registries. */
export function controlProjectionForEntry(file: Pick<RegistryFile, "agentStates" | "conversations">, entry: AgentRegistryEntry, conversationId: string | null) {
  if (conversationId === null) return null;
  const row = file.agentStates?.[subjectId(entry)];
  const conversation = file.conversations?.[conversationId];
  if (!row || !conversation || row.entryKey !== sessionKeyId(entry.key) || row.conversationId !== conversationId
    || row.facts.revision !== entryRevision(entry) || !row.facts.turn.determined) return null;
  /* A reconciler may publish a terminal projection while a conversation-only
     writer advances the turn without changing the host entry. Such a row is
     display evidence, not authority for an idle kill. */
  const projectedBusy = row.facts.turn.value.state === "open";
  if ((conversation.turn.state === "busy") !== projectedBusy || conversation.turn.state === "unknown") return null;
  return row;
}

export function readControlProjection(registry: AgentRegistry, entry: AgentRegistryEntry, conversationId: string | null) {
  return registry.agentStateRead(file => controlProjectionForEntry(file, entry, conversationId));
}
