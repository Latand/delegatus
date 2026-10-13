import { conversationIdentity, currentConversationFile } from "@/lib/accounts/identity";
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
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** A board-owned cache, bounded to the latest payload. Inputs are immutable
 * rows from the files client's structural sharing. Relationship indexes keep
 * a task's lookup proportional to its own work, including cross-project work. */
export function createTaskWorkflowProjector(): typeof projectTaskWorkflows {
  let previousRefs = new Map<string, WorkReference>();
  let previousTasks = new Map<string, TaskWorkflow>();
  return (tasks, pipelines, flows, files, project) => {
    const nextRefs = new Map<string, WorkReference>();
    const byPath = new Map(files.map(file => [file.path, file]));
    const byConversation = new Map<string, FileEntry>();
    const generations = new Map<string, FileEntry[]>();
    for (const file of files) if (file.conversationId) {
      const list = generations.get(file.conversationId) ?? [];
      list.push(file); generations.set(file.conversationId, list);
    }
    for (const file of files) {
      if (file.conversationId && !byConversation.has(file.conversationId)) {
        const current = currentConversationFile(generations.get(file.conversationId)!, file.conversationId);
        if (current) byConversation.set(file.conversationId, current);
      }
    }
    const resolve = (id: string | null | undefined, path: string | null): FileEntry | null => {
      if (id) return byConversation.get(id) ?? null;
      const recorded = path ? byPath.get(path) : undefined;
      return recorded?.conversationId ? byConversation.get(recorded.conversationId) ?? null : recorded ?? null;
    };
    const ref = (input: Partial<WorkReference> & Pick<WorkReference, "key" | "kind" | "role" | "state">): WorkReference => {
      const next: WorkReference = {
        file: resolve(input.conversationId, input.path ?? null), conversationId: null, launchId: null, path: null,
        reviewedSha: null, verdict: null, findings: NO_FINDINGS, findingsCount: null, error: null, ...input,
      };
      const previous = previousRefs.get(next.key);
      const keys = Object.keys(next) as (keyof WorkReference)[];
      const value = previous && Object.keys(previous).length === keys.length && keys.every(key => previous[key] === next[key]) ? previous : next;
      nextRefs.set(next.key, value);
      return value;
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
    return {
      tasks: projected, unlinkedReferences,
      unlinkedPipelines,
      unlinkedFlows,
      unlinkedWorkers: [...new Map(unlinkedReferences.flatMap(r => r.file ? [[conversationIdentity(r.file), r.file] as const] : [])).values()],
    };
  };
}
