"use client";

import { Check, CircleX } from "lucide-react";

import { X } from "@/components/icons";
import type { DismissalSubjectRequest, DismissalTarget } from "@/lib/attention/dismissalTypes";
import { useLocale } from "@/lib/i18n";
import { drawnLaneMovement } from "@/lib/pipelines/laneMovement";

import { sendDismissal } from "../attention/dismissalOverlay";
import type { MobileBoardConversation, MobileBoardPipelineRow } from "./mobileBoardModel";
import { pendingPipelineActs, type PendingPipelineActs } from "./MobilePipelineScreen";
import { showReceipt } from "./MobileReceipt";
import { MobileSheet } from "./MobileSheet";
import { ROW_ACTION_TONE, type MobileRowAction } from "./MobileSwipeRow";

/*
 * What a phone board row can have done to it (#1671), for the swipe tray and
 * the long-press sheet alike — one list, so the two ways in cannot offer
 * different things.
 *
 * Only what the product really supports, labelled by its effect, acting on
 * the tap with a receipt that carries the inverse (README §2 rule 9):
 *
 *   - a conversation that needs the operator: Dismiss, the needs-you
 *     dismissal (docs/design/needs-attention.md §5). It stops flagging the
 *     reason the row drew until something newer asks; Undo brings it back.
 *   - a conversation: Close card, the board's own close. It hides the card;
 *     the agent keeps running and the transcript stays. Reopen undoes it.
 *   - a pipeline waiting on a decision: Dismiss, the same dismissal, which
 *     leaves the lane untouched; Undo brings it back. And Close lane, the
 *     engine's `close`, held for the receipt's window exactly as the pipeline
 *     screen holds it, because the engine has no way back from it: Restore
 *     cancels it before anything is sent.
 *
 * No Mute and no Delete: the phone has neither, and a gesture is the last
 * place to invent one.
 */

/**
 * Dismiss what a row needs the operator for, with the receipt's Undo
 * (docs/design/needs-attention.md §5). The row leaves the queue on the tap;
 * a refusal puts it back and says why. The engine stamps a lane's dismissal
 * with the instant it is made, so a lane that parked again after an earlier
 * one is cleared for the decision it waits on now; one that parked again
 * after the row was drawn is not cleared at all, and the row says so.
 */
function dismissRow(subject: DismissalSubjectRequest, text: string, failed: (error: string) => string, changed: string): void {
  const target: DismissalTarget = subject.kind === "report" ? { kind: "subjects", subjects: [subject] } : subject;
  showReceipt(text, { kind: "undo", run: () => void sendDismissal(target, [subject], { undo: true, surface: "phone" }) });
  void sendDismissal(target, [subject], { surface: "phone" }).then((result) => {
    if (!result.ok) showReceipt(failed(result.error), null, { error: true });
    else if (result.outcome.changed?.length) showReceipt(changed, null);
  });
}

/** What an action needs of its row: a conversation's path and title, or a
    lane and its task. A board row carries both, and so does a row of the
    phone's columns (#2072 slice 4) that no task owns. A conversation that
    needs the operator also names the reason it drew, which is what its
    Dismiss clears. */
export type MobileRowActionTarget =
  | { kind: "conversation"; row: Pick<MobileBoardConversation, "path" | "title"> & { conversationId?: string | null; reasonId?: string | null } }
  | { kind: "pipeline"; row: Pick<MobileBoardPipelineRow, "pipeline" | "task"> };

export interface MobileBoardRowActionPorts {
  /** Hides the card through the board's close. */
  closeCard: (path: string, title: string) => void;
  /** Lifts that close again. */
  reopenCard: (path: string) => void;
  /** Test seam: the held-act store. Production reads the tab's singleton. */
  acts?: PendingPipelineActs;
}

export function useMobileBoardRowActions({ closeCard, reopenCard, acts = pendingPipelineActs }: MobileBoardRowActionPorts) {
  const { t } = useLocale();
  return (ref: MobileRowActionTarget): MobileRowAction[] => {
    if (ref.kind === "conversation") {
      const { path, title, conversationId, reasonId } = ref.row;
      const subject: DismissalSubjectRequest = { kind: "conversation", ...(conversationId ? { conversationId } : {}), path, reasonId: reasonId ?? null };
      return [...(reasonId ? [{
        key: "dismiss",
        label: t("needs.dismiss"),
        name: t("needs.dismiss"),
        hint: t("needs.dismissRowHint"),
        icon: <Check className="h-4 w-4" aria-hidden />,
        tone: "accent" as const,
        run: () => dismissRow(subject, t("needs.dismissedReceipt", { title }), (error) => t("needs.dismissFailed", { title, error }), t("needs.changedReceipt", { title })),
      }] : []), {
        key: "close",
        label: t("mobile2.board.swipeClose"),
        name: t("mobile2.chat.menuClose"),
        hint: t("mobile2.board.closeCardHint"),
        icon: <X className="h-4 w-4" aria-hidden />,
        tone: "neutral",
        run: () => {
          closeCard(path, title);
          showReceipt(t("mobile2.chat.closed", { title }), { kind: "reopen", run: () => reopenCard(path) });
        },
      }];
    }
    const { pipeline, task } = ref.row;
    return [
      {
        key: "dismiss",
        label: t("needs.dismiss"),
        name: t("needs.dismiss"),
        hint: t("needs.dismissRowHint"),
        icon: <Check className="h-4 w-4" aria-hidden />,
        tone: "accent",
        run: () => {
          const subject: DismissalSubjectRequest = { kind: "pipeline", pipelineId: pipeline.id, laneMovedAt: drawnLaneMovement(pipeline) };
          dismissRow(subject, t("needs.dismissedReceipt", { title: task }), (error) => t("needs.dismissFailed", { title: task, error }), t("needs.changedReceipt", { title: task }));
        },
      },
      {
        key: "closeLane",
        label: t("mobile2.board.closeLane"),
        name: t("mobile2.board.closeLane"),
        hint: t("mobile2.board.closeLaneHint"),
        icon: <CircleX className="h-4 w-4" aria-hidden />,
        tone: "danger",
        run: () => {
          acts.begin({ pipelineId: pipeline.id, action: "close" });
          showReceipt(t("mobile2.pipeline.archived"), { kind: "restore", run: () => acts.cancel() });
        },
      },
    ];
  };
}

/** The long-press sheet: the row's actions, each with what it does. */
export function MobileRowActionsSheet({ title, actions, onClose }: {
  title: string;
  actions: readonly MobileRowAction[];
  onClose: () => void;
}) {
  return (
    <MobileSheet name="row" title={title} onClose={onClose}>
      <div data-mobile2-row-actions className="flex flex-col py-1">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            data-mobile2-row-action={action.key}
            className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            onClick={() => {
              onClose();
              action.run();
            }}
          >
            <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${ROW_ACTION_TONE[action.tone]}`}>
              {action.icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`text-body font-semibold ${action.tone === "danger" ? "text-danger" : "text-primary"}`}>{action.name}</span>
              <span className="text-label text-muted">{action.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </MobileSheet>
  );
}
