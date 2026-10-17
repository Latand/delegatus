"use client";

import { useEffect, useRef } from "react";

import { applyTaskSnapshot, revertTaskSnapshot } from "@/hooks/useFiles";
import { useTaskDraft, type TaskDraftCapture } from "@/hooks/useTaskDraft";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { createTask, type CreateTaskInput } from "./taskApi";

const PROVISIONAL_PREFIX = "provisional:";

/** Whether a task id is a card drawn ahead of its create. */
export function isProvisionalTaskId(id: string): boolean {
  return id.startsWith(PROVISIONAL_PREFIX);
}

function provisionalTask(project: string, taken: TaskDraftCapture, placement: Pick<CreateTaskInput, "placement" | "pos">): BoardTask {
  const at = new Date().toISOString();
  return {
    id: `${PROVISIONAL_PREFIX}${taken.requestId}`, project, status: "inbox", text: taken.text, placement: placement.placement,
    ...(placement.pos ? { pos: placement.pos } : {}), ...(taken.dueAt ? { dueAt: taken.dueAt, dueTz: taken.dueTz } : {}),
    ...(taken.attachments.length ? { attachments: taken.attachments } : {}), assignments: [], createdAt: at, updatedAt: at,
  };
}

/**
 * The project's task draft, wired to one create: what every surface that makes a task from the shared composer
 * does (the kanban board's new-task card).
 *
 * The text (or a dictated override), the deadline, the staged images and the draft's request id go to the task
 * route, so a double press or a retry after a lost answer resolves to one task. Empty text, a busy composer or a
 * voice send in flight create nothing. The composer resets on the press and a provisional Inbox card, keyed by the
 * request id and drawn as saving, stands in for the task until the route answers; the created task (or the one a
 * retry matched) replaces it and is handed to `onCreated`. A refusal takes the card off, puts the text, deadline
 * and images back into the composer and shows the route's words.
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
    const taken = draft.capture(text);
    const card = provisionalTask(project, taken, placement);
    applyTaskSnapshot(card, false);
    composer.setStatus(null);
    draft.reset();
    const created = await createTask({
      project,
      text,
      ...placement,
      dueAt: taken.dueAt,
      dueTz: taken.dueTz,
      attachments: taken.attachments,
      clientRequestId: taken.requestId,
    });
    revertTaskSnapshot(card.id);
    if ("error" in created) {
      draft.restore(taken);
      composer.setStatus({ kind: "err", text: created.error });
      return;
    }
    applyTaskSnapshot(created.task, true);
    onCreated(created.task);
  };
  useEffect(() => {
    saveRef.current = save;
  });
  return draft;
}
