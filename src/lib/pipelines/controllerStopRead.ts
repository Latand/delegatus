import { assertOperationLease, awaitLeasedOperation, currentOperationLease, OperationLease, withoutOperationLease } from "@/lib/operationLease";
import { stateDir } from "@/lib/configDir";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { PIPELINE_CONTROLLER_MAX_JOBS } from "./controllerJobs";
import { requestPipelineTick } from "./controllerSignal";
import type { PipelinePorts } from "./engine";

const INLINE_READ_MS = 25;
const DETACHED_LANE_DEADLINE_MS = 15_000;
const host = globalThis as typeof globalThis & { __llvStopReadLanes?: Map<string, Map<string, Promise<unknown>>> };
const active = host.__llvStopReadLanes ??= new Map<string, Map<string, Promise<unknown>>>();

export function pipelineStopReadLanes(): string[] {
  return [...(active.get(stateDir())?.keys() ?? [])];
}

export async function settlePipelineStopReadLanes(): Promise<void> {
  await Promise.allSettled(active.get(stateDir())?.values() ?? []);
}

/** Transfer the executing lane with its snapshot fences when a runtime
 * read or an owned control outlasts the inline budget. The lane holds a
 * bounded slot until its last checkpoint settles. */
export function runControllerStopReadLane<T>(id: string, ports: PipelinePorts, run: (ports: PipelinePorts) => Promise<T>): Promise<T | undefined> {
  const read = ports.conversationOperatorStopped;
  const root = stateDir();
  const parent = currentOperationLease();
  assertOperationLease();
  const lane = new OperationLease();
  const detachObserver = parent?.observe(lane);
  const cancel = () => lane.abort.abort(parent?.abort.signal.reason);
  parent?.abort.signal.addEventListener("abort", cancel, { once: true });
  let release!: () => void;
  const detached = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
  let laneDeadline: ReturnType<typeof setTimeout> | undefined;
  let detachedRoot: Map<string, Promise<unknown>> | undefined;
  const occupiedSlots = () => [...active.values()].reduce((count, lanes) => count + lanes.size, 0);
  const hasCapacity = () => detachedRoot !== undefined || occupiedSlots() < PIPELINE_CONTROLLER_MAX_JOBS;

  const boundedPort = async <R>(operation: string, call: () => Promise<R>): Promise<R> => {
    assertOperationLease();
    const portLease = new OperationLease();
    const stopObserving = lane.observe(portLease);
    const cancelPort = () => portLease.abort.abort(lane.abort.signal.reason);
    lane.abort.signal.addEventListener("abort", cancelPort, { once: true });
    const transfer = detachedRoot ? undefined : setTimeout(() => {
      if (detachedRoot || lane.abort.signal.aborted) return;
      if (!hasCapacity()) {
        portLease.abort.abort(new Error("pipeline control is waiting for controller capacity"));
        return;
      }
      detachedRoot = active.get(root) ?? new Map();
      detachedRoot.set(id, work);
      active.set(root, detachedRoot);
      detachObserver?.();
      parent?.abort.signal.removeEventListener("abort", cancel);
      laneDeadline = setTimeout(() => lane.expire(), DETACHED_LANE_DEADLINE_MS);
      release();
    }, INLINE_READ_MS);
    try {
      // The transport owns its per-RPC deadline. The lane bounds the work
      // across multiple reads, a possible mutation, and reconciliation.
      return await portLease.run(() => awaitLeasedOperation(operation, call));
    } finally {
      stopObserving();
      clearTimeout(transfer);
      lane.abort.signal.removeEventListener("abort", cancelPort);
    }
  };
  const localPorts: PipelinePorts = { ...ports, async stopStageAgent(target, options) {
    if (!options?.operationId || !(options.onlyIfIdle || options.automatic)) return ports.stopStageAgent(target, options);
    if (!hasCapacity()) return { outcome: "deferred" };
    return boundedPort("pipelines.stage-stop", () => withViewerOperation("pipelines.evidence", () => ports.stopStageAgent(target, options)));
  } };
  if (read) localPorts.conversationOperatorStopped = (...args) => boundedPort("pipelines.operator-stop-evidence", () =>
    withViewerOperation("pipelines.operator-stop-evidence", () => read.apply(ports, args)));
  const withdraw = ports.invalidateProviderContinuation;
  if (withdraw) localPorts.invalidateProviderContinuation = async (conversationId, ownershipKey) => {
    if (!ownershipKey) return withdraw.call(ports, conversationId);
    if (!hasCapacity()) throw new Error("provider continuation withdrawal is waiting for controller capacity");
    return boundedPort("pipelines.provider-continuation-withdrawal", () =>
      withViewerOperation("pipelines.evidence", () => withdraw.call(ports, conversationId, ownershipKey)));
  };
  const work = lane.run(() => run(localPorts)).finally(() => {
    clearTimeout(laneDeadline);
    parent?.abort.signal.removeEventListener("abort", cancel);
    detachObserver?.();
    if (detachedRoot) {
      detachedRoot.delete(id);
      if (!detachedRoot.size) active.delete(root);
      withoutOperationLease(requestPipelineTick);
    }
  });
  return Promise.race([work, detached]).finally(() => {
    if (detachedRoot) void work.catch(error => {
      console.error("[pipelines] detached runtime-control lane did not settle", error);
    });
  });
}
