"use client";

import { useSyncExternalStore } from "react";

/*
 * What the phone remembers about its voice head (docs/design/phone-voice-head-build.md, "Hide and Show"):
 * whether the operator hid it and which bottom corner it rests in, kept in this browser's storage as one
 * value, and whether the head can be shown at all (the companion is on and this is the phone layout),
 * held in memory and set by the host. The ⋯ menu offers «Показати голос» only while it can be shown and
 * is hidden. The desktop never reads any of it.
 *
 * As the rail's stored choices (`ProjectRail.tsx`): the server and the first paint read the default, so
 * hydration is identical, and a browser that refuses the write keeps the choice for the page.
 */

/** Where this browser remembers the phone voice head's choice. */
export const PHONE_VOICE_STORAGE_KEY = "llv:phone-voice:v1";

export type PhoneVoiceSide = "left" | "right";
export interface PhoneVoiceState {
  hidden: boolean;
  side: PhoneVoiceSide;
  /** The companion is on and the phone layout is up: the head is mounted unless hidden. */
  available: boolean;
}
type Choice = Pick<PhoneVoiceState, "hidden" | "side">;

const DEFAULT_CHOICE: Choice = { hidden: false, side: "right" };
const SERVER_STATE: PhoneVoiceState = { ...DEFAULT_CHOICE, available: false };

const listeners = new Set<() => void>();
let unsaved: Choice | null = null;
let available = false;
let snapshot: { key: string; state: PhoneVoiceState } | null = null;

function parse(raw: string | null): Choice {
  if (!raw) return DEFAULT_CHOICE;
  try {
    const value = JSON.parse(raw) as Partial<Choice> | null;
    return { hidden: value?.hidden === true, side: value?.side === "left" ? "left" : "right" };
  } catch {
    return DEFAULT_CHOICE;
  }
}

function storedRaw(): string | null {
  try {
    return window.localStorage.getItem(PHONE_VOICE_STORAGE_KEY);
  } catch {
    return null; /* private mode: the default holds for this page */
  }
}

function choice(): Choice {
  return unsaved ?? parse(storedRaw());
}

/** The state as it reads now; the same object while nothing changed, as `useSyncExternalStore` needs. */
export function readPhoneVoice(): PhoneVoiceState {
  const raw = unsaved ? JSON.stringify(unsaved) : storedRaw();
  const key = `${raw ?? ""}|${available}`;
  if (snapshot?.key !== key) snapshot = { key, state: { ...(unsaved ?? parse(raw)), available } };
  return snapshot.state;
}

const notify = () => { for (const listener of [...listeners]) listener(); };

function write(next: Choice) {
  try {
    window.localStorage.setItem(PHONE_VOICE_STORAGE_KEY, JSON.stringify(next));
    unsaved = null;
  } catch {
    unsaved = next; /* private mode: the choice holds for this page only */
  }
  notify();
}

/** «Сховати»: the host unmounts the head, which ends a call it holds. */
export const hidePhoneVoice = () => write({ ...choice(), hidden: true });
/** «Показати голос»: the head comes back on its side with no call. */
export const showPhoneVoice = () => write({ ...choice(), hidden: false });
export const setPhoneVoiceSide = (side: PhoneVoiceSide) => { if (choice().side !== side) write({ ...choice(), side }); };
export function setPhoneVoiceAvailable(next: boolean) {
  if (available === next) return;
  available = next;
  notify();
}

export function subscribePhoneVoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePhoneVoice(): PhoneVoiceState {
  return useSyncExternalStore(subscribePhoneVoice, readPhoneVoice, () => SERVER_STATE);
}

/** Forgets the choice this page held in memory, as a reload does. */
export function resetPhoneVoiceForTests() {
  unsaved = null;
  available = false;
  snapshot = null;
  notify();
}
