"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { StageDrafts } from "@/components/kanban/stageDrafts";
import type { MessageKey, TFunction } from "@/lib/i18n";
import type { ConversationDraftError } from "@/lib/pipelines/conversationDraftContract";
import type { FileEntry } from "@/lib/types";

import { readConversationPreview, type ConversationDraftAttempt, type ConversationDrafts, type ConversationSource, type DraftStartState, type PreviewOutcome } from "./conversationDraftClient";

export type PreviewState =
  | { kind: "pending"; title: string }
  | { kind: "ready"; source: ConversationSource }
  | { kind: "failed"; title: string; refusal: ConversationDraftError | null };

/**
 * The menu's source while the menu is open: read when it opens, dropped when
 * it closes, so nothing polls and nothing outlives the menu. A read still on
 * its way when the menu closes is abandoned.
 */
export function useConversationPreview(file: FileEntry | null, taskId: string | null, open: boolean, read: typeof readConversationPreview = readConversationPreview): { state: PreviewState | null; reload: () => void } {
  const [round, setRound] = useState(0);
  const conversationId = open ? file?.conversationId ?? null : null;
  const title = file?.title?.trim() || conversationId || "";
  /* One read per opening and per reload; closing drops what it answered. */
  const key = conversationId && taskId ? `${conversationId}\n${taskId}\n${round}` : null;
  const [answer, setAnswer] = useState<{ key: string; state: PreviewState } | null>(null);
  const [answered, setAnswered] = useState(key);
  if (answered !== key) {
    setAnswered(key);
    setAnswer(null);
  }
  useEffect(() => {
    if (!key || !conversationId || !taskId) return;
    const controller = new AbortController();
    read(conversationId, taskId, controller.signal).then((outcome: PreviewOutcome) => {
      if (controller.signal.aborted) return;
      setAnswer({ key, state: outcome.kind === "ready" ? { kind: "ready", source: outcome.source } : { kind: "failed", title, refusal: outcome.refusal } });
    }, () => {});
    return () => controller.abort();
  }, [key, conversationId, taskId, title, read]);
  const reload = useCallback(() => setRound((value) => value + 1), []);
  const state: PreviewState | null = !key ? null : answer?.key === key ? answer.state : { kind: "pending", title };
  return { state, reload };
}

export function useConversationDraftAttempt(store: ConversationDrafts | null | undefined, taskId: string | null): ConversationDraftAttempt | null {
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => (store && taskId ? store.attempt(taskId) : null),
    () => null,
  );
}

export function useDraftStart(store: ConversationDrafts | null | undefined, pipelineId: string): DraftStartState | null {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, () => store?.start(pipelineId) ?? null, () => null);
}

export function useLandedDraft(store: ConversationDrafts | null | undefined, taskId: string | null): string | null {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, () => (store && taskId ? store.landedFor(taskId) : null), () => null);
}

const noSubscribe = () => () => {};

/** Whether the lane's first messages hold an edit that Start would leave behind: open, saving, conflicted or unconfirmed. */
export function useUnsavedStageEdit(drafts: StageDrafts, pipelineId: string): boolean {
  return useSyncExternalStore(drafts.subscribe, () => drafts.entries().some(([, draft]) => draft.pipelineId === pipelineId), () => false);
}

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  SOURCE_HAS_CHANGES: "kanban.fromConversation.reason.dirty",
  SOURCE_WORKING_COPY_UNAVAILABLE: "kanban.fromConversation.reason.noWorkingCopy",
  SOURCE_BRANCH_UNAVAILABLE: "kanban.fromConversation.reason.noBranch",
  SOURCE_NOT_ON_TASK: "kanban.fromConversation.reason.notOnTask",
  SOURCE_PROJECT_MISMATCH: "kanban.fromConversation.reason.otherProject",
  SOURCE_CHANGED: "kanban.fromConversation.reason.changed",
  SOURCE_TEXT_UNAVAILABLE: "kanban.fromConversation.reason.noText",
  SOURCE_READ_TIMEOUT: "kanban.fromConversation.reason.busy",
  store_busy: "kanban.fromConversation.reason.busy",
  NOT_FOUND: "kanban.fromConversation.reason.notFound",
  workspace_forbidden: "kanban.fromConversation.reason.forbidden",
  operator_required: "kanban.fromConversation.reason.forbidden",
};

/** Why a source cannot be drafted, in the operator's language; the server's words for a reason this page has no name for. */
export function conversationRefusalText(t: TFunction, refusal: ConversationDraftError | null): string {
  if (!refusal) return t("kanban.fromConversation.reason.unreachable");
  const key = REASON_KEYS[refusal.code];
  return key ? t(key) : refusal.error || refusal.code;
}
