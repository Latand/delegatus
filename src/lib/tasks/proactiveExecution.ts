import { proactiveCandidateDecision, proactiveCandidateAuthority } from "./proactive";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { loadTasksByIds, TASKS_FILE } from "./store";
import type { BoardTask } from "./types";
import type { Pipeline } from "@/lib/pipelines/types";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { proactiveLaneError, proactiveLiveAuthorityError, proactiveAcceptedWorkWaiting } from "./proactiveLane";
import { proactiveAccountReserveError } from "@/lib/accounts/proactiveReserve";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { readWorkerLimits, effectiveWorkerLimit } from "@/lib/operator/workerLimit";
import { projectAliasKeys } from "@/lib/projects/aliases";
import { proactiveProjectWork } from "./store";
import { hostlessConversationEvidence } from "@/lib/runtime/hostlessRegistryEvidence";

export interface ProactiveExecutionContext {
  phase: "create" | "prepare" | "dispatch" | "effect" | "settle";
  pipeline?: Pipeline;
  stageId?: string;
  account?: { id: string | null; engine: "claude" | "codex"; model?: string | null };
}
type ExecutionContext = ProactiveExecutionContext | (() => ProactiveExecutionContext | undefined);

export class ProactiveExecutionFenced extends Error {
  constructor(reason: string) { super(reason); this.name = "ProactiveExecutionFenced"; }
}

/** Shared by membership, dispatch, recovery and subsequent effects. Adoption
 * is a durable operator receipt, never a task field or a launch-body assertion.
 * Inspect every task: adding an unrelated accepted task cannot confer authority.
 * Missing retained provenance requires recovery rather than a fresh placeholder. */
export function proactiveExecutionError(tasks: readonly BoardTask[], file = TASKS_FILE, context?: ExecutionContext): string | null {
  for (const task of tasks) {
    if (!task.proactive) continue;
    try {
      const decision = proactiveCandidateDecision(task, file);
      if (decision.adopted) continue;
      if (decision.rejected) return "invented work was rejected by the operator";
      const live = typeof context === "function" ? context() : context;
      if (!live) return "proactive starts and effects remain disabled pending independent scope review";
      const refusal = live.phase === "create" ? proactiveLiveAuthorityError(task, file)
        : proactiveLaneError(task, live.pipeline, live.stageId, live.phase, file);
      if (refusal) return refusal;
      if (live.phase === "dispatch") {
        const projects = projectAliasKeys(task.project);
        if (projects.length > 128) return "proactive capacity project evidence exceeds its bound";
        const work = proactiveProjectWork(projects, file);
        if (work.some(row => row.id !== task.id && proactiveAcceptedWorkWaiting(row, file))) return "accepted work has precedence over proactive work";
        const limit = effectiveWorkerLimit(task.project);
        if (readWorkerLimits().unreadable) return "proactive worker capacity is unreadable";
        // Card completion does not settle its retained worker or lane custody.
        const identities = new Set(work.filter(row => row.id !== task.id)
          .flatMap(row => row.assignments.filter(a => a.state === "linked").map(a => a.conversationId ?? a.launchId).filter((id): id is string => !!id)));
        if (identities.size > 256) return "proactive worker evidence exceeds its bound";
        const workers = new Set<string>();
        const seat = proactiveCandidateAuthority(task, file)?.conversationId;
        for (const id of identities) {
          if (id === seat) continue;
          const members = agentRegistry().conversationMemberships(id as `conversation_${string}`);
          if (members.some(member => member.kind === "orchestrator")) continue;
          const lanes = members.filter(member => member.kind === "pipeline");
          if (!lanes.length) {
            const retained = agentRegistry().conversationRetentionSnapshot(id);
            const awaitingExit = Object.values(retained.entries).some(entry => entry.pendingHostExits?.length);
            if (awaitingExit || !hostlessConversationEvidence(retained, id)) workers.add(id);
            continue;
          }
          for (const member of lanes) {
            if (member.containerId === live.pipeline?.id) continue;
            const lane = findPipelineRecord(member.containerId);
            if (!lane) return "proactive worker capacity is unreadable";
            if (["running", "provisioning"].includes(lane.state) && !lane.closedAt && !lane.hiddenAt) workers.add(`pipeline:${lane.id}`);
          }
        }
        if (workers.size >= limit.value) return "proactive worker capacity is exhausted";
        if (live.account) {
          const account = live.account;
          const error = proactiveAccountReserveError(account.id, allowedAccountIdsForProject(task.project, account.engine),
            agentRegistry().quotaObservations(account.engine).find(row => row.accountId === account.id), Date.now(), account.model);
          if (error) return error;
        }
      }
    } catch {
      return "invented work authority is unreadable; operator recovery required";
    }
  }
  return null;
}

export function proactiveTaskExecutionError(taskIds: readonly string[], file = TASKS_FILE, context?: ExecutionContext): string | null {
  if (!taskIds.length) return null;
  try {
    const ids = new Set(taskIds);
    const tasks = loadTasksByIds(ids, file);
    if (typeof context !== "function" && context?.pipeline?.proactiveTaskIds?.some(id => !tasks.some(task => task.id === id))) return "task authority is missing; operator recovery required";
    return proactiveExecutionError(tasks, file, context);
  } catch {
    return "task authority is unreadable; operator recovery required";
  }
}

export function assertProactiveTaskExecution(taskIds: readonly string[], file = TASKS_FILE, context?: ExecutionContext): void {
  const error = proactiveTaskExecutionError(taskIds, file, context);
  if (error) throw new ProactiveExecutionFenced(error);
}

/** Native auto-dispatch cannot recheck revocable authority between turns. */
export function proactiveTasksRequireDispatchGuard(taskIds: readonly string[], file = TASKS_FILE): boolean {
  if (!taskIds.length) return false;
  const tasks = loadTasksByIds(new Set(taskIds), file);
  const present = new Set(tasks.map(task => task.id));
  return taskIds.some(id => !present.has(id))
    || tasks.some(task => task.proactive && !proactiveCandidateDecision(task, file).adopted);
}

export function proactivePipelineExecutionError(pipeline: Pipeline, phase: ProactiveExecutionContext["phase"] = "effect",
  account?: ProactiveExecutionContext["account"], stageId = pipeline.cursor?.stageId): string | null {
  return proactiveTaskExecutionError([...new Set([...pipeline.taskIds, ...pipeline.proactiveTaskIds ?? []])], TASKS_FILE,
    { pipeline, stageId, phase, account });
}
export function assertProactivePipelineExecution(pipeline: Pipeline, phase: ProactiveExecutionContext["phase"] = "dispatch",
  account?: ProactiveExecutionContext["account"], stageId = pipeline.cursor?.stageId): void {
  const error = proactivePipelineExecutionError(pipeline, phase, account, stageId);
  if (error) throw new ProactiveExecutionFenced(error);
}

/** The registry's durable membership supplies context; callers cannot provide a
 * pipeline id in a delivery body to borrow someone else's scope review. */
export function proactiveConversationContext(conversationId: string, registry: Pick<AgentRegistry, "conversationMemberships" | "canonicalConversationId" | "spawnReceipt"> = agentRegistry(),
  account?: ProactiveExecutionContext["account"]): ProactiveExecutionContext | undefined {
  const memberships = registry.conversationMemberships(conversationId as `conversation_${string}`).filter(row => row.kind === "pipeline");
  if (memberships.length !== 1) return undefined;
  const member = memberships[0]!;
  const pipeline = findPipelineRecord(member.containerId);
  if (!pipeline || !member.stageId || pipeline.cursor?.stageId !== member.stageId
    || !["running", "provisioning"].includes(pipeline.state)) return undefined;
  const attempt = pipeline.runs.find(run => run.stageId === member.stageId)?.attempts.at(-1);
  if (!attempt?.conversationId || !["spawning", "running", "committing"].includes(attempt.state)
    || registry.canonicalConversationId(attempt.conversationId as `conversation_${string}`)
      !== registry.canonicalConversationId(conversationId as `conversation_${string}`)) return undefined;
  // Before the first prompt creates a native generation, the original launch
  // receipt owns the selected account. Later continuations need their current
  // generation and cannot fall back to a predecessor's account.
  if (account && !account.id && attempt.state === "spawning" && attempt.launchId) {
    const receipt = registry.spawnReceipt(attempt.launchId);
    if (receipt && receipt.engine !== "copilot"
      && registry.canonicalConversationId(receipt.conversationId) === registry.canonicalConversationId(conversationId as `conversation_${string}`)) {
      account = { id: receipt.accountId, engine: receipt.engine, model: receipt.launchProfile.model };
    }
  }
  return { pipeline, stageId: member.stageId, phase: "dispatch", account };
}

/** Original launch receipts retain task authority across failed attempts,
 * successors and edited attachments. The registry's existing keyed retention
 * reader follows aliases without scanning the task store or registry history. */
export function proactiveConversationTaskIds(conversationIds: readonly (string | null | undefined)[],
  registry?: Pick<AgentRegistry, "conversationRetentionSnapshot">, file = TASKS_FILE): string[] {
  const ids = new Set(conversationIds.filter((id): id is string => !!id));
  if (!ids.size) return [];
  registry ??= agentRegistry();
  const tasks = new Set<string>();
  const required = new Set<string>();
  for (const id of ids) {
    const retained = registry.conversationRetentionSnapshot(id);
    for (const receipt of Object.values(retained.receipts)) {
      for (const taskId of receipt.proactiveTaskIds ?? []) { required.add(taskId); tasks.add(taskId); }
      for (const taskId of receipt.failureReporting?.taskIds ?? []) tasks.add(taskId);
    }
  }
  const rows = loadTasksByIds(tasks, file);
  if ([...required].some(id => !rows.some(row => row.id === id && row.proactive))) throw new Error("retained proactive task authority is missing; operator recovery required");
  return rows.filter(task => task.proactive).map(task => task.id);
}
