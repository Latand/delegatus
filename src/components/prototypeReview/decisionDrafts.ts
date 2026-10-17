"use client";

import { useMemo, useSyncExternalStore } from "react";

import { recommendedAnswers } from "@/lib/prototypeReview/questions";
import type { PrototypeAnswer, PrototypeRoundView } from "@/lib/prototypeReview/types";

/*
 * What the operator has chosen and written in a decision form, kept per round
 * (review id) in this browser until the answer is saved. The review window and
 * the «Рішення» card both read and write it, so a failed save, a reload, a
 * window replaced by another review, a card folded or a tab switched all bring
 * the same words back, and the same round answered from either surface shows
 * one draft.
 *
 * One localStorage key per round, so a keystroke rewrites only its own round.
 * A storage that is full or switched off falls back to the page's memory,
 * which is what drafts had before they were stored. Drafts leave when the
 * answer is saved, when a successful read shows the round decided or gone
 * (never after a failed read, which is when the words have to survive), and
 * by age and count.
 */

export interface Draft { reject: boolean; chosen: number[]; comment: string; answers: PrototypeAnswer[] }
interface Entry extends Draft { v: 1; reviewId: string; taskId: string | null; project: string; updatedAt: number }
type Round = Pick<PrototypeRoundView, "id" | "taskId" | "project" | "questions" | "variants" | "decision">;

const PREFIX = "llv.prototypeReview.draft:";
/** Drafts kept; the least recently edited go first past this many. */
export const DRAFTS_MAX = 20;
/** A draft nobody touched for this long is forgotten. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The form as it opens: the recommended answers and nothing else. */
export const initialDraft = (round: Pick<PrototypeRoundView, "questions"> | null): Draft => ({ reject: false, chosen: [], comment: "", answers: recommendedAnswers(round?.questions ?? []) });

/* null: removed since it was loaded. */
const cache = new Map<string, Entry | null>();
const listeners = new Set<() => void>();
let version = 0;
let loaded = false;

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const isNumbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isInteger(entry));
const isAnswer = (value: unknown): value is PrototypeAnswer => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return typeof answer.questionId === "string" && isNumbers(answer.options);
};
function parse(raw: string | null): Entry | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || value.v !== 1 || typeof value.reviewId !== "string"
      || typeof value.comment !== "string" || typeof value.reject !== "boolean" || typeof value.updatedAt !== "number"
      || !isNumbers(value.chosen) || !Array.isArray(value.answers) || !value.answers.every(isAnswer)
      || !(value.taskId === null || typeof value.taskId === "string") || typeof value.project !== "string") return null;
    return value as unknown as Entry;
  } catch {
    return null;
  }
}

function storageKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let at = 0; at < localStorage.length; at += 1) {
      const key = localStorage.key(at);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
function removeStored(reviewId: string): void {
  try { localStorage.removeItem(PREFIX + reviewId); } catch { /* the page's memory had it */ }
}

/** Every stored draft, read once per page load. A key that does not parse is removed. */
function load(): void {
  if (loaded) return;
  loaded = true;
  for (const key of storageKeys()) {
    const id = key.slice(PREFIX.length);
    let entry: Entry | null = null;
    try { entry = parse(localStorage.getItem(key)); } catch { /* none */ }
    if (entry && entry.reviewId === id) { if (!cache.has(id)) cache.set(id, entry); } else removeStored(id);
  }
  trim(Date.now());
}

/** Drafts past their age go, then the least recently edited past the cap. */
function trim(now: number): boolean {
  const live = [...cache.values()].filter((entry): entry is Entry => entry !== null);
  const keep = new Set(live.filter((entry) => now - entry.updatedAt <= DRAFT_MAX_AGE_MS).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DRAFTS_MAX).map((entry) => entry.reviewId));
  let changed = false;
  for (const entry of live) {
    if (keep.has(entry.reviewId)) continue;
    cache.set(entry.reviewId, null);
    removeStored(entry.reviewId);
    changed = true;
  }
  return changed;
}

function readEntry(reviewId: string): Entry | null {
  load();
  return cache.get(reviewId) ?? null;
}

/** A stored draft as this round can take it: nothing a different question
    list, other variants or a decided round could not use. */
function fit(round: Round, entry: Entry | null): Draft | null {
  if (!entry || round.decision) return null;
  const questions = round.questions ?? [];
  const answersFit = entry.answers.length === questions.length && entry.answers.every((answer, at) => {
    const question = questions[at]!;
    return answer.questionId === question.id && answer.options.every((option) => option >= 0 && option < question.options.length);
  });
  const numbers = new Set(round.variants.map((variant) => variant.number));
  return {
    reject: round.variants.length > 0 && entry.reject,
    chosen: entry.chosen.filter((number) => numbers.has(number)),
    comment: entry.comment,
    answers: answersFit ? entry.answers : recommendedAnswers(questions),
  };
}

/** The draft of a round right now: the stored one that fits, else the form as it opens. */
export function currentDecisionDraft(round: Round): Draft {
  return fit(round, readEntry(round.id)) ?? initialDraft(round);
}

/** The stored draft of a round, null when it holds none that fits. */
export function useStoredDecisionDraft(round: Round): Draft | null {
  const entry = useSyncExternalStore(subscribe, () => readEntry(round.id), () => null);
  return useMemo(() => fit(round, entry), [round, entry]);
}

/** The stored drafts of the given rounds by id, only for rounds that hold one. */
export function useStoredDecisionDrafts(rounds: readonly Round[]): Record<string, Draft> {
  const seen = useSyncExternalStore(subscribe, () => version, () => 0);
  return useMemo(() => {
    void seen;
    const found: Record<string, Draft> = {};
    for (const round of rounds) {
      const draft = fit(round, readEntry(round.id));
      if (draft) found[round.id] = draft;
    }
    return found;
  }, [rounds, seen]);
}

/** Keeps a draft as it changes. A form back at its opening state stores nothing. */
export function saveDecisionDraft(round: Round, draft: Draft, now = Date.now()): void {
  const opening = initialDraft(round);
  if (JSON.stringify(draft) === JSON.stringify(opening)) {
    forgetDecisionDraft(round.id);
    return;
  }
  const fresh = readEntry(round.id) === null;
  const entry: Entry = { v: 1, reviewId: round.id, taskId: round.taskId, project: round.project, updatedAt: now, ...draft };
  cache.set(round.id, entry);
  try { localStorage.setItem(PREFIX + round.id, JSON.stringify(entry)); } catch { /* full or switched off: the page's memory keeps it */ }
  if (fresh) trim(now);
  emit();
}

/** The answer was saved, discarded or no longer asked: the draft goes. */
export function forgetDecisionDraft(reviewId: string): void {
  const held = readEntry(reviewId);
  cache.set(reviewId, null);
  removeStored(reviewId);
  if (held) emit();
}

function storedEntries(): Entry[] {
  load();
  return [...cache.values()].filter((entry): entry is Entry => entry !== null);
}

/** A task's read that succeeded: its drafts for rounds that are decided or no
    longer there go. Pass only a complete read of this installation. */
export function reconcileTaskDrafts(taskId: string, rounds: readonly Pick<PrototypeRoundView, "id" | "decision">[]): void {
  const state = new Map(rounds.map((round) => [round.id, Boolean(round.decision)]));
  for (const entry of storedEntries()) {
    if (entry.taskId !== taskId) continue;
    if (state.get(entry.reviewId) !== false) forgetDecisionDraft(entry.reviewId);
  }
}

/** A project's decisions read that succeeded: the seat's own drafts for rounds
    no longer asking go, and so does any draft for a round listed as decided.
    The list holds each task's one waiting round only, so task drafts are
    judged by their own read. */
export function reconcileSeatDrafts(project: string, decisions: readonly Pick<PrototypeRoundView, "id" | "decision">[]): void {
  const listed = new Map(decisions.map((round) => [round.id, Boolean(round.decision)]));
  for (const entry of storedEntries()) {
    const decided = listed.get(entry.reviewId) === true;
    const gone = entry.taskId === null && entry.project === project && !listed.has(entry.reviewId);
    if (decided || gone) forgetDecisionDraft(entry.reviewId);
  }
}

/** Tests only: no draft at all, memory and storage both. */
export function resetDecisionDraftsForTests(): void {
  for (const key of storageKeys()) {
    try { localStorage.removeItem(key); } catch { /* none */ }
  }
  cache.clear();
  loaded = false;
  emit();
}

/** Tests only: a page load. Memory forgets, storage stays. */
export function reloadDecisionDraftsForTests(): void {
  cache.clear();
  loaded = false;
  emit();
}
