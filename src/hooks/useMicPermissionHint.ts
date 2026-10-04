"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  markMicHintSeen,
  micGrantedBefore,
  micHintPlatform,
  micHintSeen,
  queryMicPermission,
  shouldShowMicHint,
  type MicHintPlatform,
  type PermissionsLike,
} from "@/lib/micPermission";

/* One answer per page load, shared by every composer on the page: the board
   can mount a dozen of them, and a dozen copies of one hint would be noise.
   The first composer to mount owns the hint; when it unmounts the next one
   takes over. */
let platform: MicHintPlatform | null = null;
let asked = false;
let owner: symbol | null = null;
const claims: symbol[] = [];
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const standalone = (): boolean => {
  try {
    return (navigator as Navigator & { standalone?: boolean }).standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
};

/* The device's memory is read when the page asks, before any recording of
   this page load: a grant given a moment ago is no reason for a hint yet, and
   a browser that keeps reporting "prompt" after it must not raise one. */
const ask = () => {
  if (asked) return;
  asked = true;
  const grantedBefore = micGrantedBefore();
  const seen = micHintSeen();
  if (!grantedBefore || seen) return;
  void queryMicPermission(navigator.permissions as unknown as PermissionsLike | undefined).then((state) => {
    if (!shouldShowMicHint({ state, grantedBefore, seen })) return;
    platform = micHintPlatform({
      userAgent: navigator.userAgent,
      standalone: standalone(),
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    });
    emit();
  });
};

/** Dismissal, by the operator's tap: the row leaves at once. The device
    already knows it was shown. */
export function dismissMicHint(): void {
  if (platform === null) return;
  platform = null;
  emit();
}

/** Test seam: a fresh page load. */
export function resetMicHintForTests(): void {
  platform = null;
  asked = false;
  owner = null;
  claims.length = 0;
  listeners.clear();
}

export function useMicPermissionHint(): { hint: MicHintPlatform | null; dismiss: () => void } {
  const [id] = useState(() => Symbol("mic-hint"));
  useEffect(() => {
    claims.push(id);
    if (owner === null) owner = id;
    ask();
    emit();
    return () => {
      claims.splice(claims.indexOf(id), 1);
      if (owner === id) owner = claims[0] ?? null;
      emit();
    };
  }, [id]);
  const hint = useSyncExternalStore(subscribe, () => (owner === id ? platform : null), () => null);
  /* Once per device: the first time the row is on screen settles it. It stays
     for the rest of this page load and the next load raises none. */
  useEffect(() => {
    if (hint !== null) markMicHintSeen();
  }, [hint]);
  return { hint, dismiss: dismissMicHint };
}
