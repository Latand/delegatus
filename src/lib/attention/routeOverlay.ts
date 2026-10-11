import { canonicalOrchestratorProject, orchestratorSeatIn, readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import { SEAT_TICK_WAKE_INTERVAL_MS, seatTickPolicy } from "@/lib/monitor/seatTick";
import { effectiveSeatTickSettings, readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { attentionEscalationIndex, readAttentionDismissals } from "./dismissals";
import type { AttentionEscalationMark } from "./routeTypes";
import { stampAttentionRoutes, type AttentionRoutingInputs } from "./routing";

/*
 * The production half of attention routing (docs/design/attention-auto-resolve.md):
 * who holds each project's seat, whether its tick can wake it, which
 * conversations ever held a seat, and the escalations seats wrote. Read once
 * per projection; `/api/files` stamps the answer and the seat tick reads the
 * stamps, so both see one routing.
 */

type OrchestratorSeatFile = NonNullable<ReturnType<typeof readOrchestratorSeatFileOrNull>>;

/** Every conversation a seat record names, held now or retired. */
function seatConversationIds(file: OrchestratorSeatFile | null): Set<string> {
  const ids = new Set<string>();
  if (!file) return ids;
  for (const seat of [...Object.values(file.seats), ...Object.values(file.pending)]) if (seat.conversationId) ids.add(seat.conversationId);
  for (const revocation of file.revocations) ids.add(revocation.conversationId);
  for (const seat of file.seatLineage ?? []) if (seat.conversationId) ids.add(seat.conversationId);
  return ids;
}

export interface RoutingSources {
  seats(): OrchestratorSeatFile | null;
  /** Whether a canonical project's tick is on, so its seat can be woken. */
  tickEnabled(project: string, now: number): boolean;
  escalations(): Map<string, AttentionEscalationMark>;
  canonicalConversationId(id: string): string;
}

export function productionRoutingSources(canonicalConversationId: (id: string) => string = (id) => id): RoutingSources {
  return {
    seats: readOrchestratorSeatFileOrNull,
    tickEnabled: (project, now) => seatTickPolicy() !== null
      && effectiveSeatTickSettings(readSeatTickSettings(project), now, SEAT_TICK_WAKE_INTERVAL_MS).enabled,
    escalations: () => attentionEscalationIndex(readAttentionDismissals()),
    canonicalConversationId,
  };
}

/**
 * The routing inputs one projection reads. An unreadable seat record routes
 * nothing, so the operator still sees every ask; an unreadable escalation
 * record loses only the seat's words, and the wait stays with the seat.
 */
export function routingInputs(sources: RoutingSources, now: number): AttentionRoutingInputs {
  const file = sources.seats();
  const canonical = (id: string) => sources.canonicalConversationId(id);
  const seats = new Set([...seatConversationIds(file)].map(canonical));
  let escalations: Map<string, AttentionEscalationMark>;
  try {
    escalations = sources.escalations();
  } catch {
    escalations = new Map();
  }
  const seatByProject = new Map<string, string | null>();
  return {
    canonicalProject: canonicalOrchestratorProject,
    isSeatConversation: (conversationId) => seats.has(canonical(conversationId)),
    escalation: (key) => escalations.get(key) ?? null,
    seatFor: (project) => {
      if (seatByProject.has(project)) return seatByProject.get(project)!;
      const active = file ? orchestratorSeatIn(file, project).active : null;
      let seat: string | null = null;
      try {
        seat = active?.state === "active" && active.conversationId && sources.tickEnabled(project, now * 1000) ? canonical(active.conversationId) : null;
      } catch {
        seat = null;
      }
      seatByProject.set(project, seat);
      return seat;
    },
  };
}

/** Stamp who answers each conversation's and lane's wait onto the projection.
    A failure stamps nothing, which leaves every wait with the operator. */
export function overlayAttentionRoutes(files: readonly FileEntry[], pipelines: readonly Pipeline[], now: number, sources: RoutingSources = productionRoutingSources()): void {
  try {
    stampAttentionRoutes(files, pipelines, now, routingInputs(sources, now));
  } catch (error) {
    console.error("[attention routes] projection failed; every wait stays with the operator", error instanceof Error ? error.name : "unknown");
    for (const file of files) {
      delete file.attentionRoute;
      delete file.attentionEscalation;
    }
    for (const pipeline of pipelines) {
      delete pipeline.attentionRoute;
      delete pipeline.attentionEscalation;
    }
  }
}
