"use client";

import { memo, useState } from "react";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { GroupResurfaceReason } from "@/lib/tasks/groupHide";
import type { TaskColor, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { cleanTitle, fmtAge } from "@/components/utils";
import { latestAttempt, stageChipLabel } from "@/components/pipelines/pipelineModel";

import { CardInlineText, withinEdit } from "./CardInlineText";
import { CardDrafts } from "./KanbanDrafts";
import { ChevronDown, ChevronRight, CloseGlyph, MoreGlyph, svgProps } from "./kanbanGlyphs";
import type { KanbanCard as KanbanCardModel, KanbanMember, KanbanPipeline } from "./kanbanModel";
import { PastAttempts, PipelineSection, stageNames } from "./PipelineSection";
import type { PastAttempt } from "./pipelineGraph";
import type { PipelinePorts } from "./pipelinePorts";
import { ReaderSlot, type ReaderPlacement } from "./KanbanReaders";
import { StageDraftPanel } from "./StageDraft";
import type { StageDrafts } from "./stageDrafts";
import type { PipelineActionKind } from "./stagesModel";

/* One card of the kanban board, in the approved prototype's anatomy
   (`renderCard`): colour label, saving bar, title and tools, description,
   activity line, the compact pipeline summary, conversation tiles, and the
   footer whose status pill is the one place status changes. */

/** Pipelines that have ended: the rows a card folds away once it holds many. */
const ENDED_PIPELINE_STATES: ReadonlySet<string> = new Set(["completed", "closed"]);
/** Rows a card draws in full before the finished ones fold behind their count. */
const PIPELINE_ROWS_BEFORE_FOLD = 3;

/** When a pipeline ended, for the newest-first order of the folded rows. */
function pipelineEndedAtMs(pipeline: Pipeline): number {
  const ended = Date.parse(pipeline.closedAt ?? pipeline.createdAt ?? "");
  return Number.isFinite(ended) ? ended : 0;
}

const LockGlyph = () => <svg {...svgProps}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

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
    the card (the attempt a node opens, never a lineage-adopted helper), or
    whose first message is open in a panel. */
function selectedStages(pipeline: Pipeline, readerKeys: readonly string[], panels: readonly StagePanelLine[]): Set<string> {
  const open = new Set(readerKeys);
  const selected = new Set<string>(panels.filter((panel) => panel.pipelineId === pipeline.id).map((panel) => panel.stageId));
  for (const run of pipeline.runs) {
    const attempt = latestAttempt(pipeline, run.stageId);
    const identity = attempt?.conversationId ?? attempt?.agentPath;
    if (identity && open.has(identity)) selected.add(run.stageId);
  }
  return selected;
}

/** A waiting stage's panel on the card, as the board encodes it: `pipelineId\tstageId\tfolded`. */
interface StagePanelLine {
  pipelineId: string;
  stageId: string;
  folded: boolean;
}

export const stagePanelKey = (cardId: string, pipelineId: string, stageId: string) => `${cardId}\t${pipelineId}\t${stageId}`;

function parsePanels(encoded: string): StagePanelLine[] {
  return encoded ? encoded.split("\n").map((line) => {
    const [pipelineId = "", stageId = "", folded = "0"] = line.split("\t");
    return { pipelineId, stageId, folded: folded === "1" };
  }) : [];
}

function parseActing(encoded: string): Map<string, PipelineActionKind> {
  return new Map(encoded ? encoded.split("\n").map((line) => line.split("\t") as [string, PipelineActionKind]) : []);
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
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage, cardId: string) => void;
  onFocusCard: (cardId: string) => void;
  onOpenConversations: () => void;
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
  /** Waiting stages open on this card, one per line (see `StagePanelLine`). */
  stagePanels: string;
  /** Pipeline actions this page sent and the server has not answered: `pipelineId\taction` per line. */
  acting: string;
  drafts: StageDrafts;
  pipelinePorts: PipelinePorts;
  onOpenSheet: (cardId: string, pipeline: Pipeline) => void;
  onPipelineMenu: (cardId: string, pipeline: Pipeline, anchor: HTMLElement) => void;
  onStagePanelFold: (panelKey: string, folded: boolean) => void;
  onStagePanelClose: (panelKey: string) => void;
  onStagePanelMenu: (panelKey: string, anchor: HTMLElement) => void;
  /** «+ Agent» in the footer: a draft on this card, seeded with the task's text (K9a). */
  onAddAgent?: (card: KanbanCardModel) => void;
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
  const panels = parsePanels(props.stagePanels);
  const acting = parseActing(props.acting);
  const reading = !collapsed && (readerKeys.length > 0 || panels.length > 0 || card.drafts.length > 0);
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
  /* Several pipelines on one card: the running ones stay on top, and once the
     card holds more than three rows the finished ones fold behind one count,
     newest first (#1765). */
  const [completedOpen, setCompletedOpen] = useState(false);
  const livePipelines = card.pipelines.filter((summary) => !ENDED_PIPELINE_STATES.has(summary.pipeline.state));
  const endedPipelines = card.pipelines
    .filter((summary) => ENDED_PIPELINE_STATES.has(summary.pipeline.state))
    .sort((a, b) => pipelineEndedAtMs(b.pipeline) - pipelineEndedAtMs(a.pipeline));
  const foldCompleted = card.pipelines.length > PIPELINE_ROWS_BEFORE_FOLD && endedPipelines.length > 0;
  const shownPipelines = foldCompleted ? livePipelines : [...livePipelines, ...endedPipelines];
  const foldedPipelines = foldCompleted ? endedPipelines : [];
  const pipelineRow = (summary: KanbanPipeline) => (
    <PipelineSection
      key={summary.pipeline.id}
      summary={summary}
      open={props.graphChoices.get(`${card.id}|${summary.pipeline.id}`) ?? null}
      selected={selectedStages(summary.pipeline, readerKeys, panels)}
      acting={acting.get(summary.pipeline.id) ?? null}
      onToggle={(open) => props.onToggleGraph(card.id, summary.pipeline.id, open)}
      onOpenStage={(pipeline, stage) => props.onOpenStage(pipeline, stage, card.id)}
      onOpenSheet={(pipeline) => props.onOpenSheet(card.id, pipeline)}
      onMenu={(pipeline, anchor) => props.onPipelineMenu(card.id, pipeline, anchor)}
    />
  );
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

      {!collapsed ? (
        <>
          {shownPipelines.map(pipelineRow)}
          {foldedPipelines.length ? (
            <div className="done-pipelines" data-completed-pipelines={foldedPipelines.length}>
              <button
                type="button"
                className="btn quiet completed-toggle"
                aria-expanded={completedOpen}
                aria-label={t(completedOpen ? "kanban.pipelines.completedHide" : "kanban.pipelines.completedShow", { count: foldedPipelines.length })}
                data-completed-toggle={card.id}
                onClick={() => setCompletedOpen((open) => !open)}
              >
                {completedOpen ? <ChevronDown /> : <ChevronRight />}
                <span>{t("kanban.pipelines.completed", { count: foldedPipelines.length })}</span>
              </button>
              {completedOpen ? foldedPipelines.map(pipelineRow) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {!collapsed && (stageReaders.length || panels.length) ? (
        <div className="readers">
          {panels.map((panel) => {
            const summary = card.pipelines.find((entry) => entry.pipeline.id === panel.pipelineId);
            const stage = summary?.pipeline.stages.find((entry) => entry.id === panel.stageId);
            if (!summary || !stage) return null;
            const key = stagePanelKey(card.id, panel.pipelineId, panel.stageId);
            const attempt = latestAttempt(summary.pipeline, stage.id);
            const recorded = attempt && (attempt.agentPath || attempt.conversationId) ? { path: attempt.agentPath, conversationId: attempt.conversationId } : null;
            return (
              <StageDraftPanel
                key={key}
                panelKey={key}
                cardTitle={title}
                pipeline={summary.pipeline}
                stage={stage}
                names={stageNames(t, summary.pipeline)}
                folded={panel.folded}
                drafts={props.drafts}
                ports={props.pipelinePorts}
                onFold={(folded) => props.onStagePanelFold(key, folded)}
                onClose={() => props.onStagePanelClose(key)}
                onMenu={(anchor) => props.onStagePanelMenu(key, anchor)}
                onOpenConversation={recorded ? () => props.onOpenAttempt(recorded) : null}
              />
            );
          })}
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

      {!collapsed ? <CardDrafts ids={card.drafts} /> : null}

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
            <button type="button" className="ref quiet" onClick={props.onOpenConversations}>
              {t("kanban.notLoaded", { count: card.notLoaded })}
            </button>
          ) : null}
          {card.otherSurfaces ? (
            <button type="button" className="ref quiet" onClick={props.onOpenConversations}>
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
          {props.onAddAgent ? (
            <button type="button" className="add" data-add-agent={card.id} aria-label={t("kanban.addAgentAria", { title })} onClick={() => props.onAddAgent!(card)}>
              <span className="plus" aria-hidden="true">+</span> {t("kanban.addAgent")}
            </button>
          ) : null}
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
