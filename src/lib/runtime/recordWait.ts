import { ownsItsSettlement, type AgentRegistry, type DeliveryOperationOwner } from "@/lib/agent/registry";
import { ACCOUNT_MIGRATION_PASS_INTERVAL_MS } from "@/lib/accounts/migration/controllerSignal";
import type { HeldDelivery, ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { migrationLaneRunning } from "@/lib/accounts/migration/lanes";
import { actingOperation } from "@/lib/deliveryActuation";

import type { DeliveryProgressRecord, DeliveryProgressSink } from "./deliveryProgress";
import { ACTIVE_DELIVERY_PHASES, type DeliveryWaitReason } from "./deliveryWaitReason";
import { sendReceiptFor, settlementDeadlineForRow } from "./sendSettlement";

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

export type DeliveryProgressPort = Pick<DeliveryProgressSink, "get" | "note" | "deadline">
  & Partial<Pick<DeliveryProgressSink, "settle" | "stalled">>
  & { rearm?(operationId: string, conversationId: string, note: Parameters<DeliveryProgressSink["note"]>[2]): void };

export interface RecordedWait {
  reason: DeliveryWaitReason;
  detail?: string | null;
  /** Count one more attempt on the record. */
  attempted?: boolean;
  /** When the next look is due; null for a wait the request itself is in.
      The migration pass by default. */
  nextWakeMs?: number | null;
  /** When the wait began, for one recorded after the fact. */
  sinceMs?: number;
  /** A step the request itself is in, such as discarding its own payload: it
      is named even on a held reservation, which otherwise shows its switch. */
  ownStep?: boolean;
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
    const switching = reservation.state === "held" && !wait.ownStep;
    progress.note(operationId, reservation.runtimeConversationId, {
      waitReason: switching ? switchWaitReason(registry, reservation.conversationId) : wait.reason,
      detail: switching ? null : wait.detail ?? null,
      kind: reservation.command.kind,
      originalKey: reservation.clientMessageId,
      admittedAt: reservation.createdAt,
      nextWakeMs: switching || wait.nextWakeMs === undefined ? ACCOUNT_MIGRATION_PASS_INTERVAL_MS : wait.nextWakeMs,
      ...(wait.attempted ? { attempted: true } : {}),
      ...(wait.sinceMs !== undefined && Number.isFinite(wait.sinceMs) ? { sinceMs: wait.sinceMs } : {}),
    });
    const deadline = settlementDeadlineForRow(registry, { delivery: reservation });
    progress.deadline(operationId, deadline?.deadlineAt ?? null, deadline?.policy ?? null);
    return progress.get(operationId);
  } catch (error) {
    return logged(error);
  }
}

/** {@link recordWait} for an operation the operator re-armed under its own
    identity (P13): its ended record is reopened and the attempt counted. */
export function recordRearm(
  progress: DeliveryProgressPort | null,
  registry: AgentRegistry,
  reservation: HeldDelivery,
  wait: RecordedWait,
): DeliveryProgressRecord | null {
  if (!progress?.rearm || !reservation.command.operationId) return recordWait(progress, registry, reservation, { ...wait, attempted: true });
  const operationId = reservation.command.operationId;
  try {
    progress.rearm(operationId, reservation.runtimeConversationId, {
      waitReason: wait.reason,
      detail: wait.detail ?? null,
      kind: reservation.command.kind,
      originalKey: reservation.clientMessageId,
      admittedAt: reservation.createdAt,
      nextWakeMs: wait.nextWakeMs === undefined ? ACCOUNT_MIGRATION_PASS_INTERVAL_MS : wait.nextWakeMs,
    });
    const deadline = settlementDeadlineForRow(registry, { delivery: reservation });
    progress.deadline(operationId, deadline?.deadlineAt ?? null, deadline?.policy ?? null);
    return progress.get(operationId);
  } catch (error) {
    return logged(error);
  }
}

/**
 * {@link recordWait} for a direct-admission row (A2): a retry attempt or a
 * hand-off, which no reservation answers for. Called in the step after the
 * row is written and before the command that admits it leaves the process.
 */
export function recordDirectWait(
  progress: DeliveryProgressPort | null,
  registry: AgentRegistry,
  owner: DeliveryOperationOwner,
  wait: RecordedWait,
): DeliveryProgressRecord | null {
  if (!progress) return null;
  const operationId = owner.command.operationId;
  try {
    progress.note(operationId, owner.runtimeConversationId, {
      waitReason: wait.reason,
      detail: wait.detail ?? null,
      kind: owner.command.kind,
      originalKey: owner.clientMessageId,
      admittedAt: owner.createdAt,
      nextWakeMs: wait.nextWakeMs === undefined ? ACCOUNT_MIGRATION_PASS_INTERVAL_MS : wait.nextWakeMs,
      ...(wait.attempted ? { attempted: true } : {}),
      ...(wait.sinceMs !== undefined && Number.isFinite(wait.sinceMs) ? { sinceMs: wait.sinceMs } : {}),
    });
    const deadline = settlementDeadlineForRow(registry, { owner });
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
 * Whether a writer that may race the queue still owns the record (rule a,
 * step 4): the record is the one it wrote last, or, when it wrote none, there
 * is no record yet. A command that failed after the journal admitted it may
 * already have been listed, so its failure note is written only then.
 */
export function stillOwnsRecord(progress: DeliveryProgressPort | null, operationId: string, written: DeliveryProgressRecord | null): boolean {
  if (!progress) return false;
  try {
    const current = progress.get(operationId);
    return written ? stillAtStep(current, written) : current === null;
  } catch {
    return false;
  }
}

/**
 * What an admitting request may do with the record of an operation whose row it
 * found already written (rule a, step 4): a replay of its key, or a retry whose
 * attempt row exists. `fresh`: there is no open record, so the request writes
 * its own. `continue`: the open record is one an admitting request wrote
 * (`admitterWrote`), and nothing else has moved it, so the request carries it
 * on as it stands, without restarting its clocks. `leave`: the queue or an
 * executor leads the record now, and the request writes nothing over its
 * phase, clocks or stall.
 */
export function admissionRecordStanding(
  progress: DeliveryProgressPort | null,
  operationId: string,
  admitterWrote: (record: DeliveryProgressRecord) => boolean,
): { standing: "fresh" } | { standing: "continue" | "leave"; record: DeliveryProgressRecord } {
  let record: DeliveryProgressRecord | null = null;
  try {
    record = progress?.get(operationId) ?? null;
  } catch (error) {
    logged(error);
  }
  if (!record || record.terminal) return { standing: "fresh" };
  return { standing: admitterWrote(record) || record.detail === RESTORED_DETAIL ? "continue" : "leave", record };
}

/**
 * An admission's note on a reservation it placed or found (rule a, step 4),
 * for the paths that answer a replay from the row already written: the outage
 * and synchronization holds, and a reclaimed host's resume. It opens a missing
 * record and continues one an admission wrote. A record a queue executor
 * wrote, or one whose operation is being acted on in this process (its
 * conversation's section or a coordinator lane), keeps its phase, clocks and
 * stall: the replay writes nothing over it.
 */
export function recordAdmissionWait(
  progress: DeliveryProgressPort | null,
  registry: AgentRegistry,
  reservation: HeldDelivery,
  wait: RecordedWait,
): DeliveryProgressRecord | null {
  const operationId = reservation.command.operationId;
  if (!progress || !operationId) return null;
  const standing = admissionRecordStanding(progress, operationId, (record) => record.executorId === null
    && actingOperation(reservation.conversationId) !== operationId
    && !migrationLaneRunning(reservation.conversationId));
  return standing.standing === "leave" ? null : recordWait(progress, registry, reservation, wait);
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

/** The store A3 restores into: the Viewer's own. */
export type RestorableProgress = DeliveryProgressPort & {
  presence(operationId: string): "present" | "absent" | "unknown";
  backfillEnded(ended: Parameters<import("./deliveryProgress").DeliveryProgressStore["backfillEnded"]>[0]): boolean;
  completenessMark(): number;
};

const RESTORED_DETAIL = "recorded from the delivery record";
const RESTORE_ENDED_LIMIT = 5_000;

/**
 * What the settlement sweep restores before it settles anything
 * (docs/design/delivery-progress-and-drain.md, A3). It covers what the writers
 * at each step cannot: a record owed when the Viewer died (the store writes
 * behind), and a send claimed or ended by the inventory sidecar, which owns no
 * store.
 *
 * 1. Every open reservation and open direct-admission row without a record
 *    gets one, dated from its admission, so an active phase shows its stall
 *    at once. A `held` reservation is included on purpose.
 * 2. Every owner row that ended at or after the store's completeness mark,
 *    and whose operation the store holds nowhere, gets its ending under its
 *    original key, as the receipt reads it. Nothing is sent, re-armed or woken.
 *
 * Answers whether every ending up to `now` is now known to have its record:
 * a store that could not say whether it holds one, or a backfill that failed,
 * proves nothing, so the sweep takes no checkpoint past it and the next sweep
 * checks again.
 */
export function restoreMissingRecords(registry: AgentRegistry, progress: RestorableProgress, now = Date.now()): boolean {
  const file = registry.readOnlySnapshot();
  let complete = true;
  /** Whether the record is missing; an unreadable store marks the sweep incomplete. */
  const missing = (operationId: string): boolean => {
    const presence = progress.presence(operationId);
    if (presence === "unknown") complete = false;
    return presence === "absent";
  };
  for (const delivery of Object.values(file.heldDeliveries)) {
    if (delivery.state !== "held" && delivery.state !== "assigned" && delivery.state !== "delivery-uncertain") continue;
    const operationId = delivery.command.operationId;
    if (!operationId || !missing(operationId)) continue;
    recordWait(progress, registry, delivery, {
      reason: delivery.state === "delivery-uncertain" ? "evidence-unreadable" : "checking",
      detail: RESTORED_DETAIL,
      sinceMs: Date.parse(delivery.createdAt),
    });
  }
  for (const [operationId, owner] of Object.entries(file.deliveryOperationOwners)) {
    if (!ownsItsSettlement(owner) || owner.terminalState !== null || !missing(operationId)) continue;
    recordDirectWait(progress, registry, owner, { reason: "checking", detail: RESTORED_DETAIL, sinceMs: Date.parse(owner.createdAt) });
  }
  const mark = progress.completenessMark();
  const ended = Object.entries(file.deliveryOperationOwners)
    .filter(([, owner]) => {
      if (owner.terminalState === null) return false;
      const settledAt = Date.parse(owner.settledAt ?? "");
      return Number.isFinite(settledAt) && settledAt >= mark && settledAt <= now;
    })
    .sort(([, left], [, right]) => (right.settledAt ?? "").localeCompare(left.settledAt ?? ""))
    .slice(0, RESTORE_ENDED_LIMIT);
  for (const [operationId, owner] of ended) {
    if (!missing(operationId)) continue;
    const receipt = sendReceiptFor(file, operationId);
    if (!receipt || receipt.state === "in-flight") continue;
    try {
      const written = progress.backfillEnded({
        operationId,
        conversationId: owner.runtimeConversationId,
        originalKey: owner.clientMessageId,
        kind: owner.command.kind,
        admittedAt: owner.createdAt,
        settledAt: owner.settledAt,
        state: receipt.state === "delivered" ? "delivered" : receipt.duplicateRisk ? "uncertain" : "failed",
        reason: receipt.reason ?? null,
      });
      if (!written && !progress.get(operationId)) complete = false;
    } catch (error) {
      complete = false;
      logged(error);
    }
  }
  return complete;
}
