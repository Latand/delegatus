"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Loader2 } from "@/components/icons";
import { UserMessageRow } from "@/components/feed/UserMessageRow";
import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { refreshRuntime } from "@/hooks/useRuntime";
import type { SelectedContextPreview } from "@/lib/selection/selectedContext";

import { DELIVERY_WAIT_TICK_MS } from "@/components/runtime/deliveryWait";
import { type TFunction, useLocale } from "@/lib/i18n";

import { appendComposerDraft } from "@/components/TmuxComposer";

import { messageRowModel, messageRowOperationId, type MessageRowSession, type MessageRowSwitchHold } from "./messageRow";
import { publishRenderedMessageRows } from "./renderedRows";
import { useMessageRowRecovery } from "./rowRecovery";
import { cancelOutbox, clearParkedOutbox, retryOutbox, type OutboxEntry } from "./outbox";

/**
 * The conversation's own host and turn axes (issue #1213).
 *
 * The row may only say a message waits for a turn when the host says a turn
 * is running: the receipt's own reason cannot establish that, and a message
 * stranded by a window that died would otherwise be announced as waiting on an
 * agent that is not there. `null` when nothing structured is behind this feed,
 * and the evidence then says the wait without naming its cause.
 */
export type OutboxSessionAxes = MessageRowSession;

/**
 * The operator's submitted messages, before the transcript carries them
 * (issues #561 / #569, reshaped by send-latency slice 3).
 *
 * ONE message is ONE row. It is created at submit in its final conversational
 * position, through the SAME renderer the transcript's own record uses
 * ({@link UserMessageRow}) — same width, same opacity, same type, same
 * markdown, same controls — so nothing about the message moves or changes
 * weight while it is being confirmed. Beside it, in the fixed-size gutter the
 * copy control occupies, sits one quiet progress affordance; its disclosure
 * holds the transport evidence that used to be shouted at the operator as
 * «Queued» → «Delivering» → «Delivered». Confirmation clears the affordance
 * and the copy control takes the same slot, so the row does not move. Only a
 * proven failure adds anything: one line, one reason in the operator's
 * language, one action.
 *
 * The row does not end when the transcript's record arrives: the feed hands
 * {@link ConversationMessageRow} that record under the SAME key, so the message
 * keeps its node, its scroll position and whatever the reader had expanded.
 */

/**
 * The account switch holding this queue, when one is: `label` is the target's
 * name, or `null` while the annotation has not published one yet (the whole
 * pending window). Display-only — the entry's own `state` is untouched.
 */
export type SwitchHold = MessageRowSwitchHold;

/** An action on the message: a 44 px target for a finger, the compact pill on
    a pointer. Used for the one primary action a failure offers and for the
    recovery controls its disclosure holds. */
const ROW_ACTION = "min-h-11 shrink-0 rounded-full border border-border px-3 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-6";

/** The progress affordance's box: the copy control's own geometry, so the two
    swap without moving a pixel of the row (see `actionStyles.ts`). */
function affordanceClass(coarse: boolean): string {
  return `inline-flex shrink-0 items-center justify-center rounded-[6px] border border-border bg-card text-muted shadow-1 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${coarse ? "h-11 w-11" : "p-1"}`;
}

/**
 * The transcript's own record of this message, once it has landed.
 *
 * Passing it is how arrival is adopted INTO the row rather than replacing it:
 * the component, the key and therefore the DOM node stay exactly as they were,
 * and only the source of the words changes. The canonical record wins over the
 * local entry wherever both can speak, because the canonical record is what the
 * agent actually received.
 */
export interface CanonicalMessage {
  text: string;
  selectedContext?: SelectedContextPreview | null;
}

/** What the operator's message row can be asked to do about its delivery. */
export interface MessageRowActions {
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onClear?: (id: string) => void;
  onCheck?: (entry: OutboxEntry) => void;
  /** Replay the ADMITTED operation from the journal's own recorded request. */
  onRetryOperation?: (entry: OutboxEntry) => void;
  /** End the admitted operation: the operator decides it must not arrive. */
  onDiscard?: (entry: OutboxEntry) => void;
}

export function ConversationMessageRow({
  entry,
  canonical = null,
  t,
  nowMs = 0,
  switchHold = null,
  session = null,
  actions,
}: {
  /**
   * The local record of the submission. Present while the delivery is still
   * unresolved, and STILL present beside a canonical record, because it is the
   * only thing that knows what the submission carried — the attachment caption
   * is read from it in both states so the row's geometry never changes.
   */
  entry: OutboxEntry | null;
  canonical?: CanonicalMessage | null;
  t: TFunction;
  nowMs?: number;
  switchHold?: SwitchHold | null;
  session?: OutboxSessionAxes | null;
  actions?: MessageRowActions;
}) {
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);
  /* The transcript's own record IS arrival: once it is here, nothing about the
     delivery is unresolved and the row reads exactly like every other message
     in the conversation. The local entry is still consulted for what only it
     knows — what the submission carried — and for nothing else. */
  const row = entry && !canonical
    ? messageRowModel(t, entry, { switchHold, nowMs, session })
    : null;
  const text = canonical?.text ?? entry?.text ?? "";
  const selectedContext = canonical?.selectedContext ?? entry?.selectedContext ?? null;
  const attachments = entry ? entry.images + (entry.files ?? 0) : 0;
  const disclosureLabel = t(open ? "outbox.hideDelivery" : "outbox.showDelivery");
  const operationId = entry ? messageRowOperationId(entry) : null;
  const action = row?.phase === "pending" ? (
    <button
      type="button"
      data-outbox-progress={entry!.id}
      aria-expanded={open}
      title={row.transport}
      onClick={() => setOpen((was) => !was)}
      className={`mt-2 ${affordanceClass(coarse)}`}
    >
      <Loader2
        className={`${coarse ? "h-4 w-4" : "h-3 w-3"} animate-spin motion-reduce:animate-none`}
        aria-hidden
      />
      {/* The row's ONE accessible status, and it does not change while the
          transport does: a reader is told the message is in and waiting for
          confirmation, once, instead of following the queue's bookkeeping. */}
      <span className="sr-only">
        <span data-outbox-status>{row.status}</span>{`. ${disclosureLabel}`}
      </span>
    </button>
  ) : undefined;
  /* The failure line and the transport disclosure are the only things that
     ever sit under the bubble, and only one of them at a time. */
  const below = row?.failure ? (
    <div
      data-outbox-failure={entry!.id}
      className="mt-1 flex max-w-[86%] flex-wrap items-center justify-end gap-1.5 text-caption font-semibold"
    >
      <TriangleAlert className="h-3 w-3 shrink-0 text-danger" aria-hidden />
      <button
        type="button"
        data-outbox-reason
        aria-expanded={open}
        title={row.failure.detail ?? undefined}
        onClick={() => setOpen((was) => !was)}
        className="min-w-0 whitespace-normal break-words text-left text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span data-outbox-status>{row.failure.reason}</span>
      </button>
      {/* Exactly one action. Which one is a fact about the message: a payload
          that can replay gets Retry, a payload that cannot comes back to the
          composer, and an operation only the server can settle gets the
          re-read under its original identity — never two of them. */}
      {row.failure.action === "retry" ? (
        <button
          type="button"
          data-outbox-retry={entry!.id}
          onClick={() => actions?.onRetry(entry!.id)}
          className={`${ROW_ACTION} hover:text-accent`}
        >
          {t("outbox.action.retry")}
        </button>
      ) : row.failure.action === "retry-operation" ? (
        /* The journal's own next attempt of the admitted operation. It carries
           the identity the composer's notice used to carry, because it IS that
           control — the same request, now on the message it belongs to. */
        <button
          type="button"
          data-outbox-operation-retry={entry!.id}
          data-delivery-notice-retry
          onClick={() => actions?.onRetryOperation?.(entry!)}
          className={`${ROW_ACTION} hover:text-accent`}
        >
          {t("outbox.action.retry")}
        </button>
      ) : row.failure.action === "check" ? (
        <button
          type="button"
          data-outbox-check={entry!.id}
          onClick={() => actions?.onCheck?.(entry!)}
          className={`${ROW_ACTION} hover:text-accent`}
        >
          {t("outbox.action.checkStatus")}
        </button>
      ) : (
        <button
          type="button"
          data-outbox-clear={entry!.id}
          onClick={() => actions?.onClear?.(entry!.id)}
          className={`${ROW_ACTION} hover:text-accent`}
        >
          {t(entry!.needsReattach ? "outbox.action.attachAgain" : "outbox.action.takeBack")}
        </button>
      )}
    </div>
  ) : null;
  /* Everything the old receipt stack beside the composer used to say about
     this message, one tap behind the message itself: the transport's own
     wording, the runtime's raw sentence, and the controls that act on the
     admitted operation. Slice 3's rule is that a delivery is explained in ONE
     place, and this is it. */
  const detail = open && row && entry ? (
    <div
      data-outbox-detail={entry.id}
      /* The whole evidence block is about ONE operation, and says so: an
         action read out of it can never be aimed at another delivery's. */
      {...(operationId ? { "data-operation": operationId } : {})}
      className="mt-1 flex max-w-[86%] flex-col items-end gap-1 rounded-control border border-border bg-sunken/55 px-2 py-1 text-caption text-secondary"
    >
      {/* The transport's own words. `data-runtime-receipt-status` travels with
          them: it names WHAT this is — the delivery's own status sentence —
          and slice 3 moved it from the composer's stack onto the message it
          has always been about. */}
      {/* The transport's own words, and then the runtime's raw sentence — but
          only when they are genuinely two different things. A failure whose
          transport line IS its raw sentence used to print it twice, one line
          under the other, which reads as two problems. */}
      {row.transport !== row.failure?.detail ? (
        <span data-outbox-transport data-runtime-receipt-status className="min-w-0 whitespace-normal break-words text-right">{row.transport}</span>
      ) : null}
      {row.failure?.detail ? (
        <span data-outbox-raw data-runtime-receipt-status className="min-w-0 whitespace-normal break-words text-right text-muted">{row.failure.detail}</span>
      ) : null}
      {entry.deliveryReceipt?.reason && entry.deliveryReceipt.reason !== row.failure?.detail
        && entry.deliveryReceipt.reason !== row.transport ? (
        <span className="min-w-0 whitespace-normal break-words text-right text-muted">{entry.deliveryReceipt.reason}</span>
      ) : null}
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        {/* Nothing here is routine status: these are the things an operator can
            DO about a delivery nobody has confirmed. Check status asks the
            runtime again under THIS message's original key — the row's own id —
            and is the only thing an unconfirmed delivery is ever offered. */}
        {row.recovery === "check" && actions?.onCheck ? (
          <button
            type="button"
            data-outbox-check={entry.id}
            onClick={() => actions.onCheck!(entry)}
            className={`${ROW_ACTION} hover:text-accent`}
          >
            {t("outbox.action.checkStatus")}
          </button>
        ) : null}
        {/* No replay lives here. The journal's own next attempt of an admitted
            operation is offered where it is authorized — as the ONE primary
            action of a failure the server proved safe, above — and an outcome
            nobody has established authorizes none at all (round-4 P2). */}
        {/* Ending the operation is the operator's decision that this message
            must not arrive. Only ever offered for one the server admitted. */}
        {actions?.onDiscard && row.discardable ? (
          <button
            type="button"
            data-outbox-discard={entry.id}
            data-receipt-discard
            onClick={() => actions.onDiscard!(entry)}
            className={`${ROW_ACTION} hover:text-danger`}
          >
            {t("runtime.receipt.discard")}
          </button>
        ) : null}
        {row.cancellable && actions ? (
          <button
            type="button"
            data-outbox-cancel={entry.id}
            onClick={() => actions.onCancel(entry.id)}
            className={`${ROW_ACTION} hover:text-danger`}
          >
            {t("outbox.cancel")}
          </button>
        ) : null}
      </span>
    </div>
  ) : null;
  return (
    <UserMessageRow
      text={text}
      selectedContext={selectedContext}
      bubbleFooter={attachments ? (
        /* What the submission actually carried, in ONE presentation from the
           moment it was staged to long after its record arrived. A file-only
           bubble used to render blank here, because the count came from the
           images alone (#1224); it then used to VANISH the instant the
           transcript adopted the row, shrinking an attachment-bearing message
           by 19 px on the phone at the one moment the slice promises nothing
           moves (round-4 P2). It is a caption about the submission, not a
           second copy of the attachment: the transcript still carries the
           image itself as its own row below. */
        <span className="mt-1 block text-caption font-semibold text-muted">
          {t(entry!.files ? "composer.attachmentsCount" : "composer.imagesCount", { count: attachments })}
        </span>
      ) : null}
      action={action}
      below={below || detail ? (
        <>
          {below}
          {detail}
        </>
      ) : null}
      rowAttributes={{
        /* The delivery attributes belong to a row that is still speaking for a
           local submission. An adopted row keeps its entry — for the
           attachment caption above — but it is the transcript's record now,
           and publishing a queue state on it would say a settled message is
           still in flight. */
        ...(entry && row ? { "data-outbox-entry": entry.id, "data-outbox-state": entry.state } : {}),
        "data-message-row": row?.phase ?? "confirmed",
        ...(row?.wait ? { "data-outbox-wait": row.wait } : {}),
      }}
    />
  );
}

/**
 * One message row inside the conversation feed, with its own wait clock.
 *
 * The feed renders THIS component for the operator's message whether the row
 * is still the local submission or already the transcript's own record — one
 * component type, one key, therefore one DOM node across the transition. The
 * clock ticks only while something is genuinely waiting, so a settled
 * conversation re-renders nothing on a timer.
 */
export function FeedMessageRow({
  entry,
  canonical = null,
  switchHold = null,
  session = null,
  actions,
}: {
  entry: OutboxEntry | null;
  canonical?: CanonicalMessage | null;
  switchHold?: SwitchHold | null;
  session?: OutboxSessionAxes | null;
  actions?: MessageRowActions;
}) {
  const { t } = useLocale();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const waiting = Boolean(entry && !canonical);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNowMs(Date.now()), DELIVERY_WAIT_TICK_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    <ConversationMessageRow
      entry={entry}
      canonical={canonical}
      t={t}
      nowMs={nowMs}
      switchHold={switchHold}
      session={session}
      actions={actions}
    />
  );
}

export function OutboxBubblesView({
  entries,
  t,
  nowMs = 0,
  onCancel,
  onRetry,
  onClear,
  onCheck,
  onRetryOperation,
  onDiscard,
  switchHold = null,
  session = null,
}: {
  entries: readonly OutboxEntry[];
  t: TFunction;
  /** Clock the delivery waits are read at (issue #1213). The container ticks
      it; a caller that omits it reads every wait as zero, which renders the
      historical "Delivering" wording and never manufactures a false alarm. */
  nowMs?: number;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  /** Takes a PROVEN-unsent message back to the composer. Optional because this
      view is also mounted by render-only surfaces with no composer behind
      them, and a surface that cannot take the message back does not offer to. */
  onClear?: (id: string) => void;
  /** Re-reads delivery evidence under the message's ORIGINAL identity. Never
      a second send: an unconfirmed outcome is settled by asking, not by
      replaying. */
  onCheck?: (entry: OutboxEntry) => void;
  onRetryOperation?: (entry: OutboxEntry) => void;
  onDiscard?: (entry: OutboxEntry) => void;
  switchHold?: SwitchHold | null;
  /** The conversation's live host/turn axes — see {@link OutboxSessionAxes}. */
  session?: OutboxSessionAxes | null;
}) {
  if (!entries.length) return null;
  return (
    <div
      data-outbox
      aria-label={t("outbox.queueAria")}
      /* One live region for the whole queue: each state change announces once
         instead of every bubble competing for the same channel. There are
         three states to announce now, and a message that is simply moving
         through the transport is not one of them. */
      role="log"
      aria-live="polite"
    >
      {entries.map((entry) => (
        <ConversationMessageRow
          key={entry.id}
          entry={entry}
          t={t}
          nowMs={nowMs}
          switchHold={switchHold}
          session={session}
          actions={{ onCancel, onRetry, onClear, onCheck, onRetryOperation, onDiscard }}
        />
      ))}
    </div>
  );
}

/**
 * The actions a message row performs on this conversation's queue.
 *
 * Shared by the standalone queue view and by the feed's merged rows so both
 * surfaces do the same thing, and so the one rule that matters — an
 * unconfirmed delivery is settled by asking, never by sending again — lives in
 * one place.
 */
export function useOutboxRowActions(cardId: string, entries: readonly OutboxEntry[]): MessageRowActions {
  const recovery = useMessageRowRecovery(cardId);
  return {
    onCancel: (id) => cancelOutbox(cardId, id),
    onRetry: (id) => retryOutbox(cardId, id),
    /* The row goes and its words come back, appended to whatever the operator
       has already typed — never over it, the same gesture that drops context
       into a composer from elsewhere. Attachments cannot come back: their
       bytes were memory-only and a reload is usually what left this message
       unsendable, so the text returns alone and says nothing about files that
       no longer exist. `clearParkedOutbox` refuses everything the server may
       still hold, so this can never be the way a second copy is sent. */
    onClear: (id) => {
      const entry = entries.find((candidate) => candidate.id === id);
      const cleared = clearParkedOutbox(cardId, id);
      if (cleared) {
        if (cleared.text.trim()) appendComposerDraft(cardId, cleared.text);
        return;
      }
      if (!entry || entry.deliveryUncertain || entry.operationId || entry.deliveryReceipt) return;
      cancelOutbox(cardId, id);
      if (entry.text.trim()) appendComposerDraft(cardId, entry.text);
    },
    /* Check status asks the runtime again under the same idempotency key — the
       row's own id, which exists whether or not an operation id ever came
       back. It mints nothing and sends nothing: a delivery whose fate is
       unknown is settled by evidence arriving, never by a second copy of the
       message. Without a composer registered there is still the plain runtime
       re-read, which is what a render-only surface can honestly offer. */
    onCheck: (entry) => {
      if (recovery) recovery.check(entry.id);
      else void refreshRuntime();
    },
    ...(recovery?.retryOperation ? { onRetryOperation: (entry: OutboxEntry) => recovery.retryOperation!(entry.id) } : {}),
    ...(recovery?.discard ? { onDiscard: (entry: OutboxEntry) => recovery.discard!(entry.id) } : {}),
  };
}

export function OutboxBubbles({
  cardId,
  entries,
  switchHold = null,
  session = null,
}: {
  cardId: string;
  entries: readonly OutboxEntry[];
  switchHold?: SwitchHold | null;
  session?: OutboxSessionAxes | null;
}) {
  const { t } = useLocale();
  /* A wait only becomes news by getting older, and nothing else re-renders the
     row while a message is parked. One local interval, no store, no bus. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), DELIVERY_WAIT_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const actions = useOutboxRowActions(cardId, entries);
  /* Whatever surface paints the rows announces which deliveries they explain,
     so the composer's receipt stack can stop repeating those and keep its
     fallback for the ones nothing is painting (see `renderedRows.ts`). */
  const painted = entries.map((entry) => entry.id).join("\u0000");
  useEffect(() => {
    publishRenderedMessageRows(cardId, painted ? painted.split("\u0000") : []);
    return () => publishRenderedMessageRows(cardId, []);
  }, [cardId, painted]);
  return (
    <OutboxBubblesView
      entries={entries}
      t={t}
      nowMs={nowMs}
      onCancel={actions.onCancel}
      onRetry={actions.onRetry}
      onClear={actions.onClear}
      onCheck={actions.onCheck}
      onRetryOperation={actions.onRetryOperation}
      onDiscard={actions.onDiscard}
      switchHold={switchHold}
      session={session}
    />
  );
}
