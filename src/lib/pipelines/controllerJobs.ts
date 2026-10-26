import { yieldToRuntime } from "@/lib/cooperative";
import { statePath } from "@/lib/configDir";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { requestPipelineTick } from "./controllerSignal";

const host = globalThis as typeof globalThis & { __llvPipelineControllerJobs?: Map<string, Promise<void>>; __llvPipelineControllerJobChanges?: Set<string> };
const jobs = host.__llvPipelineControllerJobs ??= new Map<string, Promise<void>>();
const changes = host.__llvPipelineControllerJobChanges ??= new Set<string>();
export function takePipelineControllerJobChanges(): boolean { return changes.delete(statePath("pipelines")); }
type JobKind = "settlement" | "provisioning";
const key = (id: string, kind: JobKind) => JSON.stringify([statePath("pipelines"), id, ...(kind === "settlement" ? [] : [kind])]);
export const PIPELINE_CONTROLLER_MAX_JOBS = 4;
export function pipelineControllerJobLanes(): string[] {
  const root = statePath("pipelines");
  return [...jobs.keys()].flatMap(value => { const [directory, id] = JSON.parse(value); return directory === root ? [id] : []; });
}

/** The persisted provisioning row or committing cursor owns restart recovery.
 * This owner holds only scheduling custody. The existing executors retain
 * their kernel locks, inherited child descriptors and durable receipts until
 * every child and checkpoint settles, including after a phase deadline. */
export function startPipelineControllerJob(id: string, run: () => Promise<unknown>, version: () => Promise<string>, kind: JobKind = "settlement"): boolean {
  const identity = key(id, kind);
  // Publishers can wait on CPU admission for minutes. Provisioning has its
  // own bounded capacity so those waits cannot consume its admission.
  const count = [...jobs.keys()].filter(value => (JSON.parse(value)[2] ?? "settlement") === kind).length;
  if (jobs.has(identity) || count >= PIPELINE_CONTROLLER_MAX_JOBS) return false;
  let changed = false;
  const root = statePath("pipelines");
  const job = yieldToRuntime().then(() => withViewerOperation(kind === "provisioning" ? "pipelines.provisioning" : "pipelines.controller-job", () =>
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
  const root = statePath("pipelines");
  await Promise.all([...jobs].filter(([identity]) => JSON.parse(identity)[0] === root).map(([, job]) => job));
}
