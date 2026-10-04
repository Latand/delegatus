"use client";

import { useSyncExternalStore } from "react";

import { cachedProjectName } from "@/lib/client/projectNameCache";
import { projectTitle } from "@/lib/displayNames";
import type { TFunction } from "@/lib/i18n";
import type { BlockingTurn, QuietBlockers } from "@/lib/selfUpdate/quiet";

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
