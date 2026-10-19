import { conversationIdentity, conversationFileIndex } from "@/lib/accounts/identity";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

export type RelationBasis = "explicit" | "assignment";
export interface WorkReference {
  key: string;
  kind: "assignment" | "attempt" | "planned" | "review";
  role: string;
  state: string;
  file: FileEntry | null;
  conversationId: string | null;
  launchId: string | null;
  path: string | null;
  pipelineId?: string;
  stageId?: string;
  attempt?: number;
  flowId?: string;
  round?: number;
  reviewedSha: string | null;
  verdict: string | null;
  findings: readonly string[];
  findingsCount: number | null;
  error: string | null;
}
export interface TaskExecution {
  pipeline: Pipeline;
  basis: RelationBasis;
  references: WorkReference[];
}
export interface TaskWorkflow {
  task: BoardTask;
  executions: TaskExecution[];
  flows: Flow[];
  references: WorkReference[];
  workers: FileEntry[];
  unresolved: number;
  reviews: number;
}
export interface TaskWorkflowProjection {
  tasks: TaskWorkflow[];
  unlinkedPipelines: Pipeline[];
  unlinkedFlows: Flow[];
  unlinkedWorkers: FileEntry[];
  unlinkedReferences: WorkReference[];
}

/** Only recorded task membership and direct worker assignments establish an
 * execution relation. A manager who created two pipelines does not merge their
 * task histories. All attempts remain evidence, including unresolved launches. */
export function projectTaskWorkflows(
  tasks: readonly BoardTask[], pipelines: readonly Pipeline[], flows: readonly Flow[], files: readonly FileEntry[], project?: string,
): TaskWorkflowProjection {
  return createTaskWorkflowProjector()(tasks, pipelines, flows, files, project);
}

const NO_FINDINGS: readonly string[] = [];
const membershipKeys = new WeakMap<TaskWorkflowProjection, object>();

/** Equality of relationship membership, including resolved generation targets.
 * A size/mtime refresh updates the public references and workers while keeping
 * this key. Consumers that only use reference paths can retain their work;
 * consumers of file payloads must still read the fresh projection. */
export function taskWorkflowMembershipKey(projection: TaskWorkflowProjection): object {
  return membershipKeys.get(projection) ?? projection;
}

export function sameFileExceptSizeAndMtime(before: FileEntry, file: FileEntry): boolean {
  return before === file || (Object.keys(before).length === Object.keys(file).length && (Object.keys(file) as (keyof FileEntry)[])
    .every(key => Object.hasOwn(before, key) && (key === "mtime" || key === "size" || before[key] === file[key])));
}
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** A board-owned cache, bounded to the latest payload. Inputs are immutable
 * rows from the files client's structural sharing. Relationship indexes keep
 * a task's lookup proportional to its own work, including cross-project work. */
export function createTaskWorkflowProjector(): typeof projectTaskWorkflows {
  type ReferenceInput = Partial<WorkReference> & Pick<WorkReference, "key" | "kind" | "role" | "state">;
  type CachedReference = { input: ReferenceInput; value: WorkReference };
  let previousRefs = new Map<string, CachedReference>();
  let previousTasks = new Map<string, TaskWorkflow>();
  type FileOwners = { references: string[]; tasks: Set<number>; unlinkedReferences: number[]; unlinkedWorkers: number[] };
  let fileOwners = new Map<FileEntry, FileOwners>();
  let previous: { tasks: readonly BoardTask[]; pipelines: readonly Pipeline[]; flows: readonly Flow[]; files: readonly FileEntry[]; project?: string; uniquePaths: boolean; value: TaskWorkflowProjection } | undefined;
  return function projectWorkflows(tasks, pipelines, flows, files, project) {
    // Generation selection and membership ignore size/mtime. An otherwise
    // identical ordered catalog keeps each resolved target; replace its payload
    // wherever that exact file occurred in the preceding projection.
    if (previous?.uniquePaths && previous.tasks === tasks && previous.pipelines === pipelines && previous.flows === flows && previous.project === project
      && previous.files.length === files.length && files.every((file, i) => sameFileExceptSizeAndMtime(previous!.files[i], file))) {
      const changed = new Map<FileEntry, FileEntry>();
      for (let i = 0; i < files.length; i++) if (files[i] !== previous.files[i]) changed.set(previous.files[i], files[i]);
      if (!changed.size) return previous.value;
      const taskIndexes = new Set<number>(), referenceIndexes = new Set<number>(), workerIndexes = new Set<number>();
      for (const [oldFile, file] of changed) {
        const owners = fileOwners.get(oldFile);
        if (!owners) continue;
        for (const key of owners.references) {
          const cached = previousRefs.get(key)!;
          previousRefs.set(key, { input: cached.input, value: { ...cached.value, file } });
        }
        for (const index of owners.tasks) taskIndexes.add(index);
        for (const index of owners.unlinkedReferences) referenceIndexes.add(index);
        for (const index of owners.unlinkedWorkers) workerIndexes.add(index);
        fileOwners.delete(oldFile);
        fileOwners.set(file, owners);
      }
      const rows = <T,>(items: T[], update: (item: T) => T): T[] => {
        let next: T[] | undefined;
        for (let i = 0; i < items.length; i++) {
          const value = update(items[i]);
          if (value !== items[i]) { next ??= items.slice(); next[i] = value; }
        }
        return next ?? items;
      };
      const indexedRows = <T,>(items: T[], indexes: Set<number>, update: (item: T) => T): T[] => {
        if (!indexes.size) return items;
        const next = items.slice();
        for (const index of indexes) next[index] = update(items[index]);
        return next;
      };
      const reference = (value: WorkReference) => previousRefs.get(value.key)!.value;
      const currentFile = (value: FileEntry) => changed.get(value) ?? value;
      const value: TaskWorkflowProjection = {
        ...previous.value,
        tasks: indexedRows(previous.value.tasks, taskIndexes, row => {
          const references = rows(row.references, reference);
          const workers = rows(row.workers, currentFile);
          const executions = rows(row.executions, execution => {
            const references = rows(execution.references, reference);
            return references === execution.references ? execution : { ...execution, references };
          });
          return references === row.references && workers === row.workers && executions === row.executions ? row : { ...row, references, workers, executions };
        }),
        unlinkedReferences: indexedRows(previous.value.unlinkedReferences, referenceIndexes, reference),
        unlinkedWorkers: indexedRows(previous.value.unlinkedWorkers, workerIndexes, currentFile),
      };
      membershipKeys.set(value, taskWorkflowMembershipKey(previous.value));
      for (const index of taskIndexes) previousTasks.set(value.tasks[index].task.id, value.tasks[index]);
      previous = { tasks, pipelines, flows, files, project, uniquePaths: true, value };
      return value;
    }
    const nextRefs = new Map<string, CachedReference>();
    const byPath = new Map(files.map(file => [file.path, file]));
    const byConversation = conversationFileIndex(files).currentByConversation;
    const resolve = (id: string | null | undefined, path: string | null): FileEntry | null => {
      if (id) return byConversation.get(id) ?? null;
      const recorded = path ? byPath.get(path) : undefined;
      return recorded?.conversationId ? byConversation.get(recorded.conversationId) ?? null : recorded ?? null;
    };
    const ref = (input: ReferenceInput): WorkReference => {
      const file = resolve(input.conversationId, input.path ?? null);
      const previous = previousRefs.get(input.key);
      const keys = Object.keys(input) as (keyof ReferenceInput)[];
      if (previous && previous.value.file === file && Object.keys(previous.input).length === keys.length
        && keys.every(key => Object.hasOwn(previous.input, key) && previous.input[key] === input[key])) {
        nextRefs.set(input.key, previous);
        return previous.value;
      }
      const next: WorkReference = {
        file, conversationId: null, launchId: null, path: null,
        reviewedSha: null, verdict: null, findings: NO_FINDINGS, findingsCount: null, error: null, ...input,
      };
      nextRefs.set(next.key, { input, value: next });
      return next;
    };
    const attemptRef = (pipeline: Pipeline, stageId: string, a: PipelineStageAttempt) => ref({
      key: `pipeline:${pipeline.id}:${stageId}:${a.n}`, kind: "attempt", pipelineId: pipeline.id, stageId,
      attempt: a.n, role: a.effectiveRole.roleId ?? "worker", state: a.state,
      conversationId: a.conversationId, launchId: a.launchId, path: a.agentPath,
      reviewedSha: a.reviewHeadSha ?? null, verdict: a.verdict?.status ?? null,
      findings: a.verdict?.findings ?? NO_FINDINGS, findingsCount: a.verdict?.findings?.length ?? null,
      error: a.error ?? (a.verdictRecovery?.state === "exhausted" ? a.verdictRecovery.reason : null),
      flowId: a.flowId ?? undefined,
    });
    const pipelineRefs = new Map(pipelines.map(p => [p.id, [...p.stages.flatMap(stage => {
      const attempts = p.runs.find(run => run.stageId === stage.id)?.attempts ?? [];
      return attempts.length ? attempts.map(a => attemptRef(p, stage.id, a)) : [ref({
        key: `pipeline:${p.id}:${stage.id}:planned`, kind: "planned", pipelineId: p.id, stageId: stage.id,
        role: stage.effectiveRole.roleId ?? stage.kind, state: "planned",
      })];
    }), ...p.runs.filter(run => !p.stages.some(stage => stage.id === run.stageId)).flatMap(run => run.attempts.map(a => attemptRef(p, run.stageId, a)))]]));
    const matchKeys = (r: WorkReference): string[] => [
      ...(r.launchId ? [`launch:${r.launchId}`] : []),
      ...(r.conversationId ? [`conversation:${r.conversationId}`] : []),
      ...(r.file ? [`file:${conversationIdentity(r.file)}`] : []),
      ...(!r.conversationId && r.path ? [`path:${r.path}`] : []),
    ];
    const index = (map: Map<string, Set<number>>, key: string, position: number) => {
      const entries = map.get(key) ?? new Set<number>();
      entries.add(position); map.set(key, entries);
    };
    const pipelineMatches = new Map<string, Set<number>>();
    const explicitTasks = new Map<string, Set<number>>();
    pipelines.forEach((p, position) => {
      for (const id of [...(p.taskIds ?? []), ...(p.creationIntent?.taskId ? [p.creationIntent.taskId] : [])]) index(explicitTasks, id, position);
      for (const reference of pipelineRefs.get(p.id)!) for (const key of matchKeys(reference)) index(pipelineMatches, key, position);
    });
    const flowMatches = new Map<string, Set<number>>();
    const flowIdsIndex = new Map<string, Set<number>>();
    flows.forEach((flow, position) => {
      index(flowIdsIndex, flow.id, position);
      const reference = ref({ key: `implementer:${flow.id}`, kind: "assignment", role: "builder", state: flow.state,
        conversationId: flow.implementerConversationId ?? null, path: flow.implementerPath });
      for (const key of matchKeys(reference)) index(flowMatches, key, position);
    });
    const usedPipelines = new Set<string>(), usedFlows = new Set<string>(), usedWorkers = new Set<string>();
    const projected = tasks.map(task => {
      const assignments = task.assignments.map((a, i) => ref({
        key: `task:${task.id}:assignment:${i}`, kind: "assignment", role: "worker", state: a.state,
        conversationId: a.conversationId ?? null, launchId: a.launchId ?? null, path: a.path, error: a.error,
      }));
      const candidates = new Set(explicitTasks.get(task.id));
      for (const assignment of assignments) for (const key of matchKeys(assignment)) {
        for (const position of pipelineMatches.get(key) ?? []) candidates.add(position);
      }
      const executions: TaskExecution[] = [...candidates].sort((a, b) => a - b).map(position => {
        const pipeline = pipelines[position];
        const references = pipelineRefs.get(pipeline.id)!;
        const explicit = pipeline.taskIds?.includes(task.id) || pipeline.creationIntent?.taskId === task.id;
        usedPipelines.add(pipeline.id);
        return { pipeline, basis: explicit ? "explicit" : "assignment", references };
      });
      const references = [...assignments, ...executions.flatMap(e => e.references)];
      const flowIds = new Set(references.flatMap(r => r.flowId ? [r.flowId] : []));
      const flowCandidates = new Set<number>();
      for (const id of flowIds) for (const position of flowIdsIndex.get(id) ?? []) flowCandidates.add(position);
      for (const reference of references) for (const key of matchKeys(reference)) {
        for (const position of flowMatches.get(key) ?? []) flowCandidates.add(position);
      }
      const linkedFlows = [...flowCandidates].sort((a, b) => a - b).map(position => flows[position]);
      for (const flow of linkedFlows) {
        usedFlows.add(flow.id);
        for (const round of flow.rounds) references.push(ref({
          key: `flow:${flow.id}:${round.n}:${round.reviewerBindingId ?? "original"}`, kind: "review",
          role: "reviewer", state: round.verdict ?? (round.terminalAt ? "unresolved" : "reviewing"),
          conversationId: round.reviewerConversationId ?? null, path: round.reviewerPath,
          flowId: flow.id, round: round.n, reviewedSha: round.reviewHeadSha ?? null,
          verdict: round.verdict, findingsCount: round.findingsCount,
        }));
      }
      const previous = previousTasks.get(task.id);
      if (previous?.task === task && sameItems(previous.references, references) && sameItems(previous.flows, linkedFlows)
        && previous.executions.length === executions.length && previous.executions.every((e, i) => e.pipeline === executions[i].pipeline && e.basis === executions[i].basis)) {
        for (const worker of previous.workers) usedWorkers.add(conversationIdentity(worker));
        return previous;
      }
      const workers = [...new Map(references.flatMap(r => r.file ? [[conversationIdentity(r.file), r.file] as const] : [])).values()];
      for (const worker of workers) usedWorkers.add(conversationIdentity(worker));
      return { task, executions, flows: linkedFlows, references, workers,
        unresolved: references.filter(r => !r.file && r.kind !== "planned").length,
        reviews: references.filter(r => r.kind === "review" || (r.kind === "attempt" && r.role === "reviewer" && !r.flowId)).length };
    });
    const inProject = (file: FileEntry) => !project || (file.project || "other") === project;
    const unlinkedPipelines = pipelines.filter(p => !usedPipelines.has(p.id) && (!project || p.project === project
      || pipelineRefs.get(p.id)!.some(r => r.file && inProject(r.file))));
    const unlinkedFlows = flows.filter(f => !usedFlows.has(f.id) && (!project || f.project === project
      || Boolean(resolve(f.implementerConversationId, f.implementerPath) && inProject(resolve(f.implementerConversationId, f.implementerPath)!))));
    const unlinkedReferences = unlinkedPipelines.flatMap(p => pipelineRefs.get(p.id)!);
    for (const flow of unlinkedFlows) for (const round of flow.rounds) unlinkedReferences.push(ref({
      key: `flow:${flow.id}:${round.n}:${round.reviewerBindingId ?? "original"}`, kind: "review", role: "reviewer",
      state: round.verdict ?? (round.terminalAt ? "unresolved" : "reviewing"), flowId: flow.id, round: round.n,
      conversationId: round.reviewerConversationId ?? null, path: round.reviewerPath, reviewedSha: round.reviewHeadSha ?? null,
      verdict: round.verdict, findingsCount: round.findingsCount, error: round.error,
    }));
    const represented = new Set(unlinkedReferences.flatMap(r => r.file ? [conversationIdentity(r.file)] : []));
    for (const file of files) if (inProject(file) && !usedWorkers.has(conversationIdentity(file)) && !represented.has(conversationIdentity(file))) {
      represented.add(conversationIdentity(file));
      unlinkedReferences.push(ref({ key: `unlinked:${conversationIdentity(file)}`, kind: "assignment", role: "worker",
        state: file.activity, conversationId: file.conversationId ?? null, path: file.path }));
    }
    previousRefs = nextRefs;
    previousTasks = new Map(projected.map(row => [row.task.id, row]));
    const value = {
      tasks: projected, unlinkedReferences,
      unlinkedPipelines,
      unlinkedFlows,
      unlinkedWorkers: [...new Map(unlinkedReferences.flatMap(r => r.file ? [[conversationIdentity(r.file), r.file] as const] : [])).values()],
    };
    // The reverse index retires with each full projection. Metadata polls only
    // visit owners of changed files, including references shared by many tasks.
    fileOwners = new Map();
    const owners = (file: FileEntry): FileOwners => {
      let found = fileOwners.get(file);
      if (!found) {
        found = { references: [], tasks: new Set(), unlinkedReferences: [], unlinkedWorkers: [] };
        fileOwners.set(file, found);
      }
      return found;
    };
    for (const [key, cached] of nextRefs) if (cached.value.file) owners(cached.value.file).references.push(key);
    value.tasks.forEach((row, index) => {
      for (const file of row.workers) owners(file).tasks.add(index);
      for (const reference of row.references) if (reference.file) owners(reference.file).tasks.add(index);
      for (const execution of row.executions) for (const reference of execution.references) if (reference.file) owners(reference.file).tasks.add(index);
    });
    value.unlinkedReferences.forEach((reference, index) => { if (reference.file) owners(reference.file).unlinkedReferences.push(index); });
    value.unlinkedWorkers.forEach((file, index) => owners(file).unlinkedWorkers.push(index));
    membershipKeys.set(value, {});
    previous = { tasks, pipelines, flows, files, project, uniquePaths: byPath.size === files.length, value };
    return value;
  };
}
