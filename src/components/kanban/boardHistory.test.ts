import { expect, test } from "bun:test";

import { BoardHistory, HISTORY_LIMIT, type HistoryEntry } from "./boardHistory";

/* The board's undo and redo stacks (#1856), on their own: no board, no writes. */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const move = (taskId: string, settled: Promise<boolean> = Promise.resolve(true)): HistoryEntry => ({ kind: "status", taskId, title: `Task ${taskId}`, from: "inbox", to: "done", settled });

test("undo takes the newest edit, redo takes back what undo took, and a new edit clears redo", () => {
  const history = new BoardHistory();
  const a = move("a");
  const b = move("b");
  history.record(a);
  history.record(b);
  expect(history.takeUndo()).toBe(b);
  history.pushRedo(b);
  expect(history.canRedo).toBe(true);
  expect(history.takeRedo()).toBe(b);
  history.pushUndo(b);
  history.pushRedo(history.takeUndo()!);
  history.record(move("c"));
  expect(history.canRedo).toBe(false);
  expect(history.entries().undo.map((entry) => entry.kind === "status" && entry.taskId)).toEqual(["a", "c"]);
});

test("an edit whose write did not save leaves the history", async () => {
  const history = new BoardHistory();
  history.record(move("a"));
  history.record(move("b", Promise.resolve(false)));
  await flush();
  expect(history.entries().undo.map((entry) => entry.kind === "status" && entry.taskId)).toEqual(["a"]);
});

test("the history keeps the newest fifty edits", () => {
  const history = new BoardHistory();
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) history.record(move(`t${index}`));
  const undo = history.entries().undo;
  expect(undo).toHaveLength(HISTORY_LIMIT);
  expect(undo[0]).toMatchObject({ taskId: "t5" });
  expect(undo.at(-1)).toMatchObject({ taskId: `t${HISTORY_LIMIT + 4}` });
});

test("a refused task leaves both stacks, and a bulk hide keeps its other tasks", () => {
  const history = new BoardHistory();
  const hide: HistoryEntry = { kind: "hide", text: "Hidden 2 idle tasks", tasks: [{ taskId: "a", title: "A" }, { taskId: "b", title: "B" }], settled: Promise.resolve(true) };
  history.record(move("a"));
  history.record(hide);
  history.pushRedo(move("a"));
  history.dropTask("a");
  expect(history.entries()).toEqual({ undo: [hide], redo: [] });
  expect(hide.kind === "hide" && hide.tasks.map((task) => task.taskId)).toEqual(["b"]);
  history.dropTask("b");
  expect(history.canUndo).toBe(false);
});

test("the epoch moves with every recorded edit and with nothing else", () => {
  const history = new BoardHistory();
  const a = move("a");
  const start = history.epoch;
  history.record(a);
  expect(history.epoch).toBe(start + 1);
  history.takeUndo();
  history.pushRedo(a);
  history.takeRedo();
  history.pushUndo(a);
  history.dropTask("a");
  expect(history.epoch).toBe(start + 1);
});
