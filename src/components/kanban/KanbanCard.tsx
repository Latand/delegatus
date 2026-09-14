"use client";

import { memo } from "react";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { cleanTitle, fmtAge } from "@/components/utils";
import { attemptStateLabel, pipelineStateLabel, stageAttempts, stageChipLabel } from "@/components/pipelines/pipelineModel";

import type { KanbanCard as KanbanCardModel, KanbanMember, KanbanPipeline } from "./kanbanModel";
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

export function statusLabel(t: TFunction, status: TaskStatus): string {
  return t(`kanban.status.${status}`);
}

const LIVE_CHIP_STATES = new Set(["running", "reviewing", "committing"]);

function pipelineProgress(t: TFunction, summary: KanbanPipeline, nameOf: (stage: PipelineStage) => string): string {
  const { pipeline, chips } = summary;
  if (pipeline.state === "provisioning") return t("kanban.progress.provisioning");
  const needs = chips.find((chip) => chip.state === "needs_decision");
  if (needs) return t("kanban.progress.needs", { stage: nameOf(needs.stage) });
  const live = chips.find((chip) => LIVE_CHIP_STATES.has(chip.state));
  if (live) {
    const attempts = stageAttempts(pipeline, live.stage.id).length;
    const base = t("kanban.progress.live", { stage: nameOf(live.stage), state: attemptStateLabel(t, live.state) });
    return attempts > 1 ? t("kanban.progress.attempt", { progress: base, n: attempts }) : base;
  }
  if (pipeline.state === "completed") return pipelineStateLabel(t, pipeline.state);
  const failed = chips.find((chip) => chip.state === "failed");
  if (failed) return t("kanban.progress.failed", { stage: nameOf(failed.stage) });
  return pipelineStateLabel(t, pipeline.state);
}

const CHIP_TONE: Record<string, string> = {
  pending: "pending",
  skipped: "pending",
  running: "active",
  committing: "active",
  reviewing: "review",
  passed: "ok",
  failed: "bad",
  needs_decision: "needs",
};

/** A stage's name on its chip: its role, unless another stage of the same
    pipeline has that role too, where the stage's own id tells them apart. */
function stageNames(t: TFunction, pipeline: Pipeline): Map<string, string> {
  const roles = pipeline.stages.map((stage) => stageChipLabel(t, stage));
  const repeated = new Set(roles.filter((label, index) => roles.indexOf(label) !== index));
  return new Map(pipeline.stages.map((stage, index) => {
    const role = roles[index]!;
    if (!repeated.has(role)) return [stage.id, role] as const;
    const words = stage.id.replace(/[-_]+/g, " ").trim();
    return [stage.id, words ? words[0]!.toUpperCase() + words.slice(1) : role] as const;
  }));
}

function PipelineSummary({ summary, onOpenStage }: { summary: KanbanPipeline; onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void }) {
  const { t } = useLocale();
  const { pipeline } = summary;
  const names = stageNames(t, pipeline);
  const nameOf = (stage: PipelineStage) => names.get(stage.id) ?? stageChipLabel(t, stage);
  const main = summary.chips.filter((chip) => !chip.branch);
  const branches = summary.chips.filter((chip) => chip.branch);
  const chip = (entry: (typeof summary.chips)[number], index: number, branch: boolean) => {
    const label = nameOf(entry.stage);
    const state = attemptStateLabel(t, entry.state);
    const openable = stageAttempts(pipeline, entry.stage.id).some((attempt) => attempt.agentPath || attempt.conversationId);
    const className = `pchip tone-${CHIP_TONE[entry.state] ?? "pending"} st-${entry.state}${branch ? " side" : ""}`;
    const body = (
      <>
        <i className="pdot" aria-hidden="true" />
        <span className="pname">{branch ? t("kanban.branch", { stage: label }) : label}</span>
        {entry.rounds ? <span className="prounds">{t("kanban.rounds", { count: entry.rounds })}</span> : null}
      </>
    );
    const aria = entry.rounds ? t("kanban.stageAriaRounds", { stage: label, state, count: entry.rounds }) : t("kanban.stageAria", { stage: label, state });
    return openable ? (
      <button key={entry.stage.id} type="button" className={className} data-stage={entry.stage.id} aria-label={aria} title={`${label} · ${state}`} onClick={() => onOpenStage(pipeline, entry.stage)}>
        {body}
      </button>
    ) : (
      <span key={entry.stage.id} className={className} data-stage={entry.stage.id} role="img" aria-label={aria} title={`${label} · ${state}`} data-index={index}>
        {body}
      </span>
    );
  };
  return (
    <div className="stage-section compact" data-pipeline={pipeline.id} role="group" aria-label={t("kanban.pipelineAria", { progress: pipelineProgress(t, summary, nameOf) })}>
      <div className="sec-head">
        <span className="kind">{t("kanban.pipeline")}</span>
        <span className="pstate-chip" data-pstate={pipeline.state}>{pipelineStateLabel(t, pipeline.state)}</span>
        <span className="progress">{pipelineProgress(t, summary, nameOf)}</span>
        <span className="grow" />
      </div>
      <div className="psummary">
        {main.map((entry, index) => (
          <span key={entry.stage.id} className="pchip-wrap">
            {index > 0 ? <span className="parrow" aria-hidden="true">→</span> : null}
            {chip(entry, index, false)}
          </span>
        ))}
        {summary.loops.map((loop) => (
          <span
            key={`${loop.from.id}->${loop.to.id}`}
            className="ploop fail"
            title={t("kanban.loopTitle", { from: nameOf(loop.from), to: nameOf(loop.to), fired: loop.fired, max: loop.max })}
          >
            {t("kanban.loop", { from: nameOf(loop.from), to: nameOf(loop.to), fired: loop.fired, max: loop.max })}
          </span>
        ))}
        {branches.map((entry, index) => chip(entry, index, true))}
      </div>
    </div>
  );
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
  const { card, status, pending, collapsed, nowMs } = props;
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
  return (
    <article
      className={`card${status === "done" ? " done" : ""} ${workspace ? "work" : "shelf"}${collapsed ? " folded" : ""}${reading ? " has-reader" : ""}`}
      data-id={card.id}
      data-kanban-card={card.id}
      data-pending={pending ? "1" : "0"}
      data-collapsed={collapsed ? "1" : "0"}
      tabIndex={0}
      aria-label={aria}
      onKeyDown={(event) => props.onKey(card, event)}
      onPointerDown={(event) => props.onPointerDown(card, event)}
    >
      <span className="label" aria-hidden="true" />
      <span className="saving" aria-hidden="true" />
      <div className="head">
        <h3 className={`title${card.titlePending ? " pending" : ""}`} title={card.title.length > 80 ? card.title : undefined}>
          <span className="clamp">{title}</span>
        </h3>
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
      {card.titlePending ? <p className="pending-line">{t("kanban.namePending")}</p> : null}
      {!collapsed && card.description ? (
        <p className="desc"><span className="clamp">{card.description}</span></p>
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
        <PipelineSummary key={summary.pipeline.id} summary={summary} onOpenStage={props.onOpenStage} />
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
