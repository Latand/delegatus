"use client";

import { ChevronLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { X } from "@/components/icons";
import { fmtAge } from "@/components/utils";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { projectDisplayName } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { createTask, sendTask } from "./taskApi";
import { TaskComposer } from "./TaskComposer";
import { TASK_TONES, taskTitle } from "./taskModel";
import { TargetChecklist } from "./TargetChecklist";
import { pushTaskToast, sendSummary } from "./taskToast";
import { Z } from "@/components/layers";

export type TaskSheetView = "list" | "new";

/** Create view: the shared task composer (text, voice, images, deadline) plus
    the target checkboxes. Commits an `unplaced` task — placement is a board
    gesture the phone defers to `place on map`. */
function NewTaskView({
  project,
  files,
  onCreated,
}: {
  project: string;
  files: FileEntry[];
  onCreated: (task: BoardTask) => void;
}) {
  const { t } = useLocale();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  /* The composer needs its `submit` at construction, before `save` exists; a
     ref (updated in an effect) bridges the two without a forward reference. */
  const saveRef = useRef<(text?: string) => void | Promise<void>>(() => {});
  const draft = useTaskDraft(project, (overrideText) => saveRef.current(overrideText));
  const { composer } = draft;

  const save = async (overrideText?: string) => {
    const payloadText = (overrideText ?? composer.textRef.current).trim();
    if (composer.busy || composer.voiceSending) return;
    if (!payloadText) {
      composer.setStatus({ kind: "err", text: t("tasks.composerNeedsText") });
      return;
    }
    composer.setBusy(true);
    composer.setStatus(null);
    try {
      /* Images were uploaded to durable, task-ownable refs the moment they were
         picked, so a create-with-images (even without targets) can never drop
         them and the refs already survived any reload. */
      const created = await createTask({
        project,
        text: payloadText,
        placement: "unplaced",
        dueAt: draft.dueAt,
        dueTz: draft.dueTz,
        attachments: draft.stagedAttachments(),
        clientRequestId: draft.getRequestId(),
      });
      if ("error" in created) {
        composer.setStatus({ kind: "err", text: created.error });
        return;
      }
      const targets = [...checked];
      if (targets.length) {
        /* Send carries the durable attachment paths in the delivery text —
           no separate image hop that could strand images on a failed target. */
        const sent = await sendTask(created.task.id, targets);
        if ("error" in sent) pushTaskToast("err", sent.error);
        else {
          const summary = sendSummary(sent, files);
          pushTaskToast(summary.kind, summary.text);
        }
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

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void draft.composer.submit();
      }}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
    >
      <div className="flex flex-col gap-1.5">
        <TaskComposer
          draft={draft}
          placeholder={t("tasks.newPlaceholder")}
          createLabel={t("tasks.sheetCreate")}
          leftSlot={
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-sunken px-1.5 py-1 text-[9.5px] font-semibold text-secondary">
              {t("tasks.sheetTargets", { count: checked.size })}
            </span>
          }
        />
      </div>
      <div className="flex flex-col gap-1 rounded-[10px] border border-border bg-card p-1.5">
        <div className="px-1 text-[10.5px] font-bold text-muted">{t("tasks.pickerTitle")}</div>
        <TargetChecklist files={files} project={project} checked={checked} onChange={setChecked} maxHeight={9999} />
      </div>
    </form>
  );
}

/**
 * The phone's task list and its create view, full-screen over the screen it
 * was opened on. A task in the list, and a task just created, open on the
 * phone's task screen (#2072 slice 5), which is where a task's status, text,
 * pipelines and agents live; this sheet has no editor of its own.
 */
export function TaskSheet({
  project,
  projectName,
  tasks,
  files,
  initialView,
  onClose,
  onOpenTask,
}: {
  project: string;
  projectName?: string;
  tasks: BoardTask[];
  files: FileEntry[];
  initialView: TaskSheetView;
  onClose: () => void;
  /** The task screen's opener: a row of the list, or the task just created. */
  onOpenTask: (task: BoardTask, from: "list" | "new") => void;
}) {
  const { t } = useLocale();
  const [view, setView] = useState<TaskSheetView>(initialView);
  const rows = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const doneRank = (task: BoardTask) => (task.status === "done" ? 1 : 0);
        return doneRank(a) - doneRank(b) || b.updatedAt.localeCompare(a.updatedAt);
      }),
    [tasks],
  );

  return (
    <div className={`fixed inset-0 ${Z.sheet} flex flex-col bg-canvas pb-[env(safe-area-inset-bottom)]`}>
      <div className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1.5">
        {view !== "list" ? (
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("tasks.sheetBack")}
            onClick={() => setView("list")}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
        <span className="shrink-0 pl-1 text-[13px] font-bold">
          {view === "new" ? t("tasks.sheetNew") : t("tasks.panelTitle")}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted" title={projectName ?? project}>{projectDisplayName(project, projectName)}</span>
        <button
          type="button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {view === "list" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          <button
            type="button"
            className="flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-[10px] border border-dashed border-accent/50 text-[13px] font-bold text-accent hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => setView("new")}
          >
            + {t("tasks.sheetNew")}
          </button>
          {rows.map((task) => {
            const tone = TASK_TONES[task.status];
            return (
              <button
                key={task.id}
                type="button"
                className={`flex w-full min-w-0 flex-col gap-0.5 rounded-[10px] border border-border bg-card px-2.5 py-2 text-left shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  task.status === "done" ? "opacity-60" : ""
                }`}
                data-task-sheet-row={task.id}
                onClick={() => onOpenTask(task, "list")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                    style={{ backgroundColor: tone.soft, color: tone.color }}
                  >
                    {t(`tasks.status.${task.status}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                    {taskTitle(task.text) || t("tasks.untitled")}
                  </span>
                </span>
                <span className="flex items-center gap-2 pl-0.5 text-[10.5px] text-muted">
                  {task.assignments.length ? <span>⤷ {task.assignments.length}</span> : null}
                  <span>{fmtAge(new Date(task.updatedAt).getTime() / 1000)}</span>
                </span>
              </button>
            );
          })}
          {!rows.length ? <div className="px-2 py-4 text-center text-[11.5px] text-muted">{t("tasks.sheetEmpty")}</div> : null}
        </div>
      ) : (
        <NewTaskView project={project} files={files} onCreated={(task) => onOpenTask(task, "new")} />
      )}
    </div>
  );
}
