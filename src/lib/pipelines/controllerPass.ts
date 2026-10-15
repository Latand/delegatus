import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { yieldToRuntime } from "@/lib/cooperative";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { FileEntry } from "@/lib/types";
import { admitQueuedPipelineCreations } from "./creationQueue";
import { tickPipelines, defaultPipelinePorts, type PipelinePorts } from "./engine";
import { pipelineControllerJobLanes, takePipelineControllerJobChanges } from "./controllerJobs";
import { withControllerPipelineScope } from "./controllerScope";
import { acknowledgePipelineControllerWork, findControllerPipeline, selectPipelineControllerWork, pipelineControllerReady, PipelineStoreError } from "./store";

export const PIPELINE_CONTROLLER_ATTEMPTS_PER_LANE = 16;
const owner = globalThis as typeof globalThis & { __llvPipelineControllerPass?: Promise<{ changed: boolean; pendingWork: number; readyWork: boolean }> };

/** One bounded phase. Durable row changes and deadlines lead; the persisted
 * fair cursor also observes host/account events without a pipeline write. */
export function tickPipelinesController(entries: FileEntry[], suppliedPorts?: PipelinePorts): Promise<{ changed: boolean; pendingWork: number; readyWork: boolean }> {
  if (owner.__llvPipelineControllerPass) return owner.__llvPipelineControllerPass;
  const pass = withViewerOperation("pipelines.controller-schedule", async () => {
    const jobChanged = takePipelineControllerJobChanges();
    const now = suppliedPorts ? Date.parse(suppliedPorts.now()) : Date.now();
    const admitted = await admitQueuedPipelineCreations();
    const work = await selectPipelineControllerWork(now, pipelineControllerJobLanes());
    if (!work.length) return { changed: jobChanged || admitted.length > 0, pendingWork: pipelineControllerJobLanes().length, readyWork: false };
    const selected = new Set<string>();
    const cursors = new Map<string, number>();
    for (const item of work) {
      const lane = await findControllerPipeline(item.row_key);
      const obligations = [...(lane?.runs.flatMap(run => run.attempts.map(attempt => [run.stageId, attempt.n] as const)) ?? []),
        ...(lane?.unconfirmedHosts ?? []).map(host => [host.stageId, host.attempt] as const),
        ...(lane?.closeReport?.unconfirmed ?? []).map(host => [host.stageId, host.attempt] as const),
        ...(lane?.closeReport?.pending ?? []).map(host => [host.stageId, host.attempt] as const)];
      const attempts = [...new Map(obligations.map(item => [JSON.stringify(item), item])).values()];
      for (let index = 0; index < Math.min(attempts.length, PIPELINE_CONTROLLER_ATTEMPTS_PER_LANE); index++) {
        const [stage, n] = attempts[(item.attempt_cursor + index) % attempts.length]!;
        selected.add(JSON.stringify([item.row_key, stage, n]));
      }
      const current = lane?.runs.find(run => run.stageId === lane.cursor?.stageId)?.attempts.findLast(attempt => !attempt.historical);
      if (current) selected.add(JSON.stringify([item.row_key, lane!.cursor!.stageId, current.n]));
      cursors.set(item.row_key, attempts.length ? (item.attempt_cursor + PIPELINE_CONTROLLER_ATTEMPTS_PER_LANE) % attempts.length : 0);
      await yieldToRuntime();
    }
    const ports = suppliedPorts ?? defaultPipelinePorts();
    const result = await withControllerPipelineScope(work.map(item => item.row_key), () => tickPipelines(entries, ports), selected);
    for (const item of work) {
      const lane = await findControllerPipeline(item.row_key);
      let due = now + 30_000;
      for (const run of lane?.runs ?? []) for (const attempt of run.attempts) {
        if (!selected.has(JSON.stringify([item.row_key, run.stageId, attempt.n]))) continue;
        for (const time of [attempt.controllerWait?.retryAfter, attempt.providerWait?.resumeAt, attempt.memoryWait?.retryAfter,
          attempt.remoteHeadWait?.retryAfter]) {
          const at = Date.parse(time ?? "");
          if (at > now) due = Math.min(due, at);
        }
      }
      await acknowledgePipelineControllerWork(item, cursors.get(item.row_key)!, due);
      await yieldToRuntime();
    }
    return { changed: result.changed || jobChanged || admitted.length > 0, pendingWork: pipelineControllerJobLanes().length,
      readyWork: await pipelineControllerReady(now, pipelineControllerJobLanes()) };
  }).catch(error => {
    if (error instanceof StateSnapshotChangedError) return { changed: false, pendingWork: pipelineControllerJobLanes().length, readyWork: true };
    if (!(error instanceof PipelineStoreError)) throw error;
    console.error("[pipelines] skipping tick; registry unreadable", error);
    return { changed: false, pendingWork: pipelineControllerJobLanes().length, readyWork: false };
  });
  owner.__llvPipelineControllerPass = pass;
  void pass.finally(() => { if (owner.__llvPipelineControllerPass === pass) owner.__llvPipelineControllerPass = undefined; }).catch(() => {});
  return pass;
}
