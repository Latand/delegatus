import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { claudeProjectRootFor, codexSessionRootFor, pathAllowed } from "@/lib/scanner/roots";
import { isRenameableTranscriptPath } from "@/lib/session/renameEligibility";

/** A concrete, rename-eligible session resolved from a PATCH request. */
export interface TitleTarget {
  engine: "claude" | "codex";
  path: string;
  /** Canonical Viewer conversation id when the registry owns this session. */
  conversationId?: string;
  /** Former conversation ids the registry has coalesced into `conversationId`;
      title lookups/writes include them so a title filed under a provisional id
      stays reachable and migrates onto the canonical one. */
  aliasConversationIds: string[];
  /** Every transcript path the conversation owns (predecessor generations and
      continuity paths), so a title filed under an earlier UUID/path survives a
      succession and migrates onto the conversation key. */
  ownedPaths: string[];
}

export interface TitleTargetInput {
  path?: unknown;
  conversationId?: unknown;
}

function engineForPath(pathname: string): "claude" | "codex" | null {
  if (codexSessionRootFor(pathname)) return "codex";
  if (claudeProjectRootFor(pathname)) return "claude";
  return null;
}

/** Every transcript path a conversation owns — all generations plus continuity
    paths — so a title filed under a predecessor's UUID/path is still found. */
function ownedPaths(conversation: { generations: readonly { path: string }[]; continuityPaths: readonly string[] }): string[] {
  return [...conversation.generations.map((generation) => generation.path), ...conversation.continuityPaths];
}

/** Every conversation id the registry currently resolves to `canonicalId`
    (excluding the canonical id itself), so a title stored under an old id is
    still found after coalescing. */
function aliasConversationIds(canonicalId: string): string[] {
  const registry = agentRegistry();
  const aliases = registry.readOnlySnapshot().conversationAliases;
  const result: string[] = [];
  for (const alias of Object.keys(aliases)) {
    if (alias !== canonicalId && registry.canonicalConversationId(alias as ViewerConversationId) === canonicalId) result.push(alias);
  }
  return result;
}

/**
 * Resolves a rename request to a concrete session. The Viewer conversation
 * identity owns the title when the registry knows it (so account/compaction
 * successors adopt it); a bare transcript path is accepted only when it lands
 * inside an allowed root. A submitted conversation id is canonicalized so the
 * title never stays filed under a provisional alias. Returns null for anything
 * unknown or unsupported.
 */
export function resolveTitleTarget(input: TitleTargetInput): TitleTarget | null {
  const requested = typeof input.conversationId === "string" && input.conversationId.startsWith("conversation_") ? input.conversationId : undefined;
  if (requested) {
    const conversation = agentRegistry().conversation(requested as ViewerConversationId);
    const path = conversation?.generations.at(-1)?.path;
    if (conversation && path && (conversation.engine === "claude" || conversation.engine === "codex") && isRenameableTranscriptPath(conversation.engine, path)) {
      // `conversation.id` is the canonical id even when `requested` was an alias.
      return { engine: conversation.engine, path, conversationId: conversation.id, aliasConversationIds: aliasConversationIds(conversation.id), ownedPaths: ownedPaths(conversation) };
    }
    return null;
  }
  const path = typeof input.path === "string" ? input.path : "";
  if (!path || !pathAllowed(path)) return null;
  const engine = engineForPath(path);
  if (!engine || !isRenameableTranscriptPath(engine, path)) return null;
  const owner = agentRegistry().conversationForPath(path);
  return { engine, path, conversationId: owner?.id, aliasConversationIds: owner ? aliasConversationIds(owner.id) : [], ownedPaths: owner ? ownedPaths(owner) : [] };
}
