import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

import type { RuntimeEvent, RuntimeEventInput } from "./contracts";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Workflow } from "@/lib/workflows/types";

export interface RuntimeConsumerPorts {
  flowReady(flowId: string, note: string | null): Promise<Flow | void> | Flow | void;
  workflowStageCompleted(workflowId: string, stage: number): Promise<Workflow | void> | Workflow | void;
  taskDeliveryAcknowledged(taskId: string, assignmentId: string): Promise<BoardTask | void> | BoardTask | void;
  /** A turn of a conversation outside any flow settled
      (docs/design/spawn-completion-notice.md §2). The port decides whether a
      launcher is owed a notice and records only that obligation: the host
      waits on this consumer before it answers the append. */
  spawnTurnEnded?(turn: SpawnTurnEnded): Promise<void> | void;
}

export interface SpawnTurnEnded {
  conversationId: string;
  turnId: string;
  outcome: "completed" | "interrupted" | "error";
  /** When the turn began, when the session's receipts can say. */
  startedAt: string | null;
  endedAt: string;
}

/** A consumer whose write the state store refused for now — hot-state writes
    fenced during a release handoff, a busy database — and that will land once
    the refusal lifts. Every port's refusal becomes one: a flow, workflow or
    task projection and a completion notice alike. The host keeps the event
    owed and retries it, and does not count it toward quarantine: a notice is
    owed exactly once, so a fence that outlasts three attempts must not drop
    it, and a counted refusal at the head of the queue would end boot
    recovery and the retry timer with it (#2867,
    docs/design/spawn-completion-notice.md §2). Any other failure keeps the
    three-failure quarantine. */
export class RuntimeConsumerDeferredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeConsumerDeferredError";
  }
}

function busy(error: unknown): boolean {
  return error instanceof FileTransactionBusyError
    || (error instanceof Error && error.name === "FileTransactionBusyError");
}

/** Runs one port's write, turning the store's refusal into a deferral. */
async function admitted<T>(label: string, write: () => Promise<T> | T): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (busy(error)) throw new RuntimeConsumerDeferredError(`${label} deferred: ${(error as Error).message}`, { cause: error });
    throw error;
  }
}

const TURN_OUTCOMES = new Set<SpawnTurnEnded["outcome"]>(["completed", "interrupted", "error"]);

function text(...values: unknown[]): string | null {
  const value = values.find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : null;
}

/**
 * Event-only adaptation seam for legacy stores. It never scans files and has
 * no browser dependency, allowing a hosted turn to drive flow progression.
 */
function projection(kind: "flow" | "workflow" | "task", id: string, value: unknown, event: RuntimeEvent): RuntimeEventInput[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return [{
    scope: { type: kind, id },
    kind: `${kind}.state`,
    payload: value as Record<string, unknown>,
    producer: { kind: "runtime-consumer", eventKey: `consumer:${event.eventId}:${kind}:${id}` },
    causationId: event.eventId,
    correlationId: kind === "flow" ? id : event.correlationId,
  }];
}

export async function consumeRuntimeEvent(event: RuntimeEvent, ports: RuntimeConsumerPorts): Promise<RuntimeEventInput[]> {
  if (event.kind === "turn-ended") {
    const flowId = text(event.payload.flowId);
    if (flowId) {
      const flow = await admitted("flow readiness", () => ports.flowReady(flowId, text(event.payload.readyNote, event.payload.finalAssistantOutput)));
      return projection("flow", flowId, flow, event);
    }
    const conversationId = text(event.payload.conversationId);
    const turnId = text(event.payload.turnId);
    const outcome = event.payload.outcome as SpawnTurnEnded["outcome"];
    const spawnTurnEnded = ports.spawnTurnEnded;
    if (spawnTurnEnded && conversationId && turnId && TURN_OUTCOMES.has(outcome)) {
      await admitted("completion notice", () => spawnTurnEnded({
        conversationId,
        turnId,
        outcome,
        startedAt: text(event.payload.turnStartedAt),
        endedAt: event.occurredAt,
      }));
    }
    return [];
  }
  if (event.kind === "workflow.stage.completed") {
    const workflowId = text(event.payload.workflowId);
    const stage = event.payload.stage;
    if (workflowId && typeof stage === "number" && Number.isInteger(stage) && stage >= 0) {
      const workflow = await admitted("workflow stage completion", () => ports.workflowStageCompleted(workflowId, stage));
      return projection("workflow", workflowId, workflow, event);
    }
    return [];
  }
  if (event.kind === "task.delivery.acked") {
    const taskId = text(event.payload.taskId);
    const assignmentId = text(event.payload.assignmentId);
    if (taskId && assignmentId) return projection("task", taskId, await admitted("task delivery", () => ports.taskDeliveryAcknowledged(taskId, assignmentId)), event);
  }
  return [];
}
