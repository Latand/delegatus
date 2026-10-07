"use client";

import { useCallback, useEffect, useState } from "react";

import { usePrototypeReviewJump, usePrototypeReviewNotices, type PrototypeReviewTarget } from "@/hooks/usePrototypeReview";
import { cleanTitle } from "@/components/utils";
import type { BoardTask } from "@/lib/tasks/types";

import { PrototypeReview } from "./PrototypeReview";
import { publishPrototypeNotices } from "./prototypeReviewStore";

/**
 * The page's one review surface. A card's button and the orchestrator's
 * notice both ask for a task's review through the same event; this opens it,
 * one at a time, over whatever the operator is on. It also hands the waiting
 * notices of the page's task poll to the orchestrator's composer.
 */
export function PrototypeReviewHost({ tasks }: { tasks: readonly BoardTask[] }) {
  const [target, setTarget] = useState<PrototypeReviewTarget | null>(null);
  const { notices } = usePrototypeReviewNotices(tasks);
  useEffect(() => { publishPrototypeNotices(notices); }, [notices]);
  useEffect(() => () => publishPrototypeNotices([]), []);
  usePrototypeReviewJump(useCallback((next: PrototypeReviewTarget) => setTarget(next), []));
  const close = useCallback(() => setTarget(null), []);
  if (!target) return null;
  const task = tasks.find((entry) => entry.id === target.taskId);
  return <PrototypeReview key={target.taskId} taskId={target.taskId} reviewId={target.reviewId} taskTitle={cleanTitle((task?.text ?? "").split(/\r?\n/, 1)[0] ?? "", 90) || target.taskId} onClose={close} />;
}
