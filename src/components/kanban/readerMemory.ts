"use client";

/**
 * Which conversations are open as readers inside kanban cards, on this device
 * (#1695 K3).
 *
 * A reader stays open until the operator closes it; nothing on the board closes
 * one for them and there is no cap on how many, open or remembered. What is
 * remembered is the conversation's stable identity (its conversation id, or its
 * path before it has one), the last path it was seen under, and whether it is
 * folded to its header. It is this screen's arrangement, so it lives in this
 * browser's storage: the shared board preference `prefs.expanded` places cards
 * on the scheme board for every device and means something else.
 *
 * Every open identity is written. When the browser refuses the write (storage
 * full, or private mode), the readers stay open for this page and the memory
 * says so through `persisted`, for the board to tell the operator.
 */

export const READER_STORAGE_PREFIX = "llv:kanban-readers:v1:";

export interface OpenReader {
  /** `conversationIdentity(file)`. */
  key: string;
  /** The path the conversation was last seen under. */
  path: string;
  folded: boolean;
}

export function parseReaders(raw: string | null): OpenReader[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const readers: OpenReader[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const { key, path, folded } = entry as Partial<OpenReader>;
      if (typeof key !== "string" || !key || typeof path !== "string" || seen.has(key)) continue;
      seen.add(key);
      readers.push({ key, path, folded: folded === true });
    }
    return readers;
  } catch {
    return [];
  }
}

/** Open (or unfold) a reader. Re-opening one keeps its place in the order. */
export function openReader(readers: readonly OpenReader[], key: string, path: string): OpenReader[] {
  const existing = readers.find((reader) => reader.key === key);
  if (existing) {
    if (!existing.folded && existing.path === path) return readers as OpenReader[];
    return readers.map((reader) => (reader.key === key ? { ...reader, path, folded: false } : reader));
  }
  return [...readers, { key, path, folded: false }];
}

export function foldReader(readers: readonly OpenReader[], key: string, folded: boolean): OpenReader[] {
  return readers.map((reader) => (reader.key === key && reader.folded !== folded ? { ...reader, folded } : reader));
}

export function closeReader(readers: readonly OpenReader[], key: string): OpenReader[] {
  return readers.filter((reader) => reader.key !== key);
}

/** A conversation that moved to a new transcript path keeps its reader. */
export function followPaths(readers: readonly OpenReader[], pathOf: (key: string) => string | null): OpenReader[] {
  let changed = false;
  const next = readers.map((reader) => {
    const path = pathOf(reader.key);
    if (!path || path === reader.path) return reader;
    changed = true;
    return { ...reader, path };
  });
  return changed ? next : (readers as OpenReader[]);
}

export class ReaderMemory {
  private readers: OpenReader[];
  private readonly listeners = new Set<() => void>();
  private stored = true;

  constructor(private readonly project: string, private readonly storage: Pick<Storage, "getItem" | "setItem"> | null) {
    this.readers = parseReaders(this.read());
  }

  private read(): string | null {
    try {
      return this.storage?.getItem(READER_STORAGE_PREFIX + this.project) ?? null;
    } catch {
      return null;
    }
  }

  snapshot = (): readonly OpenReader[] => this.readers;

  /** False while the last write was refused: what is open is not remembered. */
  persisted = (): boolean => this.stored;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(change: (readers: readonly OpenReader[]) => OpenReader[]): void {
    const next = change(this.readers);
    if (next === this.readers) return;
    this.readers = next;
    try {
      this.storage?.setItem(READER_STORAGE_PREFIX + this.project, JSON.stringify(next));
      this.stored = true;
    } catch {
      /* The readers stay open for this page; `persisted` reports the refusal. */
      this.stored = false;
    }
    for (const listener of this.listeners) listener();
  }
}
