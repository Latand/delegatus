"use client";

import { useCallback, useRef, useState } from "react";

import type { TFunction } from "@/lib/i18n";

import type { ReceiptAction } from "./KanbanReceipts";
import { stageNames } from "./PipelineSection";
import type { PipelinePorts } from "./pipelinePorts";
import { actionObserved, pipelineActionOptions, type PipelineActionKind } from "./stagesModel";

/**
 * Pipeline actions from the board (#1695 K5b) over `PATCH /api/pipelines/:id`.
 *
 * Retry and skip act on whatever stage the pipeline waits on when the engine
 * handles them, so the board reads the pipeline first and sends only while
 * that is still the stage the operator chose. The check and the write are two
 * requests: the engine has no expected-stage guard for these actions yet, and
 * another client acting between them can still move the stage.
 *
 * A refusal the route explained keeps its words beside a Retry, and that
 * Retry reads the pipeline and checks the action again before it sends
 * anything. A write with no answer may or may not have run: it is reported as
 * not confirmed, with a Check again that only reads, never a resend.
 */

export interface PipelineActionIntent {
  pipelineId: string;
  /** The card's title, for receipts. */
  title: string;
  action: PipelineActionKind;
  /** Retry and skip: the stage the operator chose, as the pipeline showed it. */
  stageId: string | null;
  stageName: string | null;
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
      let stageName = intent.stageName;
      if (STAGE_BOUND.has(action) || recheck) {
        const current = await ports.read(pipelineId);
        if (!current) {
          busy(pipelineId, null);
          show(t("kanban.pipelineAct.unread", { action: label(stageName) }), { label: t("kanban.retry"), run: () => send.current(intent, true) }, { error: true });
          return;
        }
        const names = stageNames(t, current);
        const option = pipelineActionOptions(current).find((candidate) => candidate.action === action);
        const reason = !option
          ? t(`kanban.pipelineAct.already.${action === "pause" ? "paused" : "running"}`, { title })
          : option.refusal
            ? t(`kanban.pipelineAct.refusal.${option.refusal}`)
            : STAGE_BOUND.has(action) && option.stageId !== intent.stageId
              ? t("kanban.pipelineAct.movedTo", { stage: names.get(option.stageId ?? "") ?? option.stageId ?? "" })
              : null;
        if (reason) {
          busy(pipelineId, null);
          show(t("kanban.pipelineAct.notSent", { action: label(stageName), reason }), undefined, { error: true });
          return;
        }
        /* The stage is named from the record the action was checked against. */
        if (intent.stageId) stageName = names.get(intent.stageId) ?? intent.stageId;
      }
      /* The action alone: a stage id on retry-stage would ask for a launch-receipt retry. */
      const result = await ports.patch(pipelineId, { action });
      busy(pipelineId, null);
      const settled = { ...intent, stageName };
      if (result.ok) {
        show(t(`kanban.pipelineAct.done.${action}`, { title, stage: stageName ?? "" }));
      } else if (result.unknown) {
        show(t("kanban.pipelineAct.unknown", { action: label(stageName), title }), { label: t("kanban.pipelineAct.checkAgain"), run: () => check.current(settled) }, { error: true });
      } else {
        show(t("kanban.pipelineAct.failed", { action: label(stageName), error: result.error }), { label: t("kanban.retry"), run: () => send.current(settled, true) }, { error: true });
      }
    })();
  };

  check.current = (intent) => {
    const { pipelineId, title, action, stageId, stageName } = intent;
    const again = { label: t("kanban.pipelineAct.checkAgain"), run: () => check.current(intent) };
    const label = t(`kanban.pipelineAct.label.${action}`, { stage: stageName ?? "" });
    void ports.read(pipelineId).then((now) => {
      if (now && actionObserved(action, stageId, now)) show(t(`kanban.pipelineAct.observed.${action}`, { title, stage: stageName ?? "" }));
      else show(t("kanban.pipelineAct.stillUnknown", { action: label, title }), again, { error: true });
    });
  };

  const start = useCallback((intent: PipelineActionIntent) => send.current(intent, false), []);
  return { acting, start };
}
