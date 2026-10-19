import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { yieldToRuntime } from "@/lib/cooperative";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { FileEntry } from "@/lib/types";
import { admitQueuedPipelineCreations } from "./creationQueue";
import { tickPipelines, defaultPipelinePorts, type PipelinePorts } from "./engine";
import { pipelineControllerJobLanes, takePipelineControllerJobChanges } from "./controllerJobs";
import { withControllerPipelineScope } from "./controllerScope";
import { controllerAttemptWindow, controllerPipelineVersion, deferPipelineControllerWork, acknowledgePipelineControllerWork, findControllerPipeline, selectPipelineControllerWork, pipelineControllerReady, PipelineStoreError } from "./store";

export const PIPELINE_CONTROLLER_ATTEMPTS_PER_LANE = 16;
const owner = globalThis as typeof globalThis & { __llvPipelineControllerPass?: Promise<{ changed: boolean; pendingWork: number; readyWork: boolean }> };

/** One bounded phase. Durable row changes and deadlines lead; the persisted
 * fair cursor also observes host/account events without a pipeline write. */
export function tickPipelinesController(entries: FileEntry[], suppliedPorts?: PipelinePorts): Promise<{ changed: boolean; pendingWork: number; readyWork: boolean }> {
  if (owner.__llvPipelineControllerPass) return owner.__llvPipelineControllerPass;
  const pass = withViewerOperation("pipelines.controller-schedule", async () => {
    // Let the caller's reader work finish its turn before scheduler admission.
    // Capture changes, deadlines and ownership only after this checkpoint.
    await yieldToRuntime();
    const jobChanged = takePipelineControllerJobChanges();
    const now = suppliedPorts ? Date.parse(suppliedPorts.now()) : Date.now();
    const admitted = await admitQueuedPipelineCreations();
    const work = await selectPipelineControllerWork(now, pipelineControllerJobLanes());
    if (!work.length) return { changed: jobChanged || admitted.length > 0, pendingWork: pipelineControllerJobLanes().length, readyWork: false };
    let changed = jobChanged || admitted.length > 0;
    const ports = suppliedPorts ?? defaultPipelinePorts();
    for (const item of work) {
      try {
        const version = await controllerPipelineVersion(item.row_key);
        const lane = await findControllerPipeline(item.row_key);
        const { window, current } = await controllerAttemptWindow(item.row_key, item.attempt_cursor, lane?.cursor?.stageId ?? "");
        if (await controllerPipelineVersion(item.row_key) !== version) throw new StateSnapshotChangedError();
        const refs = [...window];
        for (const ref of current) if (!refs.some(item => item.position === ref.position)) refs.push(ref);
        refs.sort((left,right) => left.position-right.position);
        const selected = new Set(refs.map(ref => JSON.stringify([item.row_key, ref.stageId, ref.n])));
        const references = new Map([[item.row_key, refs]]);
        const result = await withControllerPipelineScope([item.row_key], () => tickPipelines(entries, ports), selected, references);
        changed ||= result.changed;
        if (result.retry) { await deferPipelineControllerWork(item); continue; }
        const fresh = await findControllerPipeline(item.row_key);
        let due = now + 30_000;
        for (const ref of refs) {
          const run = fresh?.runs[ref.run], attempt = run?.attempts[ref.attempt];
          if (run?.stageId !== ref.stageId || !attempt || attempt.n !== ref.n) continue;
          for (const time of [attempt.controllerWait?.retryAfter, attempt.providerWait?.resumeAt, attempt.memoryWait?.retryAfter,
            attempt.remoteHeadWait?.retryAfter]) {
            const at = Date.parse(time ?? "");
            if (at > now) due = Math.min(due, at);
          }
        }
        await acknowledgePipelineControllerWork(item, window.at(-1)?.position ?? -1, due);
      } catch (error) {
        if (!(error instanceof StateSnapshotChangedError)) {
          if (!(error instanceof PipelineStoreError)) throw error;
          console.error("[pipelines] deferring lane; registry unreadable", error);
        }
        // A peer still gets its turn; this lane keeps its generation and cursor.
        await deferPipelineControllerWork(item);
      } finally { await yieldToRuntime(); }
    }
    return { changed, pendingWork: pipelineControllerJobLanes().length,
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
