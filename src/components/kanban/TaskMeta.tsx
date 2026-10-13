"use client";

import { formatDue, isOverdue } from "@/lib/tasks/helpers";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * A task's deadline and its images, the two facts the old Tasks panel alone
 * drew (docs/design/calm-task-cards-build.md, amendment): «⏰ 12 Oct, 14:00»
 * in the zone it was set in, «· overdue» in danger ink once it has passed,
 * and «📎 N». Quiet text, no control; nothing when the task has neither.
 */

export function hasTaskMeta(task: Pick<BoardTask, "dueAt" | "dueTz" | "attachments"> | null | undefined): boolean {
  return Boolean(task && ((task.dueAt && task.dueTz) || task.attachments?.length));
}

export function TaskMeta({ task, nowMs }: { task: Pick<BoardTask, "dueAt" | "dueTz" | "attachments">; nowMs: number }) {
  const { t, locale } = useLocale();
  const due = task.dueAt && task.dueTz ? formatDue(task.dueAt, task.dueTz, locale) : "";
  const overdue = Boolean(task.dueAt && due && isOverdue(task.dueAt, nowMs));
  const images = task.attachments?.length ?? 0;
  if (!due && !images) return null;
  return (
    <span className="task-meta" data-task-meta="">
      {due ? (
        <span className={`task-due${overdue ? " overdue" : ""}`} data-task-due={overdue ? "overdue" : "due"} title={t("cardState.dueTitle", { zone: task.dueTz! })}>
          ⏰ {due}{overdue ? ` · ${t("cardState.overdue")}` : ""}
        </span>
      ) : null}
      {images ? <span className="task-images" data-task-images={images} title={t("cardState.images", { count: images })}>📎 {images}</span> : null}
    </span>
  );
}
