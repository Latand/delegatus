import { useSyncExternalStore } from "react";

import type { AttentionNotice } from "@/lib/attention/types";

/*
 * An agent's `request_attention` on the phone (docs/design/needs-attention.md
 * §6): never a move, never a banner, only a notice. The rows-only read the
 * phone already makes every few seconds carries the root agent's recent
 * requests; this store keeps them for the bar's ⚠ badge, which lights a dot
 * while one is unseen, and for the ⚠ sheet's «From your agents» section.
 *
 * Seen and cleared are this phone's own, kept in local storage by request id:
 * a record ends ten minutes after it was raised, so that is all the memory a
 * notice needs. The phone never answers the request, so a desktop can still
 * follow it.
 */

const STORAGE_KEY = "llv.attentionNotices.v1";
/** Ids remembered at most, newest kept: far more than ten minutes of asks. */
const MEMORY_CAP = 64;

interface Remembered {
  seen: string[];
  cleared: string[];
}

export interface PhoneNoticesState {
  /** Every notice not cleared on this phone, newest first. */
  notices: readonly AttentionNotice[];
  /** Whether one of them was never shown in the ⚠ sheet. */
  unseen: boolean;
}

const EMPTY: PhoneNoticesState = { notices: [], unseen: false };

let published: readonly AttentionNotice[] = [];
let state: PhoneNoticesState = EMPTY;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function remembered(): Remembered {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<Remembered> : {};
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
    return { seen: ids(parsed.seen), cleared: ids(parsed.cleared) };
  } catch {
    return { seen: [], cleared: [] };
  }
}

function remember(next: Remembered): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ seen: next.seen.slice(-MEMORY_CAP), cleared: next.cleared.slice(-MEMORY_CAP) }));
  } catch {
    /* A phone that cannot store this shows a notice again after a reload. */
  }
}

function compose(): void {
  const memory = remembered();
  const cleared = new Set(memory.cleared);
  const seen = new Set(memory.seen);
  const notices = published.filter((notice) => !cleared.has(notice.id));
  const unseen = notices.some((notice) => !seen.has(notice.id));
  state = notices.length === 0 ? EMPTY : { notices, unseen };
  for (const listener of listeners) listener();
}

const signature = (notices: readonly AttentionNotice[]) => notices.map((notice) => `${notice.id}\t${notice.createdAt}`).join("\n");

/** What the latest rows-only read carried. An unchanged list changes nothing. */
export function publishNotices(notices: readonly AttentionNotice[]): void {
  if (signature(notices) === signature(published)) return;
  published = notices;
  compose();
}

/** The ⚠ sheet showed these: the dot goes out. */
export function markNoticesSeen(ids: readonly string[]): void {
  const memory = remembered();
  const fresh = ids.filter((id) => !memory.seen.includes(id));
  if (!fresh.length) return;
  remember({ ...memory, seen: [...memory.seen, ...fresh] });
  compose();
}

/** × on a notice: gone from this phone. */
export function clearNotice(id: string): void {
  const memory = remembered();
  if (memory.cleared.includes(id)) return;
  remember({ ...memory, cleared: [...memory.cleared, id] });
  compose();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function usePhoneNotices(): PhoneNoticesState {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

/** Test seam: forget what was published and what this phone remembers. */
export function resetPhoneNoticesForTests(): void {
  published = [];
  storage()?.removeItem(STORAGE_KEY);
  compose();
}
