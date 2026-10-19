import { attentionReason } from "@/components/attention";
import type { FileEntry } from "@/lib/types";
import { conversationHasHost, type finishedWorkIndex } from "./finishedWork";

/** Immediate withdrawal on every board surface, even before the durable
 * reconciliation pass. Exact reason ids preserve a newer ask and Undo. */
export function withFinishedAttention(file: FileEntry, now: number, finished: ReturnType<typeof finishedWorkIndex>): FileEntry {
  const reason = attentionReason(file, now);
  const mark = file.attentionDismissal;
  if (reason?.dismissal && mark?.by.kind === "system" && mark.by.rule === "container-finished") {
    const state = finished.conversationFinishState(file);
    if (conversationHasHost(file) || state.kind === "active" || state.kind === "finished" && reason.raisedAt * 1000 > state.at) {
      return { ...file, attentionDismissal: undefined };
    }
  }
  if (file.attentionDismissal?.restoredAt && (file.attentionDismissal.reasonId === reason?.id || (reason?.clocked && reason.raisedAt * 1000 <= Date.parse(file.attentionDismissal.restoredAt)))) return file;
  if (!reason || reason.dismissal || !reason.clocked || reason.kind === "delivery" || reason.kind === "launch" || conversationHasHost(file)) return file;
  const state = finished.conversationFinishState(file);
  if (state.kind !== "finished" || reason.raisedAt * 1000 > state.at) return file;
  const at = state.at;
  return { ...file, attentionDismissal: { at: new Date(at).toISOString(), by: { kind: "system", rule: "container-finished" }, reasonId: reason.id,
    cleared: { reason: reason.kind, raisedAt: reason.raisedAt, title: file.title ?? "", project: file.project } } };
}
