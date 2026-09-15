"use client";

import { useCallback, useRef, useState } from "react";

import type { TFunction } from "@/lib/i18n";

import type { ReceiptAction } from "./KanbanReceipts";
import { stageNames } from "./PipelineSection";
import { isStageChanged, type PipelinePorts } from "./pipelinePorts";
import { actionObserved, pipelineActionOptions, type PipelineActionKind } from "./stagesModel";

/**
 * Pipeline actions from the board (#1695 K5b) over `PATCH /api/pipelines/:id`.
 *
 * Retry and skip act on the stage the pipeline waits on when the engine
 * handles them. The board sends the stage and attempt the operator saw
 * (`expectedStageId`, `expectedAttempt`), and the engine checks both inside the
 * mutation before it closes a flow, resets a worktree or starts anything: a
 * pipeline that moved on answers 409 `STAGE_CHANGED`, which the board explains
 * from a fresh read and never resends. `stageId` keeps its own meaning on
 * `retry-stage` (a launch-receipt retry) and is not sent.
 *
 * A refusal the route explained keeps its words beside a Retry: retry and skip
 * send the same guarded expectations again, and the other actions read the
 * pipeline and check the action first. A write with no answer may or may not
 * have run: it is reported as not confirmed, with a Check again that only
 * reads, never a resend.
 */

export interface PipelineActionIntent {
  pipelineId: string;
  /** The card's title, for receipts. */
  title: string;
  action: PipelineActionKind;
  /** Retry and skip: the stage the operator chose, as the pipeline showed it. */
  stageId: string | null;
  stageName: string | null;
  /** Retry and skip: the `n` of that stage's latest own attempt as the pipeline showed it, `0` for none yet. */
  expectedAttempt: number | null;
}

type Show = (text: string, action?: ReceiptAction, options?: { error?: boolean; ttl?: number }) => number;

const STAGE_BOUND: ReadonlySet<PipelineActionKind> = new Set(["retry-stage", "skip-stage"]);

export function usePipelineActions(ports: PipelinePorts, show: Show, t: TFunction) {
  const [acting, setActing] = useState<ReadonlyMap<string, PipelineActionKind>>(() => new Map());
  const inflight = useRef(new Set<string>());
  const busy = useCallback((pipelineId: string, action: PipelineActionKind | null) => {
    if (action) inflight.current.add(pipelineId);
    else inflight.current.delete(pipelineId);
    setActing((current) => {
      const next = new Map(current);
      if (action) next.set(pipelineId, action);
      else next.delete(pipelineId);
      return next;
    });
  }, []);

  const send = useRef<(intent: PipelineActionIntent, recheck: boolean) => void>(() => {});
  const check = useRef<(intent: PipelineActionIntent) => void>(() => {});

  send.current = (intent, recheck) => {
    const { pipelineId, title, action } = intent;
    if (inflight.current.has(pipelineId)) return;
    busy(pipelineId, action);
    const label = (stage: string | null) => t(`kanban.pipelineAct.label.${action}`, { stage: stage ?? "" });
    void (async () => {
      const stageName = intent.stageName;
      const stageBound = STAGE_BOUND.has(action);
      if (!stageBound && recheck) {
        const current = await ports.read(pipelineId);
        if (!current) {
          busy(pipelineId, null);
          show(t("kanban.pipelineAct.unread", { action: label(stageName) }), { label: t("kanban.retry"), run: () => send.current(intent, true) }, { error: true });
          return;
        }
        const reason = whyNot(current.pipeline, intent);
        if (reason) {
          busy(pipelineId, null);
          show(t("kanban.pipelineAct.notSent", { action: label(stageName), reason }), undefined, { error: true });
          return;
        }
      }
      const result = await ports.patch(pipelineId, stageBound
        ? { action, expectedStageId: intent.stageId ?? "", ...(intent.expectedAttempt !== null ? { expectedAttempt: intent.expectedAttempt } : {}) }
        : { action });
      busy(pipelineId, null);
      if (result.ok) {
        /* For retry and skip the engine checked this stage and attempt before acting. */
        show(t(`kanban.pipelineAct.done.${action}`, { title, stage: stageName ?? "" }));
      } else if (result.unknown) {
        show(t("kanban.pipelineAct.unknown", { action: label(stageName), title }), { label: t("kanban.pipelineAct.checkAgain"), run: () => check.current(intent) }, { error: true });
      } else if (isStageChanged(result)) {
        const now = await ports.read(pipelineId);
        const reason = now ? whyNot(now.pipeline, intent) ?? t("kanban.pipelineAct.changedUnread") : t("kanban.pipelineAct.changedUnread");
        show(t("kanban.pipelineAct.notSent", { action: label(stageName), reason }), undefined, { error: true });
      } else {
        show(t("kanban.pipelineAct.failed", { action: label(stageName), error: result.error }), { label: t("kanban.retry"), run: () => send.current(intent, true) }, { error: true });
      }
    })();
  };

  /** Why the intent no longer applies to the pipeline as it is now, or null when it still does. */
  const whyNot = (pipeline: Parameters<typeof pipelineActionOptions>[0], intent: PipelineActionIntent): string | null => {
    const option = pipelineActionOptions(pipeline).find((candidate) => candidate.action === intent.action);
    if (!option) return t(`kanban.pipelineAct.already.${intent.action === "pause" ? "paused" : "running"}`, { title: intent.title });
    if (option.refusal) return t(`kanban.pipelineAct.refusal.${option.refusal}`);
    if (!STAGE_BOUND.has(intent.action)) return null;
    const names = stageNames(t, pipeline);
    if (option.stageId !== intent.stageId) return t("kanban.pipelineAct.movedTo", { stage: names.get(option.stageId ?? "") ?? option.stageId ?? "" });
    if (intent.expectedAttempt !== null && option.attempt !== intent.expectedAttempt) return t("kanban.pipelineAct.newerAttempt", { stage: names.get(option.stageId ?? "") ?? option.stageId ?? "" });
    return null;
  };

  check.current = (intent) => {
    const { pipelineId, title, action, stageId, stageName } = intent;
    const again = { label: t("kanban.pipelineAct.checkAgain"), run: () => check.current(intent) };
    const label = t(`kanban.pipelineAct.label.${action}`, { stage: stageName ?? "" });
    void ports.read(pipelineId).then((read) => {
      const now = read?.pipeline;
      if (now && actionObserved(action, stageId, now)) show(t(`kanban.pipelineAct.observed.${action}`, { title, stage: stageName ?? "" }));
      else show(t("kanban.pipelineAct.stillUnknown", { action: label, title }), again, { error: true });
    });
  };

  const start = useCallback((intent: PipelineActionIntent) => send.current(intent, false), []);
  return { acting, start };
}
