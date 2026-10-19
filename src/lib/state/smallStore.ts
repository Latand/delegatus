import fs from "node:fs";
import { LegacyDocumentStore, type LegacyDocumentOptions } from "./legacyDocumentStore";

/** Shared import protocol for slice 5b. Legacy JSON is read only before
 * activation; malformed bytes are preserved by the importer with an incident. */
export function smallStore<D>(options: Omit<LegacyDocumentOptions<D>, "migrationId" | "busyMessage" | "readLegacy" | "error"> & {
  empty(): D;
  readLegacy?(filePath: string): D;
  error?(message: string, cause?: unknown): Error;
}): LegacyDocumentStore<D> {
  // SQLite's history projection imports flow/role definitions. Constructing
  // their stores during that same import cycle would observe an uninitialized
  // class. Resolve the instance only when an owner actually uses persistence.
  let instance: LegacyDocumentStore<D> | undefined;
  const create = () => new LegacyDocumentStore<D>({
    ...options,
    migrationId: `${options.collection}-json-v1`,
    busyMessage: `${options.collection} state is busy`,
    nonBlockingLock: true,
    maxOpenCollections: 4,
    error: options.error ?? ((message, cause) => new Error(message, { cause })),
    readLegacy: options.readLegacy ?? ((filePath) => {
      try { return options.parse(JSON.parse(fs.readFileSync(filePath, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return options.empty();
        throw error;
      }
    }),
  });
  return new Proxy({} as LegacyDocumentStore<D>, {
    get(_target, key) {
      const store = instance ??= create();
      const value = Reflect.get(store, key);
      return typeof value === "function" ? value.bind(store) : value;
    },
  });
}
