export const DEFAULT_PUBLICATION_PUSH_MS = 15 * 60_000;
export const PIPELINE_PUBLICATION_PUSH_MS = 25 * 60_000;
export const RUNTIME_PUBLICATION_PUSH_MS = 30 * 60_000;
export const DEADLINE_RETRY_PUBLICATION_PUSH_MS = 45 * 60_000;
export const PUBLICATION_PACK_MARGIN_MS = 60_000;
// The forge closed idle SSH receive-pack sessions after about 360 s.
// See docs/design/container-publication-checks.md for the measurements.
export const PUBLICATION_TRANSPORT_HOOK_MS = 180_000;

/** These changes select the measured engine suites or publication regressions.
 * A recorded deadline grants the same larger budget to all retries of that
 * head. The retry count never compounds the allowance. */
export function publicationPushBudgetMs(changed: readonly string[] | null, retryAfterDeadline = false): number {
  if (retryAfterDeadline) return DEADLINE_RETRY_PUBLICATION_PUSH_MS;
  if (changed === null) return RUNTIME_PUBLICATION_PUSH_MS;
  // Allow the observed multi-minute compilation and type checking under load,
  // with room for the remaining runtime verifiers and pack, under a finite cap.
  if (changed.some(file => file === "Dockerfile" || file.startsWith("bin/") || file.startsWith("src/runtime-host/"))) return RUNTIME_PUBLICATION_PUSH_MS;
  return changed.some(file => /^src\/lib\/pipelines\/(?:engine(?:\.[^/]+)?\.ts|git\.ts|parkedPublication\.test\.ts)$/.test(file))
    ? PIPELINE_PUBLICATION_PUSH_MS : DEFAULT_PUBLICATION_PUSH_MS;
}

export function publicationHookDeadline(pushBudgetMs: number, startedAt: number): number {
  return startedAt + pushBudgetMs - PUBLICATION_PACK_MARGIN_MS;
}
