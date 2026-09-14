import { agentRegistry, readOnlyConversationLookupFromSnapshot, supersedenceChainTail } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

/**
 * The lineage markers the files response puts on a scanned row
 * (`src/app/api/files/response.ts`), put on the stored catalog's rows (#1671).
 *
 * A stored conversation the scan no longer carries used to reach the list
 * without them, so a superseded round or an archived predecessor read as an
 * ordinary finished conversation beside the round that replaced it. The rules
 * are the files response's own: a generation behind its conversation's latest,
 * or a continuity path the conversation adopted, is `migratedTo` the latest;
 * the latest generation of a superseded conversation is `supersededBy` its
 * successor once that successor has a generation, naming the chain's live end.
 */
export function overlayCatalogLineage(
  entries: FileEntry[],
  snapshot: ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]> = agentRegistry().readOnlySnapshot(),
): void {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  for (const entry of entries) {
    if (entry.engine !== "claude" && entry.engine !== "codex") continue;
    const conversation = lookup.conversationForPath(entry.path);
    if (!conversation || conversation.engine !== entry.engine) continue;
    const latest = conversation.generations.at(-1);
    if (!latest) continue;
    const generation = conversation.generations.find((item) => item.path === entry.path);
    if (generation ? generation.path !== latest.path : conversation.continuityPaths.includes(entry.path)) entry.migratedTo = latest.path;
    if (latest.path !== entry.path || !conversation.supersededBy) continue;
    const successorId = lookup.canonicalConversationId(conversation.supersededBy.conversationId);
    const successor = successorId !== conversation.id ? snapshot.conversations[successorId]?.generations.at(-1) : undefined;
    if (!successor) continue;
    const tailId = supersedenceChainTail(snapshot, conversation.id);
    const tail = tailId !== successorId ? snapshot.conversations[tailId]?.generations.at(-1) : successor;
    entry.supersededBy = {
      conversationId: successorId,
      path: successor.path,
      at: conversation.supersededBy.at,
      reason: conversation.supersededBy.reason,
      tailConversationId: tail ? tailId : successorId,
      tailPath: tail ? tail.path : successor.path,
    };
  }
}
