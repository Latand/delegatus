import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { yieldToRuntime } from "@/lib/cooperative";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { FileEntry } from "@/lib/types";
import { admitQueuedPipelineCreations } from "./creationQueue";
import { tickPipelines, defaultPipelinePorts, type PipelinePorts } from "./engine";
import { pipelineControllerJobLanes, takePipelineControllerJobChanges } from "./controllerJobs";
import { withControllerPipelineScope } from "./controllerScope";
import { controllerAttemptWindow, acknowledgePipelineControllerWork, findControllerPipeline, selectPipelineControllerWork, pipelineControllerReady, PipelineStoreError } from "./store";

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
    const references = new Map<string, import("@/lib/state/pipelineControllerReferences").PipelineAttemptReference[]>();
    for (const item of work) {
      const lane = await findControllerPipeline(item.row_key);
      const { window, current } = await controllerAttemptWindow(item.row_key, item.attempt_cursor, lane?.cursor?.stageId ?? "");
      const refs = [...window];
      for (const ref of current) if (!refs.some(item => item.position === ref.position)) refs.push(ref);
      references.set(item.row_key, refs.sort((left,right) => left.position-right.position));
      for (const ref of refs) selected.add(JSON.stringify([item.row_key, ref.stageId, ref.n]));
      cursors.set(item.row_key, window.at(-1)?.position ?? -1);
      await yieldToRuntime();
    }
    const ports = suppliedPorts ?? defaultPipelinePorts();
    const result = await withControllerPipelineScope(work.map(item => item.row_key), () => tickPipelines(entries, ports), selected, references);
    for (const item of work) {
      const lane = await findControllerPipeline(item.row_key);
      let due = now + 30_000;
      for (const ref of references.get(item.row_key) ?? []) {
        const run = lane?.runs[ref.run], attempt = run?.attempts[ref.attempt];
        if (run?.stageId !== ref.stageId || !attempt || attempt.n !== ref.n) continue;
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
