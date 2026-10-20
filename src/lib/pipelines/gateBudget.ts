export const DEFAULT_PUBLICATION_PUSH_MS = 15 * 60_000;
export const PIPELINE_PUBLICATION_PUSH_MS = 25 * 60_000;
export const PUBLICATION_PACK_MARGIN_MS = 60_000;

/** These changes select the measured engine suites or publication regressions.
 * Keep time for the full head, baseline and paired confirmations. Individual
 * test-file, phase and confirmation limits remain the comparator's limits. */
export function publicationPushBudgetMs(changed: readonly string[] | null): number {
  if (changed === null) return PIPELINE_PUBLICATION_PUSH_MS;
  return changed.some(file => /^src\/lib\/pipelines\/(?:engine(?:\.[^/]+)?\.ts|git\.ts|parkedPublication\.test\.ts)$/.test(file))
    ? PIPELINE_PUBLICATION_PUSH_MS : DEFAULT_PUBLICATION_PUSH_MS;
}

export function publicationHookDeadline(pushBudgetMs: number, startedAt: number): number {
  return startedAt + pushBudgetMs - PUBLICATION_PACK_MARGIN_MS;
}
