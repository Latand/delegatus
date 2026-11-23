/*
 * The last certified `/api/files` answer, kept across documents (#2071,
 * docs/design/skeletons-and-transitions.md D4).
 *
 * A cold start used to wait for the whole catalog body before the board drew
 * a row. This keeps the global-scope body and its ETag in IndexedDB, so the
 * next document paints that answer at once, flagged `cached`, and its first
 * request is a conditional one: a `304` with an empty body when nothing
 * changed, a delta when the server still holds the base, a full body
 * otherwise. The payload is unchanged and no request is added.
 *
 * Bounded like the conversation tails of #1821: one record, at most 24 MB of
 * text, dropped when older than seven days or written by another version.
 * It is cleared when a running page's `/api/files` read is refused (401/403),
 * and that page stops painting it. A device refused before the page loads
 * (its token rotated, so the HTML itself is refused) never runs this code:
 * its record stays until the seven days run out. Pinned deep-link scopes are
 * never stored. The body carries nothing the page was not already
 * served (`servedPayloadSecrets.test.ts`).
 */

export const FILES_SNAPSHOT_VERSION = 1;
export const FILES_SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
export const FILES_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = "delegatus-boot";
const STORE = "snapshot";
const KEY = "files";

export const CREATION_RECEIPT_LIMIT = 8;
export const CREATION_LOCATORS_MAX_BYTES = 64 * 1024;
export interface CreationLocator {
  id: string;
  /** A pending attachment is offered on the same stored ID, never replayed. */
  link?: { attachLink: string; kind: "issue" | "pr" };
}
export interface CreationLocators { owner: string; scope?: string; entries: CreationLocator[] }

export function usableCreationLocators(value: unknown): value is CreationLocators {
  if (!value || typeof value !== "object") return false;
  const record = value as CreationLocators;
  return typeof record.owner === "string" && record.owner.length > 0 && record.owner.length <= 256
    && (record.scope === undefined || (typeof record.scope === "string" && record.scope.length <= CREATION_LOCATORS_MAX_BYTES))
    && Array.isArray(record.entries) && record.entries.length <= CREATION_RECEIPT_LIMIT
    && new Set(record.entries.map(entry => entry?.id)).size === record.entries.length
    && record.entries.every(entry => typeof entry?.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(entry.id)
      && (!entry.link || (typeof entry.link.attachLink === "string" && entry.link.attachLink.length <= 2048
        && ["issue", "pr"].includes(entry.link.kind))))
    && new TextEncoder().encode(JSON.stringify({ owner: record.owner, scope: record.scope,
      entries: record.entries.map(entry => ({ id: entry.id, link: entry.link && { attachLink: entry.link.attachLink, kind: entry.link.kind } })),
    })).byteLength <= CREATION_LOCATORS_MAX_BYTES;
}

export interface FilesSnapshotRecord {
  version: number;
  /** Epoch ms of the write. */
  savedAt: number;
  etag: string;
  /** The raw global-scope body, exactly as the cache certified it. */
  text: string;
  /** Independently retained known IDs. Never part of the ETag's catalog. */
  creations?: CreationLocators;
}

export interface FilesSnapshotStore {
  read(): Promise<FilesSnapshotRecord | null>;
  write(record: FilesSnapshotRecord, current?: () => boolean): Promise<void>;
  clear(owner?: string): Promise<void>;
  updateCreations?(owner: string, add: CreationLocator[], remove: string[], current: () => boolean, certified?: FilesSnapshotRecord, scope?: string): Promise<CreationLocators>;
}

/** A record the next document may paint: this version, not too old, not too
    big, and carrying an ETag to revalidate against. */
export function usableSnapshot(record: unknown, now: number): record is FilesSnapshotRecord {
  if (!record || typeof record !== "object") return false;
  const value = record as Partial<FilesSnapshotRecord>;
  return value.version === FILES_SNAPSHOT_VERSION
    && typeof value.savedAt === "number"
    && now - value.savedAt <= FILES_SNAPSHOT_MAX_AGE_MS
    && value.savedAt <= now + 60_000
    && typeof value.etag === "string" && value.etag !== ""
    && typeof value.text === "string" && value.text.length > 0
    && value.text.length <= FILES_SNAPSHOT_MAX_BYTES;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/** The browser's store, or null where IndexedDB is missing (private modes,
    old engines, the server). Every failure reads as "no snapshot". */
export function indexedDbFilesSnapshotStore(): FilesSnapshotStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB open blocked"));
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  };
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    const result = await request(body(tx.objectStore(STORE)));
    if (mode === "readwrite") {
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
      });
    }
    return result;
  };
  return {
    async read() {
      try {
        const record = await run("readonly", (store) => store.get(KEY) as IDBRequest<unknown>);
        if (usableSnapshot(record, Date.now())) return record;
        const creations = (record as FilesSnapshotRecord | null)?.creations;
        return usableCreationLocators(creations) ? { version: FILES_SNAPSHOT_VERSION, savedAt: Date.now(), text: "", etag: "", creations } : null;
      } catch {
        return null;
      }
    },
    async write(record, current = () => true) {
      if (record.text.length > FILES_SNAPSHOT_MAX_BYTES) throw new Error("snapshot is too large");
      const db = await open();
      if (!current()) throw new Error("snapshot owner changed");
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const read = store.get(KEY);
        read.onsuccess = () => {
          try {
            if (!current()) { tx.abort(); return; }
            if (!read.result || record.savedAt >= read.result.savedAt) store.put({ ...record, creations: read.result?.creations }, KEY);
          } catch { tx.abort(); }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("snapshot write failed"));
      });
    },
    async updateCreations(owner, add, remove, current, certified, scope) {
      const db = await open();
      if (!current()) throw new Error("creation owner changed");
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const read = store.get(KEY);
        let creations: CreationLocators;
        read.onsuccess = () => {
          try {
            if (!current()) { tx.abort(); return; }
            const previous = read.result as FilesSnapshotRecord | undefined;
            const entries = new Map((previous?.creations?.owner === owner && usableCreationLocators(previous.creations)
              ? previous.creations.entries : []).filter(entry => !remove.includes(entry.id)).map(entry => [entry.id, entry]));
            for (const entry of add) entries.set(entry.id, entry);
            creations = { owner, scope, entries: [...entries.values()] };
            if (!usableCreationLocators(creations)) { tx.abort(); return; }
            if (certified && certified.text.length > FILES_SNAPSHOT_MAX_BYTES) { tx.abort(); return; }
            const compatible = previous?.creations?.owner === owner && previous.creations.scope === scope;
            store.put({ version: FILES_SNAPSHOT_VERSION, savedAt: Date.now(), etag: "", text: "", ...(compatible ? previous : {}), ...certified, creations }, KEY);
          } catch { tx.abort(); }
        };
        tx.oncomplete = () => current() ? resolve(creations!) : reject(new Error("creation owner changed"));
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("creation recovery write failed"));
      });
    },
    async clear(owner) {
      try {
        if (owner === undefined) { await run("readwrite", (store) => store.delete(KEY)); return; }
        const db = await open();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          const read = store.get(KEY);
          read.onsuccess = () => { if (read.result?.creations?.owner === owner) store.delete(KEY); };
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
      } catch {
        /* nothing stored, or storage gone */
      }
    },
  };
}

/** An in-memory store with the same contract, for tests and for engines
    without IndexedDB. */
export function memoryFilesSnapshotStore(initial: FilesSnapshotRecord | null = null): FilesSnapshotStore & { current(): FilesSnapshotRecord | null } {
  let record = initial;
  return {
    current: () => record,
    read: async () => {
      const creations = record?.creations;
      return usableSnapshot(record, Date.now()) || usableCreationLocators(creations) ? record : null;
    },
    write: async (next, current = () => true) => {
      if (!current()) throw new Error("snapshot owner changed");
      if (next.text.length > FILES_SNAPSHOT_MAX_BYTES) throw new Error("snapshot is too large");
      if (!record || next.savedAt >= record.savedAt) record = { ...next, creations: record?.creations };
    },
    updateCreations: async (owner, add, remove, current, certified, scope) => {
      if (!current()) throw new Error("creation owner changed");
      const entries = new Map((record?.creations?.owner === owner ? record.creations.entries : [])
        .filter(entry => !remove.includes(entry.id)).map(entry => [entry.id, entry]));
      for (const entry of add) entries.set(entry.id, entry);
      const creations = { owner, scope, entries: [...entries.values()] };
      if (!usableCreationLocators(creations)) throw new Error("creation recovery capacity reached");
      if (certified && certified.text.length > FILES_SNAPSHOT_MAX_BYTES) throw new Error("snapshot is too large");
      const compatible = record?.creations?.owner === owner && record.creations.scope === scope;
      record = { version: FILES_SNAPSHOT_VERSION, savedAt: Date.now(), etag: "", text: "", ...(compatible ? record : {}), ...certified, creations };
      return creations;
    },
    clear: async (owner) => {
      if (owner === undefined || record?.creations?.owner === owner) record = null;
    },
  };
}
