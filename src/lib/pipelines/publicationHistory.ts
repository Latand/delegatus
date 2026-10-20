import type { Pipeline, PipelinePublicationFailure, PipelinePublicationRecovery, PipelineStageAttempt } from "./types";

const HISTORY_LIMIT = 64;
export const PUBLICATION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

export function publicationInterrupted(result: { error: string; outcome?: "not-landed" }): boolean {
  return result.outcome === "not-landed" || result.error === "interrupted publication did not leave its accepted head on the remote";
}

/** The hook's last phase or failed group member. Shared by publication and
 * takeover so neither can reset or reclassify the same failed operation. */
export function publicationFailurePhase(failure: PipelinePublicationFailure): string | null {
  for (const line of failure.outputTail.split("\n").map(line => line.trim()).reverse()) {
    const member = /^pre-push: ([^;:]{1,60}): failed \(/.exec(line);
    if (member) return member[1]!;
    if (/^pre-push: [^;:]{1,60}$/.test(line)) return line.slice("pre-push: ".length);
  }
  return null;
}

export function recoverablePublication(result: { error: string; failure?: PipelinePublicationFailure; outcome?: "not-landed" }): boolean {
  return result.failure?.retryableDeadline === true || publicationInterrupted(result)
    || result.failure?.changedFiles === 0 && publicationFailurePhase(result.failure) !== "privacy";
}

/** One failed operation owns one cause and one retry time, even when its
 * acknowledgement, controller or ownership epoch is replaced. */
export function recordPublicationFailure(pipeline: Pipeline, attempt: Pick<PipelineStageAttempt, "publicationRetry"> | undefined,
  input: Omit<PipelinePublicationRecovery["history"][number], "retryAt"> & { recoverable: boolean },
  delays: readonly number[],
): PipelinePublicationRecovery["history"][number] {
  const operation = pipeline.delivery!.operation!;
  if (!/^[0-9a-f]{40}$/i.test(operation.sha)) throw new Error("publication history requires a full head SHA");
  const heads = pipeline.publicationRecovery ??= {};
  const legacy = attempt?.publicationRetry?.sha === operation.sha ? attempt.publicationRetry : undefined;
  const sameLegacy = legacy?.operationId === operation.id;
  const inheritedFailures = (legacy?.failures ?? 0) + (legacy?.exhausted ? 1 : 0);
  const recovery = heads[operation.sha] ??= { sha: operation.sha, failures: inheritedFailures,
    totalAttempts: Math.max(0, inheritedFailures - (sameLegacy ? 1 : 0)), history: [] };
  const recorded = recovery.history.find(item => item.operationId === operation.id);
  if (recorded) return recorded;
  if (input.recoverable && !sameLegacy) recovery.failures++;
  if (sameLegacy && legacy.exhausted) recovery.failures = Math.max(recovery.failures, delays.length + 1);
  const delay = input.recoverable && recovery.failures <= delays.length ? delays[Math.max(0, recovery.failures - 1)] : undefined;
  const retryAt = sameLegacy && !legacy.exhausted ? legacy.retryAt
    : delay === undefined ? null : new Date(Date.parse(input.at) + delay).toISOString();
  const record = { operationId: input.operationId, epoch: input.epoch, at: input.at,
    cause: input.cause, detail: input.detail, retryAt };
  recovery.totalAttempts++;
  recovery.history = [...recovery.history, record].slice(-HISTORY_LIMIT);
  return record;
}

/** A comparison lane may carry an older copy. Takeover retains the strongest
 * counter and the union of operation identities, under the ownership lease. */
export function mergePublicationRecovery(previous: Pipeline["publicationRecovery"], current: Pipeline["publicationRecovery"]): Pipeline["publicationRecovery"] {
  if (!previous && !current) return undefined;
  const merged = structuredClone(previous ?? {});
  for (const [sha, row] of Object.entries(current ?? {})) {
    const old = merged[sha];
    if (!old) { merged[sha] = structuredClone(row); continue; }
    const entries = new Map([...old.history, ...row.history].map(entry => [entry.operationId, entry]));
    merged[sha] = { sha, failures: Math.max(old.failures, row.failures),
      totalAttempts: Math.max(old.totalAttempts, row.totalAttempts, entries.size),
      history: [...entries.values()].sort((a, b) => a.epoch - b.epoch || a.at.localeCompare(b.at)).slice(-HISTORY_LIMIT) };
  }
  return merged;
}

export function isPublicationRecovery(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([sha, item]) => {
    if (!/^[0-9a-f]{40}$/i.test(sha) || !item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as PipelinePublicationRecovery;
    return row.sha === sha && Number.isSafeInteger(row.failures) && row.failures >= 0
      && Number.isSafeInteger(row.totalAttempts) && Array.isArray(row.history) && row.history.length <= HISTORY_LIMIT
      && row.totalAttempts >= row.failures && row.totalAttempts >= row.history.length
      && new Set(row.history.map(entry => entry?.operationId)).size === row.history.length
      && row.history.every(entry => entry && typeof entry.operationId === "string" && !!entry.operationId
        && Number.isSafeInteger(entry.epoch) && entry.epoch > 0 && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
        && ["infrastructure-deadline", "interrupted", "check-failure"].includes(entry.cause)
        && typeof entry.detail === "string" && entry.detail.length <= 400
        && (entry.retryAt === null || typeof entry.retryAt === "string" && Number.isFinite(Date.parse(entry.retryAt))));
  });
}
