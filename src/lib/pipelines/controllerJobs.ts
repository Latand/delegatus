import { yieldToRuntime } from "@/lib/cooperative";
import { statePath } from "@/lib/configDir";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { requestPipelineTick } from "./controllerSignal";

const host = globalThis as typeof globalThis & {
  __llvPipelineControllerJobs?: Map<string, Promise<void>>;
  __llvPipelineControllerJobChanges?: Set<string>;
  __llvPipelineControllerActiveJobs?: Set<string>;
  __llvPipelineControllerJobResumes?: Map<string, () => void>;
};
const jobs = host.__llvPipelineControllerJobs ??= new Map<string, Promise<void>>();
const changes = host.__llvPipelineControllerJobChanges ??= new Set<string>();
const active = host.__llvPipelineControllerActiveJobs ??= new Set(jobs.keys());
const resumes = host.__llvPipelineControllerJobResumes ??= new Map<string, () => void>();
export function takePipelineControllerJobChanges(): boolean { return changes.delete(statePath("pipelines")); }
type JobKind = "settlement" | "provisioning";
const key = (id: string, kind: JobKind) => JSON.stringify([statePath("pipelines"), id, ...(kind === "settlement" ? [] : [kind])]);
export const PIPELINE_CONTROLLER_MAX_JOBS = 4;
const jobKind = (identity: string): JobKind => JSON.parse(identity)[2] ?? "settlement";
const hasCapacity = (kind: JobKind) => [...active].filter(identity => jobKind(identity) === kind).length < PIPELINE_CONTROLLER_MAX_JOBS;
function resumeWaitingJobs(): void {
  for (const [identity, resume] of resumes) {
    if (!hasCapacity(jobKind(identity))) continue;
    resumes.delete(identity);
    active.add(identity);
    resume();
  }
}
export function pipelineControllerJobLanes(): string[] {
  const root = statePath("pipelines");
  return [...jobs.keys()].flatMap(value => { const [directory, id] = JSON.parse(value); return directory === root ? [id] : []; });
}

/** The persisted provisioning row or committing cursor owns restart recovery.
 * This owner holds only scheduling custody. The existing executors retain
 * their kernel locks, inherited child descriptors and durable receipts until
 * every child and checkpoint settles, including after a phase deadline. */
export function startPipelineControllerJob(id: string, run: (waitOutsideCapacity: (wait: Promise<void>) => Promise<void>) => Promise<unknown>, version: () => Promise<string>, kind: JobKind = "settlement"): boolean {
  const identity = key(id, kind);
  // Publishers can wait on CPU admission for minutes. Provisioning has its
  // own bounded capacity so those waits cannot consume its admission.
  if (jobs.has(identity) || !hasCapacity(kind)) return false;
  active.add(identity);
  const waitOutsideCapacity = async (wait: Promise<void>) => {
    // Keep scheduling custody while a repository predecessor owns the work.
    // Its completion must reacquire capacity before this job can execute again.
    active.delete(identity);
    resumeWaitingJobs();
    try { await wait; }
    finally {
      await new Promise<void>(resolve => {
        resumes.set(identity, resolve);
        resumeWaitingJobs();
      });
    }
  };
  let changed = false;
  const root = statePath("pipelines");
  const job = yieldToRuntime().then(() => withViewerOperation(kind === "provisioning" ? "pipelines.provisioning" : "pipelines.controller-job", () =>
    performanceSpans.wait("controller.job-wait", async () => {
      const before = await version();
      try { await run(waitOutsideCapacity); }
      finally {
        try { changed = await version() !== before; }
        catch (error) { console.error("[pipelines] controller job result revision unavailable", error); }
      }
    })))
    .catch(error => console.error("[pipelines] controller job failed; durable intent retained", error))
    .finally(() => {
      jobs.delete(identity);
      active.delete(identity);
      resumeWaitingJobs();
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
