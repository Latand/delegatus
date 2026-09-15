"use client";

import { createContext, useContext, useEffect, useRef } from "react";

import { DraftAgentPane } from "@/components/DraftAgentPane";
import { createTask } from "@/components/tasks/taskApi";
import { TaskComposer } from "@/components/tasks/TaskComposer";
import { WorkflowDraftPane } from "@/components/workflows/WorkflowDraftPane";
import { isWorkflowDraftId } from "@/components/workflows/workflowModel";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { CloseGlyph } from "./kanbanGlyphs";

/**
 * Agent drafts and the new task on the kanban board (#1695 K9a).
 *
 * A draft is the conversation an agent will be: engine, directory, account and
 * first prompt are chosen in the same `DraftAgentPane` the scheme board drew,
 * and its fields live in this tab's storage under the draft's id, so a draft
 * survives a reload, a collapse or a trip to Conversations. The board decides
 * which card holds it (its band); this module only draws it there.
 */

export interface KanbanDraftActions {
  project: string;
  files: FileEntry[];
  onClose: (id: string) => void;
  onSpawned: (id: string, file: FileEntry) => void;
}

/* A context, so a files poll re-renders the draft panes and leaves every other card alone. */
export const KanbanDraftContext = createContext<KanbanDraftActions | null>(null);

/** The drafts one card holds, each at reading width. */
export function CardDrafts({ ids }: { ids: readonly string[] }) {
  const actions = useContext(KanbanDraftContext);
  if (!actions || ids.length === 0) return null;
  return (
    <div className="agent-drafts">
      {ids.map((id) => (
        <div key={id} className="agent-draft" data-kanban-draft={id}>
          {isWorkflowDraftId(id) ? (
            <WorkflowDraftPane draftId={id} project={actions.project} onClose={() => actions.onClose(id)} onLaunched={() => actions.onClose(id)} />
          ) : (
            <DraftAgentPane
              draftId={id}
              project={actions.project}
              files={actions.files}
              onClose={() => actions.onClose(id)}
              onSpawned={(file) => actions.onSpawned(id, file)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * `+ Task`: an inline card at the top of Inbox (plan §12). The full shared
 * composer (text, voice, images, deadline) over the project's own task draft,
 * so text started here is the same draft the Tasks panel shows. The create
 * carries the draft's request id, so a double press or a retry after a lost
 * answer resolves to one task; a refusal keeps the text and says why.
 */
export function KanbanTaskComposer({ project, onCreated, onCancel }: { project: string; onCreated: (task: BoardTask) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const saveRef = useRef<(text?: string) => void | Promise<void>>(() => {});
  const draft = useTaskDraft(project, (overrideText) => saveRef.current(overrideText));
  const { composer } = draft;

  useEffect(() => {
    composer.inputRef.current?.focus();
  }, [composer.inputRef]);

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
      /* The kanban places no task on a map: its column is its status. */
      const created = await createTask({
        project,
        text,
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
      className="card shelf new-task"
      data-kanban-new-task=""
      aria-label={t("dash.newTask")}
      onSubmit={(event) => {
        event.preventDefault();
        void composer.submit();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="head">
        <h3 className="title"><span className="clamp">{t("dash.newTask")}</span></h3>
        <div className="tools">
          <button type="button" className="icon-btn" aria-label={t("common.close")} title={t("common.close")} onClick={onCancel}>
            <CloseGlyph />
          </button>
        </div>
      </div>
      <TaskComposer draft={draft} placeholder={t("tasks.newPlaceholder")} createLabel={t("tasks.panelCreate")} />
    </form>
  );
}
