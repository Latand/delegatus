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
  const withheldPaths = new Set<string>();
  const withholds = (receipt: IdentityMaterializationReceipt): boolean => Boolean(receipt.artifactPath)
    && !allowsReceipt(receipt)
    && !(receipt.purpose === "resume-successor" && receipt.resumeSourcePath === receipt.artifactPath);
  const indexed = snapshot && registryHasLookupIndex(snapshot);
  // Plain snapshots retain one collection pass. SQLite views resolve only the
  // requested paths, so a pipeline tick never materializes archived history.
  if (snapshot && !indexed) {
    for (const receipt of Object.values(snapshot.receipts)) {
      if (withholds(receipt)) withheldPaths.add(receipt.artifactPath!);
    }
  }
  const allowedPaths = new Map<string, boolean>();
  const allowsPath = (artifactPath: string): boolean => {
    if (!snapshot || !indexed) return !withheldPaths.has(artifactPath);
    const cached = allowedPaths.get(artifactPath);
    if (cached !== undefined) return cached;
    const allowed = !registryRowsMatching(snapshot, "receipts", "artifactPath", artifactPath).some(withholds);
    allowedPaths.set(artifactPath, allowed);
    return allowed;
  };
  return {
    isStructured,
    allowsReceipt,
    allowsPath,
    pathForConversation: (conversationId) => {
      if (!snapshot) return null;
      const seen = new Set<string>();
      let canonicalId = conversationId;
      while (!seen.has(canonicalId)) {
        seen.add(canonicalId);
        const alias = snapshot.conversationAliases[canonicalId];
        if (!alias) break;
        canonicalId = alias;
      }
      const conversation = snapshot.conversations[canonicalId];
      return conversation?.generations.findLast((generation) => allowsPath(generation.path))?.path ?? null;
    },
  };
}
