import { useSyncExternalStore } from "react";

/*
 * The one Settings window (docs/design/settings-redo/build-brief.md §2): any
 * place opens it on a section, and on a page of that section, through one
 * window event. The host mounted by the Viewer answers.
 */

export const SETTINGS_SECTIONS = ["general", "memory", "keys", "roles", "dictation", "privacy", "telegram", "voice", "linked", "relay"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** A row's own page: it opens in the section's place, under a back row naming the section. */
export interface SettingsSub {
  id: string;
  /** Which chat, bot or tool the page is about. */
  arg?: string;
  title: string;
}

export interface OpenSettingsRequest { section: SettingsSection | null; sub?: SettingsSub }

export const OPEN_SETTINGS_WINDOW_EVENT = "delegatus:open-settings-window";

export function openSettings(section: SettingsSection | null = null, sub?: SettingsSub): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenSettingsRequest>(OPEN_SETTINGS_WINDOW_EVENT, { detail: { section, sub } }));
}

export function onOpenSettings(listener: (request: OpenSettingsRequest) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<OpenSettingsRequest>).detail ?? { section: null });
  window.addEventListener(OPEN_SETTINGS_WINDOW_EVENT, handle);
  return () => window.removeEventListener(OPEN_SETTINGS_WINDOW_EVENT, handle);
}

/* Whether the window is on screen: the install notice steps aside while it is. */
let shown = false;
const watchers = new Set<() => void>();
export function setSettingsWindowShown(next: boolean): void {
  if (shown === next) return;
  shown = next;
  for (const watcher of watchers) watcher();
}
export function useSettingsWindowShown(): boolean {
  return useSyncExternalStore((watcher) => { watchers.add(watcher); return () => watchers.delete(watcher); }, () => shown, () => false);
}
