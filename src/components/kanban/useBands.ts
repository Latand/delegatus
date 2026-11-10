"use client";

import { useMemo, useRef } from "react";
import { usePipelineCreationCards } from "@/hooks/useFiles";
import type { TaskBand } from "@/components/scheme/taskBands";

import { useLocale } from "@/lib/i18n";
import type { ReviewGroup as Flow } from "@/components/flows/reviewGroup";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { compactPipelineLayoutFlows } from "@/components/pipelines/pipelineModel";
import type { BranchGroup } from "@/components/projectModel";
import { buildSchemeLayout, type SchemeLayout } from "@/components/scheme/layout";
import { reconcileLayoutNodes } from "@/components/scheme/layoutIdentity";
import { createProjectBands } from "@/components/projectDashboardDerivation";
import { isPlacedTask } from "@/components/scheme/taskGeometry";
import { createTaskWorkflowProjector } from "@/components/tasks/taskWorkflowModel";
import { createOverviewBands } from "./overviewBands";

/**
 * The task bands a kanban draws, and the task projection they were built from
 * (#1695 K1). The desktop board and the phone's columns (#2072 slice 4) both
 * read this one hook, so a conversation sits on the same card on either
 * surface: the scheme layout (`buildSchemeLayout`, or the one the dashboard
 * already built) is grouped into bands by `buildTaskBands`, which decides
 * identity, mirrors, containers and lineage grouping.
 */

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_FLOWS: Flow[] = [];
const EMPTY_PIPELINES: Pipeline[] = [];
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

export interface BandsInput {
  project: string;
  /** Present on the cross-project Overview (#1820): its projection fences no
      single project. */
  overview?: object | null;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  reviewGroups?: Flow[];
  pipelines: Pipeline[];
  surfacePipelines?: Pipeline[];
  /** Placed tasks, for the layout pass exactly as the scheme receives them. */
  tasks: readonly BoardTask[];
  /** Every stored task of the project, with any edit the board draws ahead of the poll. */
  allTasks: readonly BoardTask[];
  drafts: string[];
  favorites?: ReadonlySet<string>;
  isolatedManualPaths?: ReadonlySet<string>;
  draftBands?: ReadonlyMap<string, string>;
  /** Board clock, epoch seconds. */
  now: number;
  /** Shared geometry from the dashboard; standalone consumers derive it here. */
  layout?: SchemeLayout;
}

export function useBands(input: BandsInput) {
  const { t } = useLocale();
  const creations = usePipelineCreationCards();
  const { groups, manual, files, flows, reviewGroups = EMPTY_FLOWS, pipelines, surfacePipelines = EMPTY_PIPELINES, tasks, allTasks, drafts, favorites = EMPTY_SET, isolatedManualPaths = EMPTY_SET, draftBands = EMPTY_MAP, now, project } = input;
  const deckFlows = useMemo(() => (reviewGroups.length ? [...flows, ...reviewGroups] : flows), [flows, reviewGroups]);
  const layoutFlows = useMemo(() => compactPipelineLayoutFlows(pipelines, deckFlows), [pipelines, deckFlows]);
  const placedTasks = useMemo(() => tasks.filter(isPlacedTask), [tasks]);
  const deriveOverview = useMemo(() => createOverviewBands(), []);
  const overview = useMemo(() => input.overview && !input.layout && !manual.length && !drafts.length
    && !favorites.size && !isolatedManualPaths.size && !draftBands.size
    ? deriveOverview({ groups, files, flows, layoutFlows, pipelines, surface: surfacePipelines, tasks: allTasks, placed: placedTasks, now,
      untitled: t("bands.untitled"), reviewFlow: t("bands.reviewFlow") }) : null,
  [input.overview, input.layout, manual, drafts, favorites, isolatedManualPaths, draftBands, deriveOverview, groups, files, flows, layoutFlows, pipelines, surfacePipelines, allTasks, placedTasks, now, t]);
  const standaloneLayout = useMemo(() => input.layout || overview ? null
    : buildSchemeLayout(groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, EMPTY_SET, { now }),
  [overview, input.layout, groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, now]);
  const sourceLayout = input.layout ?? standaloneLayout;
  const previousLayout = useRef<SchemeLayout | null>(null);
  const layout = useMemo(() => {
    if (!sourceLayout) return null;
    const built = reconcileLayoutNodes(
      // eslint-disable-next-line react-hooks/refs -- Layout identity cache; never an input to task visibility.
      previousLayout.current,
      sourceLayout,
    );
    // eslint-disable-next-line react-hooks/refs -- Retain geometry identity between projections without a state update.
    previousLayout.current = built;
    return built;
  }, [sourceLayout]);
  /* The projection's `project` only fences its UNLINKED buckets to one
     project; omitting it is already the cross-project answer, so the Overview
     passes nothing rather than calling this once per project. */
  const projectionProject = input.overview ? undefined : project;
  const projectTaskWorkflows = useMemo(() => createTaskWorkflowProjector(), []);
  const projection = useMemo(
    () => overview?.projection ?? projectTaskWorkflows(allTasks, pipelines, flows, files, projectionProject),
    [overview, projectTaskWorkflows, allTasks, pipelines, flows, files, projectionProject],
  );
  const projectBands = useMemo(() => createProjectBands(), []);
  const bands = useMemo(
    () => overview?.bands ?? projectBands(layout!, { tasks: allTasks, projection, draftBands, untitled: t("bands.untitled"), reviewFlow: t("bands.reviewFlow"), deferDoneVisibility: true }),
    [overview, projectBands, layout, allTasks, projection, draftBands, t],
  );
  const withCreations = useMemo(() => {
    const result = [...bands];
    for (const card of creations) {
      const receipt = card.receipt;
      if (!receipt || (!input.overview && receipt.project !== project) || (card.status !== "linkPending" && pipelines.some(pipeline => pipeline.id === card.id))) continue;
      const taskBand = result.findIndex(band => band.pipeline?.id === card.id || (band.task && receipt.taskIds.includes(band.task.id)));
      if (taskBand >= 0) {
        const band = result[taskBand]!;
        result[taskBand] = { ...band, creations: [...band.creations ?? [], card] };
      } else {
        const band: TaskBand = { id: `pipeline:${card.id}`, origin: "pipeline", task: null, pipeline: null, flow: null,
          title: receipt.title, status: null, hue: 0, members: [], mirrors: [], groups: [], working: 0, unknown: 0,
          conversations: 0, planned: 0, pinnedTop: false, createdAt: receipt.queuedAt, creations: [card] };
        result.push(band);
      }
    }
    return result;
  }, [bands, creations, project, pipelines, input.overview]);
  return { bands: withCreations, projection };
}
