"use client";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { cleanTitle, fmtAge } from "@/components/utils";

import { statusLabel } from "./KanbanCard";
import type { KanbanCard as KanbanCardModel } from "./kanbanModel";
import { KanbanPopover } from "./kanbanMenus";

/**
 * Everything the kanban board is not drawing, in one place (#1695 K4b,
 * prototype `openTray`): task groups hidden with `×` or a column's menu, empty
 * tasks taken off the board, and conversations closed on the board. Each row
 * brings its item back; nothing here stops, deletes or sends anything.
 *
 * Section heads appear only when more than one kind is hidden, so the common
 * case reads exactly as the prototype's single list.
 */
export function HiddenTray({ anchor, groups, offBoard, closed, nowMs, onClose, onShowGroup, onShowTask, onRestore }: {
  anchor: HTMLElement;
  groups: readonly KanbanCardModel[];
  offBoard: readonly BoardTask[];
  closed: readonly FileEntry[];
  nowMs: number;
  onClose: (refocus: boolean) => void;
  onShowGroup: (card: KanbanCardModel) => void;
  onShowTask: (task: BoardTask) => void;
  onRestore: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const total = groups.length + offBoard.length + closed.length;
  const sections = [groups.length, offBoard.length, closed.length].filter(Boolean).length;
  const head = (label: string) => (sections > 1 ? <div className="sec-label" role="presentation">{label}</div> : null);
  const titleOf = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
  return (
    <KanbanPopover anchor={anchor} label={t("kanban.hiddenTitle")} onClose={onClose} className="hidden-tray">
      <div className="head">{t("kanban.hiddenTitle")} <span className="n">· {total}</span></div>
      {groups.length ? (
        <div className="tray-section" data-tray-section="groups">
          {head(t("kanban.trayGroupsHead"))}
          {groups.map((card) => {
            const hide = card.task?.groupHidden;
            const since = hide ? Date.parse(hide.at) : Number.NaN;
            const age = Number.isFinite(since) ? (nowMs - since < 60_000 ? t("kanban.justNow") : fmtAge(since / 1000)) : "";
            return (
              <div key={card.id} className="row" data-hidden-group={card.task?.id}>
                <span className="pill" data-status={card.status} style={{ pointerEvents: "none" }}>{statusLabel(t, card.status)}</span>
                <span className="t">
                  <span className="title">{card.titlePending ? t("kanban.untitled") : card.title}</span>
                  <span className="meta">
                    {card.working ? <><span className="working">{t("kanban.trayWorking", { count: card.working })}</span> · </> : null}
                    {t("kanban.trayConversations", { count: card.conversations })}
                    {hide ? <> · {t("kanban.trayGroupMeta", { who: t(hide.by === "agent" ? "kanban.hiddenBy.agent" : "kanban.hiddenBy.operator"), age })}</> : null}
                  </span>
                </span>
                <button type="button" className="show" onClick={() => { onClose(false); onShowGroup(card); }}>{t("kanban.showOnBoard")}</button>
              </div>
            );
          })}
        </div>
      ) : null}
      {offBoard.length ? (
        <div className="tray-section" data-tray-section="empty">
          {head(t("kanban.trayEmptyHead"))}
          {offBoard.map((task) => (
            <div key={task.id} className="row" data-hidden-task={task.id}>
              <span className="pill" data-status={task.status} style={{ pointerEvents: "none" }}>{statusLabel(t, task.status)}</span>
              <span className="t">
                <span className="title">{titleOf(task.text)}</span>
                <span className="meta">{t("kanban.offBoardMeta")}</span>
              </span>
              <button type="button" className="show" onClick={() => { onClose(false); onShowTask(task); }}>{t("kanban.showOnBoard")}</button>
            </div>
          ))}
        </div>
      ) : null}
      {closed.length ? (
        <div className="tray-section" data-tray-section="closed">
          {head(t("kanban.trayClosedHead"))}
          {closed.map((file) => (
            <div key={file.path} className="row" data-closed-conversation={file.path}>
              <span className={`engine ${file.engine === "claude" || file.engine === "codex" ? file.engine : "other"}`} title={file.engine} />
              <span className="t">
                <span className="title">{cleanTitle(file.title ?? "", 80) || t("kanban.untitledConversation")}</span>
                <span className="meta">{t("kanban.trayClosedMeta")}</span>
              </span>
              <button type="button" className="show" onClick={() => { onClose(false); onRestore(file); }}>{t("kanban.trayRestore")}</button>
            </div>
          ))}
        </div>
      ) : null}
      <p className="note">{total ? t("kanban.trayNote") : t("kanban.trayNothing")}</p>
    </KanbanPopover>
  );
}
