"use client";

import { ArrowRight, Ban, Boxes, Check, ChevronDown, CircleCheck, CircleX, Eye, EyeOff, Inbox, Link2, Palette, Pause, Pencil, Play, Plus, ScrollText, UserRoundCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { EngineMark } from "@/components/EngineMark";
import { ChevronRight } from "@/components/icons";
import { TASK_COLOR_HEX } from "@/components/kanban/KanbanCard";
import { dismissUnstartedLaunch } from "@/components/kanban/kanbanAssignments";
import { KANBAN_STATUSES, summarizePipeline, type KanbanPipeline } from "@/components/kanban/kanbanModel";
import { pastAttemptLabel, pastAttemptState, pastAttemptTone, pipelineTitle } from "@/components/kanban/PipelineSection";
import { browserPipelinePorts, type PipelinePorts } from "@/components/kanban/pipelinePorts";
import { textField, withField } from "@/components/kanban/taskText";
import { useTaskMutations, type FieldEditOutcome, type StatusMoveOutcome, type TaskMutationPorts } from "@/components/kanban/useTaskMutations";
import { PipelineBlock } from "@/components/pipelines/PipelineBlock";
import { blockAgeSeconds, pipelineEnded, pipelineNeedsYou, screenCurrentStageId } from "@/components/pipelines/pipelineBlockModel";
import { attemptNavTarget, latestAttempt, resolveStageNavFile, stageNames } from "@/components/pipelines/pipelineModel";
import { humanizeDuration } from "@/components/turnDuration";
import { fileModelLabel } from "@/components/utils";
import { WorkLinkRow, WorkLinksPanel } from "@/components/workLinks/WorkLinkChips";
import { useWorkLinks, type WorkLinkTarget } from "@/components/workLinks/workLinksContext";
import { formatConversationHash } from "@/lib/accounts/identity";
import type { ResolvedWorkLinks } from "@/lib/forge/workLinks";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { TASK_COLORS, type BoardTask, type TaskColor, type TaskStatus } from "@/lib/tasks/types";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { BADGE_LABEL, ConversationRow } from "./MobileBoard";
import { launchedAt, mobileRowState, nowFragment, type MobileBoardConversation } from "./mobileBoardModel";
import { mobilePipelineActions, pendingPipelineActs, usePhonePipelineActs, useScrolledAway, type PendingPipelineActs } from "./MobilePipelineScreen";
import { showReceipt } from "./MobileReceipt";
import type { MobileRowActionTarget } from "./MobileRowActions";
import { MobileSheet, MobileSheetDivider, MobileSheetRow } from "./MobileSheet";
import { MobileShell, type MobileShellHost, type SheetRenderer } from "./MobileShell";
import { MobileSwipeRow, type MobileRowAction } from "./MobileSwipeRow";
import { useMobileNav, useMobileNavStore } from "./mobileNav";
import { cardOfTask, usePhoneBoardModel, type PhoneBoardInput, type TaskMutations } from "./usePhoneBoard";

/*
 * One task on the phone (#2072 slice 5; docs/design/phone-kanban.md §3.5,
 * §3.7). Every phone door into a task lands here: a card in the columns, a
 * card that needs the operator, the ⋯ › Tasks list, a conversation's task
 * strip, a pipeline's linked tasks and a task link a conversation carries.
 *
 * The bar says where the task stands ("Assigned · 3 agents · 2 pipelines")
 * and takes the title once the body's title scrolls away. The body, one
 * scroll:
 *
 *   1. the title, whole, edited in place with a tap;
 *   2. the pipelines, one block each at task density: what needs the operator
 *      first, then running, provisioning and paused. A decision or a spent
 *      review budget is answered inside its block; the block's head opens the
 *      pipeline screen and each stage pill its conversation. Finished lanes
 *      fold behind one row that names their PRs;
 *   3. a question or a plan approval an agent is waiting on, with Answer;
 *   4. the links attached to the task by hand (each lane's own ride its block);
 *   5. the description, one line until a tap opens it whole to edit;
 *   6. the agents, working first, each opening its conversation, keeping the
 *      board rows' swipe actions (this screen has no pager to fight them);
 *   7. the agent-facing details and the earlier attempts, folded.
 *
 * The bottom bar holds the status and + Agent, in thumb reach. The status is a
 * sheet of the four columns, and a choice moves the task through the desktop's
 * optimistic, revision-guarded mutation with a receipt that carries Undo;
 * nothing moves it on one tap. What the old phone task editor listed beside
 * that — raw assignment rows and a send-to checklist — is not here: the
 * agents are the task's conversations, and + Agent starts one on it.
 */

const STATUS_LABEL: Record<TaskStatus, MessageKey> = {
  inbox: "kanban.status.inbox",
  assigned: "kanban.status.assigned",
  blocked: "kanban.status.blocked",
  done: "kanban.status.done",
};
const STATUS_ICON: Record<TaskStatus, typeof Inbox> = { inbox: Inbox, assigned: UserRoundCheck, blocked: Ban, done: CircleCheck };

/** Lanes in the order the operator acts on them (§3.5); the model's newest
    first holds inside each rank. */
const LANE_RANK: Record<Pipeline["state"], number> = {
  needs_decision: 0, needs_review: 0, running: 1, provisioning: 2, paused: 3, draft: 4, completed: 5, closed: 5,
};

const SECTION = "flex min-h-[30px] items-center gap-1.5 px-1 text-ui font-semibold text-secondary";
const ROW = "flex min-h-11 w-full items-center gap-2 rounded-[12px] bg-card px-3 py-2 text-left shadow-1 active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
const NEEDS_EDGE = "shadow-[inset_3px_0_0_var(--color-warning),var(--shadow-1)]";
const Sep = () => <span aria-hidden className="shrink-0 opacity-60">·</span>;

export interface MobileTaskScreenProps extends PhoneBoardInput {
  taskId: string;
  /** The task mutations the phone's screens share; absent, the screen keeps its own. */
  mutations?: TaskMutations;
  mutationPorts?: TaskMutationPorts;
  host?: MobileShellHost | null;
  renderSheet?: SheetRenderer;
  /** What an agent row offers on a swipe: the board rows' own actions. */
  rowActions?: (target: MobileRowActionTarget) => readonly MobileRowAction[];
  /** Lanes whose close is on their way: gone from the screen on the tap. */
  closing?: readonly string[];
  /** A stage's or an agent's conversation, pushed over this screen so ‹ returns here. */
  onOpenConversation: (file: FileEntry) => void;
  onOpenPipeline: (pipeline: Pipeline) => void;
  /** An agent draft this task holds, not launched yet. */
  onOpenDraft?: (draftId: string) => void;
  /** «+ Agent»: a draft on the task, seeded with its text, as the desktop card's. */
  onAddAgent?: (band: { id: string; task: BoardTask; title: string }) => void;
  /** The conversations the screen draws, for presence. */
  onShown?: (paths: readonly string[]) => void;
  /** Test seams: the held-act store and the pipeline route. */
  acts?: PendingPipelineActs;
  ports?: PipelinePorts;
}

type EditField = "title" | "description" | "details";

interface Editing {
  field: EditField;
  draft: string;
  /** The field as the edit found it: a save whose stored field still reads
      this goes onto the stored text, whatever else moved there. */
  base: string;
  /** A refusal's words, or the text an agent wrote meanwhile. */
  note: { kind: "failed"; text: string } | { kind: "incoming"; value: string } | null;
}

interface Agent {
  file: FileEntry;
  stage: { pipeline: Pipeline; stage: PipelineStage } | null;
}

/** Links a lane block on screen already draws, taken off the task's own row. */
function withoutShown(resolved: ResolvedWorkLinks | null, shown: ReadonlySet<string>): ResolvedWorkLinks | null {
  if (!resolved || !shown.size) return resolved;
  return { ...resolved, links: resolved.links.filter((link) => !shown.has(link.key)) };
}

function agentRank(file: FileEntry, now: number): number {
  const state = mobileRowState(file, now);
  if (state.key === "working" || state.key === "held") return 0;
  if (state.badge) return 1;
  return 2;
}

function agentAt(file: FileEntry): number {
  return typeof file.lastAgentWorkAt === "number" && Number.isFinite(file.lastAgentWorkAt) ? file.lastAgentWorkAt : file.mtime * 1000;
}

function contextLine(t: TFunction, status: TaskStatus, agents: number, pipelines: number): string {
  return [
    t(STATUS_LABEL[status]),
    agents ? t("mobile2.kanban.agents", { count: agents }) : null,
    pipelines ? t("mobile2.task.pipelines", { count: pipelines }) : null,
  ].filter(Boolean).join(" · ");
}

/* ── The editor ─────────────────────────────────────────────────────────── */

/** A field edited in place: Enter saves a title, Save saves any field,
    leaving the field saves, Esc and Cancel drop the draft. */
function FieldEditor({ field, editing, onDraft, onSave, onCancel, onUseTheirs }: {
  field: EditField;
  editing: Editing;
  onDraft: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onUseTheirs: () => void;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const grow = () => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(field === "title" ? 180 : 320, element.scrollHeight + 2)}px`;
  };
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    grow();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);
  const label = field === "title" ? t("kanban.editTitleAria") : field === "details" ? t("kanban.editDetailsAria") : t("kanban.editDescriptionAria");
  /* The editor's own buttons keep the focus, so pressing them is not leaving. */
  const keep = (event: { preventDefault: () => void }) => event.preventDefault();
  const button = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-4 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  return (
    <div ref={wrap} data-phone-task-editor={field} className="flex flex-col gap-1.5">
      <textarea
        ref={ref}
        value={editing.draft}
        aria-label={label}
        rows={field === "title" ? 2 : 4}
        maxLength={field === "title" ? 200 : undefined}
        placeholder={field === "title" ? t("kanban.editTitlePlaceholder") : field === "details" ? t("kanban.editDetailsPlaceholder") : t("kanban.editDescriptionPlaceholder")}
        className={`w-full resize-none rounded-[10px] border border-border bg-card px-3 py-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${field === "title" ? "text-title font-semibold leading-[1.3]" : field === "details" ? "font-mono text-ui leading-[1.45]" : "text-body leading-[1.45]"}`}
        onChange={(event) => {
          onDraft(event.target.value);
          grow();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (field === "title" || event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave();
          }
        }}
        onBlur={(event) => {
          if (wrap.current && event.relatedTarget instanceof Node && wrap.current.contains(event.relatedTarget)) return;
          onSave();
        }}
      />
      {editing.note ? (
        <div role={editing.note.kind === "failed" ? "alert" : "status"} data-phone-task-edit-note={editing.note.kind} className={`flex flex-col gap-1 rounded-[10px] px-3 py-2 text-label ${editing.note.kind === "failed" ? "bg-danger-soft text-danger" : "bg-info-soft text-secondary"}`}>
          <span className="[overflow-wrap:anywhere]">
            {editing.note.kind === "failed"
              ? t("kanban.notSaved", { error: editing.note.text })
              : t(field === "title" ? "kanban.incomingTitle" : "kanban.incomingDescription", { value: editing.note.value })}
          </span>
          {editing.note.kind === "incoming" ? (
            <button type="button" className={`${button} self-start px-0 text-accent`} onPointerDown={keep} onMouseDown={keep} onClick={onUseTheirs}>
              {t("kanban.useTheirs")}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <button type="button" data-phone-task-edit-cancel className={`${button} text-secondary active:bg-sunken`} onPointerDown={keep} onMouseDown={keep} onClick={onCancel}>
          {t("kanban.editCancel")}
        </button>
        <button type="button" data-phone-task-edit-save className={`${button} bg-accent text-white active:opacity-90`} onPointerDown={keep} onMouseDown={keep} onClick={onSave}>
          {t("kanban.editSave")}
        </button>
      </div>
    </div>
  );
}

/* ── Sections ───────────────────────────────────────────────────────────── */

/** A conversation owed an answer the task's blocks do not already carry: a
    question or a plan to approve (§3.5, 3). */
function AskCard({ file, now, onOpen }: { file: FileEntry; now: number; onOpen: () => void }) {
  const { t } = useLocale();
  const state = mobileRowState(file, now);
  const question = file.pendingQuestion?.questions?.[0]?.question?.trim() || cleanTitle(file.title ?? "", 140);
  const model = fileModelLabel(file);
  return (
    <div data-phone-task-ask={file.path} className={`flex flex-col gap-1.5 rounded-[12px] bg-card px-3 pb-1 pt-2.5 ${NEEDS_EDGE}`}>
      <span className="flex min-w-0 items-center gap-[5px] text-label tabular-nums text-muted">
        {state.badge ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-warning-soft px-[7px] text-caption font-semibold leading-none text-warning">{t(BADGE_LABEL[state.badge])}</span>
        ) : null}
        <span className="inline-flex shrink-0"><EngineMark engine={file.engine} size={16} /></span>
        {model ? <span className="min-w-0 truncate">{model}</span> : null}
        {state.seconds !== null ? <><Sep /><span className="shrink-0">{humanizeDuration(blockAgeSeconds(state.seconds))}</span></> : null}
      </span>
      <p className="m-0 line-clamp-3 text-body leading-[1.35] text-primary [overflow-wrap:anywhere]">{question}</p>
      <button
        type="button"
        data-phone-task-answer={file.path}
        className="inline-flex min-h-11 items-center gap-1 self-end rounded-full px-3 text-ui font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={onOpen}
      >
        {t("mobile2.task.answer")}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** Earlier attempts and review rounds of the task's lanes, newest first,
    folded to one row (§3.5, 7). A row whose transcript is in the scan opens it. */
function EarlierAttempts({ lanes, past, files, nowMs, onOpen }: {
  lanes: readonly KanbanPipeline[];
  past: NonNullable<ReturnType<typeof cardOfTask>>["past"];
  files: readonly FileEntry[];
  nowMs: number;
  onOpen: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const names = useMemo(() => new Map(lanes.map((lane) => [lane.pipeline.id, stageNames(t, lane.pipeline)] as const)), [lanes, t]);
  if (!past.length) return null;
  const age = (atMs: number) => (atMs ? humanizeDuration(blockAgeSeconds((nowMs - atMs) / 1000)) : "");
  return (
    <section data-phone-task-past={past.length} className="shrink-0 overflow-hidden rounded-[12px] bg-card shadow-1">
      <button
        type="button"
        aria-expanded={open}
        data-phone-task-past-toggle=""
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-body font-semibold text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        onClick={() => setOpen((value) => !value)}
      >
        <ScrollText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("kanban.past.head", { count: past.length })}</span>
        <ChevronRight className={`h-[18px] w-[18px] shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {open ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {past.map((row) => {
            const label = pastAttemptLabel(t, row, names.get(row.pipelineId)?.get(row.stageId) ?? row.stageId);
            const state = pastAttemptState(t, row);
            const tone = pastAttemptTone(row);
            const file = resolveStageNavFile({ conversationId: row.conversation.conversationId, agentPath: row.conversation.path }, files);
            const Tag = file ? "button" : "div";
            return (
              <li key={row.key} className="border-t border-border">
                <Tag
                  {...(file ? { type: "button" as const, onClick: () => onOpen(file), "aria-label": t("kanban.past.openAria", { label }) } : {})}
                  data-phone-task-past-row={row.key}
                  className={`flex min-h-11 w-full items-center gap-2 py-1.5 pl-3 pr-2.5 text-left text-label tabular-nums ${file ? "active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40" : ""}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="min-w-0 truncate text-ui font-semibold text-primary">{label}</span>
                    <span className="min-w-0 truncate text-muted">
                      {state ? <span className={tone === "ok" ? "text-success" : tone === "bad" ? "text-danger" : ""}>{state}</span> : null}
                      {state && row.atMs ? " · " : ""}
                      {age(row.atMs)}
                      {file ? "" : `${state || row.atMs ? " · " : ""}${t("kanban.past.none")}`}
                    </span>
                  </span>
                  {file ? <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
                </Tag>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/* ── The screen ─────────────────────────────────────────────────────────── */

export function MobileTaskScreen(props: MobileTaskScreenProps) {
  const { t } = useLocale();
  const { taskId, files, flows, now } = props;
  const nav = useMobileNavStore();
  const navState = useMobileNav();
  const linkIndex = useWorkLinks();
  const own = useTaskMutations(props.allTasks, props.mutationPorts);
  const mutations = props.mutations ?? own;
  const { controller, statuses } = mutations;
  const { model, allTasks } = usePhoneBoardModel(props, mutations);
  const stored = useRef(new Map<string, BoardTask>());
  stored.current = new Map(props.allTasks.map((entry) => [entry.id, entry] as const));
  const task = allTasks.find((entry) => entry.id === taskId) ?? null;
  const card = useMemo(() => cardOfTask(model, taskId), [model, taskId]);
  const status: TaskStatus = card?.status ?? statuses.get(taskId) ?? task?.status ?? "inbox";
  const nowMs = now * 1000;

  const lane = usePhonePipelineActs({ ports: props.ports ?? browserPipelinePorts, acts: props.acts ?? pendingPipelineActs });

  /* The task's lanes: the card's, else the ones that name the task (a task
     the board draws no card for still shows its work). A lane whose close is
     on its way is gone on the tap. */
  const closing = props.closing;
  const lanes = useMemo(() => {
    const flowsById = new Map(flows.map((flow) => [flow.id, flow] as const));
    const found = card ? card.pipelines : props.pipelines.filter((pipeline) => pipeline.taskIds?.includes(taskId)).map((pipeline) => summarizePipeline(pipeline, flowsById));
    return found.filter((summary) => !closing?.includes(summary.pipeline.id));
  }, [card, props.pipelines, flows, taskId, closing]);
  const ordered = useMemo(() => lanes
    .map((summary, index) => ({ summary, index }))
    .sort((a, b) => LANE_RANK[a.summary.pipeline.state] - LANE_RANK[b.summary.pipeline.state] || a.index - b.index)
    .map((entry) => entry.summary), [lanes]);
  const live = ordered.filter((summary) => !pipelineEnded(summary.pipeline));
  const ended = ordered.filter((summary) => pipelineEnded(summary.pipeline));
  const [endedOpen, setEndedOpen] = useState(false);

  /* The task's conversations: its members and the ones it shares with
     another card, working first, then those that ask, then by recency. */
  const agents = useMemo<Agent[]>(() => {
    const seen = new Set<string>();
    const list: Agent[] = [];
    const add = (file: FileEntry, stage: Agent["stage"]) => {
      if (seen.has(file.path)) return;
      seen.add(file.path);
      list.push({ file, stage });
    };
    if (card) {
      for (const member of card.members) add(member.file, member.stage);
      for (const mirror of card.mirrors) add(mirror.file, null);
    } else if (task) {
      const byPath = new Map(files.map((file) => [file.path, file] as const));
      for (const assignment of task.assignments) {
        const file = assignment.path ? byPath.get(assignment.path) : undefined;
        if (file) add(file, null);
      }
    }
    return list.sort((a, b) => agentRank(a.file, now) - agentRank(b.file, now) || agentAt(b.file) - agentAt(a.file));
  }, [card, task, files, now]);
  const notLoadedRefs = card?.notLoadedRefs ?? [];
  const unstarted = card?.unstarted ?? [];
  const asks = agents.filter(({ file }) => {
    const badge = mobileRowState(file, now).badge;
    return badge === "question" || badge === "plan";
  });
  const onShown = props.onShown;
  const shownKey = agents.map((agent) => agent.file.path).join("\n");
  useEffect(() => {
    onShown?.(shownKey ? shownKey.split("\n") : []);
  }, [shownKey, onShown]);

  /* The card decides the name, borrowed title included: a placeholder no
     agent will name reads the same here as on the board. */
  const title = task ? (card?.titlePending ? t("kanban.untitled") : (card?.title || textField(task.text, "title")) || t("kanban.untitled")) : "";
  const pendingTitle = card ? card.titlePending : Boolean(task && !textField(task.text, "title"));
  const description = task ? textField(task.text, "description") : "";
  const details = task?.details ?? "";
  const receiptTitle = cleanTitle(title, 48);

  /* ── Edits ────────────────────────────────────────────────────────────── */
  const [editing, setEditing] = useState<Editing | null>(null);
  /* The edit on screen. A save takes it once: Save, Enter and the field's
     blur can all ask for the same edit, and only the first one writes. */
  const activeEdit = useRef<Editing | null>(null);
  activeEdit.current = editing;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const startEdit = (field: EditField) => {
    if (!task) return;
    const base = field === "details" ? details : textField(task.text, field);
    setEditing({ field, draft: field === "title" ? (pendingTitle ? "" : title) : base, base, note: null });
    if (field === "details") setDetailsOpen(true);
  };
  const save = async (entry: Editing): Promise<void> => {
    const raw = stored.current.get(taskId);
    if (!raw || !task || activeEdit.current !== entry) return;
    activeEdit.current = null;
    const value = entry.draft.trim();
    setEditing(null);
    let outcome: FieldEditOutcome;
    if (entry.field === "details") {
      if ((task.details ?? "") === value) return;
      outcome = await controller.edit(raw, { field: "details", value });
    } else {
      const field = entry.field;
      if (field === "title" && !value) {
        setEditing({ ...entry, note: { kind: "failed", text: t("kanban.titleRequired") } });
        return;
      }
      if (textField(task.text, field) === value && !(field === "title" && pendingTitle)) return;
      outcome = await controller.edit(raw, {
        field: "text",
        value: withField(task.text, field, value),
        rebase: (storedText) => (textField(storedText, field) === entry.base ? withField(storedText, field, value) : null),
      });
    }
    if (outcome.kind === "failed") {
      const error = outcome.error.trim();
      setEditing({ ...entry, note: { kind: "failed", text: /[.!?…]$/.test(error) ? error : `${error}.` } });
    } else if (outcome.kind === "conflict") {
      /* An agent wrote this field meanwhile: the editor comes back with the
         operator's draft, and their text beside it. */
      const server = typeof outcome.serverValue === "string" ? outcome.serverValue : "";
      const theirs = entry.field === "details" ? server : textField(server, entry.field);
      if (theirs !== value) setEditing({ ...entry, base: theirs, note: { kind: "incoming", value: theirs } });
    }
  };
  const editorFor = (field: EditField) => (editing?.field === field ? (
    <FieldEditor
      field={field}
      editing={editing}
      onDraft={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
      onSave={() => {
        if (editing) void save(editing);
      }}
      onCancel={() => setEditing(null)}
      onUseTheirs={() => setEditing((current) => (current?.note?.kind === "incoming" ? { ...current, draft: current.note.value, base: current.note.value, note: null } : current))}
    />
  ) : null);

  /* ── Status, colour, hide ─────────────────────────────────────────────── */
  const move = (from: TaskStatus, to: TaskStatus, receipt: boolean): void => {
    const raw = stored.current.get(taskId);
    if (!raw || from === to) return;
    if (receipt) showReceipt(t("mobile2.kanban.moved", { column: t(STATUS_LABEL[to]) }), { kind: "undo", run: () => move(to, from, false) });
    void controller.move(raw, to).then((outcome: StatusMoveOutcome) => {
      if (outcome.kind === "failed") showReceipt(t("kanban.moveFailed", { title: receiptTitle, error: outcome.error }), null, { error: true });
      else if (outcome.kind === "conflict") showReceipt(t("kanban.movedElsewhere", { title: receiptTitle, status: t(STATUS_LABEL[outcome.serverStatus]) }), null, { error: true });
    });
  };
  const setColour = (color: TaskColor | null): void => {
    const raw = stored.current.get(taskId);
    if (!raw) return;
    void controller.edit(raw, { field: "color", value: color }).then((outcome) => {
      if (outcome.kind === "failed") showReceipt(t("kanban.colorFailed", { title: receiptTitle, error: outcome.error }), null, { error: true });
    });
  };
  const hidden = Boolean(task?.groupHidden);
  const setHidden = (hide: boolean, receipt = true): void => {
    const raw = stored.current.get(taskId);
    if (!raw) return;
    if (receipt) {
      showReceipt(
        hide
          ? card?.working ? t("kanban.hiddenReceiptWorking", { title: receiptTitle, count: card.working }) : t("kanban.hiddenReceipt", { title: receiptTitle })
          : t("kanban.restoredReceipt", { title: receiptTitle }),
        { kind: "undo", run: () => setHidden(!hide, false) },
      );
    }
    void controller.edit(raw, hide ? { field: "hide", value: true, replaces: raw.groupHidden?.at ?? null } : { field: "hide", value: false }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      showReceipt(
        !hide ? t("kanban.showFailed", { title: receiptTitle, error: outcome.error })
          : outcome.code === "TASK_HIDE_PROTECTED" ? t("kanban.hideProtected", { title: receiptTitle }) : t("kanban.hideFailed", { title: receiptTitle, error: outcome.error }),
        null,
        { error: true },
      );
    });
  };
  const addAgent = () => {
    if (!task || !props.onAddAgent) return;
    props.onAddAgent({ id: card?.id ?? `task:${task.id}`, task: stored.current.get(taskId) ?? task, title });
  };

  /* ── Lanes ────────────────────────────────────────────────────────────── */
  const stageFile = (pipeline: Pipeline, stageId: string): FileEntry | null => resolveStageNavFile(attemptNavTarget(latestAttempt(pipeline, stageId)), files);
  const openStage = (pipeline: Pipeline, stage: PipelineStage): void => {
    const file = stageFile(pipeline, stage.id);
    /* A stage with no conversation yet is configured on its pipeline's screen. */
    if (file) props.onOpenConversation(file);
    else props.onOpenPipeline(pipeline);
  };
  const [laneFor, setLaneFor] = useState<string | null>(null);
  const [linksFor, setLinksFor] = useState<WorkLinkTarget | null>(null);
  const [menuFace, setMenuFace] = useState<"task" | "colour" | "board">("task");
  useEffect(() => {
    if (navState.sheet !== "menu") setMenuFace("task");
  }, [navState.sheet]);
  const openLinks = (target: WorkLinkTarget) => {
    setLinksFor(target);
    nav.openSheet("links");
  };
  const laneBlock = (summary: KanbanPipeline) => {
    const { pipeline } = summary;
    const needs = pipelineNeedsYou(pipeline);
    return (
      <div
        key={pipeline.id}
        data-phone-task-lane={pipeline.id}
        data-needs={needs ? "1" : undefined}
        className={`phone-lane shrink-0 rounded-[12px] bg-card px-3 pb-1.5 pt-1 ${needs ? NEEDS_EDGE : "shadow-1"} ${pipelineEnded(pipeline) ? "bg-quiet" : ""}`}
      >
        <PipelineBlock
          summary={summary}
          density="task"
          nowMs={nowMs}
          taskTitle={pendingTitle ? null : title}
          acting={lane.acting(pipeline)}
          largeAnswers
          onOpenStage={openStage}
          onOpenStages={props.onOpenPipeline}
          onMenu={(entry) => {
            setLaneFor(entry.id);
            nav.openSheet("lane");
          }}
          onWorkLinks={(target) => openLinks(target)}
          onAnswer={lane.answer}
        />
      </div>
    );
  };
  /* The task's own row keeps only the links no lane block on screen draws. */
  const laneLinks = new Set(lanes.flatMap((summary) => linkIndex.of({ kind: "pipeline", id: summary.pipeline.id })?.links.map((link) => link.key) ?? []));
  const taskLinks = withoutShown(linkIndex.of({ kind: "task", id: taskId }), laneLinks);
  const endedPrs = ended.flatMap((summary) => {
    const pr = linkIndex.of({ kind: "pipeline", id: summary.pipeline.id })?.links.find((link) => link.kind === "pr");
    return pr ? [`#${pr.number}`] : [];
  });

  /* ── Sheets ───────────────────────────────────────────────────────────── */
  const laneSummary = laneFor ? lanes.find((summary) => summary.pipeline.id === laneFor) ?? null : null;
  const sheets: SheetRenderer = (name, close) => {
    if (name === "status") {
      return (
        <MobileSheet name="status" title={t("mobile2.task.statusTitle")} onClose={close}>
          <div role="menu" aria-label={t("mobile2.task.statusTitle")} data-phone-task-status-sheet="" className="flex flex-col py-1">
            {KANBAN_STATUSES.map((entry) => {
              const Icon = STATUS_ICON[entry];
              return (
                <MobileSheetRow
                  key={entry}
                  icon={<Icon className="h-[18px] w-[18px]" aria-hidden />}
                  label={(
                    <span className="flex min-w-0 flex-col">
                      <span className="text-body font-semibold text-primary">{t(STATUS_LABEL[entry])}</span>
                      <span className="text-label font-normal text-muted">{t(`kanban.statusHint.${entry}`)}</span>
                    </span>
                  )}
                  selected={entry === status}
                  trailing={entry === status ? <Check className="h-4 w-4 text-accent" aria-hidden /> : undefined}
                  onSelect={() => {
                    close();
                    move(status, entry, true);
                  }}
                  attrs={{ "data-phone-task-status": entry }}
                />
              );
            })}
          </div>
        </MobileSheet>
      );
    }
    if (name === "lane") {
      if (!laneSummary) return null;
      const { pipeline } = laneSummary;
      const current = screenCurrentStageId(laneSummary);
      const currentFile = current ? stageFile(pipeline, current) : null;
      const stageName = current ? stageNames(t, pipeline).get(current) ?? current : "";
      const acting = lane.acting(pipeline);
      const icons = { pause: Pause, resume: Play, archive: CircleX } as const;
      const laneTitle = cleanTitle(pipelineTitle(t, pipeline), 90);
      return (
        <MobileSheet name="lane" title={laneTitle} onClose={close}>
          <div role="menu" aria-label={laneTitle} className="flex flex-col py-1" data-phone-task-lane-sheet={pipeline.id}>
            <MobileSheetRow
              icon={<Boxes className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.task.openPipeline")}
              trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
              onSelect={() => {
                close();
                props.onOpenPipeline(pipeline);
              }}
              attrs={{ "data-phone-task-lane-action": "open-pipeline" }}
            />
            {currentFile ? (
              <MobileSheetRow
                icon={<ArrowRight className="h-[18px] w-[18px]" aria-hidden />}
                label={t("mobile2.task.openStage", { stage: stageName })}
                trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
                onSelect={() => {
                  close();
                  props.onOpenConversation(currentFile);
                }}
                attrs={{ "data-phone-task-lane-action": "open-conversation" }}
              />
            ) : null}
            {mobilePipelineActions(pipeline).length ? <MobileSheetDivider /> : null}
            {mobilePipelineActions(pipeline).map((spec) => {
              const Icon = icons[spec.key];
              return (
                <MobileSheetRow
                  key={spec.key}
                  icon={<Icon className="h-[18px] w-[18px]" aria-hidden />}
                  label={t(`mobile2.pipeline.${spec.key}`)}
                  danger={spec.key === "archive"}
                  disabled={Boolean(acting)}
                  onSelect={() => {
                    close();
                    if (spec.key === "archive") lane.closeLane(pipeline);
                    else lane.start(pipeline, spec.action);
                  }}
                  attrs={{ "data-phone-task-lane-action": spec.key, "data-mobile2-pipeline-patch": spec.action }}
                />
              );
            })}
          </div>
        </MobileSheet>
      );
    }
    if (name === "links" && linksFor) {
      return (
        <MobileSheet name="links" title={t("workLinks.listTitle")} onClose={close}>
          <div data-mobile2-links-sheet={linksFor.id} className="px-3 pb-3 [&_button]:min-h-11 [&_input]:min-h-11">
            <WorkLinksPanel target={linksFor} resolved={linkIndex.of(linksFor)} />
          </div>
        </MobileSheet>
      );
    }
    if (name === "menu" && menuFace === "colour" && task) {
      return (
        <MobileSheet name="menu" title={t("kanban.colour")} onClose={close}>
          <div role="menu" aria-label={t("kanban.colour")} className="flex flex-col py-1" data-phone-task-colours="">
            {[null, ...TASK_COLORS].map((color) => (
              <MobileSheetRow
                key={color ?? "none"}
                icon={color
                  ? <span aria-hidden className="h-4 w-4 rounded-full" style={{ backgroundColor: TASK_COLOR_HEX[color] }} />
                  : <span aria-hidden className="h-4 w-4 rounded-full border border-dashed border-strong" />}
                label={t(color ? `kanban.color.${color}` : "kanban.color.none")}
                selected={(task.color ?? null) === color}
                trailing={(task.color ?? null) === color ? <Check className="h-4 w-4 text-accent" aria-hidden /> : undefined}
                onSelect={() => {
                  close();
                  setColour(color);
                }}
                attrs={{ "data-phone-task-colour": color ?? "none" }}
              />
            ))}
          </div>
        </MobileSheet>
      );
    }
    if (name === "menu" && menuFace === "task" && task) {
      const row = (key: string, icon: ReactNode, label: string, run: () => void, trailing?: ReactNode) => (
        <MobileSheetRow key={key} icon={icon} label={label} trailing={trailing} onSelect={run} attrs={{ "data-phone-task-menu": key }} />
      );
      return (
        <MobileSheet name="menu" title={cleanTitle(title, 90)} onClose={close}>
          <div role="menu" aria-label={cleanTitle(title, 90)} className="flex flex-col py-1" data-phone-task-menu-sheet={taskId}>
            {row("rename", <Pencil className="h-[18px] w-[18px]" aria-hidden />, t("kanban.rename"), () => { close(); startEdit("title"); })}
            {row("colour", <Palette className="h-[18px] w-[18px]" aria-hidden />, t("kanban.colour"), () => setMenuFace("colour"), <ChevronRight className="h-4 w-4" aria-hidden />)}
            {row("details", <ScrollText className="h-[18px] w-[18px]" aria-hidden />, t("kanban.details"), () => { close(); startEdit("details"); })}
            {row("links", <Link2 className="h-[18px] w-[18px]" aria-hidden />, t("workLinks.attach"), () => openLinks({ kind: "task", id: taskId }))}
            {card?.holdsSeat ? null : hidden
              ? row("show", <Eye className="h-[18px] w-[18px]" aria-hidden />, t("mobile2.task.showOnBoard"), () => { close(); setHidden(false); })
              : row("hide", <EyeOff className="h-[18px] w-[18px]" aria-hidden />, t("kanban.hideFromBoard"), () => { close(); setHidden(true); })}
            <MobileSheetDivider />
            {row("board", <Boxes className="h-[18px] w-[18px]" aria-hidden />, t("mobile2.pipeline.boardMenu"), () => setMenuFace("board"), <ChevronRight className="h-4 w-4" aria-hidden />)}
          </div>
        </MobileSheet>
      );
    }
    return props.renderSheet?.(name, close) ?? null;
  };

  /* ── The bar and the bottom bar ───────────────────────────────────────── */
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const titleAway = useScrolledAway(heading, body);
  const context = contextLine(t, status, agents.length, lanes.length);
  const barTitle = (
    <span className="flex min-w-0 flex-1 flex-col">
      {titleAway ? <span data-mobile2-title-text className="min-w-0 truncate text-title font-semibold leading-tight text-primary">{title}</span> : null}
      <span data-phone-task-context="" className={`min-w-0 truncate tabular-nums ${titleAway ? "text-label text-muted" : "text-ui text-secondary"}`}>{context}</span>
    </span>
  );
  const bottomBar = task ? (
    <div data-phone-task-bar="" className="flex items-center justify-between gap-3">
      <button
        type="button"
        data-phone-task-status-pill={status}
        aria-label={t("mobile2.task.statusAria", { status: t(STATUS_LABEL[status]) })}
        aria-haspopup="dialog"
        aria-expanded={navState.sheet === "status"}
        className="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-full bg-accent-soft px-4 text-body font-semibold text-accent active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={() => nav.openSheet("status")}
      >
        <span className="min-w-0 truncate">{t(STATUS_LABEL[status])}</span>
        <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
      </button>
      {props.onAddAgent ? (
        <button
          type="button"
          data-phone-task-add-agent=""
          aria-label={t("kanban.addAgentAria", { title: receiptTitle })}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-accent/50 px-4 text-body font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={addAgent}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t("kanban.addAgent")}
        </button>
      ) : null}
    </div>
  ) : undefined;

  const agentTitle = (agent: Agent): string => {
    const own = cleanTitle(agent.file.title ?? "", 90) || t("kanban.untitledConversation");
    if (!agent.stage) return own;
    const stage = stageNames(t, agent.stage.pipeline).get(agent.stage.stage.id) ?? agent.stage.stage.id;
    return lanes.length > 1 ? `${stage} · ${cleanTitle(pipelineTitle(t, agent.stage.pipeline), 60)}` : stage;
  };

  return (
    <MobileShell screen="task" screenId={taskId} back title={barTitle} host={props.host} renderSheet={sheets} dock={bottomBar}>
      <div ref={body} data-phone-task-body={taskId} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 pb-4 pt-3">
        {!task ? (
          <p data-phone-task-gone="" className="m-0 px-1 py-8 text-center text-body text-muted">{t("mobile2.task.gone")}</p>
        ) : (
          <>
            {/* 1. The title, whole; a tap edits it in place. The wrapper stays
                through an edit, so the bar keeps watching the same element. */}
            <div ref={heading} className="shrink-0">
              {editorFor("title") ?? (
                <h1 className="m-0"><button
                  type="button"
                  data-phone-task-title=""
                  aria-label={pendingTitle ? t("kanban.renamePending") : t("kanban.renameAria", { title })}
                  className={`min-h-11 w-full rounded-[8px] px-1 py-0.5 text-left text-title leading-[1.3] [overflow-wrap:anywhere] active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${pendingTitle ? "font-normal italic text-muted" : "font-semibold text-primary"}`}
                  onClick={() => startEdit("title")}
                >
                  {title}
                </button></h1>
              )}
            </div>

            {/* 2. The pipelines: what needs the operator first; finished ones folded. */}
            {live.length || ended.length ? (
              <section data-phone-task-lanes={lanes.length} className="flex shrink-0 flex-col gap-2">
                {live.map(laneBlock)}
                {ended.length ? (
                  <>
                    <button
                      type="button"
                      data-phone-task-ended={ended.length}
                      aria-expanded={endedOpen}
                      aria-label={t(endedOpen ? "kanban.pipelines.completedHide" : "kanban.pipelines.completedShow", { count: ended.length })}
                      className="flex min-h-11 w-full items-center gap-2 rounded-[12px] border border-dashed border-border px-3 text-left text-ui tabular-nums text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                      onClick={() => setEndedOpen((open) => !open)}
                    >
                      <Check className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {[t("mobile2.pipelines.completed", { count: ended.length }), ...endedPrs].join(" · ")}
                      </span>
                      <ChevronDown className={`h-[18px] w-[18px] shrink-0 text-muted transition-transform motion-reduce:transition-none ${endedOpen ? "rotate-180" : ""}`} aria-hidden />
                    </button>
                    {endedOpen ? ended.map(laneBlock) : null}
                  </>
                ) : null}
              </section>
            ) : null}

            {/* 3. What an agent asks that no block carries. */}
            {asks.length ? (
              <section data-phone-task-needs={asks.length} className="flex shrink-0 flex-col gap-1.5">
                <h2 className={`${SECTION} m-0`}>{t("mobile2.attention.title")}</h2>
                {asks.map(({ file }) => <AskCard key={file.path} file={file} now={now} onOpen={() => props.onOpenConversation(file)} />)}
              </section>
            ) : null}

            {/* 4. Links attached to the task by hand. */}
            <WorkLinkRow resolved={taskLinks} showNoPr={false} className="phone-task-links" testId={taskId} onMore={() => openLinks({ kind: "task", id: taskId })} />

            {/* 5. The description: one line, whole and editable on a tap. */}
            {editorFor("description") ?? (
              <button
                type="button"
                data-phone-task-description=""
                aria-label={description ? t("kanban.editDescription") : t("kanban.addDescription")}
                className={`${ROW} shrink-0 min-h-12`}
                onClick={() => startEdit("description")}
              >
                <span className="flex min-w-0 flex-1 items-baseline gap-[5px] text-body">
                  <span className="shrink-0 font-semibold text-primary">{t("mobile2.task.description")}</span>
                  <Sep />
                  <span className={`min-w-0 truncate ${description ? "text-secondary" : "italic text-muted"}`}>{description ? description.split(/\r?\n/, 1)[0] : t("kanban.addDescription")}</span>
                </span>
                <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
              </button>
            )}

            {/* 6. The agents, working first. */}
            <section data-phone-task-agents={agents.length} className="flex shrink-0 flex-col gap-1.5">
              <h2 className={`${SECTION} m-0`}>
                {t("mobile2.task.agents")}
                <Sep />
                <span className="text-label font-semibold tabular-nums text-muted">{agents.length + notLoadedRefs.length}</span>
              </h2>
              {agents.map((agent) => {
                const rowTitle = agentTitle(agent);
                const row: MobileBoardConversation = {
                  file: agent.file,
                  path: agent.file.path,
                  title: rowTitle,
                  state: mobileRowState(agent.file, now),
                  now: nowFragment(agent.file),
                  launchedAt: launchedAt(agent.file),
                  crowned: false,
                };
                const actions = props.rowActions?.({ kind: "conversation", row: { path: agent.file.path, title: rowTitle } }) ?? [];
                const view = <ConversationRow row={row} now={now} onOpen={props.onOpenConversation} />;
                return (
                  <div key={agent.file.path} data-phone-task-agent={agent.file.path} data-phone-task-agent-stage={agent.stage?.stage.id}>
                    {actions.length ? <MobileSwipeRow id={`task:${taskId}:${agent.file.path}`} title={rowTitle} actions={actions}>{view}</MobileSwipeRow> : view}
                  </div>
                );
              })}
              {(card?.drafts ?? []).map((draftId) => (
                <button
                  key={draftId}
                  type="button"
                  data-phone-task-draft={draftId}
                  className={`${ROW} min-h-14 bg-quiet shadow-none ring-1 ring-inset ring-border`}
                  disabled={!props.onOpenDraft}
                  onClick={() => props.onOpenDraft?.(draftId)}
                >
                  <Plus className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-body font-semibold text-secondary">{t("mobile2.task.draft")}</span>
                  <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
                </button>
              ))}
              {/* A conversation the board did not load still opens, through its
                  own transcript; the count on the card holds only these. */}
              {notLoadedRefs.map((ref) => (
                <button
                  key={ref.key}
                  type="button"
                  data-phone-task-not-loaded={ref.key}
                  className={`${ROW} min-h-14 bg-quiet shadow-none ring-1 ring-inset ring-border`}
                  onClick={() => { window.location.hash = formatConversationHash({ conversationId: ref.conversationId ?? undefined, path: ref.path }); }}
                >
                  <span className="min-w-0 flex-1 truncate text-body font-semibold text-secondary">{t("kanban.notLoadedOpen")}</span>
                  <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
                </button>
              ))}
              {/* A launch that never produced a transcript opens nothing: it
                  says so, and can be dismissed. */}
              {unstarted.map((launch) => (
                <div
                  key={launch.key}
                  data-phone-task-unstarted={launch.key}
                  title={t("kanban.launchNotStartedHint")}
                  className="flex min-h-14 w-full items-center gap-2 rounded-[12px] border border-dashed border-border px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-body text-muted">{t("kanban.launchNotStarted")}</span>
                  <button
                    type="button"
                    data-phone-launch-dismiss={launch.key}
                    aria-label={t("kanban.dismissLaunchAria", { title })}
                    className="min-h-11 shrink-0 rounded-[8px] px-3 text-ui font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onClick={() => { void dismissUnstartedLaunch(taskId, launch); }}
                  >
                    {t("kanban.dismissLaunch")}
                  </button>
                </div>
              ))}
              {!agents.length && !notLoadedRefs.length && !unstarted.length && !card?.drafts.length ? (
                <p className="m-0 px-1 text-ui text-muted">{t("mobile2.kanban.noAgents")}</p>
              ) : null}
            </section>

            {/* 7. The agent's context and the earlier attempts, folded. */}
            {editorFor("details") ?? (details ? (
              <section data-phone-task-details="" className="shrink-0 overflow-hidden rounded-[12px] bg-card shadow-1">
                <button
                  type="button"
                  aria-expanded={detailsOpen}
                  data-phone-task-details-toggle=""
                  aria-label={t(detailsOpen ? "kanban.detailsHide" : "kanban.detailsShow", { title: receiptTitle })}
                  className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-body font-semibold text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  <ScrollText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t("kanban.details")}</span>
                  <ChevronRight className={`h-[18px] w-[18px] shrink-0 text-muted transition-transform motion-reduce:transition-none ${detailsOpen ? "rotate-90" : ""}`} aria-hidden />
                </button>
                {detailsOpen ? (
                  <button
                    type="button"
                    data-phone-task-details-text=""
                    aria-label={t("kanban.editDetails")}
                    className="block max-h-[320px] w-full overflow-y-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-left font-mono text-ui leading-[1.45] text-secondary [overflow-wrap:anywhere] active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                    onClick={() => startEdit("details")}
                  >
                    {details}
                  </button>
                ) : null}
              </section>
            ) : null)}
            <EarlierAttempts lanes={lanes} past={card?.past ?? []} files={files} nowMs={nowMs} onOpen={props.onOpenConversation} />
          </>
        )}
      </div>
    </MobileShell>
  );
}
