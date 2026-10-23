import type { PipelineStage } from "@/lib/pipelines/types";

import type { LaneTimers } from "./eventLane";
import type { EventSoundId } from "./synth";

/**
 * Sound captions (docs/design/sound-captions.md): the short toast each event
 * sound earns, saying in words what the sound announced and about whom.
 *
 * This module holds plain data and the countdown. It has no i18n, so the pure
 * planners can build a caption and the stack names it at render time.
 *
 * A caption is pushed where the sound actually starts (`cuePlayer`), never at
 * request time: a muted, quiet, blocked, dropped or superseded request plays
 * nothing and so shows nothing.
 */

/** What the sound announced; the stack maps it to one line per language. */
export type CaptionWhat =
  | "step" | "merged" | "lane-done" | "merge-blocked"
  | "decision" | "question" | "plan" | "permission" | "lane-decision" | "prototype" | "update" | "attention"
  | "delivery" | "launch" | "memory"
  | "released" | "deploy-failed" | "deploy-rolled-back" | "limit"
  | "reply" | "launched";

/** Where a click on a caption goes. */
export type CaptionTarget =
  | { kind: "conversation"; path?: string; conversationId?: string }
  | { kind: "lane"; pipelineId: string; project: string }
  | { kind: "needs-you"; entryId: string; then: CaptionTarget | null };

export interface CueCaption {
  what: CaptionWhat;
  /** Who or what it is about, already cut with `cleanTitle(…, 90)`; null = resolve at render or omit. */
  subject: string | null;
  /** S3 only: the stage, named at render time with `stageDisplayName`. */
  stage?: Pick<PipelineStage, "id" | "kind" | "role">;
  pr?: number;
  target: CaptionTarget | null;
}

/** How long a toast stays when nobody holds it, ms. */
export const VISIBLE_MS = 2000;
/** A released hold leaves at least this long, so a toast does not vanish as the pointer leaves, ms. */
export const RESUME_MIN_MS = 1000;
/** The stack's bound: a fifth toast removes the oldest at once. */
export const MAX_CAPTIONS = 4;

export interface SoundCaptionItem {
  id: number;
  sound: EventSoundId;
  /** Events this one play stands for. */
  n: number;
  captions: readonly CueCaption[];
}

export interface PushedSoundCaption {
  sound: EventSoundId;
  batch: number;
  captions: readonly CueCaption[];
}

export interface SoundCaptionStore {
  push(caption: PushedSoundCaption): void;
  /** Freeze (or resume) every countdown. Sources are counted apart: hover and a hidden tab hold together. */
  hold(held: boolean, source?: string): void;
  remove(id: number): void;
  clear(): void;
  snapshot(): readonly SoundCaptionItem[];
  subscribe(listener: () => void): () => void;
  /** Stop the timer and forget everything (tests, teardown). */
  reset(): void;
}

export interface SoundCaptionStoreOptions {
  timers?: LaneTimers;
  /** Whether the document is hidden right now, and a way to hear it change. */
  visibility?: { hidden(): boolean; subscribe(onChange: () => void): () => void };
}

const REAL_TIMERS: LaneTimers = {
  now: () => Date.now(),
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Slot {
  item: SoundCaptionItem;
  /** When it leaves; null while held. */
  deadline: number | null;
  /** What was left when the hold began (VISIBLE_MS for one pushed during a hold). */
  remaining: number;
}

export function createSoundCaptionStore(options: SoundCaptionStoreOptions = {}): SoundCaptionStore {
  const timers = options.timers ?? REAL_TIMERS;
  let slots: Slot[] = [];
  let items: readonly SoundCaptionItem[] = [];
  let sequence = 0;
  let timer: unknown = null;
  const holds = new Set<string>();
  const listeners = new Set<() => void>();

  const publish = (): void => {
    items = slots.map((slot) => slot.item);
    for (const listener of [...listeners]) listener();
  };

  const rearm = (): void => {
    if (timer !== null) {
      timers.cancel(timer);
      timer = null;
    }
    let next: number | null = null;
    for (const slot of slots) if (slot.deadline !== null && (next === null || slot.deadline < next)) next = slot.deadline;
    if (next === null) return;
    timer = timers.schedule(expire, Math.max(0, next - timers.now()));
  };

  function expire(): void {
    timer = null;
    const now = timers.now();
    const kept = slots.filter((slot) => slot.deadline === null || slot.deadline > now);
    if (kept.length !== slots.length) {
      slots = kept;
      publish();
    }
    rearm();
  }

  const held = (): boolean => holds.size > 0;

  const freeze = (): void => {
    const now = timers.now();
    for (const slot of slots) {
      if (slot.deadline === null) continue;
      slot.remaining = Math.max(0, slot.deadline - now);
      slot.deadline = null;
    }
    rearm();
  };

  const thaw = (): void => {
    const now = timers.now();
    for (const slot of slots) if (slot.deadline === null) slot.deadline = now + Math.max(slot.remaining, RESUME_MIN_MS);
    rearm();
  };

  const syncHidden = (): void => {
    const hidden = options.visibility?.hidden() ?? false;
    if (hidden === holds.has("hidden")) return;
    if (hidden) {
      const wasHeld = held();
      holds.add("hidden");
      if (!wasHeld) freeze();
    } else {
      holds.delete("hidden");
      if (!held()) thaw();
    }
  };
  const stopWatching = options.visibility?.subscribe(syncHidden) ?? null;

  return {
    push({ sound, batch, captions }) {
      syncHidden();
      const item: SoundCaptionItem = { id: ++sequence, sound, n: batch, captions };
      slots.push({ item, deadline: held() ? null : timers.now() + VISIBLE_MS, remaining: VISIBLE_MS });
      if (slots.length > MAX_CAPTIONS) slots = slots.slice(slots.length - MAX_CAPTIONS);
      publish();
      rearm();
    },

    hold(next, source = "pointer") {
      if (next === holds.has(source)) return;
      const wasHeld = held();
      if (next) holds.add(source);
      else holds.delete(source);
      if (next && !wasHeld) freeze();
      else if (!next && !held()) thaw();
    },

    remove(id) {
      const kept = slots.filter((slot) => slot.item.id !== id);
      if (kept.length === slots.length) return;
      slots = kept;
      publish();
      rearm();
    },

    clear() {
      if (!slots.length) return;
      slots = [];
      publish();
      rearm();
    },

    snapshot: () => items,

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    reset() {
      if (timer !== null) timers.cancel(timer);
      timer = null;
      slots = [];
      items = [];
      holds.clear();
      listeners.clear();
      stopWatching?.();
    },
  };
}

const documentVisibility: SoundCaptionStoreOptions["visibility"] = typeof document === "undefined"
  ? undefined
  : {
      hidden: () => document.hidden,
      subscribe(onChange) {
        document.addEventListener("visibilitychange", onChange);
        return () => document.removeEventListener("visibilitychange", onChange);
      },
    };

/** The tab's one stack, like the cue player: a module singleton read with `useSyncExternalStore`. */
let store: SoundCaptionStore | null = null;
function soundCaptionStore(): SoundCaptionStore {
  store ??= createSoundCaptionStore({ visibility: documentVisibility });
  return store;
}

export function pushSoundCaption(caption: PushedSoundCaption): void {
  soundCaptionStore().push(caption);
}
export function holdSoundCaptions(held: boolean, source?: string): void {
  soundCaptionStore().hold(held, source);
}
export function removeSoundCaption(id: number): void {
  soundCaptionStore().remove(id);
}
export function clearSoundCaptions(): void {
  soundCaptionStore().clear();
}
export function subscribeSoundCaptions(listener: () => void): () => void {
  return soundCaptionStore().subscribe(listener);
}
export function soundCaptionsSnapshot(): readonly SoundCaptionItem[] {
  return soundCaptionStore().snapshot();
}
export function resetSoundCaptionsForTests(): void {
  store?.reset();
  store = null;
}
/** Test seam: run the tab's stack on a fake clock. */
export function configureSoundCaptionsForTests(options: SoundCaptionStoreOptions): void {
  store?.reset();
  store = createSoundCaptionStore(options);
}
