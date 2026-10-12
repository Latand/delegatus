import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import type { Pipeline } from "@/lib/pipelines/types";
import type { accountLimitRows } from "./compactAnswers";

export const FLEET_NOW = Date.parse("2026-10-12T15:00:00Z");
export function fleetRow(name = "one", overrides: Partial<AgentLivenessRecord> = {}): AgentLivenessRecord {
  return { conversationId: `conversation_${name}`, transcriptPath: `/sessions/${name}.jsonl`, project: "project-one", engine: "claude",
    title: "Fleet fixture", lastRecordAt: new Date(FLEET_NOW).toISOString(), turnState: "busy",
    host: { state: "alive", kind: "structured", pid: 100 }, lifecycle: "running", reason: "host_alive_turn_active",
    silentForMs: 0, stalledForMs: null, pipeline: null, evidenceSource: "transcript", ...overrides };
}
export function fleetEntry(row: AgentLivenessRecord, overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return { key: { engine: "claude", sessionId: row.conversationId! }, artifactPath: row.transcriptPath,
    cwd: "/repo", accountId: "account-one", launchProfile: emptyLaunchProfile({ model: "opus", effort: "high" }), status: "live",
    host: null, structuredHost: { kind: "claude-broker", endpoint: "fixture", process: { pid: row.host.pid!, startIdentity: "fixture-start" },
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: null, pendingAction: null, updatedAt: new Date(FLEET_NOW).toISOString(), ...overrides };
}
export function fleetRegistry(rows: readonly AgentLivenessRecord[]): RegistryFile {
  return { entries: Object.fromEntries(rows.map(row => [row.transcriptPath, fleetEntry(row)])),
    conversations: {}, receipts: {}, conversationAliases: {}, memberships: {} } as unknown as RegistryFile;
}
export function fleetPipeline(row: AgentLivenessRecord, actionAt?: string): Pipeline {
  return { id: "pipeline-one", project: row.project, state: "needs_decision", closedAt: null,
    runs: [{ stageId: "build", attempts: [{ n: 1, conversationId: row.conversationId, agentPath: row.transcriptPath,
      providerWait: { accountId: "account-one", condition: { kind: "usage_limit" }, resetsAt: FLEET_NOW + 3_600_000,
        resumeAt: new Date(FLEET_NOW + 3_660_000).toISOString(), ...(actionAt ? { actionAt } : {}) } }] }] } as unknown as Pipeline;
}
export function fleetAccounts(): ReturnType<typeof accountLimitRows> {
  return [{ engine: "claude", accountId: "account-one", active: true, fresh: false, plan: null,
    session: { usedPercent: 100, resetsAt: new Date(FLEET_NOW + 3_600_000).toISOString() }, weekly: { usedPercent: 43, resetsAt: null }, tiers: [], observedAt: "2026-10-12T14:00:00Z" }];
}
