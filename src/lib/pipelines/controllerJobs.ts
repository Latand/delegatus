import { yieldToRuntime } from "@/lib/cooperative";
import { statePath } from "@/lib/configDir";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { requestPipelineTick } from "./controllerSignal";

const host = globalThis as typeof globalThis & { __llvPipelineControllerJobs?: Map<string, Promise<void>>; __llvPipelineControllerJobChanges?: Set<string> };
const jobs = host.__llvPipelineControllerJobs ??= new Map<string, Promise<void>>();
const changes = host.__llvPipelineControllerJobChanges ??= new Set<string>();
export function takePipelineControllerJobChanges(): boolean { return changes.delete(statePath("pipelines")); }
const key = (id: string) => JSON.stringify([statePath("pipelines"), id]);
export const PIPELINE_CONTROLLER_MAX_JOBS = 4;
export function pipelineControllerJobLanes(): string[] {
  const root = statePath("pipelines");
  return [...jobs.keys()].flatMap(value => { const [directory, id] = JSON.parse(value); return directory === root ? [id] : []; });
}

/** The persisted committing cursor/publication operation owns restart recovery.
 * This owner holds only scheduling custody. The existing executors retain
 * their kernel locks, inherited child descriptors and durable receipts until
 * every child and checkpoint settles, including after a phase deadline. */
export function startPipelineControllerJob(id: string, run: () => Promise<unknown>, version: () => Promise<string>): boolean {
  const identity = key(id);
  if (jobs.has(identity) || jobs.size >= PIPELINE_CONTROLLER_MAX_JOBS) return false;
  let changed = false;
  const root = statePath("pipelines");
  const job = yieldToRuntime().then(() => withViewerOperation("pipelines.controller-job", () =>
    performanceSpans.wait("controller.job-wait", async () => {
      const before = await version();
      try { await run(); }
      finally {
        try { changed = await version() !== before; }
        catch (error) { console.error("[pipelines] controller job result revision unavailable", error); }
      }
    })))
    .catch(error => console.error("[pipelines] controller job failed; durable intent retained", error))
    .finally(() => {
      jobs.delete(identity);
      if (changed) {
        changes.add(root);
        while (changes.size > 8) changes.delete(changes.values().next().value!);
        requestPipelineTick();
      }
    });
  jobs.set(identity, job);
  return true;
}

/** Used for shutdown diagnostics and replay settlement, never phase completion. */
export async function settlePipelineControllerJobs(): Promise<void> {
  const owned = new Set(pipelineControllerJobLanes().map(key));
  await Promise.all([...jobs].filter(([identity]) => owned.has(identity)).map(([, job]) => job));
}
