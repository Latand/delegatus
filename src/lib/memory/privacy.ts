import { stateDir } from "@/lib/configDir";
import { assertOperationLease, OperationLeaseExpiredError } from "@/lib/operationLease";
import { runPrivacyWork } from "@/lib/links/taskPageWorker";
import { storedLessonRevision, RoleMemoryRefusal, ROLE_MEMORY_CHANGED_MESSAGE, ROLE_MEMORY_PREPARATION_MESSAGE } from "./roleStore";
import type { PrivacyRequest, RenderReportInput, RenderReportResult, IssueReportFinding } from "./privacyWork";
import type { PublicDenyList } from "@/lib/bridge/publicSafe";
import { PrivacyWorkError, privacyFailureOf, transientPrivacyFailure } from "./privacyFailure";
import { PrivacyRetryExhausted, privacyPreparationHasTime, privacyFailureObserved, privacyRequestWasClipped, privacyRevisionRerun, privacyWorkerRequest, withPrivacyRetry } from "./privacyRetry";

/** A revision conflict is safe to retry only before dispatch. Never carries text. */
export class RoleMemoryChanged extends RoleMemoryRefusal {
  readonly roleMemoryChanged = true;
  readonly failure = "store-changed";
  constructor() { super("LESSON_PRIVACY_UNAVAILABLE", ROLE_MEMORY_CHANGED_MESSAGE); }
}

/** Only a completed retryable preparation window authorizes durable waiting. */
export class RoleMemoryPreparationDeferred extends RoleMemoryRefusal {
  constructor(readonly exhaustion?: PrivacyRetryExhausted) {
    super("LESSON_PRIVACY_UNAVAILABLE", exhaustion
      ? `role memory could not be read or filtered; ${exhaustion.failure}; ${exhaustion.summary}; nothing was sent`
      : ROLE_MEMORY_PREPARATION_MESSAGE, exhaustion ? { cause: exhaustion } : undefined);
  }
}
export function roleMemoryDeferralReason(error: unknown): string | null {
  return error instanceof RoleMemoryChanged ? ROLE_MEMORY_CHANGED_MESSAGE
    : error instanceof RoleMemoryPreparationDeferred ? ROLE_MEMORY_PREPARATION_MESSAGE : null;
}

/** Restart from original inputs on revision changes or a classified transient
 * read failure. Unknown and permanent failures remain decisive. */
export async function withCurrentRoleMemory<T>(work: () => Promise<T>, options: { revisionAttempts?: 1 | 3 } = {}): Promise<T> {
  return withRoleMemoryRetry(() => withCurrentRevision(work, options.revisionAttempts ?? 3));
}

/** Include launch-side reads and composition in one cutoff without adding
 * another revision replay around composition's own revision fence. */
export async function withRoleMemoryRetry<T>(work: () => Promise<T>): Promise<T> {
  try { return await withPrivacyRetry(work); }
  catch (error) {
    if (error instanceof PrivacyRetryExhausted && (error.failure === "window-exhausted" || transientPrivacyFailure(error.failure))) {
      throw new RoleMemoryPreparationDeferred(error);
    }
    if (error instanceof PrivacyRetryExhausted) throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE",
      `role memory could not be read or filtered; ${error.failure}; ${error.summary}; nothing was sent`, { cause: error });
    throw error;
  }
}
async function withCurrentRevision<T>(work: () => Promise<T>, attempts: number): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    assertOperationLease();
    const revision = storedLessonRevision();
    try {
      const value = await work();
      assertOperationLease();
      if (storedLessonRevision() === revision) return value;
    } catch (error) {
      assertOperationLease();
      // A concurrent write cannot turn a permanent refusal into an accepted replay.
      if ((!(error instanceof RoleMemoryChanged) && !transientPrivacyFailure(privacyFailureOf(error)))
        || storedLessonRevision() === revision) throw error;
    }
    privacyRevisionRerun();
  }
  throw new RoleMemoryChanged();
}

async function requestWork<T>(request: PrivacyRequest): Promise<T> {
  return privacyWorkerRequest(async () => {
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
  });
}
function run<T>(request: PrivacyRequest): Promise<T> { return withCurrentRoleMemory(() => requestWork<T>(request)); }
type FilterEntry = { output: string; bytes: number; touched: number };
type FilterCache = { generation: string; bytes: number; entries: Map<string, FilterEntry> };
const cacheHost = globalThis as typeof globalThis & { __delegatusCompletedPrivacyV1?: FilterCache };
const completed = cacheHost.__delegatusCompletedPrivacyV1 ??= { generation: "", bytes: 0, entries: new Map<string, FilterEntry>() };
const CACHE_TTL_MS = 10 * 60_000;
function generationFor(root: string, revision: string): string { return JSON.stringify([1, root, revision]); }
function selectGeneration(generation: string): void {
  if (completed.generation !== generation) {
    completed.entries.clear(); completed.bytes = 0; completed.generation = generation;
  }
}
function removeCompleted(input: string): void {
  const entry = completed.entries.get(input);
  if (entry) { completed.bytes -= entry.bytes; completed.entries.delete(input); }
}
function filterString(input: string): Promise<string> {
  return withRoleMemoryRetry(async () => {
    let root = "", revision = "", generation = "";
    const output = await withCurrentRoleMemory(async () => {
      assertOperationLease();
      root = stateDir(); revision = storedLessonRevision(); generation = generationFor(root, revision);
      selectGeneration(generation);
      const now = performance.now();
      for (const [key, entry] of completed.entries) if (now - entry.touched >= CACHE_TTL_MS) removeCompleted(key);
      const entry = revision ? completed.entries.get(input) : undefined;
      if (entry) {
        completed.entries.delete(input); completed.entries.set(input, entry); entry.touched = now;
        return entry.output;
      }
      return requestWork<string>({ kind: "filter", value: input });
    });
    assertOperationLease();
    if (stateDir() !== root || storedLessonRevision() !== revision) throw new RoleMemoryChanged();
    // Complete results only. Never alias output to input or share in-flight leases.
    if (revision && completed.generation === generation && privacyPreparationHasTime()) {
      const bytes = Buffer.byteLength(input) + Buffer.byteLength(output) + Buffer.byteLength(generation) + 64;
      if (bytes <= 128 * 1024) {
        removeCompleted(input);
        completed.entries.set(input, { output, bytes, touched: performance.now() }); completed.bytes += bytes;
        while (completed.entries.size > 128 || completed.bytes > 8 * 1024 * 1024) removeCompleted(completed.entries.keys().next().value!);
      }
    }
    return output;
  });
}
export function withoutStoredLessonsAsync<T>(value: T): Promise<T> {
  return (typeof value === "string" ? filterString(value) : run<T>({ kind: "filter", value })) as Promise<T>;
}
export function renderReportAsync(input: RenderReportInput): Promise<RenderReportResult> {
  return run({ kind: "report", input: { ...input, at: input.at.toISOString() } });
}
export function scrubIssueReportAsync(report: { title: string; body: string }, deny: PublicDenyList): Promise<IssueReportFinding[]> {
  return run({ kind: "issue", report, deny });
}

/** Import curation publishes its known values before acknowledging the write. */
export function refreshCurationKnownValuesAsync(): Promise<void> { return run<void>({ kind: "curation-known-values" }); }
