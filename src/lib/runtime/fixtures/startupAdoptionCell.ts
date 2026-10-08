import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import type { AgentMemoryCell } from "../agentMemory";
import { adoptStructuredHostsAtStartup, type StructuredStartupDependencies } from "../startup";
import { bindStructuredDeliveryQueue } from "../structuredDeliveryController";

/**
 * One durable host row of `engine` whose conversation holds `member`, adopted
 * by the real boot pass. Returns the memory and CPU cell boot adoption handed
 * the host, or the error that refused it; no engine process starts.
 */
export async function startupAdoptionCell(directory: string, engine: "codex" | "claude", member: "pipeline" | "flow" | null): Promise<{ cell: AgentMemoryCell | null } | { refused: Error }> {
  const root = fs.mkdtempSync(path.join(directory, `adopt-${engine}-`));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = randomUUID();
  const artifactPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const launchProfile = emptyLaunchProfile({ cwd: root });
  registry.reconcileConversations([{ engine, path: artifactPath, accountId: null, launchProfile,
    turn: { state: "terminal", source: "lifecycle", terminalAt: "2026-10-07T00:00:00.000Z" }, observedAt: "2026-10-07T00:00:00.000Z" }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  if (member) registry.rememberMembership(conversation.id, { kind: member, containerId: `${member}_adoption`, role: member === "flow" ? "reviewer" : "builder",
    slot: "build:1", stageId: null, stageOrder: null, round: null, parentConversationId: null });
  const key = `${engine}:${sessionId}`;
  registry.upsert({ key: { engine, sessionId }, artifactPath, cwd: root, accountId: null, launchProfile, status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  let result: { cell: AgentMemoryCell | null } | { refused: Error } | null = null;
  const capture = (async (store: AgentRegistry, optionsFor: (entry: never) => { memoryCell?: AgentMemoryCell | null; releaseCleanup?: () => void }) => {
    try {
      const options = optionsFor(store.readOnlySnapshot().entries[key]! as never);
      options.releaseCleanup?.();
      result = { cell: options.memoryCell ?? null };
    } catch (error) { result = { refused: error as Error }; }
    return [];
  }) as unknown as NonNullable<StructuredStartupDependencies["adopt"]> & NonNullable<StructuredStartupDependencies["adoptClaude"]>;
  try {
    await adoptStructuredHostsAtStartup({ registry, client: null, refreshTranscriptState: async () => {}, orchestratorSeats: () => [],
      resolveCodexOwner: () => null, resolveClaudeOwner: () => null,
      adopt: engine === "codex" ? capture : async () => [], adoptClaude: engine === "claude" ? capture : async () => [] });
  } finally { await bindStructuredDeliveryQueue([]); }
  if (!result) throw new Error("boot adoption never asked for the host's options");
  return result;
}
