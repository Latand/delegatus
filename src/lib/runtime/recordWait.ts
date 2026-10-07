import type { AgentRegistry } from "@/lib/agent/registry";
import { ACCOUNT_MIGRATION_PASS_INTERVAL_MS } from "@/lib/accounts/migration/controllerSignal";
import type { HeldDelivery, ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { migrationLaneRunning } from "@/lib/accounts/migration/lanes";
import { actingOperation } from "@/lib/deliveryActuation";

import type { DeliveryProgressRecord, DeliveryProgressSink } from "./deliveryProgress";
import { ACTIVE_DELIVERY_PHASES, type DeliveryWaitReason } from "./deliveryWaitReason";
import { settlementDeadlineForRow } from "./sendSettlement";

/**
 * The one writer of an accepted send's progress record before the runtime
 * journal holds it (docs/design/delivery-progress-and-drain.md, A1).
 *
 * It is called in the synchronous step after every reservation write and
 * after every direct-admission row write, and by every later step that
 * changes what the send waits on: the admission's claim and command, a dead
 * host's resume, the account-migration drain. It creates the record when
 * there is none, with the original key, admission time, kind and settlement
 * deadline read off the reservation, or updates its reason. A reservation held
 * behind its conversation's account switch keeps the switch's reason.
 */

export type DeliveryProgressPort = Pick<DeliveryProgressSink, "get" | "note" | "deadline"> & Partial<Pick<DeliveryProgressSink, "settle">>;

export interface RecordedWait {
  reason: DeliveryWaitReason;
  detail?: string | null;
  /** Count one more attempt on the record. */
  attempted?: boolean;
  /** When the next look is due; null for a wait the request itself is in.
      The migration pass by default. */
  nextWakeMs?: number | null;
}

/** The switch phase a send held behind its conversation's account switch
    waits on, in the codes the hold itself writes. */
export function switchWaitReason(registry: AgentRegistry, conversationId: ViewerConversationId): DeliveryWaitReason {
  const phase = registry.conversation(conversationId)?.migration?.phase;
  if (phase === "failed-recoverable") return "switch-failed";
  if (phase === "waiting-turn") return "switch-after-turn";
  return "switching-accounts";
}

function logged(error: unknown): null {
  console.error("[structured delivery] progress record failed", { error: error instanceof Error ? error.message : String(error) });
  return null;
}

/** Answers the record as written, or null when nothing was recorded. */
export function recordWait(
  progress: DeliveryProgressPort | null,
  registry: AgentRegistry,
  reservation: HeldDelivery,
  wait: RecordedWait,
): DeliveryProgressRecord | null {
  if (!progress || !reservation.command.operationId) return null;
  const operationId = reservation.command.operationId;
  try {
    const switching = reservation.state === "held";
    progress.note(operationId, reservation.runtimeConversationId, {
      waitReason: switching ? switchWaitReason(registry, reservation.conversationId) : wait.reason,
      detail: switching ? null : wait.detail ?? null,
      kind: reservation.command.kind,
      originalKey: reservation.clientMessageId,
      admittedAt: reservation.createdAt,
      nextWakeMs: switching || wait.nextWakeMs === undefined ? ACCOUNT_MIGRATION_PASS_INTERVAL_MS : wait.nextWakeMs,
      ...(wait.attempted ? { attempted: true } : {}),
    });
    const deadline = settlementDeadlineForRow(registry, { delivery: reservation });
    progress.deadline(operationId, deadline?.deadlineAt ?? null, deadline?.policy ?? null);
    return progress.get(operationId);
  } catch (error) {
    return logged(error);
  }
}

/** Whether a record is still at the step a writer left it on: no other
    writer changed its reason, detail, attempt or executor, and it has not
    ended. A stall mark changes none of these. */
export function stillAtStep(current: DeliveryProgressRecord | null, written: DeliveryProgressRecord): boolean {
  return Boolean(current
    && !current.terminal
    && current.waitReason === written.waitReason
    && current.detail === written.detail
    && current.attempt === written.attempt
    && current.executorId === written.executorId);
}

/**
 * An observer's note (rule a, step 5): a pass that found the conversation's
 * lane running, a drain refused the section, the watchdog. It writes
 * `conversation-busy` only to an `assigned` reservation other than the acting
 * one, whose record is missing or shows a passive reason. It never touches the
 * acting operation's record nor replaces an active phase, so an observer can
 * neither erase a stall nor count as progress.
 */
export function recordObservedWait(
  progress: DeliveryProgressPort | null,
  registry: AgentRegistry,
  reservation: HeldDelivery,
  detail: string,
): DeliveryProgressRecord | null {
  if (!progress || reservation.state !== "assigned") return null;
  const operationId = reservation.command.operationId;
  if (!operationId || actingOperation(reservation.conversationId) === operationId) return null;
  try {
    const current = progress.get(operationId);
    if (current && (current.terminal || ACTIVE_DELIVERY_PHASES.has(current.waitReason))) return null;
  } catch (error) {
    return logged(error);
  }
  return recordWait(progress, registry, reservation, { reason: "conversation-busy", detail });
}

/** Whether something in this process is acting on the conversation now: a
    section holder or a coordinator lane. */
export function conversationActorRunning(conversationId: string): boolean {
  return actingOperation(conversationId) !== null || migrationLaneRunning(conversationId);
}
