import { waitForStateLock } from "./lockWait";
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
  // Slice 5b; the inventory is docs/design/state-sqlite-slice-5b.md.
  {
    collection: "push_subscriptions",
    importAtActivation: async () => (await import("@/lib/push")).pushSubscriptionStore.importLegacy(statePath("push-subscriptions.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/push")).pushSubscriptionStore.checkpointRollbackMirror(statePath("push-subscriptions.json")),
  },
  {
    collection: "push_sent",
    importAtActivation: async () => (await import("@/lib/push")).pushSentStore.importLegacy(statePath("push-sent.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/push")).pushSentStore.checkpointRollbackMirror(statePath("push-sent.json")),
  },
  {
    collection: "review_loop_presets",
    importAtActivation: async () => (await import("@/lib/flows/store")).presetStore.importLegacy(statePath("review-loop-presets.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/flows/store")).presetStore.checkpointRollbackMirror(statePath("review-loop-presets.json")),
  },
  {
    collection: "workflow_templates",
    importAtActivation: async () => (await import("@/lib/workflows/store")).templateStore.importLegacy(statePath("workflow-templates.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/workflows/store")).templateStore.checkpointRollbackMirror(statePath("workflow-templates.json")),
  },
  {
    collection: "role_presets",
    importAtActivation: async () => (await import("@/lib/roles/store")).rolePresetStore.importLegacy(statePath("role-presets.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/roles/store")).rolePresetStore.checkpointRollbackMirror(statePath("role-presets.json")),
  },
  {
    collection: "spawn_nesting",
    importAtActivation: async () => (await import("@/lib/agent/nestingPolicy")).nestingPolicyStore.importLegacy(statePath("spawn-nesting.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/agent/nestingPolicy")).nestingPolicyStore.checkpointRollbackMirror(statePath("spawn-nesting.json")),
  },
  {
    collection: "root_lineage",
    importAtActivation: async () => (await import("@/lib/root/store")).rootLineageStore.importLegacy(statePath("root-lineage.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/root/store")).rootLineageStore.checkpointRollbackMirror(statePath("root-lineage.json")),
  },
  {
    collection: "telegram_reports",
    importAtActivation: async () => (await import("@/lib/telegram/reportStore")).telegramReportStore.importLegacy(statePath("telegram/reports.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/telegram/reportStore")).telegramReportStore.checkpointRollbackMirror(statePath("telegram/reports.json")),
  },
  {
    collection: "telegram_registrations",
    importAtActivation: async () => (await import("@/lib/telegram/hostRegistration")).telegramRegistrationStore.importLegacy(statePath("telegram/registrations.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/telegram/hostRegistration")).telegramRegistrationStore.checkpointRollbackMirror(statePath("telegram/registrations.json")),
  },
  // Slice 6; inventory: docs/design/state-sqlite-slice-6.md.
  {
    collection: "project_aliases",
    importAtActivation: async () => (await import("@/lib/projects/persistence")).projectAliasStore.importLegacy(statePath("project-aliases.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/projects/persistence")).projectAliasStore.checkpointRollbackMirror(statePath("project-aliases.json")),
  },
  {
    collection: "project_curation",
    importAtActivation: async () => (await import("@/lib/projects/persistence")).projectCurationStore.importLegacy(statePath("project-curation.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/projects/persistence")).projectCurationStore.checkpointRollbackMirror(statePath("project-curation.json")),
  },
  {
    collection: "worktree_map",
    importAtActivation: async () => (await import("@/lib/projects/persistence")).worktreeMapStore.importLegacy(statePath("worktree-map.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/projects/persistence")).worktreeMapStore.checkpointRollbackMirror(statePath("worktree-map.json")),
  },
  {
    collection: "project_remotes",
    importAtActivation: async () => (await import("@/lib/projects/persistence")).projectRemoteStore.importLegacy(statePath("project-remotes.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/projects/persistence")).projectRemoteStore.checkpointRollbackMirror(statePath("project-remotes.json")),
  },
  {
    collection: "session_titles",
    importAtActivation: async () => (await import("@/lib/session/titleStore")).sessionTitleStore.importLegacy(statePath("session-titles.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/session/titleStore")).sessionTitleStore.checkpointRollbackMirror(statePath("session-titles.json")),
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
      outcomes.set(entry.collection, await waitForStateLock("state.import.activation", () => entry.importAtActivation(), { subject: entry.collection }));
    } catch (error) {
      log(`[state import] ${entry.collection} import failed`, error);
      outcomes.set(entry.collection, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return outcomes;
}

/** Write each moved store's legacy file for a rollback release that predates it. */
export async function checkpointLegacyCollectionMirrorsForDemotion(): Promise<void> {
  for (const entry of LEGACY_COLLECTIONS) await waitForStateLock("state.mirror.demotion", () => entry.checkpointMirrorForDemotion(), { subject: entry.collection });
  // Recovery augments the map, aliases and journal; the board above already
  // mirrors its migrated rows. The preceding release needs all four together.
  await (await import("@/lib/projects/worktreeRecoveryStore")).checkpointWorktreeRecoveryForDemotion();
}
