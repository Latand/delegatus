import { resolveConversationAlias, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { registryRowProjection, registryRowsMatching, type RegistryRowProjector } from "@/lib/agent/sqliteRegistryStore";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

export interface HostlessConversationEvidence { key: string; endedAt: string }

function endedEntry(entry: AgentRegistryEntry): { endedAt: string } | null {
  if (entry.status !== "dead" && entry.status !== "unhosted") return null;
  if (entry.host || entry.structuredHost?.process || entry.claimOwner || entry.pendingAction
    || (entry.structuredTerminationSurvivors?.length ?? 0) > 0) return null;
  return { endedAt: entry.updatedAt };
}

const OPEN_RECEIPTS: RegistryRowProjector<"receipts", ViewerConversationId | null> = {
  id: "hostless-open-receipts-v1", collection: "receipts",
  project: receipt => receipt.state === "completed" || receipt.state === "failed" || receipt.state === "conflicted"
    ? null : receipt.conversationId,
};
const CURRENT_GENERATIONS: RegistryRowProjector<"conversations", { id: ViewerConversationId; key: string } | null> = {
  id: "hostless-current-generations-v1", collection: "conversations",
  project: conversation => {
    const generation = conversation.generations.at(-1);
    return generation ? { id: conversation.id, key: sessionKeyId({ engine: conversation.engine, sessionId: generation.id }) } : null;
  },
};
const ENDED_ENTRIES: RegistryRowProjector<"entries", { endedAt: string } | null> = {
  id: "hostless-ended-entries-v1", collection: "entries", project: endedEntry,
};

/** Complete discovery keeps only the proof fields of immutable archive rows. */
export function hostlessConversations(snapshot: RegistryFile): Map<string, HostlessConversationEvidence> {
  const launching = new Set(registryRowProjection(snapshot, OPEN_RECEIPTS)
    .flatMap(([, id]) => id ? [resolveConversationAlias(snapshot, id)] : []));
  const ended = new Map(registryRowProjection(snapshot, ENDED_ENTRIES));
  const hostless = new Map<string, HostlessConversationEvidence>();
  for (const [, conversation] of registryRowProjection(snapshot, CURRENT_GENERATIONS)) {
    if (!conversation || launching.has(conversation.id)) continue;
    const entry = ended.get(conversation.key);
    if (entry) hostless.set(conversation.id, { key: conversation.key, endedAt: entry.endedAt });
  }
  for (const alias of Object.keys(snapshot.conversationAliases)) {
    const owner = hostless.get(resolveConversationAlias(snapshot, alias as ViewerConversationId));
    if (owner) hostless.set(alias, owner);
  }
  return hostless;
}

/** Revalidate one owner after I/O without discovering every historical owner again. */
export function hostlessConversationEvidence(snapshot: RegistryFile, conversationId: string): HostlessConversationEvidence | null {
  const canonical = resolveConversationAlias(snapshot, conversationId as ViewerConversationId);
  const conversation = snapshot.conversations[canonical];
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const identities = [canonical, ...Object.keys(snapshot.conversationAliases)
    .filter(alias => resolveConversationAlias(snapshot, alias as ViewerConversationId) === canonical)];
  if (registryRowsMatching(snapshot, "receipts", "conversationId", identities).some(receipt =>
    receipt.state !== "completed" && receipt.state !== "failed" && receipt.state !== "conflicted")) return null;
  const key = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
  const entry = snapshot.entries[key];
  const ended = entry ? endedEntry(entry) : null;
  return ended ? { key, endedAt: ended.endedAt } : null;
}
