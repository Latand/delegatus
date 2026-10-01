"use client";

import { createContext } from "react";

export interface SpeechTarget { id: string; text: string; roots: () => HTMLElement[]; area?: number; order?: number; }
export interface SpeechSnapshot {
  target: SpeechTarget | null;
  activeText: string | null;
  activeId: string | null;
  phase: "idle" | "loading" | "playing";
  error: string | null;
}
/** Feed lifetime owns playback. Header/row remounts and changes of the visible
 * target cannot splice a new answer into an active read. */
export class ConversationSpeech {
  private state: SpeechSnapshot = { target: null, activeText: null, activeId: null, phase: "idle", error: null };
  private listeners = new Set<() => void>();
  stop: (() => void) | null = null;
  private generation = 0;
  nextGeneration(): number { return ++this.generation; }
  isGeneration(value: number): boolean { return this.generation === value; }
  claimStop(stop: () => void): void { this.stop = stop; }
  releaseStop(stop: () => void): void { if (this.stop === stop) this.stop = null; }
  setRoots(owner: symbol, resolve: (id: string) => HTMLElement[]): void { this.viewports.set(owner, { target: null, roots: resolve }); }
  feeds = 0;
  transferUntil = 0;
  beginTransfer(): void { this.transferUntil = performance.now() + 1000; }
  private viewports = new Map<symbol, { target: SpeechTarget | null; roots: (id: string) => HTMLElement[] }>();
  rootsFor = (id: string): HTMLElement[] => {
    const candidates = [...this.viewports.values()].sort((a, b) => (b.target?.area ?? 0) - (a.target?.area ?? 0));
    for (const viewport of candidates) { const roots = viewport.roots(id); if (roots.length) return roots; }
    return this.viewports.size === 0 && this.state.target?.id === id ? this.state.target.roots() : [];
  };
  selectFor(owner: symbol, target: SpeechTarget | null): void {
    const viewport = this.viewports.get(owner);
    if (viewport) viewport.target = target;
    this.select([...this.viewports.values()].flatMap((value) => value.target ? [value.target] : []).sort((a, b) => (b.area ?? 0) - (a.area ?? 0) || (b.order ?? 0) - (a.order ?? 0))[0] ?? null);
  }
  releaseViewport(owner: symbol): void { this.viewports.delete(owner); this.selectFor(owner, null); }
  getSnapshot = (): SpeechSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(next: Partial<SpeechSnapshot>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  select(target: SpeechTarget | null): void {
    if (target?.id === this.state.target?.id && target?.text === this.state.target?.text) return;
    this.update({ target });
  }
}
const conversations = new Map<string, ConversationSpeech>();
export function conversationSpeech(scope: string): ConversationSpeech {
  let speech = conversations.get(scope);
  if (!speech) { speech = new ConversationSpeech(); conversations.set(scope, speech); }
  return speech;
}
export function ownConversationFeed(scope: string): () => void {
  const speech = conversationSpeech(scope); speech.feeds++; speech.transferUntil = 0;
  return () => {
    speech.feeds--;
    // Moving a pane to full-window can remount its feed in the same commit.
    const finish = () => {
      if (speech.feeds) return;
      speech.stop?.(); speech.select(null);
    };
    queueMicrotask(() => {
      if (speech.feeds) return;
      const delay = speech.transferUntil - performance.now();
      if (delay > 0) setTimeout(finish, delay);
      else finish();
    });
  };
}
export const SpeechScope = createContext<string | null>(null);
