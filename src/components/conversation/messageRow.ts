/**
 * What ONE sent message says about itself (send-latency slice 3).
 *
 * The operator used to read a sequence: «Queued», then «Delivering», then
 * «Held», then «Delivered», each in its own shape, for a single message they
 * pressed Send on once. Every one of those words is transport bookkeeping —
 * true, and none of it a decision the operator makes. This module collapses
 * the whole vocabulary into the three states a person acts on:
 *
 * - `pending`   — the message is in, its arrival is not confirmed yet. Covers
 *                 local submission, reservation, accepted hold, queued behind
 *                 a turn, delivering, host recovery AND an unknown outcome: an
 *                 admission nobody could confirm is not a message that was not
 *                 sent, and a transport timeout must never be rendered as one.
 * - `confirmed` — arrival is proven (a delivered receipt, the transcript's own
 *                 echo, or assistant output for the turn it created).
 * - `failed`    — a proven failure that needs a decision, with one action.
 *
 * The transport words are not deleted, they are demoted: {@link transportLine}
 * is the evidence the row's own disclosure holds, and it is the exact wording
 * the bubble used to publish at rest.
 *
 * Pure: no React, no store. The row's rendering is a function of the entry,
 * the conversation's axes and the clock, so the three-state collapse is
 * testable without a DOM.
 */

import type { MessageKey, TFunction } from "@/lib/i18n";

import { deliveryWaitFor, deliveryWaitText, type DeliveryWaitPhase } from "@/components/runtime/deliveryWait";
import { humanReceiptReasonKey, type HostAxis, type TurnAxis } from "@/components/runtime/runtimeModel";

import type { OutboxEntry } from "./outbox";

export interface MessageRowSession {
  host: HostAxis;
  turn: TurnAxis;
}

/** The account switch holding this queue — display only, see OutboxBubbles. */
export interface MessageRowSwitchHold {
  label: string | null;
}

export type MessageRowPhase = "pending" | "confirmed" | "failed";

/**
 * The one action a proven failure offers. Exactly one is ever rendered:
 *
 * - `retry`            — the payload is here and the original key replays
 *                        idempotently;
 * - `retry-operation`  — the payload is the SERVER's (this browser no longer
 *                        holds the bytes, or never did), and the journal starts
 *                        the admitted operation's next attempt from its own
 *                        recorded request. Still one message, still one key;
 * - `return`           — the payload cannot be replayed from here (its
 *                        attachment bytes were memory-only, or nothing was ever
 *                        admitted), so the words go back to the composer;
 * - `check`            — nothing can be replayed and only the server can say
 *                        what happened; re-read under the original identity.
 */
export type MessageRowAction = "retry" | "retry-operation" | "return" | "check";

/** Receipt reasons that mean "the queue is retrying this by itself" — the
    delivery is still moving, and the row's disclosure says so in words rather
    than leaving the operator to read a raw reason code. */
const BUSY_RETRY_REASONS: ReadonlySet<string> = new Set(["delivery-auto-retry", "interrupt-auto-retry"]);

export interface MessageRowModel {
  phase: MessageRowPhase;
  /** The stable sentence the row publishes at rest, in the UI language. */
  status: string;
  /** Transport evidence for the disclosure — the old chip's exact wording. */
  transport: string;
  /** The wait phase, published on the row for the drivers that read it. */
  wait: DeliveryWaitPhase | "transmitting" | null;
  /** A proven failure's human reason, and the raw sentence behind it. */
  failure: { reason: string; detail: string | null; action: MessageRowAction } | null;
  /** Nothing can confirm this delivery yet: the disclosure offers Check status. */
  uncertain: boolean;
  /**
   * What an unconfirmed delivery's disclosure offers.
   *
   * Exactly one value while the outcome is unknown, and it is never a way out
   * of the row: `check` re-reads the runtime under THIS message's original
   * key — the idempotency key the row is filed under, which exists whether or
   * not an operation id ever came back. The alternative that used to sit here,
   * handing the words back to the composer, is what let the same message be
   * admitted twice under a second key (round-3 P1), so an uncertain row has no
   * exit at all: it settles when evidence arrives, and only authoritative
   * non-execution turns it into a failure the operator may replay.
   */
  recovery: "check" | null;
  /**
   * The disclosure may offer to END the admitted operation.
   *
   * Only ever true for a PROVEN failure that owns an operation. A delivery
   * whose outcome is unknown authorizes nothing from here (round-4 P2): its
   * fate is not established, so ending it is not the operator's decision to
   * make yet and replaying it would be a second engine write for a message
   * that may already be in the journal. An operation that already arrived, or
   * that the operator already discarded, is not something left to decide
   * about either.
   *
   * The journal's own next attempt is not a second control beside this one:
   * where a replay is authorized — a failure the server proved SAFE — it is
   * the row's ONE primary action, and the disclosure never repeats it.
   */
  discardable: boolean;
  /** The message can still be dropped from here without lying about it. */
  cancellable: boolean;
}

/**
 * Raw failure sentences the runtime writes in English, mapped to a human
 * reason in the operator's own language.
 *
 * The operator photographed «structured host recovery failed after 12
 * contended attempts: account is busy» inside a Ukrainian interface. The raw
 * sentence stays reachable (it names the attempt count, which matters when
 * reporting), but the row reads a sentence the person in front of it can act
 * on. Ordered: the combined cause is recognised before either half of it.
 */
const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/(recovery|respawn|restart).{0,64}(failed|gave up)[\s\S]{0,64}\b(busy|contended|in use)\b/i, "outbox.failure.hostBusy"],
  [/\b(host|agent) (recovery|restart|respawn)\b|\brecovery failed\b|\brespawn failed\b/i, "outbox.failure.hostRecovery"],
  [/\baccount is busy\b|\baccount busy\b|\bbusy\b/i, "outbox.failure.accountBusy"],
  [/\bsign[- ]?in\b|\bsign in again\b|\bunauthorized\b|\b401\b|\blog ?out and\b|\brefresh token\b|\bcredentials?\b|\bexpired token\b/i, "outbox.failure.signInExpired"],
  [/\bnot resumable\b|\bnothing (left )?to resume\b|\bno session\b|\broot conversation\b/i, "outbox.failure.notResumable"],
  [/\bruntime host is unavailable\b|\bno host\b|\bdead host\b/i, "outbox.failure.hostGone"],
];

/**
 * The server-side operation this row is about, from either place it can be
 * recorded: the entry's own admission id, or the identity on the receipt the
 * stream projected onto it. An entry can carry only the second — a receipt can
 * arrive for a key whose HTTP response never named an operation — and reading
 * only the first is how a row with a perfectly addressable operation ends up
 * offering nothing to do about it.
 */
export function messageRowOperationId(entry: OutboxEntry): string | null {
  return entry.operationId ?? entry.deliveryReceipt?.operationId ?? null;
}

/** The human reason for a raw failure sentence, or null when none is known. */
export function failureReasonKey(raw: string | null | undefined): MessageKey | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const known = humanReceiptReasonKey(trimmed);
  if (known) return known;
  for (const [pattern, key] of FAILURE_PATTERNS) {
    if (pattern.test(trimmed)) return key;
  }
  return null;
}

/**
 * The transport sentence the bubble used to show at rest: the receipt's own
 * hold, the switch hold, the delivery wait model's phase, or the plain state
 * word. Unchanged wording on purpose — it is still the truth, it just lives
 * under the disclosure now instead of in front of the operator.
 */
export function transportLine(
  t: TFunction,
  entry: OutboxEntry,
  switchHold: MessageRowSwitchHold | null,
  nowMs: number,
  session: MessageRowSession | null,
): { label: string; wait: MessageRowModel["wait"] } {
  /* An outcome nobody could establish keeps its own words in the evidence —
     the transport genuinely does not know, and the disclosure says exactly
     that. The row above it still reads "waiting for confirmation": unknown is
     not delivered and it is not lost. */
  if (entry.deliveryUncertain) return { label: t("orchPanel.errorUnknownTitle"), wait: "uncertain" };
  /* The queue is re-attempting this delivery on its own because the agent was
     busy. That used to be a separate optimistic row beside the composer; it is
     evidence about THIS message, so it reads on this message's disclosure in
     the operator's own language and never as a raw reason code. */
  if (entry.deliveryReceipt?.reason && BUSY_RETRY_REASONS.has(entry.deliveryReceipt.reason)
    && (entry.state === "delivering" || entry.state === "queued")) {
    return { label: t("runtime.receipt.busyRetry"), wait: "transmitting" };
  }
  /* A server-held admission with no receipt yet says only "held". That is the
     honest answer while nothing else is known — but when the conversation's own
     host axis says the window is gone or is being started again, the wait model
     below knows MORE than "held", and the operator who sent into a dead host is
     owed that. The generic wording stays for every other hold. */
  const hostAxisSpeaks = session?.host === "dead" || session?.host === "unhosted"
    || session?.host === "recovering" || session?.host === "registering";
  if (entry.acceptedHeld && entry.state === "delivering" && !hostAxisSpeaks) {
    return { label: t("composer.deliveryHeldWaiting"), wait: null };
  }
  /* While this card is switching accounts the server holds every delivery it
     admits, and this is the ONE place that says so. */
  if (switchHold && (entry.state === "delivering" || entry.state === "queued")) {
    return {
      label: switchHold.label
        ? t("outbox.heldForSwitch", { label: switchHold.label })
        : t("outbox.heldForSwitchUnnamed"),
      wait: null,
    };
  }
  if (entry.state === "delivering") {
    const wait = deliveryWaitFor({
      /* A held admission is parked, not on the wire: reading it as `queued`
         is what lets the model name the host wait it is actually in. */
      status: entry.awaitingTurn || entry.acceptedHeld ? "queued" : "delivering",
      host: session?.host ?? null,
      turn: session?.turn ?? null,
      /* The enqueue stamp: written once when the operator pressed send and
         never rewritten, which is what the wait has to be measured from. */
      admittedAt: new Date(entry.at).toISOString(),
      nowMs,
    });
    const waitLabel = wait ? deliveryWaitText(t, wait) : null;
    if (waitLabel) return { label: waitLabel, wait: wait!.phase };
    /* A hand-over genuinely in progress keeps the wording it always had. */
    return { label: t("outbox.delivering"), wait: wait?.phase ?? "transmitting" };
  }
  if (entry.state === "failed") {
    return { label: entry.needsReattach ? t("outbox.reattach") : entry.error ?? t("outbox.failed"), wait: null };
  }
  if (entry.state === "delivered") return { label: t("outbox.delivered"), wait: null };
  return { label: t("outbox.queued"), wait: null };
}

/** Whether `retryOutbox` would actually replay this entry (it refuses the rest). */
function locallyRetryable(entry: OutboxEntry): boolean {
  return entry.state === "failed"
    && !entry.deliveryUncertain
    && !entry.needsReattach
    && !entry.originalOperationOnly
    && entry.deliveryReceipt?.reason !== "delivery-discarded";
}

/**
 * Whether the JOURNAL can replay this failure for us.
 *
 * The bytes are the server's: this browser either never held them or let them
 * go, and the admitted operation's own recorded request is the complete
 * original. Asking the journal for its next attempt is therefore the same
 * message under the same identity, which is why it is an action the row may
 * offer — and why a discard, which the operator chose, is not replayed.
 */
function operationRetryable(entry: OutboxEntry): boolean {
  return Boolean(messageRowOperationId(entry))
    && !entry.deliveryUncertain
    && entry.deliveryReceipt?.reason !== "delivery-discarded"
    && entry.deliveryReceipt?.status !== "rejected";
}

/** The whole rendering of one message row, in the operator's own language. */
export function messageRowModel(
  t: TFunction,
  entry: OutboxEntry,
  options: { switchHold?: MessageRowSwitchHold | null; nowMs?: number; session?: MessageRowSession | null } = {},
): MessageRowModel {
  const { switchHold = null, nowMs = 0, session = null } = options;
  const transport = transportLine(t, entry, switchHold, nowMs, session);
  /* An unconfirmed outcome is NOT a failure: the message may well have
     arrived, and the one thing the row must never do is tell the operator it
     was not sent. It stays pending, and the disclosure offers Check status
     under the original identity. */
  const uncertain = Boolean(entry.deliveryUncertain) || transport.wait === "uncertain";
  /* Uncertainty outranks every other reading of the entry. A local row the
     composer could not confirm is written `failed` with the unknown flag on
     it, and calling THAT a proven failure is the one thing this model must
     never do: the message may be in the journal, and "not delivered" would
     invite a second copy of it. */
  const phase: MessageRowPhase = uncertain
    ? "pending"
    : entry.state === "failed"
      ? "failed"
      : entry.state === "delivered"
        ? "confirmed"
        : "pending";
  const raw = phase === "failed"
    ? entry.deliveryReceipt?.reason ?? entry.error ?? null
    : null;
  const reasonKey = entry.needsReattach ? "outbox.failure.attachmentsLost" : failureReasonKey(raw);
  const failure = phase === "failed"
    ? {
      reason: reasonKey ? t(reasonKey) : t("outbox.failure.generic"),
      /* The raw sentence is never thrown away — it names attempt counts and
         provider wording a report needs — it is one tap behind the reason. */
      detail: raw && (!reasonKey || t(reasonKey) !== raw.trim()) ? raw.trim() : null,
      /* The journal is asked first whenever it CAN answer: an operation the
         server admitted is continued from its own recorded request, which is
         the same message under the same identity and cannot become a second
         one. Only a failure no operation owns — a refusal before admission, a
         host that was never reached — is replayed from this browser. */
      action: (entry.needsReattach
        ? "return"
        : operationRetryable(entry)
          ? "retry-operation"
          : locallyRetryable(entry)
            ? "retry"
            : messageRowOperationId(entry) || entry.deliveryReceipt
              ? "check"
              : "return") as MessageRowAction,
    }
    : null;
  const pendingUncertain = phase === "pending" && uncertain;
  /* The window in which the admitted operation is still something to decide
     about, and it opens only for a PROVEN failure.

     While the outcome is unknown the row offers exactly one thing — the lookup
     under its original key (see {@link MessageRowModel.recovery}). Nothing
     else may appear there: the journal's own next attempt re-arms a second
     engine write for a message that may well have arrived, and ending an
     operation decides the fate of a delivery nobody has established yet. A
     replay becomes an offer only once authoritative evidence has settled what
     happened — a proven failure, where the row's ONE primary action is that
     replay and the server's `safe` resend is what proved the original did not
     execute.

     A failure the operator can replay from here is answered by its own primary
     action, so repeating the journal's controls under the disclosure would be
     the second place to do the same thing — which is the whole defect this
     slice removes. `phase === "failed"` is also what makes the entry's own
     state `failed`, so nothing delivered can reach here. */
  const operationActionable = phase === "failed"
    && Boolean(messageRowOperationId(entry))
    && entry.deliveryReceipt?.reason !== "delivery-discarded"
    /* A failure the server proved SAFE is already terminal and already known
       not to have executed: there is nothing left to end, and the row's own
       action is the whole of what can be done about it. */
    && entry.deliveryReceipt?.resend !== "safe"
    && (failure!.action === "retry-operation" || failure!.action === "check");
  return {
    phase,
    status: phase === "failed"
      ? failure!.reason
      : phase === "confirmed"
        ? t("outbox.arrived")
        : t("outbox.awaitingConfirmation"),
    transport: transport.label,
    wait: transport.wait,
    failure,
    uncertain: pendingUncertain,
    discardable: operationActionable,
    /* Always the query, never the exit: see {@link MessageRowModel.recovery}.
       The key the row is filed under IS the idempotency key, so the query has
       something to ask about even when no operation id ever came back. */
    recovery: pendingUncertain ? "check" : null,
    /* Dropping the row is honest exactly where it always was: a message still
       sitting in this browser, and a settled failure. Never for an admitted
       delivery — the server would go on holding a message the operator was
       told was withdrawn — and never beside an action that already ends the
       row by handing its words back. */
    cancellable: !entry.deliveryUncertain
      && !entry.preparing
      && (entry.state === "queued" || (phase === "failed" && failure!.action !== "return")),
  };
}
