import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { PrototypeRoundView } from "@/lib/prototypeReview/types";

import {
  DRAFTS_MAX, DRAFT_MAX_AGE_MS, currentDecisionDraft, forgetDecisionDraft, initialDraft, reconcileSeatDrafts, reconcileTaskDrafts,
  reloadDecisionDraftsForTests, resetDecisionDraftsForTests, saveDecisionDraft,
} from "./decisionDrafts";

/* The pure store, with no DOM: a storage the case controls stands in for the browser's. */

class FakeStorage {
  items = new Map<string, string>();
  failWrites = false;
  get length() { return this.items.size; }
  key(at: number) { return [...this.items.keys()][at] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new DOMException("quota", "QuotaExceededError"); this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}

const KEY = (id: string) => `llv.prototypeReview.draft:${id}`;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage = new FakeStorage();

beforeAll(() => { Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true }); });
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original); else delete (globalThis as { localStorage?: unknown }).localStorage;
});
afterEach(() => {
  resetDecisionDraftsForTests();
  storage = new FakeStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  reloadDecisionDraftsForTests();
});

const round = (id: string, extra: Partial<PrototypeRoundView> = {}): PrototypeRoundView => ({
  id, title: "Layout", taskId: "task-1", project: "project-a", createdAt: "2026-10-17T10:00:00.000Z", source: { conversationId: null },
  variants: [{ number: 1, name: "A", description: "", frames: [], videos: [] }, { number: 2, name: "B", description: "", frames: [], videos: [] }],
  ...extra,
});
const asking = (id: string, extra: Partial<PrototypeRoundView> = {}) => round(id, {
  variants: [], questions: [{ id: "when", text: "When?", options: [{ label: "Now", recommended: true }, { label: "Later" }] }], ...extra,
});
const typed = (comment: string, extra: Partial<ReturnType<typeof initialDraft>> = {}) => ({ ...initialDraft(null), comment, ...extra });

describe("a draft in this browser", () => {
  test("is written on a change, read back after a reload and removed when forgotten", () => {
    const own = round("r1");
    saveDecisionDraft(own, typed("  words\n", { chosen: [2] }), NOW);
    expect(JSON.parse(storage.getItem(KEY("r1"))!)).toEqual({ v: 1, reviewId: "r1", taskId: "task-1", project: "project-a", updatedAt: NOW, reject: false, chosen: [2], comment: "  words\n", answers: [] });
    reloadDecisionDraftsForTests();
    expect(currentDecisionDraft(own)).toEqual({ reject: false, chosen: [2], comment: "  words\n", answers: [] });
    forgetDecisionDraft("r1");
    expect(storage.getItem(KEY("r1"))).toBeNull();
    expect(currentDecisionDraft(own)).toEqual(initialDraft(own));
  });

  test("a form back at its opening state stores nothing", () => {
    const own = asking("r1");
    saveDecisionDraft(own, typed("x", { answers: [{ questionId: "when", options: [1] }] }), NOW);
    expect(storage.getItem(KEY("r1"))).not.toBeNull();
    saveDecisionDraft(own, initialDraft(own), NOW);
    expect(storage.getItem(KEY("r1"))).toBeNull();
  });

  test("keeps at most 20 drafts, dropping the least recently edited", () => {
    for (let at = 0; at < DRAFTS_MAX + 3; at += 1) saveDecisionDraft(round(`r${at}`), typed(`draft ${at}`), NOW + at);
    const left = [...storage.items.keys()].sort();
    expect(left).toHaveLength(DRAFTS_MAX);
    expect(storage.getItem(KEY("r0"))).toBeNull();
    expect(storage.getItem(KEY("r2"))).toBeNull();
    expect(storage.getItem(KEY("r3"))).not.toBeNull();
    expect(storage.getItem(KEY(`r${DRAFTS_MAX + 2}`))).not.toBeNull();
  });

  test("forgets a draft nobody touched for 30 days, when a page loads and when a new draft is written", () => {
    const base = Date.now();
    const stale = (id: string, updatedAt: number) => storage.setItem(KEY(id), JSON.stringify({ v: 1, reviewId: id, taskId: null, project: "p", updatedAt, reject: false, chosen: [], comment: "x", answers: [] }));
    stale("old", base - DRAFT_MAX_AGE_MS - 60_000);
    stale("edge", base - DRAFT_MAX_AGE_MS + 60_000);
    reloadDecisionDraftsForTests();
    expect(currentDecisionDraft(round("old")).comment).toBe("");
    expect(storage.getItem(KEY("old"))).toBeNull();
    expect(currentDecisionDraft(round("edge")).comment).toBe("x");
    // A new draft trims against its own time, two minutes on: the edge draft is now past its age.
    saveDecisionDraft(round("new"), typed("new"), base + 120_000);
    expect(storage.getItem(KEY("edge"))).toBeNull();
    expect(storage.getItem(KEY("new"))).not.toBeNull();
  });

  test("ignores corrupt JSON and a version it does not know, and removes the key", () => {
    storage.setItem(KEY("bad"), "{not json");
    storage.setItem(KEY("future"), JSON.stringify({ v: 2, reviewId: "future", taskId: null, project: "p", updatedAt: NOW, reject: false, chosen: [], comment: "x", answers: [] }));
    storage.setItem(KEY("shape"), JSON.stringify({ v: 1, reviewId: "shape", taskId: null, project: "p", updatedAt: NOW, reject: "yes", chosen: [], comment: "x", answers: [] }));
    storage.setItem(KEY("other"), JSON.stringify({ v: 1, reviewId: "someone-else", taskId: null, project: "p", updatedAt: NOW, reject: false, chosen: [], comment: "x", answers: [] }));
    reloadDecisionDraftsForTests();
    for (const id of ["bad", "future", "shape", "other"]) expect(currentDecisionDraft(round(id))).toEqual(initialDraft(round(id)));
    for (const id of ["bad", "future", "shape", "other"]) expect(storage.getItem(KEY(id))).toBeNull();
  });

  test("a storage that refuses writes keeps the draft in the page's memory", () => {
    storage.failWrites = true;
    const own = round("r1");
    saveDecisionDraft(own, typed("kept in memory"), NOW);
    expect(storage.items.size).toBe(0);
    expect(currentDecisionDraft(own).comment).toBe("kept in memory");
    forgetDecisionDraft("r1");
    expect(currentDecisionDraft(own).comment).toBe("");
  });

  test("is not applied to a round it does not fit", () => {
    const own = asking("r1");
    saveDecisionDraft(own, typed("words", { answers: [{ questionId: "when", options: [1] }] }), NOW);
    // Same id, other questions: the words stay, the answers fall back to the recommended ones.
    const changed = asking("r1", { questions: [{ id: "where", text: "Where?", options: [{ label: "Here", recommended: true }, { label: "There" }] }] });
    expect(currentDecisionDraft(changed)).toEqual({ reject: false, chosen: [], comment: "words", answers: [{ questionId: "where", options: [0] }] });
    // An option index past the round's options.
    saveDecisionDraft(own, typed("words", { answers: [{ questionId: "when", options: [5] }] }), NOW);
    expect(currentDecisionDraft(own).answers).toEqual([{ questionId: "when", options: [0] }]);
    // Variants the round does not have, and a rejection where there are no variants.
    saveDecisionDraft(round("r2"), typed("v", { chosen: [1, 9] }), NOW);
    expect(currentDecisionDraft(round("r2", { variants: round("x").variants.slice(0, 1) })).chosen).toEqual([1]);
    saveDecisionDraft(round("r3"), typed("r", { reject: true }), NOW);
    expect(currentDecisionDraft(round("r3", { variants: [] })).reject).toBe(false);
    // A decided round shows no draft.
    const decided = round("r2", { decision: { chosen: [1], comment: "", at: NOW.toString(), delivery: { state: "sent", retryable: false } } });
    expect(currentDecisionDraft(decided)).toEqual(initialDraft(decided));
  });
});

describe("reconciling with a read that succeeded", () => {
  test("a task's read drops its drafts for rounds that are decided or gone, and keeps the others", () => {
    saveDecisionDraft(round("waiting"), typed("w"), NOW);
    saveDecisionDraft(round("decided"), typed("d"), NOW);
    saveDecisionDraft(round("gone"), typed("g"), NOW);
    saveDecisionDraft(round("elsewhere", { taskId: "task-2" }), typed("e"), NOW);
    saveDecisionDraft(asking("seat", { taskId: null }), typed("s", { answers: [{ questionId: "when", options: [1] }] }), NOW);
    reconcileTaskDrafts("task-1", [{ id: "waiting" }, { id: "decided", decision: { chosen: [1], comment: "", at: "", delivery: { state: "sent", retryable: false } } }] as never);
    expect(storage.getItem(KEY("waiting"))).not.toBeNull();
    expect(storage.getItem(KEY("decided"))).toBeNull();
    expect(storage.getItem(KEY("gone"))).toBeNull();
    expect(storage.getItem(KEY("elsewhere"))).not.toBeNull();
    expect(storage.getItem(KEY("seat"))).not.toBeNull();
  });

  test("a project's read drops the seat's drafts for rounds no longer listed, and never a task's draft for being absent", () => {
    const answer = { answers: [{ questionId: "when", options: [1] }] };
    saveDecisionDraft(asking("seat-open", { taskId: null }), typed("o", answer), NOW);
    saveDecisionDraft(asking("seat-gone", { taskId: null }), typed("g", answer), NOW);
    saveDecisionDraft(asking("seat-other-project", { taskId: null, project: "project-b" }), typed("p", answer), NOW);
    saveDecisionDraft(round("task-round"), typed("t"), NOW);
    reconcileSeatDrafts("project-a", [{ id: "seat-open" }] as never);
    expect(storage.getItem(KEY("seat-open"))).not.toBeNull();
    expect(storage.getItem(KEY("seat-gone"))).toBeNull();
    expect(storage.getItem(KEY("seat-other-project"))).not.toBeNull();
    expect(storage.getItem(KEY("task-round"))).not.toBeNull();
    reconcileSeatDrafts("project-a", [{ id: "task-round", decision: { chosen: [1], comment: "", at: "", delivery: { state: "sent", retryable: false } } }] as never);
    expect(storage.getItem(KEY("task-round"))).toBeNull();
  });
});
