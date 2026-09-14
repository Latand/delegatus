"use client";

import { memo } from "react";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { GroupResurfaceReason } from "@/lib/tasks/groupHide";
import type { TaskColor, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { cleanTitle, fmtAge } from "@/components/utils";
import { latestAttempt, stageChipLabel } from "@/components/pipelines/pipelineModel";

import { CardInlineText, withinEdit } from "./CardInlineText";
import type { KanbanCard as KanbanCardModel, KanbanMember } from "./kanbanModel";
import { PastAttempts, PipelineSection, stageNames } from "./PipelineSection";
import type { PastAttempt } from "./pipelineGraph";
import { ReaderSlot, type ReaderPlacement } from "./KanbanReaders";

/* One card of the kanban board, in the approved prototype's anatomy
   (`renderCard`): colour label, saving bar, title and tools, description,
   activity line, the compact pipeline summary, conversation tiles, and the
   footer whose status pill is the one place status changes. */

const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
export const ChevronDown = () => <svg {...svgProps} className="chev"><path d="m6 9 6 6 6-6" /></svg>;
export const ChevronRight = () => <svg {...svgProps} className="chev"><path d="m9 6 6 6-6 6" /></svg>;
export const MoreGlyph = () => (
  <svg {...svgProps}>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const CloseGlyph = () => <svg {...svgProps}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const LockGlyph = () => <svg {...svgProps}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

/** The hue each colour name is drawn with; the name is what the board says. */
export const TASK_COLOR_HEX: Record<TaskColor, string> = {
  coral: "#e07a5f",
  amber: "#d9a400",
  lime: "#7cb342",
  teal: "#1a9e8f",
  sky: "#3d7fd6",
  violet: "#8a63d2",
  pink: "#d64f8a",
  slate: "#7b8a99",
};

export function resurfaceText(t: TFunction, reason: GroupResurfaceReason): string {
  return t(`kanban.resurfaced.${reason.kind}`);
}

export function statusLabel(t: TFunction, status: TaskStatus): string {
  return t(`kanban.status.${status}`);
}

/** The stages whose latest own attempt's conversation is open as a reader on
    the card: the attempt a node opens, never a lineage-adopted helper. */
function selectedStages(pipeline: Pipeline, readerKeys: readonly string[]): Set<string> {
  const open = new Set(readerKeys);
  const selected = new Set<string>();
  for (const run of pipeline.runs) {
    const attempt = latestAttempt(pipeline, run.stageId);
    const identity = attempt?.conversationId ?? attempt?.agentPath;
    if (identity && open.has(identity)) selected.add(run.stageId);
  }
  return selected;
}

function engineClass(file: FileEntry): string {
  return file.engine === "claude" || file.engine === "codex" ? file.engine : "other";
}

function memberRole(t: TFunction, member: KanbanMember): string {
  if (member.stage) return stageChipLabel(t, member.stage.stage);
  return cleanTitle(member.file.title ?? "", 80) || t("kanban.untitledConversation");
}

const MemberTile = memo(function MemberTile({ member, workspace, onOpen }: { member: KanbanMember; workspace: boolean; onOpen: (file: FileEntry) => void }) {
  const { t } = useLocale();
  const role = memberRole(t, member);
  const state = t(`kanban.memberState.${member.state}`);
  const stateClass = member.needsYou ? "needs" : member.working ? "working" : member.state;
  return (
    <button
      type="button"
      role="listitem"
      className={`tile${member.working ? " working" : ""}${member.needsYou ? " needs" : ""}`}
      data-member={member.file.path}
      aria-label={t("kanban.openMember", { role, state })}
      style={workspace ? undefined : { width: "100%" }}
      onClick={() => onOpen(member.file)}
    >
      <span className="row">
        <span className={`engine ${engineClass(member.file)}`} title={member.file.engine} />
        <span className="role">{role}</span>
        <span className={`state ${stateClass}`}>{state}</span>
      </span>
      {member.latest ? <span className="latest">{member.latest}</span> : null}
      <span className="age">{fmtAge(member.file.mtime)}</span>
    </button>
  );
});

export interface KanbanCardProps {
  card: KanbanCardModel;
  status: TaskStatus;
  pending: boolean;
  collapsed: boolean;
  nowMs: number;
  onToggleCollapsed: (id: string) => void;
  onStatusMenu: (card: KanbanCardModel, anchor: HTMLElement) => void;
  onCardMenu: (card: KanbanCardModel, anchor: HTMLElement) => void;
  onKey: (card: KanbanCardModel, event: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (card: KanbanCardModel, event: React.PointerEvent<HTMLElement>) => void;
  onOpenMember: (file: FileEntry) => void;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void;
  onFocusCard: (cardId: string) => void;
  onOpenCatalog: () => void;
  onOpenOnBoard: () => void;
  /** The title or description being edited on this card, with its draft. */
  editing: { field: "title" | "description"; draft: string } | null;
  /** A save the server refused: the draft is kept for Retry. */
  failedEdit: { field: "title" | "description"; draft: string; message: string } | null;
  /** Text an agent wrote to the field being edited, offered beside the draft. */
  incomingEdit: { field: "title" | "description"; value: string } | null;
  onStartEdit: (card: KanbanCardModel, field: "title" | "description") => void;
  onEditDraft: (cardId: string, draft: string) => void;
  onCommitEdit: (cardId: string) => void;
  onCancelEdit: (cardId: string) => void;
  onRetryEdit: (cardId: string) => void;
  onDiscardEdit: (cardId: string) => void;
  onUseTheirs: (cardId: string) => void;
  onKeepMine: (cardId: string) => void;
  onHide: (card: KanbanCardModel) => void;
  /** The operator's graph-or-summary choices, by `cardId|pipelineId`. */
  graphChoices: ReadonlyMap<string, boolean>;
  onToggleGraph: (cardId: string, pipelineId: string, open: boolean) => void;
  /** Open the conversation an earlier attempt or review round kept. */
  onOpenAttempt: (conversation: PastAttempt["conversation"]) => void;
  /** Open readers this card shows, by conversation identity, one per line —
      a string so an unchanged set never re-renders the card. */
  readerKeys: string;
  placement: ReaderPlacement;
}

function ageLabel(t: TFunction, updatedAtMs: number, nowMs: number): string {
  if (!updatedAtMs) return "";
  if (nowMs - updatedAtMs < 60_000) return t("kanban.justNow");
  return fmtAge(updatedAtMs / 1000);
}

export const KanbanCard = memo(function KanbanCard(props: KanbanCardProps) {
  const { card, status, pending, collapsed, nowMs, editing, failedEdit, incomingEdit } = props;
  /* The card holding the orchestrator's conversation stays on the board. */
  const protectedSeat = card.holdsSeat;
  const resurfaced = card.task && !card.hide.hidden ? card.hide.resurfaced : null;
  const { t } = useLocale();
  const workspace = status === "assigned";
  const title = card.titlePending ? t("kanban.untitled") : card.title;
  const pipelinesWaiting = card.pipelines.reduce((sum, summary) => sum + summary.waiting, 0);
  const statusText = statusLabel(t, status);
  /* A pipeline stage's conversation is reached through its stage chip, as in
     the prototype; tiles are the conversations that run outside a pipeline. */
  const tiles = card.members.filter((member) => member.stage === null);
  const readerKeys = props.readerKeys ? props.readerKeys.split("\n") : [];
  const reading = !collapsed && readerKeys.length > 0;
  const tileKeys = new Set(tiles.map((member) => conversationIdentity(member.file)));
  /* A stage's reader opens under the card's pipeline; a tile's reader takes
     the tile's place. */
  const stageReaders = readerKeys.filter((key) => !tileKeys.has(key));
  const openTiles = new Set(readerKeys.filter((key) => tileKeys.has(key)));
  const aria = [title, statusText, card.working ? t("kanban.activityWorking", { count: card.working }) : "", card.needsYou ? t("kanban.activityNeeds") : "", collapsed ? t("kanban.collapsed") : ""]
    .filter(Boolean)
    .join(", ");
  /* What is happening now, never a status: working, owed an answer, how many
     conversations, or plainly that nothing is on it. */
  const activity: Array<{ key: string; node: React.ReactNode }> = [];
  if (card.working) activity.push({ key: "working", node: <span className="working num">{t("kanban.activityWorking", { count: card.working })}</span> });
  if (card.needsYou) activity.push({ key: "needs", node: <span className="needs">{t("kanban.activityNeeds")}</span> });
  if (card.conversations) activity.push({ key: "conversations", node: <span className="quiet num">{t("kanban.activityConversations", { count: card.conversations })}</span> });
  else if (card.pipelines.length === 0) activity.push({ key: "none", node: <span className="quiet">{t("kanban.activityNoAgent")}</span> });
  if (pipelinesWaiting) activity.push({ key: "waiting", node: <span className="quiet num">{t("kanban.activityStagesWaiting", { count: pipelinesWaiting })}</span> });
  const hex = card.color ? TASK_COLOR_HEX[card.color] : null;
  const style = hex ? ({ "--label": hex, "--label-strong": hex } as React.CSSProperties) : undefined;
  return (
    <article
      className={`card${status === "done" ? " done" : ""} ${workspace ? "work" : "shelf"}${collapsed ? " folded" : ""}${reading ? " has-reader" : ""}`}
      data-id={card.id}
      data-kanban-card={card.id}
      data-pending={pending ? "1" : "0"}
      data-collapsed={collapsed ? "1" : "0"}
      data-color={card.color ?? "none"}
      data-protected={protectedSeat ? "1" : undefined}
      style={style}
      tabIndex={0}
      aria-label={protectedSeat ? `${aria}, ${t("kanban.staysOnBoard")}` : aria}
      onKeyDown={(event) => props.onKey(card, event)}
      onPointerDown={(event) => props.onPointerDown(card, event)}
    >
      <span className="label" aria-hidden="true" />
      <span className="saving" aria-hidden="true" />
      <div className="head">
        {editing?.field === "title" ? (
          <CardInlineText
            field="title"
            draft={editing.draft}
            onDraft={(draft) => props.onEditDraft(card.id, draft)}
            onCommit={() => props.onCommitEdit(card.id)}
            onCancel={() => props.onCancelEdit(card.id)}
          />
        ) : (
          <h3 className={`title${card.titlePending ? " pending" : ""}`}>
            {card.task ? (
              <button
                type="button"
                className="title-trigger"
                data-rename={card.id}
                aria-label={card.titlePending ? t("kanban.renamePending") : t("kanban.renameAria", { title })}
                title={card.title.length > 80 ? card.title : t("kanban.renameHint")}
                onClick={() => props.onStartEdit(card, "title")}
              >
                <span className="clamp">{title}</span>
              </button>
            ) : (
              <span className="clamp" title={card.title.length > 80 ? card.title : undefined}>{title}</span>
            )}
          </h3>
        )}
        <div className="tools">
          <button
            type="button"
            className="icon-btn fold"
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? "kanban.expandCard" : "kanban.collapseCard", { title })}
            title={t(collapsed ? "kanban.expandCardShort" : "kanban.collapseCardShort")}
            onClick={() => props.onToggleCollapsed(card.id)}
          >
            {collapsed ? <ChevronRight /> : <ChevronDown />}
          </button>
          {card.task && protectedSeat ? (
            <span className="icon-btn lock" role="img" aria-label={t("kanban.seatProtected")} title={t("kanban.seatProtected")} data-lock="">
              <LockGlyph />
            </span>
          ) : card.task ? (
            <button
              type="button"
              className="icon-btn hide"
              data-hide={card.id}
              aria-label={t("kanban.hideAria", { title })}
              title={t("kanban.hideHint")}
              onClick={() => props.onHide(card)}
            >
              <CloseGlyph />
            </button>
          ) : null}
          {card.task ? (
            <button
              type="button"
              className="icon-btn"
              aria-label={t("kanban.cardActions", { title })}
              aria-haspopup="menu"
              data-menu={card.id}
              onClick={(event) => props.onCardMenu(card, event.currentTarget)}
            >
              <MoreGlyph />
            </button>
          ) : null}
        </div>
      </div>
      {card.titlePending && editing?.field !== "title" ? <p className="pending-line">{t("kanban.namePending")}</p> : null}
      {collapsed ? null : editing?.field === "description" ? (
        <CardInlineText
          field="description"
          draft={editing.draft}
          onDraft={(draft) => props.onEditDraft(card.id, draft)}
          onCommit={() => props.onCommitEdit(card.id)}
          onCancel={() => props.onCancelEdit(card.id)}
        />
      ) : card.task && (card.description || workspace) ? (
        <button
          type="button"
          className={`desc${card.description ? "" : " placeholder"}`}
          data-describe={card.id}
          aria-label={card.description ? t("kanban.editDescription") : t("kanban.addDescription")}
          onClick={() => props.onStartEdit(card, "description")}
        >
          <span className="clamp">{card.description || t("kanban.addDescription")}</span>
        </button>
      ) : card.description ? (
        <p className="desc"><span className="clamp">{card.description}</span></p>
      ) : null}

      {!collapsed && failedEdit ? (
        <div className="notice error" role="alert" data-edit-failed={failedEdit.field}>
          <span className="msg">{t("kanban.notSaved", { error: failedEdit.message })}</span>
          <button type="button" onClick={() => props.onRetryEdit(card.id)}>{t("kanban.retry")}</button>
          <button type="button" onClick={() => props.onDiscardEdit(card.id)}>{t("kanban.discard")}</button>
        </div>
      ) : null}
      {!collapsed && incomingEdit ? (
        /* Part of the edit: pressing its buttons, however slowly, never counts
           as leaving the field, and only leaving both saves. */
        <div
          className="notice info"
          role="status"
          data-edit-incoming={incomingEdit.field}
          data-edit-scope=""
          onBlur={(event) => {
            const cardElement = event.currentTarget.closest<HTMLElement>("[data-kanban-card]");
            setTimeout(() => {
              if (!cardElement?.isConnected || withinEdit(cardElement, document.activeElement)) return;
              props.onCommitEdit(card.id);
            }, 0);
          }}
        >
          <span className="msg">{t(incomingEdit.field === "title" ? "kanban.incomingTitle" : "kanban.incomingDescription", { value: incomingEdit.value })}</span>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => props.onUseTheirs(card.id)}>{t("kanban.useTheirs")}</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => props.onKeepMine(card.id)}>{t("kanban.keepMine")}</button>
        </div>
      ) : null}
      {!collapsed && resurfaced ? (
        <div className="notice info resurfaced" role="status" data-resurfaced={resurfaced.kind}>
          <span className="msg">{t("kanban.resurfacedLine", { reason: resurfaceText(t, resurfaced) })}</span>
          {protectedSeat ? null : <button type="button" onClick={() => props.onHide(card)}>{t("kanban.hideAgain")}</button>}
        </div>
      ) : null}

      <div className="activity">
        {activity.map((part, index) => (
          <span key={part.key} className="part">
            {index > 0 ? <span className="sep" aria-hidden="true">·</span> : null}
            {part.node}
          </span>
        ))}
      </div>

      {!collapsed ? card.pipelines.map((summary) => (
        <PipelineSection
          key={summary.pipeline.id}
          summary={summary}
          open={props.graphChoices.get(`${card.id}|${summary.pipeline.id}`) ?? null}
          selected={selectedStages(summary.pipeline, readerKeys)}
          onToggle={(open) => props.onToggleGraph(card.id, summary.pipeline.id, open)}
          onOpenStage={props.onOpenStage}
        />
      )) : null}

      {!collapsed && stageReaders.length ? (
        <div className="readers">
          {stageReaders.map((key) => <ReaderSlot key={key} placement={props.placement} readerKey={key} />)}
        </div>
      ) : null}

      {!collapsed && tiles.length ? (
        <div className="members" role="list" aria-label={t("kanban.conversations")}>
          {tiles.map((member) => {
            const key = conversationIdentity(member.file);
            return openTiles.has(key) ? (
              <div key={member.key} role="listitem" className="member-reader">
                <ReaderSlot placement={props.placement} readerKey={key} />
              </div>
            ) : (
              <MemberTile key={member.key} member={member} workspace={workspace} onOpen={props.onOpenMember} />
            );
          })}
        </div>
      ) : null}

      {!collapsed && card.past.length ? (
        <PastAttempts
          rows={card.past}
          names={new Map(card.pipelines.map((summary) => [summary.pipeline.id, stageNames(t, summary.pipeline)] as const))}
          nowMs={nowMs}
          onOpen={props.onOpenAttempt}
        />
      ) : null}

      {!collapsed && (card.mirrors.length || card.notLoaded || card.otherSurfaces) ? (
        <div className="refs">
          {card.mirrors.map((mirror) => (
            <button key={mirror.key} type="button" className="ref" onClick={() => props.onFocusCard(mirror.primaryCardId)}>
              {t("kanban.alsoOn", { title: cleanTitle(mirror.file.title ?? "", 48) || t("kanban.untitledConversation"), card: mirror.primaryTitle })}
            </button>
          ))}
          {card.notLoaded ? (
            <button type="button" className="ref quiet" onClick={props.onOpenCatalog}>
              {t("kanban.notLoaded", { count: card.notLoaded })}
            </button>
          ) : null}
          {card.otherSurfaces ? (
            <button type="button" className="ref quiet" onClick={props.onOpenOnBoard}>
              {t("kanban.otherSurfaces", { count: card.otherSurfaces })}
            </button>
          ) : null}
        </div>
      ) : null}

      {card.task ? (
        <div className="foot">
          <button
            type="button"
            className="pill"
            data-status={status}
            aria-haspopup="menu"
            aria-label={t("kanban.statusAria", { status: statusText })}
            onClick={(event) => props.onStatusMenu(card, event.currentTarget)}
          >
            {statusText} <ChevronDown />
          </button>
          <span className="age num" title={t("kanban.updated", { age: ageLabel(t, card.updatedAtMs, nowMs) })}>{ageLabel(t, card.updatedAtMs, nowMs)}</span>
          <span className="spacer" />
        </div>
      ) : (
        <div className="foot">
          <span className="origin-chip">{t(`kanban.origin.${card.origin}`)}</span>
          <span className="age num">{ageLabel(t, card.updatedAtMs, nowMs)}</span>
        </div>
      )}
    </article>
  );
});
