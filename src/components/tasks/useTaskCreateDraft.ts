"use client";

import { useEffect, useRef } from "react";

import { useTaskDraft } from "@/hooks/useTaskDraft";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { createTask, type CreateTaskInput } from "./taskApi";

/**
 * The project's task draft, wired to one create: what every surface that makes a task from the shared composer
 * does (the Tasks panel, the kanban board's new-task card).
 *
 * The text (or a dictated override), the deadline, the staged images and the draft's request id go to the task
 * route, so a double press or a retry after a lost answer resolves to one task. Empty text, a busy composer or a
 * voice send in flight create nothing. A refusal keeps the draft and shows the route's words; a created task
 * resets the draft and is handed to `onCreated`.
 */
export function useTaskCreateDraft(
  project: string,
  placement: Pick<CreateTaskInput, "placement" | "pos">,
  onCreated: (task: BoardTask) => void,
) {
  const { t } = useLocale();
  /* A ref (updated in an effect) bridges the composer's `submit`, needed at construction, to the later `save`
     without a forward reference. */
  const saveRef = useRef<(text?: string) => void | Promise<void>>(() => {});
  const draft = useTaskDraft(project, (overrideText) => saveRef.current(overrideText));
  const { composer } = draft;

  const save = async (overrideText?: string) => {
    const text = (overrideText ?? composer.textRef.current).trim();
    if (composer.busy || composer.voiceSending) return;
    if (!text) {
      composer.setStatus({ kind: "err", text: t("tasks.composerNeedsText") });
      return;
    }
    composer.setBusy(true);
    composer.setStatus(null);
    try {
      const created = await createTask({
        project,
        text,
        ...placement,
        dueAt: draft.dueAt,
        dueTz: draft.dueTz,
        attachments: draft.stagedAttachments(),
        clientRequestId: draft.getRequestId(),
      });
      if ("error" in created) {
        composer.setStatus({ kind: "err", text: created.error });
        return;
      }
      draft.reset();
      onCreated(created.task);
    } finally {
      composer.setBusy(false);
    }
  };
  useEffect(() => {
    saveRef.current = save;
  });
  return draft;
}
