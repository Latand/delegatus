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
 * text, dropped when older than seven days or written by another version, and
 * cleared when the server refuses this browser (401/403). Pinned deep-link
 * scopes are never stored. The body carries nothing the page was not already
 * served (`servedPayloadSecrets.test.ts`).
 */

export const FILES_SNAPSHOT_VERSION = 1;
export const FILES_SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
export const FILES_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = "delegatus-boot";
const STORE = "snapshot";
const KEY = "files";

export interface FilesSnapshotRecord {
  version: number;
  /** Epoch ms of the write. */
  savedAt: number;
  etag: string;
  /** The raw global-scope body, exactly as the cache certified it. */
  text: string;
}

export interface FilesSnapshotStore {
  read(): Promise<FilesSnapshotRecord | null>;
  write(record: FilesSnapshotRecord): Promise<void>;
  clear(): Promise<void>;
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
        return usableSnapshot(record, Date.now()) ? record : null;
      } catch {
        return null;
      }
    },
    async write(record) {
      if (record.text.length > FILES_SNAPSHOT_MAX_BYTES) return;
      try {
        await run("readwrite", (store) => store.put(record, KEY));
      } catch {
        /* quota, a closing page: the next certified answer tries again */
      }
    },
    async clear() {
      try {
        await run("readwrite", (store) => store.delete(KEY));
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
    read: async () => (usableSnapshot(record, Date.now()) ? record : null),
    write: async (next) => {
      if (next.text.length <= FILES_SNAPSHOT_MAX_BYTES) record = next;
    },
    clear: async () => {
      record = null;
    },
  };
}
