import type { FileEntry } from "@/lib/types";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  supersedenceChainTail,
  type ConversationLookup,
  type RegistryConversation,
  type RegistryFile,
} from "./registry";

export type ConversationLineageMarkers = Pick<FileEntry, "migratedTo" | "supersededBy">;

/**
 * The lineage a conversation row carries: whether `pathname` is a generation
 * the conversation moved on from, and whether it is a round a successor
 * replaced (#383). The files response and the stored catalog's list both read
 * it here, so the board and «All conversations» drop the same rows (#1671).
 *
 * - A generation behind the conversation's latest, or a continuity path the
 *   conversation adopted, is `migratedTo` the latest generation.
 * - The latest generation of a superseded conversation is `supersededBy` its
 *   successor, once that successor has a generation. Fail-open: with none the
 *   row keeps no marker, so it never hides behind a dangling link. Primary
 *   navigation resolves the live chain END (A→B→C opens C) while the immediate
 *   edge stays the round history; a tail without a generation falls back to
 *   the immediate successor.
 */
export function conversationLineageMarkers(
  snapshot: Pick<RegistryFile, "conversations" | "conversationAliases">,
  lookup: ConversationLookup,
  conversation: RegistryConversation,
  pathname: string,
): ConversationLineageMarkers {
  const markers: ConversationLineageMarkers = {};
  const latest = conversation.generations.at(-1);
  if (!latest) return markers;
  const generation = conversation.generations.find((item) => item.path === pathname);
  if (generation ? generation.path !== latest.path : conversation.continuityPaths.includes(pathname)) markers.migratedTo = latest.path;
  if (latest.path !== pathname || !conversation.supersededBy) return markers;
  const successorId = lookup.canonicalConversationId(conversation.supersededBy.conversationId);
  const successor = successorId !== conversation.id ? snapshot.conversations[successorId]?.generations.at(-1) : undefined;
  if (!successor) return markers;
  const tailId = supersedenceChainTail(snapshot, conversation.id);
  const tail = tailId !== successorId ? snapshot.conversations[tailId]?.generations.at(-1) : successor;
  markers.supersededBy = {
    conversationId: successorId,
    path: successor.path,
    at: conversation.supersededBy.at,
    reason: conversation.supersededBy.reason,
    tailConversationId: tail ? tailId : successorId,
    tailPath: tail ? tail.path : successor.path,
  };
  return markers;
}

/** Put those markers on stored catalog rows, which reach the list without the
    files response's projection (#1671). */
export function overlayConversationLineage(
  entries: FileEntry[],
  snapshot: RegistryFile = agentRegistry().readOnlySnapshot(),
): void {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  for (const entry of entries) {
    if (entry.engine !== "claude" && entry.engine !== "codex") continue;
    const conversation = lookup.conversationForPath(entry.path);
    if (!conversation || conversation.engine !== entry.engine) continue;
    const markers = conversationLineageMarkers(snapshot, lookup, conversation, entry.path);
    if (markers.migratedTo) entry.migratedTo = markers.migratedTo;
    if (markers.supersededBy) entry.supersededBy = markers.supersededBy;
  }
}
