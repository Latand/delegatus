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

/** Transfer the executing lane, including its live snapshot fences, if a
 * stop lookup outlasts the inline budget. The same await receives its answer.
 * Admission owns one bounded slot until the lane's last checkpoint settles. */
export function runControllerStopReadLane<T>(id: string, ports: PipelinePorts, run: (ports: PipelinePorts) => Promise<T>): Promise<T | undefined> {
  const read = ports.conversationOperatorStopped;
  if (!read) return run(ports);
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
  const localPorts: PipelinePorts = { ...ports, async conversationOperatorStopped(...args) {
    assertOperationLease();
    const readLease = new OperationLease();
    const stopObserving = lane.observe(readLease);
    const cancelRead = () => readLease.abort.abort(lane.abort.signal.reason);
    lane.abort.signal.addEventListener("abort", cancelRead, { once: true });
    const transfer = detachedRoot ? undefined : setTimeout(() => {
      if (detachedRoot || lane.abort.signal.aborted) return;
      const occupied = [...active.values()].reduce((count, lanes) => count + lanes.size, 0);
      if (occupied >= PIPELINE_CONTROLLER_MAX_JOBS) {
        readLease.abort.abort(new Error("operator stop evidence is waiting for read capacity"));
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
      // The transport owns its per-RPC deadline, including legacy receipt
      // lookups. The lane lease bounds the whole read and its reconciliation.
      return await readLease.run(() => awaitLeasedOperation("pipelines.operator-stop-evidence", () =>
        withViewerOperation("pipelines.operator-stop-evidence", () => read.apply(ports, args))));
    } finally {
      stopObserving();
      clearTimeout(transfer);
      lane.abort.signal.removeEventListener("abort", cancelRead);
    }
  } };
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
      console.error("[pipelines] detached stop-read lane did not settle", error);
    });
  });
}
