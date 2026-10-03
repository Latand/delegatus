"use client";

import { Bot } from "lucide-react";

import { X } from "@/components/icons";
import { TaskIcon } from "@/components/tasks/TaskIcon";
import { TASK_COLOR_HEX } from "@/components/tasks/taskColorHex";
import { useLocale } from "@/lib/i18n";
import type { SelectedTaskRef } from "@/lib/selection/selectedContext";

import { openTaskChip, removeTaskChip, useTaskChips } from "./taskChips";

/**
 * The tasks attached to the orchestrator's next message, drawn above its
 * input (docs/design: reference variant «Вибрана задача» above the composer).
 *
 * A chip is not text in the box: the draft stays the operator's words. Its
 * title opens the task on the board, and × takes it back out. The row is
 * absent when nothing is attached, so a composer with no chips has exactly the
 * layout it had before.
 */
export function TaskChipRow({ project }: { project: string }) {
  const { t } = useLocale();
  const chips = useTaskChips(project);
  if (!chips.length) return null;
  return (
    <ul role="list" aria-label={t("taskChip.list")} data-task-chips="" className="m-0 flex list-none flex-col gap-1 p-0">
      {chips.map((chip) => (
        <li
          key={chip.id}
          data-task-chip={chip.id}
          aria-label={t("taskChip.aria", { title: chip.title })}
          className="flex min-w-0 items-center gap-1.5 rounded-control border border-accent/30 bg-accent-soft py-0.5 pl-2 pr-0.5 text-label text-accent"
          style={chip.color ? { boxShadow: `inset 3px 0 0 ${TASK_COLOR_HEX[chip.color]}` } : undefined}
        >
          <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <button
            type="button"
            data-task-chip-open={chip.id}
            title={t("taskChip.open", { title: chip.title })}
            aria-label={t("taskChip.open", { title: chip.title })}
            className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => openTaskChip(project, chip.id)}
          >
            <span className="shrink-0 font-semibold">{t("taskChip.label")}</span>
            <TaskIcon icon={chip.icon} title={chip.title} size={14} tint={chip.color ? TASK_COLOR_HEX[chip.color] : null} omitDefault className="shrink-0" />
            <span className="min-w-0 truncate font-medium text-primary">{chip.title}</span>
          </button>
          <button
            type="button"
            data-task-chip-remove={chip.id}
            title={t("taskChip.remove", { title: chip.title })}
            aria-label={t("taskChip.remove", { title: chip.title })}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => removeTaskChip(project, chip.id)}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The same references on a sent message, in the history. Small and passive, the
 * way the selected-card badge is: what the message was about, readable beside
 * its text. A click opens the task on the board when the surface can.
 */
export function TaskChipBadges({ tasks, project, className = "" }: { tasks: readonly SelectedTaskRef[]; project?: string; className?: string }) {
  const { t } = useLocale();
  if (!tasks.length) return null;
  return (
    <span data-task-badges="" className={`flex max-w-full flex-wrap items-center gap-1 ${className}`}>
      {tasks.map((task) => {
        const body = (
          <>
            <Bot className="h-3 w-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{task.title}</span>
          </>
        );
        const cls = "inline-flex max-w-full items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] leading-tight text-accent";
        return project ? (
          <button
            key={task.id}
            type="button"
            data-task-badge={task.id}
            aria-label={t("taskChip.open", { title: task.title })}
            title={t("taskChip.open", { title: task.title })}
            className={`${cls} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
            onClick={() => openTaskChip(project, task.id)}
          >
            {body}
          </button>
        ) : (
          <span key={task.id} data-task-badge={task.id} aria-label={t("taskChip.aria", { title: task.title })} title={task.title} className={cls}>
            {body}
          </span>
        );
      })}
    </span>
  );
}
