import { canonicalOrchestratorProject, orchestratorSeatIn, readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import { SEAT_TICK_WAKE_INTERVAL_MS, seatTickPolicy } from "@/lib/monitor/seatTick";
import { effectiveSeatTickSettings, readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import type { Pipeline } from "@/lib/pipelines/types";
import { withPrototypeReviewSummaries } from "@/lib/prototypeReview/read";
import { loadTasksForList } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { attentionEscalationIndex, readAttentionDismissals, type AttentionDismissalV1 } from "./dismissals";
import type { AttentionEscalationMark } from "./routeTypes";
import { conversationRoute, stampAttentionRoutes, waitingRoundIds, type AttentionRoutingInputs } from "./routing";

/*
 * The production half of attention routing (docs/design/attention-auto-resolve.md):
 * who holds each project's seat, whether its tick can wake it, which
 * conversations ever held a seat, the escalations seats wrote and which of
 * their decision rounds still wait. Read once per projection; `/api/files`
 * stamps the answer and the seat tick reads the stamps, so both see one
 * routing.
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
 * record loses only the link to the form, and the wait stays with the seat.
 */
export function routingInputs(sources: RoutingSources, now: number, waitingRounds: ReadonlySet<string> = new Set()): AttentionRoutingInputs {
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
    formWaiting: (reviewId) => waitingRounds.has(reviewId),
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
    `waitingRounds` are the board's waiting decision rounds, which keep an
    escalated wait on its form. A failure stamps nothing, which leaves every
    wait with the operator. */
export function overlayAttentionRoutes(
  files: readonly FileEntry[], pipelines: readonly Pipeline[], waitingRounds: ReadonlySet<string>, now: number, sources: RoutingSources = productionRoutingSources(),
): void {
  try {
    stampAttentionRoutes(files, pipelines, now, routingInputs(sources, now, waitingRounds));
  } catch (error) {
    console.error("[attention routes] projection failed; every wait stays with the operator", error instanceof Error ? error.name : "unknown");
    for (const file of files) delete file.attentionRoute;
    for (const pipeline of pipelines) delete pipeline.attentionRoute;
  }
}

/** The decision rounds that wait on the operator, read from the task store
    the board projects them from, with the same dismissals and supersession:
    the set `/api/files` stamps with, for a reader that has no board at hand. */
export function storedWaitingRoundIds(
  tasks: readonly BoardTask[] = loadTasksForList(), dismissals?: ReadonlyMap<string, AttentionDismissalV1>,
): Set<string> {
  return waitingRoundIds(withPrototypeReviewSummaries(tasks, dismissals));
}

/**
 * Whether someone other than the operator answers each entry's question
 * first, for the push controller: the routing the board stamps, with the
 * board's waiting rounds, so a wait escalated to a form that still waits
 * pushes nothing whether or not its seat can be woken. An unreadable task
 * store keeps no wait on a form, which leaves it with the seat or the operator.
 */
export function questionRouteReader(
  sources: RoutingSources, now: number, waitingRounds: () => ReadonlySet<string> = storedWaitingRoundIds,
): (entry: FileEntry) => boolean {
  let rounds: ReadonlySet<string>;
  try {
    rounds = waitingRounds();
  } catch {
    rounds = new Set();
  }
  const inputs = routingInputs(sources, now, rounds);
  return (entry) => {
    try {
      return conversationRoute(entry, now, inputs) !== null;
    } catch {
      return false;
    }
  };
}
