// Compatibility oracle copied from git show 7bc9b9de:src/lib/agentState/store.ts.
const emptyAgentStateMetricsBeforeAntigravity = {
  version: 1, revision: 0, at: 0, registryTranscriptDivergencesTotal: 0, registryTranscriptDivergencesCurrent: 0,
  unownedHosts: 0, unownedRssBytes: null, unownedRssMeasured: 0, unownedRssUnknown: 0, stuckTurns: 0,
  stuckByEngine: { codex: 0, claude: 0, copilot: 0 }, stuckByReason: { silent: 0, checking: 0, providerWait: 0 },
  subjectsObserved: 0, subjectsUnverified: 0, subjectsDeferred: 0, pendingProjectionPublications: 0,
  lastCompleteReconciliationAt: null, afterKey: null, journalRows: 0, terminalSubjects: 0, physicalAliasesUnverified: 0,
};

export function validAgentStateMetricsBeforeAntigravity(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const row = v as Record<string, unknown>;
  return Object.entries(emptyAgentStateMetricsBeforeAntigravity).every(([key, sample]) => {
    const value = row[key];
    if (key === "version") return value === 1;
    if (key === "stuckByEngine" || key === "stuckByReason") return Boolean(value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === Object.keys(sample!).length
      && Object.keys(sample!).every(bucket => typeof (value as Record<string, unknown>)[bucket] === "number"
        && Number.isSafeInteger((value as Record<string, number>)[bucket]) && (value as Record<string, number>)[bucket]! >= 0));
    if (key === "afterKey") return value === null || typeof value === "string" && value.length <= 128;
    if (sample === null) return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }) && (row.physicalSubjects === undefined || Array.isArray(row.physicalSubjects) && row.physicalSubjects.length <= 16 && row.physicalSubjects.every(id => typeof id === "string" && /^[a-f0-9]{48}$/.test(id)))
    && Object.keys(row).length === Object.keys(emptyAgentStateMetricsBeforeAntigravity).length + Number(row.physicalSubjects !== undefined);
}
