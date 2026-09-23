"use client";

import { useMemo, useRef } from "react";

import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { compactPipelineLayoutFlows } from "@/components/pipelines/pipelineModel";
import type { BranchGroup } from "@/components/projectModel";
import { buildSchemeLayout, type SchemeLayout } from "@/components/scheme/layout";
import { reconcileLayoutNodes } from "@/components/scheme/layoutIdentity";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { isPlacedTask } from "@/components/scheme/taskGeometry";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";

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
  const { groups, manual, files, flows, reviewGroups = EMPTY_FLOWS, pipelines, surfacePipelines = EMPTY_PIPELINES, tasks, allTasks, drafts, favorites = EMPTY_SET, isolatedManualPaths = EMPTY_SET, draftBands = EMPTY_MAP, now, project } = input;
  const deckFlows = useMemo(() => (reviewGroups.length ? [...flows, ...reviewGroups] : flows), [flows, reviewGroups]);
  const layoutFlows = useMemo(() => compactPipelineLayoutFlows(pipelines, deckFlows), [pipelines, deckFlows]);
  const placedTasks = useMemo(() => tasks.filter(isPlacedTask), [tasks]);
  const previousLayout = useRef<SchemeLayout | null>(null);
  const layout = useMemo(() => {
    const built = reconcileLayoutNodes(
      previousLayout.current,
      input.layout ?? buildSchemeLayout(groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, EMPTY_SET, { now }),
    );
    previousLayout.current = built;
    return built;
  }, [input.layout, groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, now]);
  /* The projection's `project` only fences its UNLINKED buckets to one
     project; omitting it is already the cross-project answer, so the Overview
     passes nothing rather than calling this once per project. */
  const projectionProject = input.overview ? undefined : project;
  const projection = useMemo(
    () => projectTaskWorkflows([...allTasks], pipelines, flows, files, projectionProject),
    [allTasks, pipelines, flows, files, projectionProject],
  );
  const bands = useMemo(
    () => buildTaskBands(layout, { tasks: allTasks, projection, draftBands, untitled: t("bands.untitled"), reviewFlow: t("bands.reviewFlow") }),
    [layout, allTasks, projection, draftBands, t],
  );
  return { bands, projection };
}
