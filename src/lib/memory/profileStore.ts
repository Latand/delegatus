import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import type { ProfileRow } from "./profileTypes";
import type { Locale } from "@/lib/i18n/core";

const key = (row: Pick<ProfileRow, "project" | "locale">) => JSON.stringify([row.project, row.locale]);
const seed = { collection: "memory_profile", schemaVersion: 1, migrationId: "memory-profile-v1", key, loadRecords: (): ProfileRow[] => [] };
/** Exported for the install transfer, which initializes the collection through its owner. */
export function memoryProfileCollection(create: boolean): SqliteStateCollection<ProfileRow> | null {
  const file = statePath("state.sqlite");
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  return new SqliteStateCollection<ProfileRow>(file, { collection: seed.collection, schemaVersion: 1, busyMessage: "memory profile busy", key, clone: structuredClone, strictDecode: true,
    decode: value => {
      if (!value || typeof value !== "object") return null;
      const row = value as ProfileRow;
      return typeof row.project === "string" && ["uk", "en"].includes(row.locale) && typeof row.model === "string" && Array.isArray(row.parts) ? row : null;
    },
  });
}
export function readProfileRow(project: string, locale: Locale): ProfileRow | null {
  return memoryProfileCollection(false)?.get(key({ project, locale })) ?? null;
}
export function writeProfileRow(row: ProfileRow): void {
  memoryProfileCollection(true)!.boundedPatch(1, tx => tx.put(row));
}
