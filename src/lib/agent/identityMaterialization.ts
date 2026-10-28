import type { AgentRegistryEntry, RegistryFile, SpawnReceipt } from "./registry";
import { sessionKeyId } from "./sessionKey";
import { registryHasLookupIndex, registryRowsMatching } from "./sqliteRegistryStore";

type IdentityMaterializationSnapshot = Pick<
  RegistryFile,
  "receipts" | "entries" | "conversations" | "conversationAliases"
>;

export type IdentityMaterializationReceipt = Pick<
  SpawnReceipt,
  "transport" | "state" | "key" | "artifactPath" | "purpose" | "resumeSourcePath"
>;

type IdentityMaterializationOptions = {
  structured?: boolean;
  entry?: Pick<AgentRegistryEntry, "structuredHost" | "structuredHostOperationId">;
};

export interface IdentityMaterializationFence {
  isStructured: (receipt: IdentityMaterializationReceipt, options?: IdentityMaterializationOptions) => boolean;
  allowsReceipt: (receipt: IdentityMaterializationReceipt, options?: IdentityMaterializationOptions) => boolean;
  allowsPath: (artifactPath: string) => boolean;
  pathForConversation: (conversationId: `conversation_${string}`) => string | null;
}

/**
 * The publication fence for a staged structured identity. The registry keeps
 * the future key and path while a host binds; external resolvers may use them
 * after finalization proves the transcript exists. A same-path resume leaves
 * the already-readable source generation resolvable while its replacement
 * receipt stays private.
 */
export function identityMaterializationFence(snapshot?: IdentityMaterializationSnapshot): IdentityMaterializationFence {
  const isStructured = (receipt: IdentityMaterializationReceipt, options: IdentityMaterializationOptions = {}): boolean => {
    if (receipt.transport !== null) return receipt.transport === "structured";
    const entry = options.entry ?? (receipt.key ? snapshot?.entries[sessionKeyId(receipt.key)] : undefined);
    return options.structured === true
      || Boolean(entry?.structuredHost)
      || typeof entry?.structuredHostOperationId === "string";
  };
  const allowsReceipt = (receipt: IdentityMaterializationReceipt, options: IdentityMaterializationOptions = {}): boolean =>
    !isStructured(receipt, options) || receipt.state === "completed";
  const canonicalConversationId = (id: `conversation_${string}`): `conversation_${string}` => {
    const seen = new Set<string>();
    while (snapshot?.conversationAliases[id] && !seen.has(id)) {
      seen.add(id);
      id = snapshot.conversationAliases[id]!;
    }
    return id;
  };
  const identity = (receipt: SpawnReceipt): string | null => receipt.key && receipt.artifactPath
    ? JSON.stringify([receipt.artifactPath, canonicalConversationId(receipt.conversationId), receipt.engine, sessionKeyId(receipt.key)])
    : null;
  // A finalized same-identity successor proves this path is already public,
  // even when recovery left the original launch staged. It cannot publish a
  // different conversation or session that merely claims the same path.
  const publishedIdentities = (receipts: SpawnReceipt[]): Set<string> => new Set(receipts
    .filter(receipt => receipt.state === "completed")
    .map(identity).filter((key): key is string => key !== null));
  const withheldPaths = new Set<string>();
  const withholds = (receipt: IdentityMaterializationReceipt): boolean => Boolean(receipt.artifactPath)
    && !allowsReceipt(receipt)
    && !(receipt.purpose === "resume-successor" && receipt.resumeSourcePath === receipt.artifactPath);
  const indexed = snapshot && registryHasLookupIndex(snapshot);
  // Plain snapshots retain one collection pass. SQLite views resolve only the
  // requested paths, so a pipeline tick never materializes archived history.
  if (snapshot && !indexed) {
    const receipts = Object.values(snapshot.receipts);
    const published = publishedIdentities(receipts);
    for (const receipt of receipts) {
      if (withholds(receipt) && !published.has(identity(receipt) ?? "")) withheldPaths.add(receipt.artifactPath!);
    }
  }
  const allowedPaths = new Map<string, boolean>();
  const allowsPath = (artifactPath: string): boolean => {
    if (!snapshot || !indexed) return !withheldPaths.has(artifactPath);
    const cached = allowedPaths.get(artifactPath);
    if (cached !== undefined) return cached;
    const receipts = registryRowsMatching(snapshot, "receipts", "artifactPath", artifactPath);
    const published = publishedIdentities(receipts);
    const allowed = !receipts.some(receipt => withholds(receipt) && !published.has(identity(receipt) ?? ""));
    allowedPaths.set(artifactPath, allowed);
    return allowed;
  };
  return {
    isStructured,
    allowsReceipt,
    allowsPath,
    pathForConversation: (conversationId) => {
      if (!snapshot) return null;
      const conversation = snapshot.conversations[canonicalConversationId(conversationId)];
      return conversation?.generations.findLast((generation) => allowsPath(generation.path))?.path ?? null;
    },
  };
}
