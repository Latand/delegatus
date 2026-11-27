import fs from "node:fs";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AgentRegistry } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { projectForCwd } from "@/lib/scanner/describe";

export function projectStartFixtureSeat(registry: AgentRegistry, artifactDir: string, cwd: string, fixtureNumber: number, hostPid = process.pid) {
  const id = `00000000-0000-4000-8000-${String(fixtureNumber).padStart(12, "0")}`;
  const project = projectForCwd(cwd)!;
  const filename = path.join(artifactDir, `${id}.jsonl`);
  fs.writeFileSync(filename, JSON.stringify({ type: "user", sessionId: id, cwd, message: { role: "user", content: "Fixture" } }) + "\n");
  const launchProfile = emptyLaunchProfile({ title: "Fixture orchestrator", cwd, project });
  const begun = registry.beginSpawnRequest({ engine: "claude", cwd, transport: "structured", role: "orchestrator", accountId: "fixture-account",
    origin: { kind: "operator" }, launchProfile });
  if (begun.kind !== "created") throw new Error("fixture launch refused");
  const entry = {
    key: { engine: "claude" as const, sessionId: id }, cwd, accountId: "fixture-account", artifactPath: filename,
    launchProfile, status: "live" as const, host: null,
    structuredHost: { kind: "claude-broker" as const, endpoint: "fixture", process: captureProcessIdentity(hostPid), eventCursor: 0,
      protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "fixture-writer", pendingAction: "spawn" as const,
  };
  if (registry.stageStructuredSpawn(begun.receipt.launchId, entry).kind !== "settled"
    || registry.finalizeStructuredSpawn(begun.receipt.launchId).kind !== "settled") throw new Error("fixture launch did not settle");
  const clientRequestId = `fixture-seat-${fixtureNumber}`;
  const now = new Date().toISOString();
  beginOrchestratorSeatIntent({ project, mandate: "Coordinate the board", clientRequestId, mode: "spawn", now });
  completeOrchestratorSeatIntent({ project, clientRequestId, conversationId: begun.receipt.conversationId, path: filename, now });
  return { conversationId: begun.receipt.conversationId, launchId: begun.receipt.launchId, project, entry };
}
