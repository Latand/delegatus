"use client";

import { useSyncExternalStore } from "react";

import { cachedProjectName } from "@/lib/client/projectNameCache";
import { projectTitle } from "@/lib/displayNames";
import type { TFunction } from "@/lib/i18n";
import type { BlockingStage, BlockingTurn, QuietBlockers } from "@/lib/selfUpdate/quiet";
import type { ResumeWork } from "@/lib/selfUpdate/types";

import { roleNameById } from "@/components/builderCopy";

/**
 * The names a person reads for the work an update waits on. The server sends
 * a turn with its project key (`repo-<hash>`) and its conversation id; the
 * Viewer already holds the project's display name and the conversation's
 * title, and publishes them here for the update dialog and both Needs-you
 * lists. Presentation only: nothing is keyed by a published name.
 */
export interface BlockerNames {
  projects: Readonly<Record<string, string>>;
  conversations: Readonly<Record<string, string>>;
  /** Board card titles by task id, for the stages the update confirmation names. */
  tasks?: Readonly<Record<string, string>>;
  /** Board card titles by a conversation that works for the card. */
  cards?: Readonly<Record<string, string>>;
}

const NONE: BlockerNames = { projects: {}, conversations: {} };
let current = NONE;
const listeners = new Set<() => void>();

export function publishBlockerNames(next: BlockerNames): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBlockerNames(): BlockerNames {
  return useSyncExternalStore(subscribe, () => current, () => NONE);
}

/** The ids a surface outside the Viewer's own feed wants named: the update
    confirmation reads work the Viewer's feed leaves out. */
export interface WantedNames {
  conversations: readonly string[];
  tasks: readonly string[];
}

const NOTHING: WantedNames = { conversations: [], tasks: [] };
let wanted = NOTHING;
const wantListeners = new Set<() => void>();

export function wantBlockerNames(next: WantedNames): void {
  if (JSON.stringify(next) === JSON.stringify(wanted)) return;
  wanted = next;
  for (const listener of wantListeners) listener();
}

function subscribeWanted(listener: () => void): () => void {
  wantListeners.add(listener);
  return () => { wantListeners.delete(listener); };
}

export function useWantedBlockerNames(): WantedNames {
  return useSyncExternalStore(subscribeWanted, () => wanted, () => NOTHING);
}

/** The ids `workRows` looks up for one reading of the work. */
export function workNamesWanted(work: ResumeWork | null | undefined): WantedNames {
  if (!work) return NOTHING;
  return {
    conversations: (work.turnList ?? []).filter((turn) => !turn.stage).map((turn) => turn.conversationId),
    tasks: (work.stageList ?? []).flatMap((stage) => stage.taskId ? [stage.taskId] : []),
  };
}

const ENGINES: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot" };

function turnLabel(turn: BlockingTurn, names: BlockerNames, t: TFunction): string {
  const project = turn.project ? projectTitle(turn.project, names.projects[turn.project], cachedProjectName(turn.project)) : null;
  if (turn.seat) return project ? t("selfUpdate.auto.block.seat", { project }) : t("selfUpdate.auto.block.seatUnnamed");
  const engine = ENGINES[turn.engine];
  const work = names.conversations[turn.conversationId]?.trim()
    || (engine ? t("selfUpdate.auto.block.agent", { engine }) : t("selfUpdate.auto.block.agentUnknown"));
  return project ? `${project} · ${work}` : work;
}

/**
 * The running work as rows: each stage once, then each turn that belongs to
 * no listed stage, by project name and conversation title. A count stands in
 * only where the server sent no list to name.
 */
export function blockerRows(blockers: QuietBlockers | null | undefined, names: BlockerNames, t: TFunction): { key: string; text: string }[] {
  if (!blockers) return [];
  const stages = blockers.stageList ?? [];
  const turns = blockers.turnList ?? [];
  const rows = stages.map((stage) => ({ key: `${stage.pipelineId}:${stage.stageId}`, text: `${stage.stageId} · ${stage.task}` }));
  const labels = new Map<string, number>();
  for (const turn of turns) {
    if (turn.stage) continue;
    const label = turnLabel(turn, names, t);
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  for (const [label, count] of labels) rows.push({ key: `turn:${label}`, text: count > 1 ? `${label} ×${count}` : label });
  if (!stages.length && blockers.stages > 0) rows.push({ key: "stages", text: t("selfUpdate.auto.block.stages", { count: blockers.stages }) });
  if (!turns.length && blockers.turns > 0) rows.push({ key: "turns", text: t("selfUpdate.auto.block.turns", { count: blockers.turns }) });
  return rows;
}

/** One running item as a person reads it: what the work is, who does it and
    in which project. No project key or conversation id is ever a name. */
export interface WorkRow {
  key: string;
  kind: "stage" | "seat" | "agent";
  title: string;
  /** Empty when it would only repeat the title. */
  who: string;
  /** The project's display name, or null when it has none a person can read. */
  project: string | null;
}

function projectName(key: string | null | undefined, names: BlockerNames): string | null {
  return key ? projectTitle(key, names.projects[key], cachedProjectName(key)) : null;
}

/* The role in words: the role's name, a review flow's own words, or a stage
   id that is a word. An opaque id says nothing, so it says nothing here. */
function stageWho(stage: BlockingStage, t: TFunction): string {
  if (stage.roleId) return roleNameById(t, stage.roleId);
  if (stage.pipelineId.startsWith("flow:")) return t("pipelineStrip.reviewStage");
  const words = stage.stageId.replace(/[-_]+/g, " ").trim();
  if (!words || /^[0-9a-f]{8,}$|^\d+$/i.test(stage.stageId)) return "";
  return words[0]!.toUpperCase() + words.slice(1);
}

/**
 * The confirmation's rows: each stage once, by its card's title, then each
 * turn that belongs to no listed stage, by the card it works for, else its
 * conversation's title, else its agent.
 */
export function workRows(work: ResumeWork | null | undefined, names: BlockerNames, t: TFunction): WorkRow[] {
  if (!work) return [];
  const rows: WorkRow[] = (work.stageList ?? []).map((stage) => {
    const who = stageWho(stage, t);
    const title = (stage.taskId ? names.tasks?.[stage.taskId]?.trim() : "") || stage.task.trim() || who;
    return { key: `stage:${stage.pipelineId}:${stage.stageId}`, kind: "stage", title, who: title === who ? "" : who, project: projectName(stage.project, names) };
  });
  for (const turn of work.turnList ?? []) {
    if (turn.stage) continue;
    const engine = ENGINES[turn.engine];
    const agent = engine ? t("selfUpdate.auto.block.agent", { engine }) : t("selfUpdate.auto.block.agentUnknown");
    const project = projectName(turn.project, names);
    if (turn.seat) {
      rows.push({ key: `turn:${turn.conversationId}`, kind: "seat", title: t("selfUpdate.auto.block.seatUnnamed"), who: agent, project });
      continue;
    }
    const title = names.cards?.[turn.conversationId]?.trim() || names.conversations[turn.conversationId]?.trim() || agent;
    rows.push({ key: `turn:${turn.conversationId}`, kind: "agent", title, who: title === agent ? "" : agent, project });
  }
  return rows;
}

/** Rows under each project's name, in the order the projects first appear;
    every project with no readable name shares one group, which comes last. */
export function groupWorkRows(rows: readonly WorkRow[]): { project: string | null; rows: WorkRow[] }[] {
  const groups = new Map<string | null, WorkRow[]>();
  for (const row of rows) groups.set(row.project, [...groups.get(row.project) ?? [], row]);
  const named = [...groups].filter(([project]) => project !== null);
  const unnamed = groups.get(null);
  return [...named, ...(unnamed ? [[null, unnamed] as const] : [])].map(([project, rows]) => ({ project, rows }));
}
