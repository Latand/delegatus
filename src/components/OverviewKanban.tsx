"use client";

import { useMemo } from "react";

import { useNowSeconds, BOARD_CLOCK_MS } from "@/hooks/useNowSeconds";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { KanbanBoard, type KanbanOverviewScope } from "./kanban/KanbanBoard";
import { cardHasLiveWork } from "./kanban/kanbanModel";
import { pipelinesForProjects } from "./pipelines/pipelineModel";
import { buildBranchGroups, OVERVIEW } from "./projectModel";

/**
 * The Overview's board (#1820).
 *
 * It is the SAME board a project renders — `KanbanBoard` over
 * `buildSchemeLayout` → `buildTaskBands` → `buildKanbanModel` — with exactly
 * two differences, both of them inputs rather than code:
 *
 * 1. **Scope.** Every project's conversations, tasks and pipelines are fed at
 *    once. Nothing below this file had to learn about more than one project:
 *    the layout and the bands are keyed by conversation and task identity, and
 *    the task projection's `project` argument only fences its unlinked
 *    buckets, so omitting it IS the cross-project answer.
 * 2. **The filter.** `cardHasLiveWork` — the predicate behind the board's own
 *    «N working» and «N need you» counters — narrows the columns exactly where
 *    the board's search narrows them.
 *
 * What stays project-only is what needs one project to write into: the
 * orchestrator seat, «+ Task», «+ Agent», drafts and the per-project board
 * preferences (hidden cards, crowned favourites, manual placement). None of
 * them is faked here; they are simply not passed, and the board draws neither.
 * A status move is unaffected — it already writes with the task's own
 * `expectedProject`.
 *
 * Every byte comes from the projection the Viewer already polls. This file
 * issues no request and starts no loop of its own.
 */

const NO_FILES: FileEntry[] = [];
const NO_DRAFTS: string[] = [];
const NO_SELECTION: ReadonlySet<string> = new Set();

export interface OverviewKanbanProps {
  /** The projects the Overview shows, archived ones already removed. */
  projects: readonly string[];
  /** Display name per project key, for the label on each card. */
  displayNames: Readonly<Record<string, string>>;
  files: FileEntry[];
  /** Every stored task the Viewer holds; one payload, for every project. */
  tasks: readonly BoardTask[];
  flows: Flow[];
  pipelines: Pipeline[];
  loaded: boolean;
  catalogFailures: number;
  /** A card's project label opens that project's own board. */
  onSelectProject: (project: string) => void;
  /** The board's «see every conversation» escape: the Overview's own search. */
  onOpenConversations: () => void;
}

export function OverviewKanban({ projects, displayNames, files, tasks, flows, pipelines, loaded, catalogFailures, onSelectProject, onOpenConversations }: OverviewKanbanProps) {
  /* The dashboard's board clock, shared by cadence: the working predicate is
     read from row states that age, so it must advance between scans. */
  const now = useNowSeconds(BOARD_CLOCK_MS);
  const shown = useMemo(() => new Set(projects), [projects]);
  /* One grouping pass per project, concatenated. `buildBranchGroups` already
     selects a project's own roots out of the whole file list, so this is the
     same grouping a project's board gets, for each project in turn. */
  const groups = useMemo(
    () => projects.flatMap((project) => buildBranchGroups(files, project, { now })),
    [projects, files, now],
  );
  /* The fence that lets a pipeline grow memberless stage rows, taken over the
     union instead of one project — asking per project would walk every
     pipeline and every file once per project. */
  const surfacePipelines = useMemo(() => pipelinesForProjects(pipelines, shown, files), [pipelines, shown, files]);
  const boardTasks = useMemo(() => tasks.filter((task) => shown.has(task.project)), [tasks, shown]);
  const scope = useMemo<KanbanOverviewScope>(
    () => ({ names: displayNames, onOpenProject: onSelectProject, keep: cardHasLiveWork }),
    [displayNames, onSelectProject],
  );

  return (
    <KanbanBoard
      project={OVERVIEW}
      overview={scope}
      groups={groups}
      manual={NO_FILES}
      files={files}
      flows={flows}
      pipelines={pipelines}
      surfacePipelines={surfacePipelines}
      tasks={boardTasks}
      allTasks={boardTasks}
      drafts={NO_DRAFTS}
      now={now}
      loaded={loaded}
      catalogFailures={catalogFailures}
      selection={NO_SELECTION}
      /* Known and empty: the Overview reads no seat, so the board neither
         fetches one nor waits on one. */
      seatRefs={null}
      onOpenConversations={onOpenConversations}
    />
  );
}
