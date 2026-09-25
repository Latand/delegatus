"use client";

import { memo, useState } from "react";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { GroupResurfaceReason } from "@/lib/tasks/groupHide";
import type { TaskColor, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { ResolvedWorkLinks } from "@/lib/forge/workLinks";
import { EngineMark } from "@/components/EngineMark";
import { cleanTitle, fmtAge } from "@/components/utils";
import { latestAttempt, stageAttemptPlace, stageCardLabel, stageCardLabelParts, stageLabelTitle } from "@/components/pipelines/pipelineModel";
import { PipelineBlock } from "@/components/pipelines/PipelineBlock";
import { laneMergeUnsettled, type PipelineAnswer } from "@/components/pipelines/pipelineBlockModel";
import { clearedLine, needLabel } from "@/components/attention/decision";
import type { NeedReason } from "@/components/attention/needReason";

import { TaskIcon } from "@/components/tasks/TaskIcon";
import { WorkLinkRow } from "@/components/workLinks/WorkLinkChips";
import { useWorkLinks, type WorkLinkTarget } from "@/components/workLinks/workLinksContext";

import { CardInlineText, withinEdit, type CardEditField } from "./CardInlineText";
import { CardDrafts } from "./KanbanDrafts";
import { engineWord } from "./identityMarks";
import { CheckGlyph, ChevronDown, ChevronRight, CloseGlyph, MoreGlyph, svgProps } from "./kanbanGlyphs";
import type { KanbanCard as KanbanCardModel, KanbanMember, KanbanPipeline, KanbanUnstartedLaunch } from "./kanbanModel";
import { PastAttempts, stageNames } from "./PipelineSection";
import type { PastAttempt } from "./pipelineGraph";
import type { PipelinePorts } from "./pipelinePorts";
import { ReaderSlot, type ReaderPlacement } from "./KanbanReaders";
import { StageDraftPanel } from "./StageDraft";
import type { StageDrafts } from "./stageDrafts";
import type { PipelineActionKind } from "./stagesModel";

/* One card of the kanban board, in the approved prototype's anatomy
   (`renderCard`) made flat (#2072, docs/design/desktop-flat-cards.md §4,
   variant B): colour label, saving bar, the task's icon (#2102), title and
   tools, the links no lane row draws, description, the collapsed Details row
   carrying the agent's context (#1834), one lane row per pipeline
   (`PipelineBlock` at task density), the conversations as rows, and the
   footer: the age, who is working and how many conversations the card holds.

   The column the card stands in names its status, so the card does not
   repeat it (#2148): status changes from the card's ⋯ ("Move to"), the S key
   or a drag. That ⋯ is the card's one menu: each lane's actions are a group
   in it, and a lane's stage chain is its head row.

   The card is the only frame. A lane is set apart by space, a stage pill
   is an outline with no fill, and a conversation is a row. What the old
   activity line said moved to where it belongs: "needs you" to the amber edge
   and the lane's own state word, the working and conversation counts to the
   footer, and the stages still waiting to their dashed pills.

   Why the card needs the operator is named at its foot (docs/design/
   needs-attention.md §4): the oldest reason, "+N" for the rest, and a Dismiss
   control that clears them all until something new asks. A cleared card says
   who cleared it, and that line is its Undo. */

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

function memberRole(t: TFunction, member: KanbanMember): string {
  if (member.stage) return stageCardLabel(t, member.stage.stage, stageAttemptPlace(member.stage.pipeline, member.stage.stage.id, member.file));
  return cleanTitle(member.file.title ?? "", 80) || t("kanban.untitledConversation");
}

const MemberTile = memo(function MemberTile({ member, workspace, onOpen }: { member: KanbanMember; workspace: boolean; onOpen: (file: FileEntry) => void }) {
  const { t } = useLocale();
  const role = memberRole(t, member);
  /* A tile that needs the operator names why in its title. */
  const reason = member.needsYou && member.need ? needLabel(t, member.need) : undefined;
  /* A stage's tile sets its attempt apart as a muted suffix that survives the
     name's truncation, and names the role preset only in its tooltip (#1865). */
  const place = member.stage ? stageAttemptPlace(member.stage.pipeline, member.stage.stage.id, member.file) : null;
  const parts = member.stage && place ? stageCardLabelParts(t, member.stage.stage, place) : null;
  const engine = member.file.engine === "claude" || member.file.engine === "codex" ? engineWord(member.file.engine) : null;
  const hint = member.stage && place ? stageLabelTitle(t, member.stage.stage, place, engine) : undefined;
  const state = t(`kanban.memberState.${member.state}`);
  const stateClass = member.needsYou ? "needs" : member.working ? "working" : member.state;
  return (
    <button
      type="button"
      role="listitem"
      className={`tile${workspace ? "" : " fill"}${member.working ? " working" : ""}${member.needsYou ? " needs" : ""}`}
      data-member={member.file.path}
      title={reason}
      aria-label={t("kanban.openMember", { role, state })}
      onClick={() => onOpen(member.file)}
    >
      <span className="row">
        <EngineMark engine={member.file.engine} size={12} className="engine" label={member.file.engine} />
        <span className="role" title={hint}>{parts ? parts.name : role}</span>
        {parts && parts.attempt !== null ? <span className="attempt"> · {parts.attempt}</span> : null}
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
  onCardMenu: (card: KanbanCardModel, anchor: HTMLElement) => void;
  onKey: (card: KanbanCardModel, event: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (card: KanbanCardModel, event: React.PointerEvent<HTMLElement>) => void;
  onOpenMember: (file: FileEntry) => void;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage, cardId: string) => void;
  onFocusCard: (cardId: string) => void;
  onOpenConversations: () => void;
  /** The title, description or details being edited on this card, with its draft. */
  editing: { field: CardEditField; draft: string } | null;
  /** A save the server refused: the draft is kept for Retry. */
  failedEdit: { field: CardEditField; draft: string; message: string } | null;
  /** Text an agent wrote to the field being edited, offered beside the draft. */
  incomingEdit: { field: CardEditField; value: string } | null;
  onStartEdit: (card: KanbanCardModel, field: CardEditField) => void;
  onEditDraft: (cardId: string, draft: string) => void;
  onCommitEdit: (cardId: string) => void;
  onCancelEdit: (cardId: string) => void;
  onRetryEdit: (cardId: string) => void;
  onDiscardEdit: (cardId: string) => void;
  onUseTheirs: (cardId: string) => void;
  onKeepMine: (cardId: string) => void;
  onHide: (card: KanbanCardModel) => void;
  /** The icon before the title opens the task icon picker (#2102). Absent,
      the icon is drawn and changes nothing. */
  onIconMenu?: (card: KanbanCardModel, anchor: HTMLElement) => void;
  /** The operator's graph-or-summary choices, by `cardId|pipelineId`. */
  graphChoices: ReadonlyMap<string, boolean>;
  onToggleGraph: (cardId: string, pipelineId: string, open: boolean) => void;
  /** Open the conversation an earlier attempt or review round kept. */
  onOpenAttempt: (conversation: PastAttempt["conversation"]) => void;
  /** Dismiss launches of this task that did not start: one row's, or all of
      them. Absent, the rows still say so and offer nothing. */
  onDismissLaunch?: (card: KanbanCardModel, launches: readonly KanbanUnstartedLaunch[]) => void;
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
  /** Cross-project Overview (#1820): display name per project key. Cards from
      several projects share the columns there, so each one says which project
      it belongs to. Absent on a project's own board, where every card on
      screen is already that project's. */
  projectNames?: Readonly<Record<string, string>> | null;
  /** The card's project label opens that project's own board. */
  onOpenProject?: (project: string) => void;
  /** Every PR and issue link of the task or one of its pipelines, with the
      attach form (#2059). */
  onWorkLinks?: (target: WorkLinkTarget, anchor: HTMLElement) => void;
  /** A lane row's answer in place: skip or retry the stage it stopped on,
      close it, or give its review one more round (#2072). */
  onAnswer?: (cardId: string, title: string, pipeline: Pipeline, answer: PipelineAnswer) => void;
  /** Dismiss: stop flagging every reason the card draws until something new
      asks (docs/design/needs-attention.md §5). Absent, the foot only names
      the reasons. */
  onDismiss?: (card: KanbanCardModel) => void;
  /** Bring back what was dismissed on this card. */
  onUndoDismiss?: (card: KanbanCardModel) => void;
}

/** The foot's reason: the oldest one's label, and how many more there are. */
function reasonsText(t: TFunction, reasons: readonly NeedReason[]): string {
  const first = needLabel(t, reasons[0]!);
  return reasons.length > 1 ? `${first} ${t("needs.more", { count: reasons.length - 1 })}` : first;
}



/** Links a lane row on the card already draws, taken off the task's own row,
    so every link appears once on screen (variant B). What stays is what no
    lane row on screen draws: a folded lane's links and the ones attached to
    the task by hand. */
function withoutShown(resolved: ResolvedWorkLinks | null, shown: ReadonlySet<string>): ResolvedWorkLinks | null {
  if (!resolved || !shown.size) return resolved;
  return { ...resolved, links: resolved.links.filter((link) => !shown.has(link.key)) };
}

function ageLabel(t: TFunction, updatedAtMs: number, nowMs: number): string {
  if (!updatedAtMs) return "";
  if (nowMs - updatedAtMs < 60_000) return t("kanban.justNow");
  return fmtAge(updatedAtMs / 1000);
}

/** The launches of a task that did not start. One is its own row; more fold
    behind one summary row that opens on click, with Dismiss all beside it. */
function UnstartedLaunches({ card, title, nowMs, onOpen, onDismiss }: {
  card: KanbanCardModel;
  title: string;
  nowMs: number;
  onOpen: (file: FileEntry) => void;
  onDismiss?: (card: KanbanCardModel, launches: readonly KanbanUnstartedLaunch[]) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const launches = card.unstarted;
  const row = (launch: KanbanUnstartedLaunch) => (
    <div
      key={launch.key}
      role="listitem"
      className={`unstarted-row${launch.failed ? " failed" : ""}`}
      data-launch-not-started={launch.key}
      data-launch-failed={launch.failed ? launch.key : undefined}
      title={t(launch.failed ? "kanban.launchFailedHint" : "kanban.launchNotStartedHint")}
    >
      <span className="what">{t(launch.failed ? "kanban.launchFailed" : "kanban.launchNotStarted")}</span>
      <span className="age num">{ageLabel(t, launch.atMs, nowMs)}</span>
      {/* A failed launch opens its launch view: the error in full and Retry. */}
      {launch.failed ? (
        <button
          type="button"
          className="open"
          data-launch-open={launch.key}
          aria-label={t("kanban.openFailedLaunchAria", { title })}
          onClick={() => onOpen(launch.failed!.file)}
        >
          {t("kanban.openFailedLaunch")}
        </button>
      ) : null}
      {onDismiss && launch.dismissable ? (
        <button
          type="button"
          className="dismiss"
          data-launch-dismiss={launch.key}
          aria-label={t("kanban.dismissLaunchAria", { title })}
          onClick={() => onDismiss(card, [launch])}
        >
          {t("kanban.dismissLaunch")}
        </button>
      ) : null}
      {launch.failed?.error ? <span className="error" data-launch-error={launch.key}>{launch.failed.error}</span> : null}
    </div>
  );
  if (launches.length === 1) {
    return <div className="unstarted" role="list" aria-label={t("kanban.launchNotStarted")}>{row(launches[0]!)}</div>;
  }
  const dismissable = launches.filter((launch) => launch.dismissable);
  return (
    <div className="unstarted" data-launches-not-started={launches.length}>
      <div className={`unstarted-row summary${launches.some((launch) => launch.failed) ? " failed" : ""}`}>
        <button
          type="button"
          className="fold"
          aria-expanded={open}
          aria-label={t(open ? "kanban.launchesNotStartedHide" : "kanban.launchesNotStartedShow", { count: launches.length })}
          data-launches-toggle={card.id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          <span className="what">{t("kanban.launchesNotStarted", { count: launches.length })}</span>
        </button>
        {onDismiss && dismissable.length ? (
          <button
            type="button"
            className="dismiss"
            data-launches-dismiss-all={card.id}
            aria-label={t("kanban.dismissAllLaunchesAria", { count: dismissable.length, title })}
            onClick={() => onDismiss(card, dismissable)}
          >
            {t("kanban.dismissAllLaunches")}
          </button>
        ) : null}
      </div>
      {open ? <div className="unstarted-list" role="list" aria-label={t("kanban.launchNotStarted")}>{launches.map(row)}</div> : null}
    </div>
  );
}

export const KanbanCard = memo(function KanbanCard(props: KanbanCardProps) {
  const { card, status, pending, collapsed, nowMs, editing, failedEdit, incomingEdit } = props;
  /* The card holding the orchestrator's conversation stays on the board. */
  const protectedSeat = card.holdsSeat;
  const resurfaced = card.task && !card.hide.hidden ? card.hide.resurfaced : null;
  const { t } = useLocale();
  const linkIndex = useWorkLinks();
  const onWorkLinks = props.onWorkLinks;
  const workspace = status === "assigned";
  const title = card.titlePending ? t("kanban.untitled") : card.title;
  /* A placeholder's text is no title to guess an icon from: it gets the quiet default. */
  const iconTitle = card.titlePending ? "" : card.title;
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
  const reasons = card.needsYou ? reasonsText(t, card.reasons) : "";
  const cleared = !card.needsYou ? card.cleared[0] ?? null : null;
  const aria = [title, statusText, card.working ? t("kanban.activityWorking", { count: card.working }) : "", reasons, collapsed ? t("kanban.collapsed") : ""]
    .filter(Boolean)
    .join(", ");
  /* The card's one status hue is its edge (§3.4): amber while it owes the
     operator an answer, which the foot names. A stalled member keeps its red
     state word on its tile and no longer colours the card. */
  const attention = card.needsYou ? "needs" : undefined;
  const onDismiss = props.onDismiss;
  const onUndoDismiss = props.onUndoDismiss;
  /* What is happening now, never a status, at the foot of the card: why it
     needs the operator (or who cleared it), who is working, and how many
     conversations it holds or that nothing is on it. */
  const footMeta = (
    <>
      {card.needsYou ? (
        <span className="foot-meta needs" data-foot-needs={card.reasons.length} title={card.reasons.map((need) => needLabel(t, need)).join("\n")}>
          <span className="clamp">{reasons}</span>
        </span>
      ) : null}
      {card.needsYou && onDismiss ? (
        <button
          type="button"
          className="icon-btn dismiss"
          data-dismiss={card.id}
          aria-label={t("needs.dismissAria", { title })}
          title={t("needs.dismissHint")}
          onClick={() => onDismiss(card)}
        >
          <CheckGlyph />
        </button>
      ) : null}
      {cleared ? (
        <span className="foot-meta cleared" data-foot-cleared={cleared.by.kind}>{clearedLine(t, cleared, nowMs / 1000)}</span>
      ) : null}
      {cleared && onUndoDismiss ? (
        <button type="button" className="undo" data-undo-dismiss={card.id} aria-label={t("needs.undoAria", { title })} onClick={() => onUndoDismiss(card)}>
          {t("needs.undo")}
        </button>
      ) : null}
      {card.working ? <span className="foot-meta working num" data-foot-working={card.working}>{t("kanban.activityWorking", { count: card.working })}</span> : null}
      {card.conversations
        ? <span className="foot-meta num" data-foot-conversations={card.conversations}>{t("kanban.activityConversations", { count: card.conversations })}</span>
        : card.pipelines.length === 0 ? <span className="foot-meta" data-foot-none="">{t("kanban.activityNoAgent")}</span> : null}
    </>
  );
  /* Several pipelines on one card: the running ones stay on top, and once the
     card holds more than three rows the finished ones fold behind one count,
     newest first (#1765). */
  const [completedOpen, setCompletedOpen] = useState(false);
  /* Agent-facing details (#1834): one row, closed on every fresh render of the
     board, which is what makes a reload show it closed again. Editing it opens
     the row, so a save that leaves the field still shows the text. */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const editingDetails = editing?.field === "details";
  const detailsShown = detailsOpen || editingDetails;
  /* A completed lane whose merge still moves or stopped on the operator is
     not folded with the finished ones (#2187 §6). */
  const folds = (summary: KanbanPipeline) => ENDED_PIPELINE_STATES.has(summary.pipeline.state) && !laneMergeUnsettled(summary.pipeline);
  const livePipelines = card.pipelines.filter((summary) => !folds(summary));
  const endedPipelines = card.pipelines
    .filter(folds)
    .sort((a, b) => pipelineEndedAtMs(b.pipeline) - pipelineEndedAtMs(a.pipeline));
  const foldCompleted = card.pipelines.length > PIPELINE_ROWS_BEFORE_FOLD && endedPipelines.length > 0;
  const shownPipelines = foldCompleted ? livePipelines : [...livePipelines, ...endedPipelines];
  const foldedPipelines = foldCompleted ? endedPipelines : [];
  /* The task's own row keeps only the links no lane row on screen draws. */
  const drawnLanes = collapsed ? [] : completedOpen ? card.pipelines : shownPipelines;
  const drawnLinks = new Set(drawnLanes.flatMap((summary) => linkIndex.of({ kind: "pipeline", id: summary.pipeline.id })?.links.map((link) => link.key) ?? []));
  const taskLinks = withoutShown(linkIndex.of({ kind: "task", id: card.task?.id ?? "" }), drawnLinks);
  const onAnswer = props.onAnswer;
  const pipelineRow = (summary: KanbanPipeline) => (
    <PipelineBlock
      key={summary.pipeline.id}
      summary={summary}
      density="task"
      nowMs={nowMs}
      taskTitle={card.titlePending ? null : card.title}
      graphOpen={props.graphChoices.get(`${card.id}|${summary.pipeline.id}`) ?? false}
      selected={selectedStages(summary.pipeline, readerKeys, panels)}
      acting={acting.get(summary.pipeline.id) ?? null}
      onToggleGraph={(open) => props.onToggleGraph(card.id, summary.pipeline.id, open)}
      onOpenStage={(pipeline, stage) => props.onOpenStage(pipeline, stage, card.id)}
      onOpenStages={(pipeline) => props.onOpenSheet(card.id, pipeline)}
      /* A task's card has one ⋯, and the lane's actions are a group in it. A
         pipeline on no task has no card menu, so its lane keeps its own. */
      onMenu={card.task ? undefined : (pipeline, anchor) => props.onPipelineMenu(card.id, pipeline, anchor)}
      onWorkLinks={onWorkLinks}
      onAnswer={onAnswer ? (pipeline, answer) => onAnswer(card.id, title, pipeline, answer) : undefined}
    />
  );
  const projectName = props.projectNames?.[card.project] ?? null;
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
      data-attention={attention}
      data-protected={protectedSeat ? "1" : undefined}
      style={style}
      tabIndex={0}
      aria-label={protectedSeat ? `${aria}, ${t("kanban.staysOnBoard")}` : aria}
      onKeyDown={(event) => props.onKey(card, event)}
      onPointerDown={(event) => props.onPointerDown(card, event)}
    >
      <span className="label" aria-hidden="true" />
      <span className="saving" aria-hidden="true" />
      {projectName ? (
        /* #699's lesson holds: the card itself is inert, so this is one
           explicit target with its own bounds and nothing nests inside it. */
        <button
          type="button"
          className="project-chip"
          data-project-chip={card.project}
          aria-label={t("kanban.openProjectBoard", { project: projectName })}
          title={t("kanban.openProjectBoard", { project: projectName })}
          onClick={() => props.onOpenProject?.(card.project)}
        >
          <span className="clamp">{projectName}</span>
        </button>
      ) : null}
      <div className="head">
        {/* The icon leads the title in a fixed box and never takes the
            title's room (#2102): stored, else suggested by the title, else a
            quiet default. On a task it is the picker's button. */}
        {card.task && props.onIconMenu ? (
          <button
            type="button"
            className="task-icon"
            data-icon-menu={card.id}
            aria-haspopup="dialog"
            aria-label={t("kanban.iconChange", { title })}
            title={t("kanban.iconChange", { title })}
            onClick={(event) => props.onIconMenu?.(card, event.currentTarget)}
          >
            <TaskIcon icon={card.icon} title={iconTitle} />
          </button>
        ) : (
          <span className="task-icon">
            <TaskIcon icon={card.icon} title={iconTitle} />
          </span>
        )}
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
      {/* #2059: the task's own links and every pipeline's, deduplicated, and
          still there when the card is collapsed and its pipelines are not. */}
      {card.task ? (
        <WorkLinkRow
          resolved={taskLinks}
          showNoPr={false}
          className="links"
          testId={card.task.id}
          onMore={onWorkLinks ? (anchor) => onWorkLinks({ kind: "task", id: card.task!.id }, anchor) : undefined}
        />
      ) : null}
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

      {/* The agent's context, folded away: one row while closed, the whole text
          scrolling inside itself while open, and nothing at all when the task
          has no details (#1834). */}
      {!collapsed && (card.details || editingDetails) ? (
        <div className="details" data-details={card.id}>
          <button
            type="button"
            className="btn quiet details-toggle"
            aria-expanded={detailsShown}
            aria-label={t(detailsShown ? "kanban.detailsHide" : "kanban.detailsShow", { title })}
            data-details-toggle={card.id}
            onClick={() => setDetailsOpen((open) => (editingDetails ? open : !open))}
          >
            {detailsShown ? <ChevronDown /> : <ChevronRight />}
            <span>{t("kanban.details")}</span>
          </button>
          {editingDetails ? (
            <CardInlineText
              field="details"
              draft={editing.draft}
              onDraft={(draft) => props.onEditDraft(card.id, draft)}
              onCommit={() => props.onCommitEdit(card.id)}
              onCancel={() => props.onCancelEdit(card.id)}
            />
          ) : detailsShown ? (
            <button
              type="button"
              className="details-text"
              data-details-text={card.id}
              aria-label={t("kanban.editDetails")}
              onClick={() => props.onStartEdit(card, "details")}
            >
              {card.details}
            </button>
          ) : null}
        </div>
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

      {!collapsed && card.unstarted.length ? (
        <UnstartedLaunches card={card} title={title} nowMs={nowMs} onOpen={props.onOpenMember} onDismiss={props.onDismissLaunch} />
      ) : null}

      {!collapsed && (card.mirrors.length || card.notLoadedRefs.length || card.otherSurfaces) ? (
        <div className="refs">
          {card.mirrors.map((mirror) => (
            <button key={mirror.key} type="button" className="ref" onClick={() => props.onFocusCard(mirror.primaryCardId)}>
              {t("kanban.alsoOn", { title: cleanTitle(mirror.file.title ?? "", 48) || t("kanban.untitledConversation"), card: mirror.primaryTitle })}
            </button>
          ))}
          {/* Each conversation the card lists opens on its own, loaded here or
              not; a stage's opens from its pipeline's chips and Past attempts. */}
          {card.notLoadedRefs.map((ref) => (
            <button key={ref.key} type="button" className="ref quiet" data-not-loaded={ref.key} onClick={() => props.onOpenAttempt({ path: ref.path, conversationId: ref.conversationId })}>
              {t("kanban.notLoadedOpen")}
            </button>
          ))}
          {card.otherSurfaces ? (
            <button type="button" className="ref quiet" onClick={props.onOpenConversations}>
              {t("kanban.otherSurfaces", { count: card.otherSurfaces })}
            </button>
          ) : null}
        </div>
      ) : null}

      {card.task ? (
        <div className="foot">
          <span className="age num" title={t("kanban.updated", { age: ageLabel(t, card.updatedAtMs, nowMs) })}>{ageLabel(t, card.updatedAtMs, nowMs)}</span>
          {footMeta}
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
          {footMeta}
        </div>
      )}
    </article>
  );
});
