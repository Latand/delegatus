"use client";

import { useCallback, useMemo } from "react";

import { useNowSeconds, BOARD_CLOCK_MS } from "@/hooks/useNowSeconds";
import { isOpaqueProjectKey, projectTitle } from "@/lib/displayNames";
import { cachedProjectName } from "@/lib/client/projectNameCache";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { useSeatConversations } from "./orchestrator/useOrchestratorSeat";
import { KanbanBoard, type KanbanOverviewScope } from "./kanban/KanbanBoard";
import { cardHasLiveWork } from "./kanban/kanbanModel";
import { MobileKanban } from "./mobile/MobileKanban";
import { useClosingPipelines } from "./mobile/MobilePipelineScreen";
import { overviewAttention } from "./mobile/overviewPhone";
import { pipelinesForProjects } from "./pipelines/pipelineModel";
import { PhoneKanbanSkeleton } from "./skeletons";
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
 * The one thing it asks for itself is the set of conversations the seat
 * records name (#1841): an orchestrator seat belongs to the seat panel of its
 * own project's board and to no task list, and a board spanning every project
 * needs every project's seats to keep them all out. The per-project read
 * cannot answer that here, because the Overview names no project.
 *
 * What stays project-only is what needs one project to write into: the
 * orchestrator seat, «+ Task», «+ Agent», drafts and the per-project board
 * preferences (hidden cards, crowned favourites, manual placement). None of
 * them is faked here; they are simply not passed, and the board draws neither.
 * A status move is unaffected — it already writes with the task's own
 * `expectedProject`.
 *
 * Every card, count and column comes from the projection the Viewer already
 * polls; the seat read above is the file's only request, one slow status read
 * that starts and stops with this board.
 *
 * On the phone (#2098) the same inputs draw the phone kanban a project draws
 * (`MobileKanban`): its status tabs, its cards with the pipeline block at card
 * density, its card sheet, each card naming its project. A card opens its
 * task, its pipeline or its conversation through `phone`, full screen on the
 * navigation stack the Overview is the board of; nothing expands inside a
 * card.
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
  /** The phone's doors (#2098). Present, the Overview draws the phone kanban
      instead of the desktop board. */
  phone?: OverviewPhoneDoors | null;
}

export interface OverviewPhoneDoors {
  onOpenTask: (task: BoardTask) => void;
  onOpenPipeline: (pipeline: Pipeline) => void;
  onOpenConversation: (file: FileEntry) => void;
  /** How many tasks the board is not drawing, for ⋯ › Hidden tasks. */
  onHiddenCount?: (count: number) => void;
}

export function OverviewKanban({ projects, displayNames, files, tasks, flows, pipelines, loaded, catalogFailures, onSelectProject, onOpenConversations, phone = null }: OverviewKanbanProps) {
  const { t } = useLocale();
  /* The dashboard's board clock, shared by cadence: the working predicate is
     read from row states that age, so it must advance between scans. */
  const now = useNowSeconds(BOARD_CLOCK_MS);
  /* Null until the first answer, which hides nothing: the board draws the
     seats it does today until it is told which conversations they are. */
  const seatRefs = useSeatConversations(true);
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
  /* The phone's pin walks the queue the bar's ⚠ sheet lists on the Overview:
     every project's. Keyed by value, since the queue is rebuilt each render. */
  const closing = useClosingPipelines();
  const onPhone = phone !== null;
  const attentionSignature = useMemo(
    () => (onPhone ? overviewAttention(files, pipelines, now, closing).join("\n") : ""),
    [onPhone, files, pipelines, now, closing],
  );
  const attention = useMemo(() => (attentionSignature ? attentionSignature.split("\n") : []), [attentionSignature]);
  /* The name the Overview shows for a project, never its raw key: the name
     map, else the one this browser last saw, else a readable key. The map
     falls back to the key itself for a project nobody named, and an opaque
     key is not a name. */
  const projectLabel = useCallback((project: string) => {
    const named = displayNames[project]?.trim();
    const live = named && named !== project && !isOpaqueProjectKey(named) ? named : undefined;
    return projectTitle(project, live, cachedProjectName(project));
  }, [displayNames]);
  /* An empty column says what the Overview's narrowing left out of it; the
     whole board empty says nothing works anywhere. */
  const emptyCopy = useCallback((status: TaskStatus, elsewhere: boolean) => ({
    title: elsewhere ? t("mobile2.overview.emptyColumn", { column: t(`kanban.status.${status}`) }) : t("overview.noneWorking"),
    body: t("overview.noneWorkingHint"),
  }), [t]);

  if (phone) {
    /* Not answered yet (#2071): the shape of the phone board. */
    if (!loaded) return <PhoneKanbanSkeleton seat={false} />;
    return (
      <MobileKanban
        project={OVERVIEW}
        overview={scope}
        cardFilter={cardHasLiveWork}
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
        seatRefs={seatRefs}
        attention={attention}
        closing={closing}
        projectLabel={projectLabel}
        emptyCopy={emptyCopy}
        onOpenTask={phone.onOpenTask}
        onOpenPipeline={phone.onOpenPipeline}
        onOpenConversation={phone.onOpenConversation}
        onHiddenCount={phone.onHiddenCount}
      />
    );
  }

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
      /* Every project's seat conversations, so no seat draws a card and no
         seat-only task lands in the header's hidden count (#1841). */
      seatRefs={seatRefs}
      onOpenConversations={onOpenConversations}
    />
  );
}
