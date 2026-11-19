import type { AgentRegistry, AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { entryRevision, subjectId } from "./store";

/** Read from the same registry backend as the recipient. The serving
 * reconciler's process-wide cache also serves other registries. */
export function controlProjectionForEntry(file: Pick<RegistryFile, "agentStates">, entry: AgentRegistryEntry, conversationId: string | null) {
  const row = file.agentStates?.[subjectId(entry)];
  return row && row.entryKey === sessionKeyId(entry.key) && row.conversationId === conversationId
    && row.facts.revision === entryRevision(entry) ? row : null;
}

export function readControlProjection(registry: AgentRegistry, entry: AgentRegistryEntry, conversationId: string | null) {
  return registry.agentStateRead(file => controlProjectionForEntry(file, entry, conversationId));
}
