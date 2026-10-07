import { loadFlows } from "@/lib/flows/store";
import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import { filterPipelinesForFileScan } from "@/lib/pipelines/visibility";
import { loadTasksForList } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { loadWorkflows } from "@/lib/workflows/store";
import { filterWorkflowsForFileScan } from "@/lib/workflows/visibility";
import { tmuxEndpointHealth } from "@/lib/tmux";

export interface FilesResponseDependencies {
  loadFlows: typeof loadFlows;
  loadPipelinesForProjection: typeof loadPipelinesForProjection;
  filterPipelinesForFileScan: typeof filterPipelinesForFileScan;
  /** The shared, frozen task list: the route reconciles and overlays it by
      copying the tasks it changes, so it never needs a copy of every row. */
  loadTasks: () => readonly BoardTask[];
  loadWorkflows: typeof loadWorkflows;
  filterWorkflowsForFileScan: typeof filterWorkflowsForFileScan;
  tmuxEndpointHealth: typeof tmuxEndpointHealth;
}

const productionDependencies: FilesResponseDependencies = {
  loadFlows,
  loadPipelinesForProjection,
  filterPipelinesForFileScan,
  loadTasks: loadTasksForList,
  loadWorkflows,
  filterWorkflowsForFileScan,
  tmuxEndpointHealth,
};

let testDependencies: Partial<FilesResponseDependencies> | null = null;

export function filesResponseDependencies(): FilesResponseDependencies {
  return testDependencies === null
    ? productionDependencies
    : { ...productionDependencies, ...testDependencies };
}

export function setFilesResponseDependenciesForTests(
  dependencies: Partial<FilesResponseDependencies> | null,
): void {
  testDependencies = dependencies;
}
