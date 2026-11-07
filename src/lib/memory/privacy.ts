import { assertOperationLease, OperationLeaseExpiredError } from "@/lib/operationLease";
import { runPrivacyWork } from "@/lib/links/taskPageWorker";
import { storedLessonRevision, RoleMemoryRefusal, ROLE_MEMORY_CHANGED_MESSAGE } from "./roleStore";
import type { PrivacyRequest, RenderReportInput, RenderReportResult, IssueReportFinding } from "./privacyWork";
import type { PublicDenyList } from "@/lib/bridge/publicSafe";
import { PrivacyWorkError, privacyFailureOf } from "./privacyFailure";
import { PrivacyRetryExhausted, privacyFailureObserved, privacyRequestWasClipped, privacyRevisionRerun, privacyWorkerRequest, withPrivacyRetry } from "./privacyRetry";

/** A revision conflict is safe to retry only before dispatch. Never carries text. */
export class RoleMemoryChanged extends RoleMemoryRefusal {
  readonly roleMemoryChanged = true;
  readonly failure = "store-changed";
  constructor() { super("LESSON_PRIVACY_UNAVAILABLE", ROLE_MEMORY_CHANGED_MESSAGE); }
}

/** Restart from original inputs on revision changes or a classified transient
 * read failure. Unknown and permanent failures remain decisive. */
export async function withCurrentRoleMemory<T>(work: () => Promise<T>): Promise<T> {
  return withRoleMemoryRetry(() => withCurrentRevision(work));
}

/** Include launch-side reads and composition in one cutoff without adding
 * another revision replay around composition's own revision fence. */
export async function withRoleMemoryRetry<T>(work: () => Promise<T>): Promise<T> {
  try { return await withPrivacyRetry(work); }
  catch (error) {
    if (error instanceof PrivacyRetryExhausted) throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE",
      `role memory could not be read or filtered; ${error.failure}; ${error.summary}; nothing was sent`, { cause: error });
    throw error;
  }
}
async function withCurrentRevision<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = storedLessonRevision();
    try {
      const value = await work();
      if (storedLessonRevision() === revision) return value;
    } catch (error) {
      if (!(error instanceof RoleMemoryRefusal) || storedLessonRevision() === revision) throw error;
    }
    privacyRevisionRerun();
  }
  throw new RoleMemoryChanged();
}

async function run<T>(request: PrivacyRequest): Promise<T> {
  return withCurrentRoleMemory(() => privacyWorkerRequest(async () => {
    try { return (await runPrivacyWork(request)).value as T; }
    catch (error) {
      const observed = privacyFailureOf(error);
      const failure = observed === "worker-timeout" && privacyRequestWasClipped() ? "window-exhausted" : observed;
      // A revision retry may consume this error before the outer retry loop
      // sees it. Record the safe cause at its origin, including lost leases.
      if (!(error instanceof OperationLeaseExpiredError)) console.warn(`[role-memory] privacy worker failed: ${failure}`);
      privacyFailureObserved(failure);
      assertOperationLease();
      if (error instanceof OperationLeaseExpiredError) throw error;
      throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", `role memory could not be read or filtered; ${failure}; nothing was sent`, { cause: new PrivacyWorkError(failure) });
    }
  }));
}
export function withoutStoredLessonsAsync<T>(value: T): Promise<T> { return run({ kind: "filter", value }); }
export function renderReportAsync(input: RenderReportInput): Promise<RenderReportResult> {
  return run({ kind: "report", input: { ...input, at: input.at.toISOString() } });
}
export function scrubIssueReportAsync(report: { title: string; body: string }, deny: PublicDenyList): Promise<IssueReportFinding[]> {
  return run({ kind: "issue", report, deny });
}

/** Import curation publishes its known values before acknowledging the write. */
export function refreshCurationKnownValuesAsync(): Promise<void> { return run<void>({ kind: "curation-known-values" }); }
