"use client";

import type { ReactNode } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import type { SelectedContextPreview } from "@/lib/selection/selectedContext";

import { ChevronUp } from "../icons";
import { SelectedContextBadge } from "../SelectedContextBadge";
import { CopyButton } from "./CopyButton";
import { MESSAGE_ACTION } from "./actionStyles";
import { mdBlocks } from "./markdown";
import { tr } from "./parse";

/**
 * The operator's own message, in the one shape it ever has (send-latency
 * slice 3).
 *
 * A message used to be drawn twice by two different components: the outbox
 * painted a 75%-wide bubble at 0.8 opacity with a status line under it, and
 * the transcript's own record replaced it with an 86%-wide bubble at full
 * opacity with a copy control — so on a phone the operator watched their
 * message change width, weight and controls on the way to being confirmed.
 * Both callers render THIS component now, so there is nothing left to differ:
 * width, opacity, padding, type size, markdown, the long-message disclosure
 * and the action gutter are written once.
 *
 * The row is a column: the message line, which is identical in every state,
 * and an optional slot under it that only a proven failure fills. The action
 * gutter is a fixed-size box — the copy control's own geometry — so swapping
 * the pending affordance for the copy control moves nothing.
 */

/** Long enough that the bubble folds it away (the transcript's own rule). */
const LONG_MESSAGE = 500;

export function UserMessageRow({
  text,
  copyText,
  selectedContext,
  bubbleFooter,
  action,
  below,
  rowAttributes,
}: {
  text: string;
  /** What the copy control puts on the clipboard; defaults to {@link text}. */
  copyText?: string;
  selectedContext?: SelectedContextPreview | null;
  /** Inside the bubble, under the body: the submission's attachment count. */
  bubbleFooter?: ReactNode;
  /** The action gutter. Defaults to the copy control every message has. */
  action?: ReactNode;
  /** Under the bubble: the failure line, the transport disclosure. */
  below?: ReactNode;
  rowAttributes?: Record<string, string | undefined>;
}) {
  const isMobile = useIsMobile();
  const long = text.length > LONG_MESSAGE;
  return (
    <div className="my-3 flex flex-col items-end" {...rowAttributes}>
      <div
        className="group/msg flex w-full items-start justify-end gap-1.5"
        data-mobile-message={isMobile ? "user" : undefined}
      >
        {action ?? (
          <CopyButton text={copyText ?? text} label={tr("feed.copyMd")} className={`mt-2 ${MESSAGE_ACTION}`} />
        )}
        {/* Mobile v2 (#1439, lane 4): the user keeps the bubble, at 86% and
            15 px on the phone (README §2.6). */}
        <div
          data-user-bubble
          className={isMobile
            ? "max-w-[86%] whitespace-pre-wrap break-words rounded-surface bg-user px-3 py-[9px] text-title leading-[1.45]"
            : "max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5"}
        >
          {/* #844: what this turn pointed at, from the reference persisted on
              the record itself — the same badge the composer showed before the
              operator sent it, so the two can be compared at a glance. */}
          {selectedContext ? <SelectedContextBadge reference={selectedContext} className="mb-1.5" /> : null}
          {long ? (
            <details className="group/usr">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <span className="group-open/usr:hidden">
                  {text.slice(0, 180)}… <span className="font-semibold text-accent">({tr("common.chars", { n: text.length })})</span>
                </span>
                <span className="hidden items-center gap-1 text-[11px] font-semibold text-muted group-open/usr:inline-flex">
                  {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
                </span>
              </summary>
              {mdBlocks(text)}
            </details>
          ) : (
            mdBlocks(text)
          )}
          {bubbleFooter}
        </div>
      </div>
      {below}
    </div>
  );
}
