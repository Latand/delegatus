import type { RegistryFile } from "./registry";
import { agentLivenessSnapshot, type AgentLivenessSources, type AgentLivenessRequest } from "@/lib/lifecycle/liveness";
import { fleetRuntimeFor } from "@/lib/mcp/agentFleet";
import { fleetRow } from "@/lib/mcp/agentFleet.fixture";
import type { FileEntry } from "@/lib/types";
import type { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const now = Date.parse("2026-10-01T00:01:00.000Z");
export const receiptHotCallers = ["agent_activity", "agent_fleet", "get_orchestrator", "update_task", "attention.needs-you", "seat.status"] as const;
export function receiptLivenessSources(store: SqliteAgentRegistryStore): AgentLivenessSources {
  return {
    now: () => now, registrySnapshot: () => store.readOnlySnapshot().file,
    pipelines: () => [], workProcesses: () => [],
    probe: { now: () => now, pidAlive: () => false, processIdentity: () => null },
    listFiles: async () => [{ path: "/fixture/current.jsonl", project: "fixture", engine: "codex", activity: "live",
      conversationId: "conversation_selected", mtime: now / 1000, size: 4096, title: "Fixture" } as FileEntry],
    describeTranscript: async path => ({ path, project: "fixture", title: "Fixture", engine: "codex", mtimeMs: now, sizeBytes: 4096,
      conversationId: "conversation_selected", activity: "live", activityReason: null }),
    transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: now }),
  };
}

/** Replay the receipt-bearing shared call paths used by these HTTP consumers.
 * Transport, auth and unrelated controller work are outside this measurement. */
export async function replayReceiptCaller(caller: typeof receiptHotCallers[number], store: SqliteAgentRegistryStore) {
  const request: AgentLivenessRequest = caller === "get_orchestrator" || caller === "update_task" || caller === "seat.status"
    ? { conversationId: "conversation_selected", limit: 1 }
    : { project: "fixture", liveOnly: true, limit: 200 };
  const snapshot = await agentLivenessSnapshot(request, receiptLivenessSources(store));
  if (caller === "agent_fleet") {
    const selected = fleetRow("selected", { engine: "codex", transcriptPath: "/fixture/current.jsonl" });
    // Two distinct canonical ids reproduce the fleet's IN list, even when
    // only one has receipts. The live projection supplies the actual row.
    const rows = [selected, fleetRow("missing")];
    return { snapshot, runtime: fleetRuntimeFor(rows, store.readOnlySnapshot().file as RegistryFile)(selected) };
  }
  return { snapshot };
}
