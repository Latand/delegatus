import { stateDir, statePath } from "@/lib/configDir";

import type { LegacyImportOutcome } from "./legacyImport";

/**
 * Every legacy JSON store that has moved into `state.sqlite` (#1870). The
 * activation import, the demotion mirror and the deployment adapter's fence
 * checkpoint all read this list, so a slice that moves a store adds one entry.
 * Entries load their store lazily to keep this module free of import cycles,
 * and resolve their path per call rather than at module load.
 */
interface LegacyCollectionEntry {
  collection: string;
  importAtActivation(): Promise<LegacyImportOutcome>;
  checkpointMirrorForDemotion(): Promise<void>;
}

const MIGRATION_OPERATION_JOURNAL_ROOTS = [
  "migration-provider-operations",
  "migration-provider-claude-operations",
] as const;

export const LEGACY_COLLECTIONS: readonly LegacyCollectionEntry[] = [
  {
    collection: "tasks",
    importAtActivation: async () => (await import("@/lib/tasks/store")).importLegacyTasks(statePath("tasks.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/tasks/store")).checkpointTaskRollbackMirrorForDemotion(statePath("tasks.json")),
  },
  {
    collection: "board",
    importAtActivation: async () => (await import("@/lib/board/store")).importLegacyBoard(statePath("board.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/board/store")).checkpointBoardRollbackMirrorForDemotion(statePath("board.json")),
  },
  {
    collection: "bridge_reports",
    importAtActivation: async () => (await import("@/lib/bridge/store")).importLegacyBridgeReports(statePath("bridge-reports.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/bridge/store")).checkpointBridgeReportsRollbackMirrorForDemotion(statePath("bridge-reports.json")),
  },
  /* `bridge.json` and every `bridge-channels/<hash>.json`: the entry names the
     state directory, and the store reads both sources beneath it. */
  {
    collection: "bridge_channels",
    importAtActivation: async () => (await import("@/lib/bridge/store")).importLegacyBridgeChannels(stateDir(), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/bridge/store")).checkpointBridgeChannelsRollbackMirrorForDemotion(stateDir()),
  },
  {
    collection: "accounts",
    importAtActivation: async () => (await import("@/lib/accounts/accountsStore")).importLegacyAccounts(undefined, { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/accounts/accountsStore")).checkpointAccountRollbackMirrorsForDemotion(),
  },
  /* The operator-facing small stores (slice 5). Each entry resolves the
     store's own path, which honours the store's test override. */
  {
    collection: "attention",
    importAtActivation: async () => (await import("@/lib/attention/store")).importLegacyAttention(undefined, { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/attention/store")).checkpointAttentionRollbackMirrorForDemotion(),
  },
  {
    collection: "reply_suggestions",
    importAtActivation: async () => (await import("@/lib/suggestions/store")).importLegacyReplySuggestions(undefined, { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/suggestions/store")).checkpointReplySuggestionsRollbackMirrorForDemotion(),
  },
  {
    collection: "attention_dismissals",
    importAtActivation: async () => (await import("@/lib/attention/dismissals")).importLegacyAttentionDismissals(undefined, { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/attention/dismissals")).checkpointAttentionDismissalsRollbackMirrorForDemotion(),
  },
  {
    collection: "seat_tick_settings",
    importAtActivation: async () => (await import("@/lib/monitor/seatTickSettings")).importLegacySeatTickSettings(undefined, { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/monitor/seatTickSettings")).checkpointSeatTickSettingsRollbackMirrorForDemotion(),
  },
  /* The conversation-migration journal roots: a directory of per-operation
     files rather than one file, so the entry names the root and the store keys
     its collection off the root's basename. */
  ...MIGRATION_OPERATION_JOURNAL_ROOTS.map((root) => ({
    collection: `account_migration_ops:${root}`,
    importAtActivation: async () => (await import("@/lib/accounts/migration/provider"))
      .importMigrationOperationJournalsAtActivation(statePath(root)),
    checkpointMirrorForDemotion: async () => (await import("@/lib/accounts/migration/provider"))
      .checkpointMigrationOperationJournalMirrorForDemotion(statePath(root)),
  })),
];

/** Import (or finish importing, or reconcile) every moved store. One store's
    failure is logged and does not stop the others or the activation: a store
    whose import has not committed keeps serving reads from its legacy file. */
export async function ensureLegacyCollectionsImported(
  log: (...args: unknown[]) => void = console.error,
): Promise<Map<string, LegacyImportOutcome | Error>> {
  const outcomes = new Map<string, LegacyImportOutcome | Error>();
  for (const entry of LEGACY_COLLECTIONS) {
    try {
      outcomes.set(entry.collection, await entry.importAtActivation());
    } catch (error) {
      log(`[state import] ${entry.collection} import failed`, error);
      outcomes.set(entry.collection, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return outcomes;
}

/** Write each moved store's legacy file for a rollback release that predates it. */
export async function checkpointLegacyCollectionMirrorsForDemotion(): Promise<void> {
  for (const entry of LEGACY_COLLECTIONS) await entry.checkpointMirrorForDemotion();
}
