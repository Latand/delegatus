import type { FileEntry } from "@/lib/types";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import type { BranchGroup } from "@/components/projectModel";
import { buildSchemeLayout } from "@/components/scheme/layout";
import { transcriptIdentity } from "@/components/scheme/placementHorizon";
import { buildTaskBands, type TaskBand } from "@/components/scheme/taskBands";
import { projectTaskWorkflows, type TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";

interface Part {
  files: FileEntry[];
  groups: BranchGroup[];
  flows: Flow[];
  layoutFlows: Flow[];
  pipelines: Pipeline[];
  surface: Pipeline[];
  tasks: BoardTask[];
  placed: BoardTask[];
}
interface Input extends Omit<Part, "tasks" | "placed"> {
  tasks: readonly BoardTask[];
  placed: readonly BoardTask[];
  now: number;
  untitled: string;
  reviewFlow: string;
}
interface Result { bands: TaskBand[]; projection: TaskWorkflowProjection }
const sameRows = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((row, i) => row === b[i]);
const emptyPart = (): Part => ({ files: [], groups: [], flows: [], layoutFlows: [], pipelines: [], surface: [], tasks: [], placed: [] });

/** The Overview has no manual placement or drafts. Its independent projects
 * can derive bands separately: canvas coordinates never reach a kanban card.
 * Projects sharing lineage, identities, assignments or execution records are
 * joined first, so mirrors, reviewer history and cross-project work retain the
 * same ownership rules as the complete layout. A cache holds only this answer. */
export function createOverviewBands(): (input: Input) => Result {
  let previous = new Map<string, { input: Part; result: Result }>();
  let previousClock = Number.NaN, previousLabels = "";
  return input => {
    const parents = new Map<string, string>();
    const root = (project: string): string => {
      const parent = parents.get(project);
      if (!parent) { parents.set(project, project); return project; }
      if (parent === project) return project;
      const resolved = root(parent); parents.set(project, resolved); return resolved;
    };
    const join = (a: string, b: string | undefined) => {
      if (b === undefined) return;
      const left = root(a), right = root(b);
      if (left !== right) parents.set(right, left);
    };
    const fileProject = (file: FileEntry) => file.project || "other";
    const byPath = new Map<string, string>(), byConversation = new Map<string, string>(), byLaunch = new Map<string, string>();
    const addIdentity = (index: Map<string, string>, key: string, project: string) => {
      join(project, index.get(key)); index.set(key, project);
    };
    for (const file of input.files) {
      const project = fileProject(file); root(project);
      addIdentity(byPath, file.path, project);
      addIdentity(byPath, transcriptIdentity(file.path), project);
      if (file.conversationId) addIdentity(byConversation, file.conversationId, project);
    }
    const linkFile = (project: string, id?: string | null, path?: string | null) => {
      // Record unresolved identities too: a task and a lane can share an
      // admission before the first transcript arrives.
      if (id) addIdentity(byConversation, id, project);
      if (path) { addIdentity(byPath, path, project); addIdentity(byPath, transcriptIdentity(path), project); }
    };
    for (const file of input.files) {
      linkFile(fileProject(file), file.durableLineage?.parentConversationId ?? file.parentRemoved?.conversationId, file.parent);
    }
    const taskProject = new Map(input.tasks.map(task => [task.id, task.project]));
    for (const task of input.tasks) {
      root(task.project);
      for (const assignment of task.assignments) {
        linkFile(task.project, assignment.conversationId, assignment.path);
        if (assignment.launchId) addIdentity(byLaunch, assignment.launchId, task.project);
      }
    }
    for (const task of input.placed) {
      root(task.project);
      if (task.source) linkFile(task.project, null, task.source.path);
    }
    const allFlows = [...input.flows, ...input.layoutFlows];
    const flowProject = new Map(allFlows.map(flow => [flow.id, flow.project || "other"]));
    for (const flow of allFlows) {
      const project = flow.project || "other"; root(project);
      linkFile(project, flow.implementerConversationId, flow.implementerPath);
      for (const round of flow.rounds) for (const target of reviewerBindingTargetsForRound(flow, round, input.files)) {
        linkFile(project, target.conversationId, target.path);
      }
    }
    for (const pipeline of [...input.pipelines, ...input.surface]) {
      const project = pipeline.project || "other"; root(project);
      linkFile(project, pipeline.srcConversationId, pipeline.srcPath);
      for (const id of [...(pipeline.taskIds ?? []), ...(pipeline.creationIntent?.taskId ? [pipeline.creationIntent.taskId] : [])]) join(project, taskProject.get(id));
      for (const run of pipeline.runs) for (const attempt of run.attempts) {
        linkFile(project, attempt.conversationId, attempt.agentPath);
        if (attempt.launchId) addIdentity(byLaunch, attempt.launchId, project);
        if (attempt.flowId) join(project, flowProject.get(attempt.flowId));
      }
    }
    for (const group of input.groups) {
      const project = fileProject(group.columns[0].file);
      for (const column of group.columns) {
        join(project, fileProject(column.file));
        for (const task of column.tasks) join(project, fileProject(task));
      }
      for (const file of [...group.finished, ...group.returnable]) join(project, fileProject(file));
    }
    // Name a connected component by membership, independently of union order.
    const members = new Map<string, string[]>();
    for (const project of parents.keys()) {
      const key = root(project), list = members.get(key) ?? [];
      list.push(project); members.set(key, list);
    }
    const keys = new Map([...members].map(([key, projects]) => [key, JSON.stringify(projects.sort())]));
    const parts = new Map<string, Part>();
    const part = (project: string) => {
      const key = keys.get(root(project))!;
      let value = parts.get(key);
      if (!value) { value = emptyPart(); parts.set(key, value); }
      return value;
    };
    for (const file of input.files) part(fileProject(file)).files.push(file);
    for (const group of input.groups) part(fileProject(group.columns[0].file)).groups.push(group);
    for (const flow of input.flows) part(flow.project || "other").flows.push(flow);
    for (const flow of input.layoutFlows) part(flow.project || "other").layoutFlows.push(flow);
    for (const pipeline of input.pipelines) part(pipeline.project || "other").pipelines.push(pipeline);
    for (const pipeline of input.surface) part(pipeline.project || "other").surface.push(pipeline);
    for (const task of input.tasks) part(task.project).tasks.push(task);
    for (const task of input.placed) part(task.project).placed.push(task);
    const labels = JSON.stringify([input.untitled, input.reviewFlow]);
    const next = new Map<string, { input: Part; result: Result }>();
    for (const [key, current] of parts) {
      const prior = previous.get(key);
      if (prior && previousClock === input.now && previousLabels === labels
        && (Object.keys(current) as (keyof Part)[]).every(field => sameRows(prior.input[field], current[field]))) {
        next.set(key, prior); continue;
      }
      const layout = buildSchemeLayout(current.groups, [], current.files, current.layoutFlows, [], current.pipelines, current.surface, undefined, undefined, current.placed, undefined, { now: input.now });
      const projection = projectTaskWorkflows(current.tasks, current.pipelines, current.flows, current.files);
      const bands = buildTaskBands(layout, { tasks: current.tasks, projection, untitled: input.untitled, reviewFlow: input.reviewFlow, deferDoneVisibility: true });
      next.set(key, { input: current, result: { bands, projection } });
    }
    previous = next; previousClock = input.now; previousLabels = labels;
    const results = [...next.values()].map(part => part.result);
    return {
      bands: results.flatMap(result => result.bands),
      projection: {
        tasks: results.flatMap(result => result.projection.tasks),
        unlinkedPipelines: results.flatMap(result => result.projection.unlinkedPipelines),
        unlinkedFlows: results.flatMap(result => result.projection.unlinkedFlows),
        unlinkedWorkers: results.flatMap(result => result.projection.unlinkedWorkers),
        unlinkedReferences: results.flatMap(result => result.projection.unlinkedReferences),
      },
    };
  };
}
