import { activeDrain } from "@/lib/selfUpdate/drain";
import type { NextRequest } from "next/server";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";
import { spawnNoticeFinalMessage } from "@/lib/spawnNotice/production";
import { reportSpawnHeaders, startDeferredSpawnWork, type ReportSpawnResult } from "@/lib/telegram/reportSpawn";

/** The normal spawn lane, outside Next's request-scoped after(). */
export async function launchAutonomousConversation(body: Record<string, unknown>): Promise<ReportSpawnResult> {
  const [{ executeSpawnRequest, productionSpawnCommandDependencies }, { ensureOperatorSpawnCapability }, { VIEWER_SPAWN_CAPABILITY_HEADER }] = await Promise.all([
    import("@/lib/agent/spawnCommand"), import("@/lib/agent/operatorCapability"), import("@/lib/agent/spawnPolicy"),
  ]);
  const request = { headers: reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER), json: async () => body } as unknown as NextRequest;
  // Loading the spawn lane is asynchronous; existing receipts keep their custody.
  if (activeDrain() && !productionSpawnCommandDependencies.registry().spawnReceiptForClientAttempt(String(body.clientAttemptId))) {
    return { status: 503, body: { code: "AUTO_UPDATE_DRAIN" } };
  }
  const response = await executeSpawnRequest(request, { ...productionSpawnCommandDependencies,
    autonomousAdmissionHeld: () => !!activeDrain(), defer: startDeferredSpawnWork });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
export type SpawnedTurn = { clientAttemptId: string; conversationId?: string | null; claimedAt: string; launchedAt?: string | null };
export type SpawnedTurnObservation = {
  state: "running" | "ended" | "failed";
  failure?: { kind: "launch-failed" | "host-died"; detail: string };
  conversationId?: string;
  launchId?: string;
  path?: string | null;
  finalText?: string | null;
  turnError?: string | null;
};
/** A completed receipt alone proves admission; host liveness and a fresh transcript prove the turn ended. */
export async function observeSpawnedTurn(
  run: SpawnedTurn, sources: Pick<SeatTickSources, "registry" | "liveness" | "now">,
  finalMessage: typeof spawnNoticeFinalMessage = spawnNoticeFinalMessage, launchGraceMs = 15 * 60_000,
): Promise<SpawnedTurnObservation> {
  const registry = sources.registry();
  const receipt = registry.spawnReceiptForClientAttempt(run.clientAttemptId);
  const bound = receipt ? { conversationId: receipt.conversationId, launchId: receipt.launchId, path: receipt.artifactPath } : {};
  if (receipt && (receipt.rejection || receipt.state === "failed" || receipt.state === "conflicted")) return { ...bound, state: "failed", failure: { kind: "launch-failed", detail: receipt.error ?? "launch refused" } };
  const id = receipt?.conversationId ?? run.conversationId;
  const record = id ? (await sources.liveness({ conversationId: id, stallAfterMs: 30 * 60_000, limit: 1 }))[0] : null;
  if (record?.reason === "host_gone_turn_open") return { ...bound, state: "failed", failure: { kind: "host-died", detail: "host exited over an open turn" } };
  if (record?.reason === "launch_unproven_expired" || (!record || record.reason === "launch_unproven") && sources.now() - Date.parse(run.claimedAt) > launchGraceMs) return { ...bound, state: "failed", failure: { kind: "launch-failed", detail: "no host proved the launch" } };
  if (receipt?.state === "completed" && record && ["host_alive_turn_idle", "host_gone_turn_settled"].includes(record.reason) && record.lastRecordAt && Date.parse(record.lastRecordAt) >= Date.parse(run.launchedAt ?? run.claimedAt)) {
    const final = finalMessage(id!);
    return { ...bound, state: "ended", finalText: final.text, turnError: final.error };
  }
  return { ...bound, state: "running" };
}
