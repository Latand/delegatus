import type { NeedReason } from "@/components/attention/needReason";
import type { DismissalSubjectRequest, DismissalTarget } from "@/lib/attention/dismissalTypes";

import type { KanbanCard } from "./kanbanModel";

/**
 * What one click on a card's Dismiss clears (docs/design/needs-attention.md
 * §5): exactly the reasons the card drew, which is the group hide's rule of
 * "what the operator saw". The card's task is the target when it has one, so
 * the server records it against the task; a card no task owns names its
 * subjects alone. Undo names the reasons the card shows as cleared.
 */
export function cardDismissal(card: KanbanCard, undo: boolean): { target: DismissalTarget; subjects: DismissalSubjectRequest[] } {
  const needs = undo ? card.cleared.map((entry) => entry.need) : card.reasons;
  const subjects = needs.map(subjectOf);
  const target: DismissalTarget = card.task
    ? { kind: "task", taskId: card.task.id, subjects }
    : { kind: "subjects", subjects };
  return { target, subjects };
}

export function subjectOf(need: NeedReason): DismissalSubjectRequest {
  if (need.subject === "pipeline") return { kind: "pipeline", pipelineId: need.pipeline.id };
  return {
    kind: "conversation",
    ...(need.file.conversationId ? { conversationId: need.file.conversationId } : {}),
    path: need.file.path,
    reasonId: need.key,
    reason: need.kind,
  };
}
