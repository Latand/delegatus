import { seatTickWorkSignal, seatTickWorkRemainingMs } from "./seatTickWork";
import type { SeatTickSources } from "./seatTickSources";
import { agentRegistry } from "@/lib/agent/registry";
import { agentLivenessSnapshot, productionLivenessSources } from "@/lib/lifecycle/liveness";
import { activeSeatsByCurrentProject, orchestratorSeatForCurrentProject } from "@/lib/orchestrator/seatProjectIdentity";
import { latestLedgerDeployment } from "@/lib/runtime/deploymentLedger";
import { readSeatTickSettings } from "./seatTickSettings";

/** Seat facts shared by the tick and curator admission without loading tick controllers. */
export type SeatTickAdmissionSources = Pick<SeatTickSources, "now" | "settings" | "seatFor" | "activeSeats" | "registry" | "liveness" | "latestDeployment">;

export function defaultSeatTickAdmissionSources(): SeatTickAdmissionSources {
  return {
    now: () => Date.now(),
    settings: project => readSeatTickSettings(project),
    seatFor: project => orchestratorSeatForCurrentProject(project),
    activeSeats: () => activeSeatsByCurrentProject().map((seat) => seat.project),
    registry: () => agentRegistry(),
    liveness: async request => {
      const snapshot = await agentLivenessSnapshot({
        signal: seatTickWorkSignal(), answerBudgetMs: seatTickWorkRemainingMs(),
        ...(request.reconcileStructuredIdle ? { reconcileStructuredIdle: true } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.project ? { project: request.project, liveOnly: true } : {}),
        stallAfterMs: request.stallAfterMs, limit: request.limit,
      }, productionLivenessSources());
      return snapshot.conversations;
    },
    latestDeployment: latestLedgerDeployment,
  };
}
