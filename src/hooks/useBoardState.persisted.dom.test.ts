/**
 * Persisted boards (#2071, docs/design/skeletons-and-transitions.md D5).
 *
 * The session cache of confirmed boards (#172) only lived for one document,
 * so every cold start held the board's skeleton for a second round trip. The
 * last confirmed boards of the six most recent projects now survive in
 * `localStorage`; a new document paints one at once as `cached`, and its GET
 * confirms or replaces it. `loaded` still means "confirmed in this document",
 * so the reviewer auto-close and every other writer keeps waiting for it.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import type { BoardProjectStateV1 } from "@/lib/view/types";

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const saved = { window: G.window, localStorage: G.localStorage };
beforeAll(() => {
  G.window = dom;
  G.localStorage = dom.localStorage;
});
afterAll(() => {
  G.window = saved.window;
  G.localStorage = saved.localStorage;
});

const { createBoardStore, EMPTY_BOARD_PREFS, PERSISTED_BOARDS_KEY, persistedBoard, resetPendingOpensForTest } = await import("./useBoardState");

const settle = async () => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};
const boardOf = (revision: number, manual: string[] = []): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  explicitManual: manual,
  prefs: { ...EMPTY_BOARD_PREFS, manual },
});
const answering = (board: BoardProjectStateV1) => async () => ({ ok: true, status: 200, json: async () => ({ board }) });
const inert = { setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval() {}, setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimeout() {} };

/** A new document: the session cache is gone, the browser's storage is not. */
function newDocument(): void {
  const kept = dom.localStorage.getItem(PERSISTED_BOARDS_KEY);
  resetPendingOpensForTest();
  if (kept !== null) dom.localStorage.setItem(PERSISTED_BOARDS_KEY, kept);
}

beforeEach(() => {
  resetPendingOpensForTest();
  dom.localStorage.clear();
});

test("a confirmed board is kept for the next document, which paints it as cached until its GET confirms", async () => {
  const first = createBoardStore({ project: "atlas", fetcher: answering(boardOf(3, ["/sessions/alpha.jsonl"])), storage: null, scheduler: inert });
  await settle();
  expect(first.getSnapshot().loaded).toBe(true);
  expect(persistedBoard("atlas")?.revision).toBe(3);
  first.dispose();

  newDocument();
  let answer!: (value: { ok: boolean; status: number; json(): Promise<unknown> }) => void;
  const second = createBoardStore({
    project: "atlas",
    fetcher: () => new Promise((resolve) => { answer = resolve; }),
    storage: null,
    scheduler: inert,
  });
  const cached = second.getSnapshot();
  expect(cached.cached).toBe(true);
  expect(cached.loaded).toBe(false);
  expect(cached.prefs.manual).toEqual(["/sessions/alpha.jsonl"]);
  expect(cached.revision).toBe(3);
  answer({ ok: true, status: 200, json: async () => ({ board: boardOf(4, ["/sessions/alpha.jsonl", "/sessions/beta.jsonl"]) }) });
  await settle();
  const confirmed = second.getSnapshot();
  expect(confirmed.loaded).toBe(true);
  expect(confirmed.cached).toBe(false);
  expect(confirmed.prefs.manual).toEqual(["/sessions/alpha.jsonl", "/sessions/beta.jsonl"]);
  second.dispose();
});

test("a project never confirmed in this browser still starts unavailable", () => {
  const store = createBoardStore({ project: "never-seen", fetcher: () => new Promise(() => {}), storage: null, scheduler: inert });
  const snapshot = store.getSnapshot();
  expect(snapshot.loaded).toBe(false);
  expect(snapshot.cached).toBe(false);
  expect(snapshot.sync).toBe("unavailable");
  store.dispose();
});

test("only the six most recently confirmed projects are kept", async () => {
  for (let index = 0; index < 8; index += 1) {
    const store = createBoardStore({ project: `project-${index}`, fetcher: answering(boardOf(index + 1)), storage: null, scheduler: inert });
    await settle();
    store.dispose();
  }
  const kept = (JSON.parse(dom.localStorage.getItem(PERSISTED_BOARDS_KEY)!) as Array<[string, unknown]>).map(([project]) => project);
  expect(kept).toEqual(["project-7", "project-6", "project-5", "project-4", "project-3", "project-2"]);
  expect(persistedBoard("project-0")).toBeUndefined();
});
