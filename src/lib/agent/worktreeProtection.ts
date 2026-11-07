import type { AgentRegistryEntry, RegistryFile } from "./registry";

/** Evidence used by filesystem retention. This view grants no agent authority. */
export type WorktreeProtection = {
  entries: Record<string, Partial<Pick<AgentRegistryEntry, "cwd" | "status" | "pendingAction" | "updatedAt"
    | "host" | "structuredHost" | "structuredTerminationSurvivors" | "claimOwner">>>;
  conversations: Record<string, { engine?: string; turn?: { state: string };
    migration?: { phase: string } | null;
    generations?: Array<{ id?: string; launchProfile?: { cwd?: string | null } | null }> }>;
  heldDeliveries: Record<string, { conversationId?: string; state?: string }>;
};

export function protectionEntry(row: RegistryFile["entries"][string]): WorktreeProtection["entries"][string] {
  return { cwd: row.cwd, status: row.status, pendingAction: row.pendingAction, updatedAt: row.updatedAt,
    host: row.host, structuredHost: row.structuredHost, structuredTerminationSurvivors: row.structuredTerminationSurvivors,
    claimOwner: row.claimOwner };
}

export function protectionConversation(row: RegistryFile["conversations"][string]): WorktreeProtection["conversations"][string] {
  const generation = row.generations.at(-1);
  return { engine: row.engine, turn: row.turn ? { state: row.turn.state } : undefined,
    migration: row.migration ? { phase: row.migration.phase } : null,
    generations: generation ? [{ id: generation.id, launchProfile: { cwd: generation.launchProfile?.cwd } }] : [] };
}

export function protectionDelivery(row: RegistryFile["heldDeliveries"][string]): WorktreeProtection["heldDeliveries"][string] | null {
  return ["held", "assigned", "delivery-uncertain"].includes(row.state)
    ? { conversationId: row.conversationId, state: row.state } : null;
}

export function worktreeProtection(file: RegistryFile): WorktreeProtection {
  return {
    entries: Object.fromEntries(Object.entries(file.entries).map(([key, row]) => [key, protectionEntry(row)])),
    conversations: Object.fromEntries(Object.entries(file.conversations).map(([key, row]) => [key, protectionConversation(row)])),
    heldDeliveries: Object.fromEntries(Object.entries(file.heldDeliveries).flatMap(([key, row]) => {
      const value = protectionDelivery(row);
      return value ? [[key, value]] : [];
    })),
  };
}
