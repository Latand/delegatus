"use client";

import { CircleX, EyeOff } from "lucide-react";

import { X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

import { patchPipeline } from "../pipelines/pipelineModel";
import { dismissStamp, pipelineHiddenFromBoard, type MobileBoardRowRef } from "./mobileBoardModel";
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
 *   - a conversation: Close card, the board's own close. It hides the card;
 *     the agent keeps running and the transcript stays. Reopen undoes it.
 *   - a pipeline waiting on a decision: Hide, the reversible `dismiss`. The
 *     lane is untouched; Restore runs `undismiss`. And Close lane, the
 *     engine's `close`, held for the receipt's window exactly as the pipeline
 *     screen holds it, because the engine has no way back from it: Restore
 *     cancels it before anything is sent.
 *
 * No Mute and no Delete: the phone has neither, and a gesture is the last
 * place to invent one.
 */

/**
 * Hide a lane for the decision it waits on now (#1671). The engine keeps the
 * instant of a lane's first Hide through every later `dismiss`, so a lane that
 * parked again after an earlier Hide would answer a second Hide with that old
 * instant and come straight back. Such a lane has its old Hide cleared first.
 * Both requests carry the hidden record, so the row stays gone between them:
 * the `undismiss` echo and the `dismiss` record apply in the same task, and no
 * frame is painted in between. A refusal of either puts the lane back and
 * returns why.
 */
async function hidePipeline(pipeline: Pipeline): Promise<string | null> {
  const hidden = { ...pipeline, dismissedAt: dismissStamp(pipeline) };
  if (pipeline.dismissedAt && !pipelineHiddenFromBoard(pipeline)) {
    const fail = await patchPipeline(pipeline.id, "undismiss", undefined, hidden);
    if (fail) return fail;
  }
  return patchPipeline(pipeline.id, "dismiss", undefined, hidden);
}

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
  return (ref: MobileBoardRowRef): MobileRowAction[] => {
    if (ref.kind === "conversation") {
      const { path, title } = ref.row;
      return [{
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
        key: "hide",
        label: t("mobile2.board.swipeHide"),
        name: t("mobile2.board.hidePipeline"),
        hint: t("mobile2.board.hidePipelineHint"),
        icon: <EyeOff className="h-4 w-4" aria-hidden />,
        tone: "accent",
        run: () => {
          /* The optimistic record leaves the queue before the request goes:
             the row, the bar's badge and the queue sheet all read it. A refusal
             puts the record back and says why. */
          void hidePipeline(pipeline).then((fail) => { if (fail) showReceipt(fail); });
          showReceipt(t("mobile2.board.pipelineHidden", { task }), {
            kind: "restore",
            run: () => {
              void patchPipeline(pipeline.id, "undismiss", undefined, { ...pipeline, dismissedAt: null })
                .then((fail) => { if (fail) showReceipt(fail); });
            },
          });
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
