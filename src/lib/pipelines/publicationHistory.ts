import type { Pipeline, PipelinePublicationFailure, PipelinePublicationRecovery, PipelineStageAttempt } from "./types";

const HISTORY_LIMIT = 64;
export const PUBLICATION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const APP_PUSH_WAIT_REASON = "waiting for GitHub to accept the App push";
export const APP_PUSH_WINDOW_ENDED_REASON = `${APP_PUSH_WAIT_REASON}; the one-hour automatic retry window ended`;
export const APP_PUSH_RETRY_WINDOW_MS = 60 * 60_000;

export function publicationInterrupted(result: { error: string; outcome?: "not-landed" | "superseded" }): boolean {
  return result.outcome !== "superseded" && (result.outcome === "not-landed" || result.error === "interrupted publication did not leave its accepted head on the remote");
}

export function publicationEnvironmentFailure(result: { error: string; failure?: Pick<PipelinePublicationFailure, "step" | "outputTail"> & Partial<PipelinePublicationFailure> }): boolean {
  const failure = result.failure;
  return result.error.startsWith("stage environment:") || failure?.step === "preparing publication dependencies";
}

export function publicationPrivacyRefusal(line: string): boolean {
  return /^PRIVACY GATE:[ \t]*FAIL$|^pre-push: privacy:.*(?:failed|refused)/.test(line.trim());
}

/** Every failed scanner report must contain only its configuration fault.
 * Missing or mixed summaries retain the scanner's refusal. */
export function publicationPrivacyConfigurationFault(output: string): boolean {
  const lines = output.split("\n").map(line => line.trim());
  let found = false;
  for (let index = 0; index < lines.length; index++) {
    if (!/^PRIVACY GATE:[ \t]*FAIL$/.test(lines[index]!)) continue;
    found = true;
    const counts: string[] = [];
    for (let next = index + 1; next < lines.length && /^[a-z_]+: \d+$/.test(lines[next]!); next++) counts.push(lines[next]!);
    if (counts.length !== 1 || !/^configuration_error: [1-9]\d*$/.test(counts[0]!)) return false;
  }
  return found;
}

const TRANSPORT_ADMITTED = "pre-push: verified completed checks for this publication; transport admitted";

export function publicationRemoteRefusalLine(output: string): string | undefined {
  return output.split("\n").map(line => line.trim()).find(line =>
    /^(?:remote:.*fatal error|!\s+\[remote rejected\])/.test(line));
}

/** The hook's unfinished phase or failed group member. Shared by publication and
 * takeover so neither can reset or reclassify the same failed operation. */
export function publicationFailurePhase(failure: Pick<PipelinePublicationFailure, "outputTail"> & Partial<PipelinePublicationFailure>): string | null {
  const lines = failure.outputTail.split("\n").map(line => line.trim());
  if (lines.some(publicationPrivacyRefusal)) return "privacy";
  const failed = lines.findLast(line => /^pre-push: [^;:]{1,60}: failed \(/.test(line));
  if (failed) return /^pre-push: ([^;:]{1,60}):/.exec(failed)![1]!;
  if (lines.includes(TRANSPORT_ADMITTED) || publicationRemoteRefusalLine(failure.outputTail)) return null;
  let privacyPassed = false;
  for (const line of lines.reverse()) {
    if (line === "PRIVACY GATE: PASS") privacyPassed = true;
    if (line === "pre-push: privacy" && privacyPassed) continue;
    if (/^pre-push: [^;:]{1,60}$/.test(line)) return line.slice("pre-push: ".length);
  }
  return null;
}

/** A completed hook or an explicit remote ref refusal proves that asking the
 * producer to edit accepted content is unsupported. The remote cause is unknown. */
export function publicationRemoteRefusal(failure: PipelinePublicationFailure | undefined): boolean {
  return failure?.step === "publishing the pipeline branch" && !failure.retryableApp403 && !failure.retryableDeadline
    && publicationFailurePhase(failure) === null
    && (failure.outputTail.split("\n").some(line => line.trim() === TRANSPORT_ADMITTED)
      || !!publicationRemoteRefusalLine(failure.outputTail));
}

export function recoverablePublication(result: { error: string; failure?: PipelinePublicationFailure; outcome?: "not-landed" | "superseded" }): boolean {
  if (result.outcome === "superseded") return false;
  return result.failure?.retryableApp403 === true || result.failure?.retryableDeadline === true || publicationInterrupted(result)
    || result.failure?.changedFiles === 0 && publicationFailurePhase(result.failure) !== "privacy" && !publicationRemoteRefusal(result.failure);
}

/** One recorded operation owns one cause and retry time across recovery.
 * Superseded admissions retain their disposition without spending a budget. */
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
  const result = operation.result ?? operation.executor?.result;
  const superseded = input.cause === "superseded" || result?.outcome === "superseded";
  const recoverable = !superseded && input.recoverable;
  const cause = superseded ? "superseded" : result?.ok === false && publicationEnvironmentFailure(result) || input.detail.startsWith("stage environment:")
    ? "environment" : input.cause === "check-failure" && result?.ok === false && publicationRemoteRefusal(result.failure)
      ? "remote-refusal" : input.cause;
  // Takeover's legacy writer passes the beginning of the push output. A long
  // successful hook log can fill it before the remote explains its refusal.
  const remoteLine = cause === "remote-refusal" && result?.failure && publicationRemoteRefusalLine(result.failure.outputTail);
  const detail = remoteLine ? `remote publication was refused; underlying cause is unknown: ${remoteLine}`.slice(0, 400) : input.detail;
  if (!superseded && input.cause === "app-git-403") {
    const result = operation.result ?? operation.executor?.result;
    // Older receipts have no observation field. Their immutable refusal journal
    // predates controller recovery too; never replace it with the restart time.
    const journal = result?.ok === false ? pipeline.delivery!.journal.findLast(entry =>
      entry.kind === "recovery" && entry.reason === `publication refused: ${result.error}`)?.at : undefined;
    const observedAt = result?.failure?.observedAt ?? journal ?? input.at;
    recovery.app403Since = [recovery.app403Since, observedAt].filter((at): at is string => !!at).sort()[0]!;
  }
  if (recoverable && !sameLegacy) recovery.failures++;
  if (!superseded && sameLegacy && legacy.exhausted) recovery.failures = Math.max(recovery.failures, delays.length + 1);
  const delay = recoverable && recovery.failures <= delays.length ? delays[Math.max(0, recovery.failures - 1)] : undefined;
  let retryAt = !superseded && sameLegacy && !legacy.exhausted ? legacy.retryAt
    : delay === undefined ? null : new Date(Date.parse(input.at) + delay).toISOString();
  if (!superseded && input.cause === "app-git-403" && input.recoverable) {
    const end = Date.parse(recovery.app403Since!) + APP_PUSH_RETRY_WINDOW_MS;
    const count = recovery.history.filter(entry => entry.cause === "app-git-403").length;
    retryAt = Date.parse(input.at) >= end ? null
      : new Date(Math.min(end, Date.parse(input.at) + PUBLICATION_RETRY_DELAYS_MS[Math.min(count, PUBLICATION_RETRY_DELAYS_MS.length - 1)]!)).toISOString();
  }
  const record = { operationId: input.operationId, epoch: input.epoch, at: input.at,
    cause, detail, retryAt };
  if (!superseded) recovery.totalAttempts++;
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
      ...((old.app403Since || row.app403Since) ? { app403Since: [old.app403Since, row.app403Since].filter((at): at is string => !!at).sort()[0] } : {}),
      totalAttempts: Math.max(old.totalAttempts, row.totalAttempts, [...entries.values()].filter(entry => entry.cause !== "superseded").length),
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
      && (row.app403Since === undefined || typeof row.app403Since === "string" && Number.isFinite(Date.parse(row.app403Since)))
      && Number.isSafeInteger(row.totalAttempts) && Array.isArray(row.history) && row.history.length <= HISTORY_LIMIT
      && row.totalAttempts >= row.failures && row.totalAttempts >= row.history.filter(entry => entry?.cause !== "superseded").length
      && new Set(row.history.map(entry => entry?.operationId)).size === row.history.length
      && row.history.every(entry => entry && typeof entry.operationId === "string" && !!entry.operationId
        && Number.isSafeInteger(entry.epoch) && entry.epoch > 0 && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
        && ["infrastructure-deadline", "interrupted", "check-failure", "app-git-403", "environment", "remote-refusal", "superseded"].includes(entry.cause)
        && typeof entry.detail === "string" && entry.detail.length <= 400
        && (entry.retryAt === null || typeof entry.retryAt === "string" && Number.isFinite(Date.parse(entry.retryAt))));
  });
}
