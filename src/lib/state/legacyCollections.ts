import { statePath } from "@/lib/configDir";

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

export const LEGACY_COLLECTIONS: readonly LegacyCollectionEntry[] = [
  {
    collection: "tasks",
    importAtActivation: async () => (await import("@/lib/tasks/store")).importLegacyTasks(statePath("tasks.json"), { reconcile: true }),
    checkpointMirrorForDemotion: async () => (await import("@/lib/tasks/store")).checkpointTaskRollbackMirrorForDemotion(statePath("tasks.json")),
  },
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
