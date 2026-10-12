"use client";

/*
 * The three numbered variants of the tasks menu, drawn with the product's own
 * pieces: TaskIcon, the status tones, StageGlyph (the model glyph in the
 * stage's state), WorkLinkText (the PR chip text), TaskMotionLine fed by the
 * board's own `taskMotion`, the bar's control classes and the tokens. Nothing
 * here is wired to a store; `data.ts` stands in for the board's card model.
 *
 * One row, one agent row, one card and one head serve all three variants, so
 * a fact sits in the same place whichever variant draws it.
 */
import { Bot, ChevronDown, ChevronLeft, ChevronRight, Crown, ExternalLink, ListTodo, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { modelGlyphName } from "@/components/kanban/modelGlyph";
import { StageGlyph } from "@/components/kanban/StageGlyph";
import { TaskMotionLine } from "@/components/kanban/TaskMotionLine";
import type { StageChipState } from "@/components/pipelines/pipelineModel";
import { TaskIcon } from "@/components/tasks/TaskIcon";
import { TASK_COLOR_HEX } from "@/components/tasks/taskColorHex";
import { TASK_TONES } from "@/components/tasks/taskModel";
import { fmtAgeSeconds } from "@/components/utils";
import { WorkLinkText } from "@/components/workLinks/WorkLinkChips";
import { BAR_PRESSED } from "@/components/ProjectBar";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";

import {
  AGENTS, FAVORITES, GROUP_ORDER, PROJECT, PROJECT_NAMES, TASKS, bucketOf, byRecency, currentStage, foldOf, groupOf, motionOf, recencyMin, workLinks,
  type AgentState, type Bucket, type Group, type ProtoAgent, type ProtoTask,
} from "./data";
import { proto, type ProtoKey } from "./strings";

export type Tab = "tasks" | "agents";
export type Scope = "project" | "all";

function useProto() {
  const { t, locale } = useLocale();
  const p = (key: ProtoKey, vars?: Record<string, string | number>) => proto(locale, key, vars);
  return { t, locale, p };
}

const age = (min: number) => fmtAgeSeconds(min * 60);
const roleName = (t: TFunction, role: string) => t(`roleCopy.${role}.name` as MessageKey);
const taskById = new Map(TASKS.map((task) => [task.id, task] as const));

/* ── Small shared pieces ─────────────────────────────────────────────── */

/** The task's status as the board draws a state in a row: a dot in the status
    tone, and its name in a short popover on hover or tap. `open` pins the
    popover for a frame. */
export function StatusDot({ task, open = false }: { task: ProtoTask; open?: boolean }) {
  const { t, p } = useProto();
  const label = p("statusIs", { status: t(`tasks.status.${task.status}`) });
  return (
    <span className="group/dot relative inline-flex h-4 w-4 shrink-0 items-center justify-center" role="img" aria-label={label} data-proto-status-dot={task.status}>
      <i className="h-2 w-2 rounded-full" style={{ backgroundColor: TASK_TONES[task.status].color }} />
      <span className={`absolute left-0 top-full z-10 mt-1 w-max max-w-[220px] flex-col gap-0.5 rounded-control border border-border bg-card px-2 py-1.5 text-left text-label leading-snug shadow-2 ${open ? "flex" : "hidden group-hover/dot:flex"}`} data-proto-status-pop="">
        <span className="font-semibold text-primary">{label}</span>
        <span className="text-muted">{p("createdAge", { age: age(task.createdMin) })}</span>
      </span>
    </span>
  );
}

function TaskMark({ task, size = 16 }: { task: ProtoTask; size?: number }) {
  const { locale } = useLocale();
  return <TaskIcon icon={task.icon ?? null} title={task.title[locale]} size={size} tint={task.color ? TASK_COLOR_HEX[task.color] : null} />;
}

function ColourEdge({ task }: { task: ProtoTask }) {
  return <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full" style={{ backgroundColor: task.color ? TASK_COLOR_HEX[task.color] : "transparent" }} />;
}

const AGENT_TONE: Record<AgentState, string> = {
  working: "text-success",
  check: "text-info",
  idle: "text-muted",
  "needs-you": "text-warning",
  finished: "text-muted",
  failed: "text-danger",
};

/** The agent's state in one to three words. A duration is printed only where
    the caller has no other time beside it (`sinceMin` null leaves it out). */
export function agentWord(p: ReturnType<typeof useProto>["p"], state: AgentState, sinceMin: number | null): string {
  const span = sinceMin === null ? "" : age(sinceMin).replace(/ (тому|ago)$/, "");
  if (state === "working") return span ? p("agentWorking", { age: span }) : p("agentWorkingBare");
  if (state === "check") return p("agentCheck");
  if (state === "idle") return span ? p("agentIdle", { age: span }) : p("agentIdleBare");
  if (state === "needs-you") return p("agentNeedsYou");
  if (state === "failed") return p("agentFailed");
  return p("agentFinished");
}

/* A stage's state word wears the tone the same state has on an agent, so
   «working» is one colour on a row, in the stage list and in the Agents list;
   a passed stage is quiet. */
const STAGE_WORD_TONE: Record<StageChipState, string> = {
  pending: "text-muted", skipped: "text-muted", running: AGENT_TONE.working, reviewing: AGENT_TONE.check, committing: AGENT_TONE.check,
  passed: "text-secondary", failed: AGENT_TONE.failed, needs_decision: AGENT_TONE["needs-you"],
};

/** The agent waits on the operator and the task carries the question. */
const asksOperator = (task: ProtoTask) => task.agent?.state === "needs-you" && task.hold?.kind === "operator";

/** What runs now: the stage's model glyph in its state, the stage, and the
    agent's own state. When the agent asks the operator, the state is the
    question itself in the attention colour; under a «Needs you» heading the
    words «asks you» are left to the heading. */
function NowLine({ task, underHeading = false }: { task: ProtoTask; underHeading?: boolean }) {
  const { t, locale, p } = useProto();
  const stage = currentStage(task);
  if (!stage) {
    return <span className="min-w-0 text-muted" data-proto-now="">{task.workMin === null ? p("never") : p("noAgent")}</span>;
  }
  const agent = task.agent;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2" data-proto-now="">
      <span className="flex shrink-0 items-center gap-2">
        <StageGlyph state={stage.state} model={{ engine: stage.engine, model: stage.model }} fallback="mark" badge={false} />
        <span className="font-mono text-[10.5px] text-secondary" data-proto-stage-name="">{stage.id}</span>
      </span>
      {asksOperator(task) ? (
        <span className="min-w-0 font-medium text-warning [overflow-wrap:anywhere]" data-proto-ask="">{underHeading ? task.hold!.note[locale] : p("asksYou", { question: task.hold!.note[locale] })}</span>
      ) : agent ? (
        <span className={`whitespace-nowrap ${AGENT_TONE[agent.state]}`}>{agentWord(p, agent.state, agent.state === "working" ? agent.sinceMin : null)}</span>
      ) : (
        <span className={`whitespace-nowrap ${STAGE_WORD_TONE[stage.state]}`}>{t(`kanban.graphState.${stage.state}`)}</span>
      )}
    </span>
  );
}

/* The chip's own tones (workLinks.css), on the passive text a row can hold. */
const PR_TONE: Record<NonNullable<ProtoTask["pr"]>["state"], string> = { open: "text-success", draft: "text-muted", merged: "text-accent", closed: "text-danger" };

/** The PR and its merge state, as the card's own chip text plus the state word. */
function PrLine({ task, now }: { task: ProtoTask; now: number }) {
  const { t } = useLocale();
  if (!task.pr) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap" data-proto-pr="">
      <span className={`font-semibold ${PR_TONE[task.pr.state]}`}><WorkLinkText resolved={workLinks(task, now)} testId={task.id} className="inline-flex items-center gap-0.5" /></span>
      <span className="text-muted">{t(`workLinks.state.${task.pr.state}`)}</span>
    </span>
  );
}

/** The hold, in the board's own sentence and without its age: the row's one
    time is the last work. A question to the operator is on the stage line. */
function HoldLine({ task, now }: { task: ProtoTask; now: number }) {
  const { locale } = useLocale();
  if (!task.hold || asksOperator(task)) return null;
  const motion = motionOf(task, now, locale);
  if (motion.key !== "waiting" && motion.key !== "stopped" && motion.key !== "needs-you") return null;
  return <span className="block [&_.motion-age]:hidden [&_.motion-line]:text-secondary" data-proto-hold=""><TaskMotionLine motion={motion} working={0} nowMs={now} plain /></span>;
}

function Age({ min, className = "" }: { min: number | null; className?: string }) {
  if (min === null) return null;
  return <span className={`shrink-0 text-label leading-[18px] tabular-nums text-muted ${className}`} data-proto-age="">{age(min)}</span>;
}

function SegmentTabs({ tab, onTab, size = "dock" }: { tab: Tab; onTab: (tab: Tab) => void; size?: "dock" | "phone" }) {
  const { p } = useProto();
  const tall = size === "phone" ? "h-11 text-[13px]" : "h-7 text-ui";
  return (
    <div className="flex shrink-0 items-center rounded-control border border-border bg-card p-0.5" role="tablist" data-proto-tabs="">
      {(["tasks", "agents"] as const).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          className={`inline-flex ${tall} flex-1 items-center justify-center gap-1.5 rounded-[6px] border px-2.5 font-semibold ${tab === key ? BAR_PRESSED : "border-transparent text-secondary hover:text-primary"}`}
          onClick={() => onTab(key)}
        >
          {key === "tasks" ? <ListTodo className="h-[14px] w-[14px]" aria-hidden /> : <Bot className="h-[14px] w-[14px]" aria-hidden />}
          {p(key === "tasks" ? "tabTasks" : "tabAgents")}
        </button>
      ))}
    </div>
  );
}

function CloseButton({ phone }: { phone: boolean }) {
  const { t } = useLocale();
  return (
    <button type="button" className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:text-primary ${phone ? "h-11 w-11 border border-border" : "h-7 w-7"}`} aria-label={t("tasks.panelClose")} data-proto-close="">
      <X className={phone ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden />
    </button>
  );
}

function ScopeToggle({ scope, onScope, phone = false }: { scope: Scope; onScope: (scope: Scope) => void; phone?: boolean }) {
  const { p } = useProto();
  return (
    <div className="flex shrink-0 items-center rounded-full border border-border p-0.5" data-proto-scope="">
      {(["project", "all"] as const).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={scope === key}
          className={`rounded-full px-2 ${phone ? "h-11 text-ui" : "py-0.5 text-caption"} font-bold ${scope === key ? "bg-accent/10 text-accent" : "text-muted hover:text-primary"}`}
          onClick={() => onScope(key)}
        >
          {p(key === "project" ? "scopeProject" : "scopeAll")}
        </button>
      ))}
    </div>
  );
}

/** The menu's head, the same in every variant: the Tasks | Agents tabs with
    the close button, then the project scope and, on Tasks only, «+ new task». */
function MenuHead({ tab, onTab, scope, onScope, phone }: { tab: Tab; onTab: (tab: Tab) => void; scope: Scope; onScope: (scope: Scope) => void; phone: boolean }) {
  const { p } = useProto();
  return (
    <div className={`flex shrink-0 flex-col gap-2 border-b border-border ${phone ? "p-2" : "px-3 py-2"}`} data-proto-head="">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><SegmentTabs tab={tab} onTab={onTab} size={phone ? "phone" : "dock"} /></div>
        <CloseButton phone={phone} />
      </div>
      <div className="flex items-center gap-2">
        <ScopeToggle scope={scope} onScope={onScope} phone={phone} />
        {tab === "tasks" ? <button type="button" className={`ml-auto rounded-control border border-dashed border-accent/50 px-2 font-bold text-accent ${phone ? "h-11 text-[13px]" : "h-7 text-ui"}`} data-proto-new="">+ {p("newTask")}</button> : null}
      </div>
    </div>
  );
}

function FoldHeader({ label, open, onToggle, phone = false }: { label: string; open: boolean; onToggle: () => void; phone?: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      className={`flex w-full items-center gap-1.5 px-3 ${phone ? "min-h-11" : "min-h-8"} text-left text-label font-semibold text-secondary hover:text-primary`}
      onClick={onToggle}
      data-proto-fold=""
    >
      {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
      {label}
    </button>
  );
}

function scoped<T extends { project: string }>(rows: readonly T[], scope: Scope): T[] {
  return scope === "project" ? rows.filter((row) => row.project === PROJECT) : [...rows];
}

/* ── The task row ────────────────────────────────────────────────────── */

interface TaskRowProps {
  task: ProtoTask;
  now: number;
  scope: Scope;
  phone: boolean;
  /** The status dot under the icon (variants 1 and 3; variant 2's heading says the state). */
  status?: boolean;
  underHeading?: boolean;
  /** The PR and the hold on the row (variants 1 and 2; variant 3 keeps them in its pane). */
  detail?: boolean;
  small?: boolean;
  divided?: boolean;
  /** How the row opens: in place, as a pushed screen, or into the pane beside it. */
  opens: "expand" | "push" | "select";
  active?: boolean;
  onOpen: () => void;
  popStatus?: boolean;
  children?: ReactNode;
}

/**
 * One grid for every variant. Line 1: icon, title, age, the open mark in a
 * column of its own at the right edge. Line 2: the status dot under the icon,
 * what runs now and the PR, and the project under the age when the scope is
 * all projects. Line 3: the hold. The row is as tall as its lines.
 */
function TaskRow({ task, now, scope, phone, status = false, underHeading = false, detail = true, small = false, divided = false, opens, active = false, onOpen, popStatus = false, children }: TaskRowProps) {
  const { locale } = useProto();
  const marked = opens !== "select";
  const tint = opens === "select" ? (active ? "bg-accent/10" : "hover:bg-well") : "hover:bg-well";
  return (
    <li className={`relative ${divided ? "border-b border-border" : ""} ${opens === "expand" && active ? "bg-well" : ""}`} data-proto-row={task.id}>
      <ColourEdge task={task} />
      <button
        type="button"
        {...(opens === "expand" ? { "aria-expanded": active } : opens === "select" ? { "aria-current": active || undefined } : {})}
        className={`grid w-full ${marked ? "grid-cols-[16px_minmax(0,1fr)_auto_14px]" : "grid-cols-[16px_minmax(0,1fr)_auto]"} content-center items-start gap-x-2 gap-y-1 py-2 pl-3 pr-2.5 text-left ${tint} ${phone ? "min-h-14" : ""} ${task.status === "done" ? "opacity-75" : ""}`}
        onClick={onOpen}
      >
        <span className="col-start-1 row-start-1 flex h-[18px] items-center"><TaskMark task={task} /></span>
        <span className={`col-start-2 row-start-1 min-w-0 font-semibold leading-[18px] [overflow-wrap:anywhere] ${phone ? "text-[14px]" : small ? "text-ui" : "text-body"}`} data-proto-title="">{task.title[locale]}</span>
        <Age min={recencyMin(task)} className="col-start-3 row-start-1" />
        {marked ? (
          <span className="col-start-4 row-start-1 flex h-[18px] items-center justify-end text-muted" data-proto-chevron="">
            {opens === "expand" ? <ChevronDown className={`h-3.5 w-3.5 transition-transform ${active ? "rotate-180" : ""}`} aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          </span>
        ) : null}
        {status ? <span className="col-start-1 row-start-2 flex h-4 items-center"><StatusDot task={task} open={popStatus} /></span> : null}
        <span className={`col-start-2 ${scope === "all" ? "" : "col-end-[-1]"} row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-label leading-4`} data-proto-line="">
          <NowLine task={task} underHeading={underHeading} />
          {detail ? <PrLine task={task} now={now} /> : null}
        </span>
        {scope === "all" ? <span className="col-start-3 col-end-[-1] row-start-2 max-w-[110px] justify-self-end truncate text-label leading-4 text-muted" data-proto-project="">{PROJECT_NAMES[task.project]}</span> : null}
        {detail && task.hold && !asksOperator(task) ? <span className="col-start-2 col-end-[-1] row-start-3 min-w-0"><HoldLine task={task} now={now} /></span> : null}
      </button>
      {children}
    </li>
  );
}

/* ── The card ────────────────────────────────────────────────────────── */

function CardActions({ phone }: { phone: boolean }) {
  const { p } = useProto();
  return (
    <div className="flex flex-wrap gap-1.5" data-proto-actions="">
      <button type="button" className={`inline-flex items-center gap-1 rounded-control border border-accent/45 bg-accent/10 px-2.5 font-semibold text-accent ${phone ? "h-11 text-[13px]" : "h-7 text-ui"}`}>
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />{p("openCard")}
      </button>
      <button type="button" className={`inline-flex items-center gap-1 rounded-control border border-border bg-card px-2.5 font-semibold text-secondary ${phone ? "h-11 text-[13px]" : "h-7 text-ui"}`}>
        {p("showOnBoard")}
      </button>
    </div>
  );
}

function PaneClose({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  return (
    <button type="button" className="-mr-1.5 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted hover:text-primary" aria-label={t("common.close")} onClick={onClose} data-proto-pane-close="">
      <X className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

/** The whole card: inline under a row (variants 1 and 2) or as the pane and
    the phone's detail screen (variant 3). A stage is its glyph, its name and
    its state word in the state's colour, one per line, with no chip around it. */
function ExpandedCard({ task, now, phone, pane = false, agents: withAgents = true, label, onClose }: { task: ProtoTask; now: number; phone: boolean; pane?: boolean; agents?: boolean; label?: string; onClose?: () => void }) {
  const { t, locale, p } = useProto();
  const agents = withAgents ? AGENTS.filter((agent) => agent.taskId === task.id) : [];
  return (
    <div className={`flex flex-col gap-3 ${pane ? "p-4" : "pb-3 pl-9 pr-3 pt-1"}`} data-proto-expanded={task.id}>
      {label ? <h4 className="text-label font-semibold text-secondary">{label}</h4> : null}
      {pane ? (
        <div className="flex items-start gap-2">
          <span className="flex h-[22px] items-center"><TaskMark task={task} size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-title font-bold leading-snug [overflow-wrap:anywhere]">{task.title[locale]}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-label text-muted">
              <StatusDot task={task} />
              <span>{PROJECT_NAMES[task.project]}</span>
              <span>· {task.workMin === null ? p("never") : p("lastWork", { age: age(task.workMin) })}</span>
            </div>
          </div>
          {onClose ? <PaneClose onClose={onClose} /> : null}
        </div>
      ) : null}
      {task.body ? <p className="text-ui leading-snug text-secondary [overflow-wrap:anywhere]">{task.body[locale]}</p> : null}
      {pane && asksOperator(task) ? <p className="text-label font-medium leading-snug text-warning [overflow-wrap:anywhere]" data-proto-ask="">{p("asksYou", { question: task.hold!.note[locale] })}</p> : null}
      {pane ? <HoldLine task={task} now={now} /> : null}
      {task.stages.length ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-label font-semibold text-secondary">{p("stages")}</h4>
          <ol className="grid grid-cols-[14px_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-label leading-4" data-proto-stages="">
            {task.stages.map((stage) => (
              <li key={stage.id} className="contents" data-proto-stage={stage.id}>
                <StageGlyph state={stage.state} model={{ engine: stage.engine, model: stage.model }} fallback="mark" badge={false} />
                <span className="font-mono text-[10.5px]" data-proto-stage-name="">{stage.id}</span>
                <span className={STAGE_WORD_TONE[stage.state]}>{t(`kanban.graphState.${stage.state}`)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {pane && task.pr ? <div className="flex text-label"><PrLine task={task} now={now} /></div> : null}
      {agents.length ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-label font-semibold text-secondary">{p("agentsOfTask")}</h4>
          <ul className="flex flex-col gap-2">
            {agents.map((agent) => <AgentFacts key={agent.id} agent={agent} />)}
          </ul>
        </section>
      ) : null}
      {pane ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-label font-semibold text-secondary">{p("activity")}</h4>
          <ol className="flex flex-col gap-0.5 text-label text-secondary">
            {task.events.map((event, index) => (
              <li key={index} className="flex gap-2"><span className="w-20 shrink-0 tabular-nums text-muted">{age(event.min)}</span><span className="min-w-0">{p(`ev_${event.kind}` as ProtoKey, { stage: event.stage ?? "", n: event.pr ?? "" })}</span></li>
            ))}
          </ol>
        </section>
      ) : null}
      <CardActions phone={phone} />
    </div>
  );
}

/* ── Agents ──────────────────────────────────────────────────────────── */

const AGENT_STAGE_STATE = { working: "running", check: "committing", "needs-you": "needs_decision", failed: "failed", finished: "passed", idle: "pending" } as const;

function agentName(t: TFunction, locale: "en" | "uk", agent: ProtoAgent): string {
  return agent.title ? agent.title[locale] : `${roleName(t, agent.role)}${agent.stage ? ` · ${agent.stage}` : ""}`;
}

/** An agent inside a task's card: its facts side by side. The row above
    already says how long a working agent has worked, so the launch age is
    printed only for an agent that is not working: one time either way. */
function AgentFacts({ agent }: { agent: ProtoAgent }) {
  const { t, locale, p } = useProto();
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 text-label leading-4" data-proto-agent-facts={agent.id}>
      <StageGlyph state={AGENT_STAGE_STATE[agent.state]} model={{ engine: agent.engine, model: agent.model }} fallback="mark" badge={false} />
      <span className="text-secondary">{agentName(t, locale, agent)}</span>
      <span className="text-muted">{modelGlyphName(agent.engine, agent.model)}</span>
      <span className={AGENT_TONE[agent.state]}>{agentWord(p, agent.state, null)}</span>
      {agent.state === "working" ? null : <span className="text-muted">· {p("launched", { age: age(agent.launchedMin) })}</span>}
    </li>
  );
}

/** An agent in the Agents list. Line 1: the name with its state beside it,
    and the launch age the list is ordered by. Line 2: its task, wrapped and
    never cut. Only a spawned agent is marked, since a stage agent is the rule. */
function AgentRow({ agent, scope, phone, selected = false, onSelect }: { agent: ProtoAgent; scope: Scope; phone: boolean; selected?: boolean; onSelect?: () => void }) {
  const { t, locale, p } = useProto();
  const task = agent.taskId ? taskById.get(agent.taskId) ?? null : null;
  const all = scope === "all";
  return (
    <li className="border-b border-border" data-proto-agent={agent.id}>
      <button
        type="button"
        aria-current={selected || undefined}
        className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] content-center items-start gap-x-2 gap-y-1 py-2 pl-3 pr-2.5 text-left ${selected ? "bg-accent/10" : "hover:bg-well"} ${phone ? "min-h-14" : ""}`}
        onClick={onSelect}
      >
        <span className="col-start-1 row-start-1 flex h-[18px] items-center justify-center"><StageGlyph state={AGENT_STAGE_STATE[agent.state]} model={{ engine: agent.engine, model: agent.model }} fallback="mark" badge={false} /></span>
        <span className={`col-start-2 row-start-1 min-w-0 leading-[18px] [overflow-wrap:anywhere] ${phone ? "text-[14px]" : "text-body"}`} data-proto-agent-line="">
          <span className="font-semibold" data-proto-agent-name="">{agentName(t, locale, agent)}</span>
          <span className={`whitespace-nowrap pl-2 text-label ${AGENT_TONE[agent.state]}`} data-proto-agent-state="">{agentWord(p, agent.state, null)}</span>
        </span>
        <span className="col-start-3 row-start-1 shrink-0 text-label leading-[18px] tabular-nums text-muted" data-proto-age="">{age(agent.launchedMin)}</span>
        <span className={`col-start-2 ${all ? "" : "col-end-[-1]"} row-start-2 flex min-w-0 items-start gap-1.5 text-label leading-4 text-secondary`} data-proto-agent-task="">
          {agent.kind === "spawned" ? <span className="shrink-0 text-muted" data-proto-spawned="">{p("spawnedAgent")}{task ? " ·" : ` · ${p("noTask")}`}</span> : null}
          {task ? (
            <>
              <span className="flex h-4 shrink-0 items-center"><TaskMark task={task} size={13} /></span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{task.title[locale]}</span>
            </>
          ) : agent.kind === "spawned" ? null : <span className="text-muted">{p("noTask")}</span>}
        </span>
        {all ? <span className="col-start-3 row-start-2 max-w-[110px] justify-self-end truncate text-label leading-4 text-muted" data-proto-project="">{PROJECT_NAMES[agent.project]}</span> : null}
      </button>
    </li>
  );
}

function AgentsList({ scope, phone, selectedId = null, onSelect }: { scope: Scope; phone: boolean; selectedId?: string | null; onSelect?: (id: string) => void }) {
  const { locale, p } = useProto();
  const [favOpen, setFavOpen] = useState(false);
  const rows = scoped(AGENTS, scope).sort((a, b) => a.launchedMin - b.launchedMin);
  return (
    <div className="flex flex-col" data-proto-agents="">
      <FoldHeader label={p("favorites", { count: FAVORITES.length })} open={favOpen} onToggle={() => setFavOpen(!favOpen)} phone={phone} />
      {favOpen ? (
        <ul className="pb-1">
          {FAVORITES.map((favorite) => (
            <li key={favorite.id} className="flex min-h-8 items-center gap-1.5 px-3 text-ui">
              <Crown className="h-3 w-3 fill-crown text-crown" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-semibold">{favorite.title[locale]}</span>
              {scope === "all" ? <span className="shrink-0 text-label text-muted">{PROJECT_NAMES[favorite.project]}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="border-y border-border px-3 py-1.5 text-label font-semibold text-secondary" data-proto-agents-heading="">{p("recentAgents")} · {rows.length}</div>
      <ul>{rows.map((agent) => <AgentRow key={agent.id} agent={agent} scope={scope} phone={phone} selected={agent.id === selectedId} onSelect={onSelect ? () => onSelect(agent.id) : undefined} />)}</ul>
    </div>
  );
}

/* ── Variant 1: one list by recency ───────────────────────────────────── */

export function Variant1({ now, phone, initialTab, expandedId, initialScope = "project", popId = null }: { now: number; phone: boolean; initialTab: Tab; expandedId?: string | null; initialScope?: Scope; popId?: string | null }) {
  const { p } = useProto();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [scope, setScope] = useState<Scope>(initialScope);
  const [expanded, setExpanded] = useState<string | null>(expandedId ?? null);
  const [idleOpen, setIdleOpen] = useState(true);
  const [doneOpen, setDoneOpen] = useState(false);
  const tasks = useMemo(() => scoped(TASKS, scope).sort(byRecency), [scope]);
  const active = tasks.filter((task) => foldOf(task) === "active");
  const idle = tasks.filter((task) => foldOf(task) === "idle");
  const done = tasks.filter((task) => foldOf(task) === "done");
  const row = (task: ProtoTask) => (
    <TaskRow key={task.id} task={task} now={now} scope={scope} phone={phone} status divided opens="expand" active={expanded === task.id} popStatus={popId === task.id} onOpen={() => setExpanded(expanded === task.id ? null : task.id)}>
      {expanded === task.id ? <ExpandedCard task={task} now={now} phone={phone} /> : null}
    </TaskRow>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-proto-variant="1">
      <MenuHead tab={tab} onTab={setTab} scope={scope} onScope={setScope} phone={phone} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-proto-scroll="">
        {tab === "agents" ? <AgentsList scope={scope} phone={phone} /> : (
          <>
            <ul>{active.map(row)}</ul>
            <FoldHeader label={p("idleGroup", { count: idle.length })} open={idleOpen} onToggle={() => setIdleOpen(!idleOpen)} phone={phone} />
            {idleOpen ? <ul>{idle.map(row)}</ul> : null}
            <FoldHeader label={p("doneGroup", { count: done.length })} open={doneOpen} onToggle={() => setDoneOpen(!doneOpen)} phone={phone} />
            {doneOpen ? <ul>{done.map(row)}</ul> : null}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Variant 2: grouped by what the task needs ───────────────────────── */

const GROUP_LABEL: Record<Group, ProtoKey> = {
  "needs-you": "groupNeedsYou", working: "groupWorking", waiting: "groupWaiting", "not-started": "groupNotStarted", finished: "groupFinished", idle: "groupIdle", done: "groupDone",
};
const GROUP_FOLDED: ReadonlySet<Group> = new Set(["idle", "done"]);

export function Variant2({ now, phone, initialTab, expandedId, initialScope = "project" }: { now: number; phone: boolean; initialTab: Tab; expandedId?: string | null; initialScope?: Scope }) {
  const { locale, p } = useProto();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [scope, setScope] = useState<Scope>(initialScope);
  const [expanded, setExpanded] = useState<string | null>(expandedId ?? null);
  const [open, setOpen] = useState<ReadonlySet<Group>>(new Set(GROUP_ORDER.filter((group) => !GROUP_FOLDED.has(group))));
  const tasks = useMemo(() => scoped(TASKS, scope).sort(byRecency), [scope]);
  const groups = new Map<Group, ProtoTask[]>();
  for (const task of tasks) {
    const group = groupOf(task, motionOf(task, now, locale));
    groups.set(group, [...(groups.get(group) ?? []), task]);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-proto-variant="2">
      <MenuHead tab={tab} onTab={setTab} scope={scope} onScope={setScope} phone={phone} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-proto-scroll="">
        {tab === "agents" ? <AgentsList scope={scope} phone={phone} /> : GROUP_ORDER.filter((group) => groups.has(group)).map((group) => {
          const rows = groups.get(group)!;
          const isOpen = open.has(group);
          return (
            <section key={group} className="border-b border-border" data-proto-group={group}>
              <FoldHeader
                label={`${p(GROUP_LABEL[group])} · ${rows.length}`}
                open={isOpen}
                phone={phone}
                onToggle={() => setOpen((previous) => {
                  const next = new Set(previous);
                  if (next.has(group)) next.delete(group); else next.add(group);
                  return next;
                })}
              />
              {isOpen ? (
                <ul className="pb-1">
                  {rows.map((task) => (
                    <TaskRow key={task.id} task={task} now={now} scope={scope} phone={phone} underHeading={group === "needs-you"} opens="expand" active={expanded === task.id} onOpen={() => setExpanded(expanded === task.id ? null : task.id)}>
                      {expanded === task.id ? <ExpandedCard task={task} now={now} phone={phone} /> : null}
                    </TaskRow>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ── Variant 3: two panes, list by day and the whole card beside it ───── */

const BUCKET_LABEL: Record<Bucket, ProtoKey> = { today: "bucketToday", yesterday: "bucketYesterday", week: "bucketWeek", older: "bucketOlder" };

/** The agent the pane is about: what the list beside it does not say (the
    model), above its task's card. The list row carries the launch age. */
function AgentHead({ agent, onClose }: { agent: ProtoAgent; onClose: () => void }) {
  const { t, locale, p } = useProto();
  return (
    <div className="flex items-start gap-2 border-b border-border px-4 py-3" data-proto-agent-head={agent.id}>
      <span className="flex h-[22px] items-center"><StageGlyph state={AGENT_STAGE_STATE[agent.state]} model={{ engine: agent.engine, model: agent.model }} fallback="mark" badge={false} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-title font-bold leading-snug [overflow-wrap:anywhere]">{agentName(t, locale, agent)}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-label text-muted">
          <span>{modelGlyphName(agent.engine, agent.model)}</span>
          {agent.kind === "spawned" ? <span>· {p("spawnedAgent")}</span> : null}
          <span className={AGENT_TONE[agent.state]}>· {agentWord(p, agent.state, null)}</span>
        </div>
      </div>
      <PaneClose onClose={onClose} />
    </div>
  );
}

export function Variant3({ now, phone, initialTab, selectedId, initialScope = "project", phoneDetail = false, paneWidth = 380, popId = null }: { now: number; phone: boolean; initialTab: Tab; selectedId?: string | null; initialScope?: Scope; phoneDetail?: boolean; paneWidth?: number; popId?: string | null }) {
  const { p } = useProto();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [scope, setScope] = useState<Scope>(initialScope);
  const tasks = useMemo(() => scoped(TASKS, scope).sort(byRecency), [scope]);
  const [selected, setSelected] = useState<string>(selectedId ?? tasks[0]!.id);
  const [agentId, setAgentId] = useState<string | null>(AGENTS.find((agent) => agent.taskId === (selectedId ?? tasks[0]!.id))?.id ?? null);
  const [detail, setDetail] = useState(phoneDetail);
  const [paneOpen, setPaneOpen] = useState(true);
  const [doneOpen, setDoneOpen] = useState(false);
  const live = tasks.filter((task) => foldOf(task) !== "done");
  const done = tasks.filter((task) => foldOf(task) === "done");
  const buckets = (["today", "yesterday", "week", "older"] as const).map((bucket) => [bucket, live.filter((task) => bucketOf(task) === bucket)] as const).filter(([, rows]) => rows.length);
  const selectedTask = TASKS.find((task) => task.id === selected) ?? tasks[0]!;
  const selectedAgent = AGENTS.find((agent) => agent.id === agentId) ?? null;
  if (phone && detail) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-proto-variant="3" data-proto-detail="">
        <button type="button" className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-2 text-[13px] font-semibold text-accent" onClick={() => setDetail(false)}>
          <ChevronLeft className="h-5 w-5" aria-hidden />{p("back")}
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto"><ExpandedCard task={selectedTask} now={now} phone pane /></div>
      </div>
    );
  }
  const row = (task: ProtoTask) => (
    <TaskRow key={task.id} task={task} now={now} scope={scope} phone={phone} status detail={false} small opens={phone ? "push" : "select"} active={!phone && paneOpen && task.id === selected} popStatus={popId === task.id} onOpen={() => { setSelected(task.id); setDetail(true); setPaneOpen(true); }} />
  );
  const list = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MenuHead tab={tab} onTab={setTab} scope={scope} onScope={setScope} phone={phone} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-proto-scroll="">
        {tab === "agents" ? <AgentsList scope={scope} phone={phone} selectedId={phone || !paneOpen ? null : agentId} onSelect={(id) => { setAgentId(id); setPaneOpen(true); }} /> : (
          <>
            {buckets.map(([bucket, rows]) => (
              <section key={bucket} data-proto-bucket={bucket}>
                <div className="sticky top-0 z-[1] border-b border-border bg-card px-3 py-1 text-label font-semibold text-secondary">{p(BUCKET_LABEL[bucket])} · {rows.length}</div>
                <ul>{rows.map(row)}</ul>
              </section>
            ))}
            <FoldHeader label={p("doneGroup", { count: done.length })} open={doneOpen} onToggle={() => setDoneOpen(!doneOpen)} phone={phone} />
            {doneOpen ? <ul>{done.map(row)}</ul> : null}
          </>
        )}
      </div>
    </div>
  );
  if (phone) return <div className="flex min-h-0 flex-1 flex-col" data-proto-variant="3">{list}</div>;
  const paneAgent = tab === "agents" ? selectedAgent : null;
  const paneTask = tab === "agents" ? (paneAgent?.taskId ? taskById.get(paneAgent.taskId) ?? null : null) : selectedTask;
  const close = () => setPaneOpen(false);
  /* The pane hangs off the list's left edge over the board and is as tall as
     its card, so the board stays in view beside and below it. */
  return (
    <div className="relative flex min-h-0 flex-1" data-proto-variant="3">
      {list}
      {paneOpen && (paneAgent || paneTask) ? (
        <div className="absolute right-full top-0 z-10 flex max-h-full flex-col overflow-y-auto rounded-bl-[10px] border-b border-l border-r border-border bg-card shadow-2" style={{ width: paneWidth }} data-proto-pane="">
          {paneAgent ? <AgentHead agent={paneAgent} onClose={close} /> : null}
          {paneTask
            ? <ExpandedCard task={paneTask} now={now} phone={false} pane agents={!paneAgent} label={paneAgent ? p("taskOfAgent") : undefined} onClose={paneAgent ? undefined : close} />
            : <p className="p-4 text-label text-muted">{p("noTask")}</p>}
        </div>
      ) : null}
    </div>
  );
}

/* ── Frames: the dock, the drawer and the phone sheet ─────────────────── */

/** The side panel. The tabs inside are its heading, so it prints no title. */
export function DockFrame({ width, title, children }: { width: number; title: string; children: ReactNode }) {
  return <aside className="relative flex shrink-0 flex-col border-l border-border bg-card" style={{ width }} aria-label={title} data-proto-dock="">{children}</aside>;
}

export function PhoneSheet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas pb-[env(safe-area-inset-bottom)]" aria-label={title} data-proto-sheet="">
      <div className="flex min-h-0 flex-1 flex-col bg-card">{children}</div>
    </div>
  );
}
