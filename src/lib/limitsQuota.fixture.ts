import { agentRegistry, type RegistryFile } from "./agent/registry";

export function updateQuotaRegistryFixture(change: (state: RegistryFile) => void): void {
  const registry = agentRegistry(), before = registry.readOnlySnapshot(), next = structuredClone(before);
  change(next);
  registry.restoreSnapshot(before, next);
}

/** Explicit custody for a synthetic rollout; never infer production ownership
 * from its containing account directory. */
export function attributeQuotaFixture(file: string, accountId: string): void {
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("codex", file, accountId);
  updateQuotaRegistryFixture(state => {
    const generation = state.conversations[conversation.id]!.generations[0]!;
    generation.createdAt = "2000-01-01T00:00:00.000Z";
    generation.host = { kind: "codex-app-server", identity: "fixture-host", epoch: 1, verifiedAt: generation.createdAt };
  });
}
