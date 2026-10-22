import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { AsyncLocalStorage } from "node:async_hooks";
import { conversationIdsResolvingTo, resolveConversationAlias, type AgentRegistry, type RegistryFile } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { registryConversationsForPath, registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";

const scope = new AsyncLocalStorage<{ registry: AgentRegistry; keys: ReadonlySet<string> } | null>();

export function withStartupRowScope<T>(registry: AgentRegistry, keys: ReadonlySet<string> | null, work: () => T): T {
  return scope.run(keys ? { registry, keys } : null, work);
}

/** Retry decisions see only the selected rows and their related evidence.
 * Reads are rebuilt at each boundary; no captured owner survives an await via
 * a cached projection. Registry mutation methods still use the real store. */
export function startupHostInScope(registry: AgentRegistry, key: string): boolean {
  const selected = scope.getStore();
  return !selected || selected.registry !== registry || selected.keys.has(key);
}

export function startupSnapshot(registry: AgentRegistry, prepared?: RegistryFile): RegistryFile {
  const snapshot = prepared ?? registry.readOnlySnapshot();
  const selected = scope.getStore();
  if (!selected || selected.registry !== registry) return snapshot;
  const entries: RegistryFile["entries"] = {};
  const conversations: RegistryFile["conversations"] = {};
  const ids = new Set<ViewerConversationId>();
  for (const key of selected.keys) {
    const entry = snapshot.entries[key];
    if (!entry) continue;
    entries[key] = entry;
    const conversation = registryConversationsForPath(snapshot, entry.artifactPath)[0];
    if (!conversation) continue;
    const canonical = resolveConversationAlias(snapshot, conversation.id);
    for (const id of conversationIdsResolvingTo(snapshot, canonical)) {
      ids.add(id);
      if (snapshot.conversations[id]) conversations[id] = snapshot.conversations[id];
    }
  }
  const related = <K extends "heldDeliveries" | "receipts">(collection: K): RegistryFile[K] =>
    Object.fromEntries(registryRowsMatching(snapshot, collection, "conversationId", [...ids])
      .map(row => [collection === "heldDeliveries" ? (row as RegistryFile["heldDeliveries"][string]).id : (row as RegistryFile["receipts"][string]).launchId, row])) as RegistryFile[K];
  return { ...snapshot, entries, conversations,
    heldDeliveries: related("heldDeliveries"), receipts: related("receipts"),
    memberships: Object.fromEntries([...ids].filter(id => snapshot.memberships[id]).map(id => [id, snapshot.memberships[id]])),
  };
}


/** Authorization at a host boundary does not refresh the bulk selection. */
export function startupHostSnapshot(registry: AgentRegistry, key: SessionKey, includeArtifactPath = false): RegistryFile {
  return typeof registry.startupHostSnapshot === "function" ? registry.startupHostSnapshot(key, includeArtifactPath) : startupSnapshot(registry);
}
