"use client";

import { useCallback, useEffect, useState } from "react";

import { DecisionSheet } from "@/components/decisions/DecisionSheet";
import { openOperatorDecisions } from "@/components/decisions/decisionSurface";
import { openPrototypeReview, usePrototypeReviewJump, usePrototypeReviewNotices, type PrototypeReviewTarget } from "@/hooks/usePrototypeReview";
import { cleanTitle } from "@/components/utils";
import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import type { BoardTask } from "@/lib/tasks/types";

import { PrototypeReview } from "./PrototypeReview";
import { publishPrototypeNotices } from "./prototypeReviewStore";

/**
 * The page's one review surface. A card's button and the orchestrator's
 * notice both ask for a task's review through the same event; this opens it,
 * one at a time, over whatever the operator is on. A seat's own question has
 * no task: it opens in the seat's «Рішення» column, or the sheet that stands
 * in for it (docs/design/operator-decision-forms.md). It also hands the
 * waiting notices of the page's task poll to the orchestrator's panel.
 */
export function PrototypeReviewHost({ tasks, seatDecisions }: { tasks: readonly BoardTask[]; seatDecisions?: readonly PrototypeReviewNotice[] }) {
  const [target, setTarget] = useState<(PrototypeReviewTarget & { kind: "prototype-review" }) | null>(null);
  const { notices } = usePrototypeReviewNotices(tasks, undefined, seatDecisions);
  useEffect(() => { publishPrototypeNotices(notices); }, [notices]);
  useEffect(() => () => publishPrototypeNotices([]), []);
  usePrototypeReviewJump(useCallback((next: PrototypeReviewTarget) => {
    if (next.kind === "seat-decision") { openOperatorDecisions({ project: next.project, reviewId: next.reviewId }); return; }
    setTarget(next);
  }, []));
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reviewId = params.get("prototypeReview"), taskId = params.get("prototypeTask"), project = params.get("project");
    if (!reviewId || !/^pr_[a-f0-9]{32}$/.test(reviewId)) return;
    if (taskId) openPrototypeReview({ kind: "prototype-review", taskId, reviewId });
    else if (project) openOperatorDecisions({ project, reviewId });
  }, []);
  const close = useCallback(() => setTarget(null), []);
  const task = target ? tasks.find((entry) => entry.id === target.taskId) : undefined;
  return (
    <>
      {target ? <PrototypeReview key={target.taskId} taskId={target.taskId} reviewId={target.reviewId} taskTitle={cleanTitle((task?.text ?? "").split(/\r?\n/, 1)[0] ?? "", 90) || target.taskId} onClose={close} /> : null}
      <DecisionSheet />
    </>
  );
}
