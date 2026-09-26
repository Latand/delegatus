import { stagePosition } from "@/components/mobile/mobileChatState";
import type { DismissalSubjectRequest, DismissalTarget } from "@/lib/attention/dismissalTypes";
import type { TFunction } from "@/lib/i18n";
import { drawnLaneMovement } from "@/lib/pipelines/laneMovement";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { conversationFrameRole, type FrameRole } from "@/lib/roleFrames";

import { attentionEntryProject, type MobileAttentionEntry } from "./attentionQueue";
import { needLabel } from "./decision";
import { laneNeed, laneStageId } from "./needReason";

/*
 * The needs-you panel's pure half (docs/design/needs-you-options.md, option B):
 * the one queue (`buildNeedsYouQueue`) cut into a section per project, the
 * role of the agent behind each row, and what «Dismiss» names for a row, a
 * section or the whole list. The desktop panel, the phone sheet and the
 * project rail read these, so the header, the panel's sections and the rail
 * carry one number per project.
 */

export interface NeedsYouSection {
  project: string;
  entries: MobileAttentionEntry[];
}

/**
 * The queue by project: the project on screen first, then every other project
 * in the rail's order (`railProjectOrder`), so the panel and the rail beside
 * it list the projects the same way down. A project the rail does not list,
 * or every project when no order is given, follows in the order its first
 * entry holds in the queue. Inside a section the rows run oldest wait first,
 * conversations and lanes together (`needsYouEntrySince`), so the ages read
 * in one direction down every section.
 */
export function needsYouSections(queue: readonly MobileAttentionEntry[], current: string | null, order: readonly string[] = []): NeedsYouSection[] {
  const byProject = new Map<string, MobileAttentionEntry[]>();
  for (const entry of queue) {
    const project = attentionEntryProject(entry);
    const list = byProject.get(project);
    if (list) list.push(entry);
    else byProject.set(project, [entry]);
  }
  const rank = new Map(order.map((project, index) => [project, index]));
  const place = (project: string) => (project === current ? -1 : rank.get(project) ?? order.length);
  /* `sort` is stable, so projects the order does not name keep the queue's order. */
  return [...byProject]
    .sort(([a], [b]) => place(a) - place(b))
    .map(([project, entries]) => ({ project, entries: byWait(entries) }));
}

/** When an entry started waiting, in epoch seconds: a conversation's reason,
    a lane's need (the movement it parked at); null when a lane names none. */
/** A parked lane's wait in the card's words (`needLabel`): what the desktop
    panel and the phone sheet both say under a lane's title. */
export function needsYouLaneLine(t: TFunction, pipeline: Pipeline): string {
  const need = laneNeed(pipeline)?.need;
  return need ? needLabel(t, need) : t("needs.laneDecision");
}

export function needsYouEntrySince(entry: MobileAttentionEntry): number | null {
  if (entry.kind === "conversation") return entry.item.since;
  return laneNeed(entry.row.pipeline)?.need.since ?? null;
}

/* Oldest wait first; an entry without a start keeps its place after them. */
function byWait(entries: readonly MobileAttentionEntry[]): MobileAttentionEntry[] {
  const since = new Map(entries.map((entry) => [entry, needsYouEntrySince(entry)]));
  const at = (entry: MobileAttentionEntry) => since.get(entry) ?? Number.MAX_SAFE_INTEGER;
  return [...entries].sort((a, b) => at(a) - at(b));
}

/** How many entries each project holds: the rail's ⏸ count. */
export function needsYouCounts(queue: readonly MobileAttentionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of queue) {
    const project = attentionEntryProject(entry);
    counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  return counts;
}

/**
 * Which kind of agent waits behind a row, from the authorities the role
 * frames already read (`conversationFrameRole`): an orchestrator's question is
 * the seat's, a conversation wears its pipeline stage's role or its spawn
 * role, and a parked lane wears the role of the stage it stopped on.
 */
export function needsYouEntryRole(entry: MobileAttentionEntry, pipelines: readonly Pipeline[]): FrameRole {
  if (entry.kind === "pipeline") {
    const lane = entry.row.pipeline;
    const stageId = laneStageId(lane);
    const stage = stageId ? lane.stages.find((candidate) => candidate.id === stageId) ?? null : entry.row.stageRef;
    return conversationFrameRole({ stage: stageRole(stage) });
  }
  const { file, reason } = entry.item;
  if (reason.kind === "decision") return "orchestrator";
  return conversationFrameRole({ stage: stageRole(stagePosition(pipelines, file.path)?.stage ?? null), file });
}

/** A stage's role as the role frames read it: the one it was declared with,
    else the registry resolution captured when the pipeline was created. */
function stageRole(stage: PipelineStage | null): { kind?: string; role?: { roleId?: string | null } | null } | null {
  if (!stage) return null;
  return { kind: stage.kind, role: { roleId: stage.role?.roleId ?? stage.effectiveRole?.roleId ?? null } };
}

/**
 * What «Dismiss» clears for one row: exactly the reason the row drew. An
 * orchestrator's question is its report, resolved in the report log; a
 * conversation's reason is named by its attention id; a lane by the movement
 * it was drawn at, so a lane that parked again since is not cleared.
 */
export function needsYouSubject(entry: MobileAttentionEntry): DismissalSubjectRequest {
  if (entry.kind === "pipeline") {
    return { kind: "pipeline", pipelineId: entry.row.pipeline.id, laneMovedAt: drawnLaneMovement(entry.row.pipeline) };
  }
  const { file, reason } = entry.item;
  if (reason.report) return { kind: "report", seq: reason.report.seq };
  return {
    kind: "conversation",
    ...(file.conversationId ? { conversationId: file.conversationId } : {}),
    path: file.path,
    reasonId: reason.id,
    reason: reason.kind,
  };
}

/** One request for several rows (a section's or the panel's «Dismiss all»). */
export function needsYouDismissal(entries: readonly MobileAttentionEntry[]): { target: DismissalTarget; subjects: DismissalSubjectRequest[] } {
  const subjects = entries.map(needsYouSubject);
  return { target: { kind: "subjects", subjects }, subjects };
}

/** The row the operator is looking at: the open conversation, or the focused lane card. */
export function isFocusedNeedsYouEntry(entry: MobileAttentionEntry, focus: { path: string | null; laneId: string | null }): boolean {
  if (entry.kind === "pipeline") return focus.laneId !== null && entry.row.pipeline.id === focus.laneId;
  return focus.path !== null && entry.item.file.path === focus.path;
}
