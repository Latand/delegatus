/**
 * One device, one sound per event (docs/design/sound-redesign.md §8).
 *
 * With two Delegatus tabs open, event sounds play only in the tab that most
 * recently had focus. The tab writes a key holding its id and the time on
 * focus and on becoming visible, refreshes the time every 30 s while it owns
 * the key, and removes the key on `pagehide`. A key older than 90 s, or no
 * key, is void: the next tab with an event sound to play claims it and plays,
 * so a closed or crashed tab never silences the others. Two tabs claiming in
 * the same instant can double one sound, which is the old behaviour.
 */

export const EVENT_TAB_KEY = "llvAudioEventTab";
export const EVENT_TAB_REFRESH_MS = 30_000;
export const EVENT_TAB_VOID_AFTER_MS = 90_000;

export interface FocusOwnerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FocusOwnerDeps {
  storage: () => FocusOwnerStorage | null;
  now: () => number;
  tabId: string;
}

export interface FocusOwner {
  /** This tab took focus or became visible. */
  claim(): void;
  /** Whether this tab plays event sounds; claims a void key. */
  owns(): boolean;
  /** Keep a held key fresh. */
  refresh(): void;
  /** The tab is going away: give the key up if it is ours. */
  release(): void;
}

function read(storage: FocusOwnerStorage): { id: string; at: number } | null {
  try {
    const raw = storage.getItem(EVENT_TAB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown };
    return typeof parsed.id === "string" && typeof parsed.at === "number" ? { id: parsed.id, at: parsed.at } : null;
  } catch {
    return null;
  }
}

export function createFocusOwner(deps: FocusOwnerDeps): FocusOwner {
  const write = (storage: FocusOwnerStorage): void => {
    try {
      storage.setItem(EVENT_TAB_KEY, JSON.stringify({ id: deps.tabId, at: deps.now() }));
    } catch {
      /* storage refused: this tab plays, as every tab did before */
    }
  };
  return {
    claim() {
      const storage = deps.storage();
      if (storage) write(storage);
    },
    owns() {
      const storage = deps.storage();
      /* No storage: no other tab can be told apart, so play. */
      if (!storage) return true;
      const held = read(storage);
      if (!held || deps.now() - held.at > EVENT_TAB_VOID_AFTER_MS) {
        write(storage);
        return true;
      }
      return held.id === deps.tabId;
    },
    refresh() {
      const storage = deps.storage();
      if (storage && read(storage)?.id === deps.tabId) write(storage);
    },
    release() {
      const storage = deps.storage();
      if (!storage || read(storage)?.id !== deps.tabId) return;
      try {
        storage.removeItem(EVENT_TAB_KEY);
      } catch {
        /* the key goes void after 90 s anyway */
      }
    },
  };
}

/**
 * Wire one tab's owner to the page: claim on focus and on becoming visible,
 * refresh every 30 s, release on `pagehide`. Returns the cleanup.
 */
export function watchFocusOwner(
  owner: FocusOwner,
  page: Pick<Window, "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval">,
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState" | "hasFocus">,
): () => void {
  const onFocus = () => owner.claim();
  const onVisibility = () => {
    if (doc.visibilityState === "visible") owner.claim();
  };
  const onPageHide = () => owner.release();
  if (doc.visibilityState === "visible" && doc.hasFocus()) owner.claim();
  page.addEventListener("focus", onFocus);
  page.addEventListener("pagehide", onPageHide);
  doc.addEventListener("visibilitychange", onVisibility);
  const timer = page.setInterval(() => owner.refresh(), EVENT_TAB_REFRESH_MS);
  return () => {
    page.removeEventListener("focus", onFocus);
    page.removeEventListener("pagehide", onPageHide);
    doc.removeEventListener("visibilitychange", onVisibility);
    page.clearInterval(timer);
  };
}
