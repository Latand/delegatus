import { listClaudeAccounts } from "@/lib/accounts/claude";
import { accountManager } from "@/lib/accounts/manager";
import { stateDir } from "@/lib/configDir";
import { assertStateMutationAllowed } from "@/lib/state/stateMutationBarrier";
import { projectAllowsAccount } from "@/lib/accounts/projectBindings";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { createClaudeCloudTaskProvider } from "@/lib/pipelines/cloudClaudeClient";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { canonicalProject, recordedProjectRemote } from "./aliases";
import { prepareClaudeCloudTask } from "./claudeCloudTasks";

export function claudeCloudTaskDemandPorts() {
  return { accounts: listClaudeAccounts, allowed: projectAllowsAccount, remote: recordedProjectRemote,
    resolve: (project: string, accountId: string) => accountManager.resolveProjectSpawn("claude", { project, requestedId: accountId, requireCapacity: false }),
    prepare: (input: Parameters<typeof prepareClaudeCloudTask>[0]) => prepareClaudeCloudTask(input, createClaudeCloudTaskProvider()) };
}
type Ports = ReturnType<typeof claudeCloudTaskDemandPorts>;
type Job = { promise: Promise<void>; abort: AbortController };
const globalStore = globalThis as typeof globalThis & { __llvClaudeTaskDemands?: Map<string, Job>; __llvClaudeTaskTail?: Promise<void> };
const jobs = () => globalStore.__llvClaudeTaskDemands ??= new Map();
/** The Viewer owns a bounded demand queue. No discovery walk creates unused routines. */
export function queueClaudeCloudTasks(project: string, accountId: string | undefined, assertCurrent: () => void, ports: Ports = claudeCloudTaskDemandPorts(), repositoryHint?: string, options: { force?: boolean } = {}) {
  project = canonicalProject(project);
  const selectedRemote = ports.remote(project);
  const recordedRepository = selectedRemote === null ? null : githubRepositoryOfRemote(selectedRemote);
  if (repositoryHint && recordedRepository && recordedRepository !== repositoryHint) throw new Error("Claude preparation selection changed");
  const repository = repositoryHint ?? recordedRepository;
  if (!repository) throw new Error("Claude Cloud requires a GitHub repository");
  const accounts = ports.accounts().filter(a => (!accountId || a.id === accountId) && ports.allowed(project, "claude", a.id));
  if (accountId && !accounts.length) throw new Error("Claude account is unavailable or not allowed for this project");
  const pairs = accounts.map(account => ({ account, key: `${project}\0${account.id}` }));
  if (jobs().size + pairs.filter(p => !jobs().has(p.key)).length > 256) throw new Error("Claude task preparation queue is full");
  assertStateMutationAllowed(stateDir()); assertCurrent();
  for (const { account, key } of pairs) {
    if (jobs().has(key)) continue;
    const abort = new AbortController();
    const job: Job = { abort, promise: Promise.resolve() };
    jobs().set(key, job);
    // A queued request ends before its first provider operation.
    job.promise = (globalStore.__llvClaudeTaskTail ?? Promise.resolve()).then(() => new Promise<void>(resolve => setTimeout(resolve, 0))).then(() => withViewerOperation("cloud.environment-preparation", async () => {
      const timer = setTimeout(() => abort.abort(), 10 * 60_000);
      try {
        const guard = () => {
          abort.signal.throwIfAborted(); assertStateMutationAllowed(stateDir());
          // Explicit preparation retains its caller’s authority throughout the job.
          if (options.force) assertCurrent();
          const currentRemote = ports.remote(project);
          const currentRepository = currentRemote === null ? null : githubRepositoryOfRemote(currentRemote);
          const remoteMatches = selectedRemote === null
            ? currentRemote === null || currentRepository === repository
            : currentRepository === repository;
          if (!ports.allowed(project, "claude", account.id) || !remoteMatches) throw new Error("Claude preparation selection changed");
          const current = ports.resolve(project, account.id);
          if (current.kind !== "available" || current.account.home !== account.home) throw new Error("Claude preparation account changed");
        };
        let force = options.force === true;
        while (!abort.signal.aborted) {
          guard(); const resolved = ports.resolve(project, account.id);
          if (resolved.kind !== "available") return;
          const result = await ports.prepare({ project, account: resolved.account, repository, ref: "", signal: abort.signal, assertCurrent: guard, force });
          force = false;
          if (result.state !== "pending") return;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(wait); abort.signal.removeEventListener("abort", done); resolve(); };
            const wait = setTimeout(done, Math.max(100, Math.min(30_000, result.retryAt - Date.now())));
            abort.signal.addEventListener("abort", done, { once: true });
            if (abort.signal.aborted) done();
          });
        }
      } finally { clearTimeout(timer); }
    })).catch(() => { /* The saved row retains provider failures; revoked work has no further effects. */ }).finally(() => {
      if (jobs().get(key) === job) jobs().delete(key);
    });
    globalStore.__llvClaudeTaskTail = job.promise;
  }
  return { queued: pairs.map(p => p.account.id) };
}
/** Owned jobs can be joined by shutdown and isolated tests. */
export async function settleClaudeCloudTaskDemands(): Promise<void> { await Promise.all([...jobs().values()].map(j => j.promise)); }
