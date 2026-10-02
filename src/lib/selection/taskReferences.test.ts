import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_SELECTED_TASKS,
  MAX_TASK_TITLE_CHARS,
  captureSelectedContext,
  decodeSelectedContextRef,
  encodeSelectedContextRef,
  parseSelectedContextRef,
  stripTaskReferenceLines,
  stripTaskReferencePrelude,
  taskChipTitle,
  taskReferencePrelude,
  taskReferencesFromText,
  withSelectedTasks,
  type SelectedContextRef,
} from "./selectedContext";
import { decodeCodexStructuredUserText, encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";

/**
 * The task reference an operator's chip carries to the orchestrator seat: a
 * list of `{ id, title }` on the same record the selected card rides, so the
 * channel the seat already reads for context names tasks as well as
 * conversations. A conversation reference without tasks must stay exactly what
 * it was.
 */

const AT = "2026-10-02T09:00:00.000Z";
const TASK_A = ["11111111", "2222", "4333", "8444", "555555555555"].join("-");
const TASK_B = ["66666666", "7777", "4888", "8999", "000000000000"].join("-");

const CARDS = [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: "conversation_atlas_a", project: "atlas", label: "Worker A" }];

function selected(): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: CARDS[0].path, selectedPaths: [CARDS[0].path] },
    cards: CARDS,
    identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
    revision: 1,
    now: Date.parse(AT),
  });
}

function none(): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: null,
    revision: null,
    now: Date.parse(AT),
  });
}

let directory: string;
let previous: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "task-references-"));
  previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

test("tasks ride beside a selected conversation without touching its identity", () => {
  const ref = withSelectedTasks(selected(), [{ id: TASK_A, title: "Fix the mobile board" }]);
  expect(ref).toMatchObject({ state: "selected", conversationId: "conversation_atlas_a", tasks: [{ id: TASK_A, title: "Fix the mobile board" }] });
  expect(parseSelectedContextRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
});

test("tasks also ride an explicit empty selection", () => {
  const ref = withSelectedTasks(none(), [{ id: TASK_A, title: "Fix the mobile board" }, { id: TASK_B, title: "Second" }]);
  expect(ref.state).toBe("none");
  expect(parseSelectedContextRef(ref)).toEqual(ref);
  expect(decodeSelectedContextRef(encodeSelectedContextRef(ref))).toEqual(ref);
});

test("a reference with no tasks is byte-identical to the one written before tasks existed", () => {
  const before = selected();
  expect(withSelectedTasks(before, [])).toEqual(before);
  expect(withSelectedTasks(before, undefined)).toEqual(before);
  expect("tasks" in parseSelectedContextRef(before)!).toBe(false);
  expect(decodeSelectedContextRef(encodeSelectedContextRef(before))).toEqual(before);
});

test("tasks are validated: bad ids drop, duplicates collapse, titles and the list are bounded", () => {
  const long = "x".repeat(MAX_TASK_TITLE_CHARS + 40);
  const many = Array.from({ length: MAX_SELECTED_TASKS + 5 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}` }));
  const ref = parseSelectedContextRef({
    ...selected(),
    tasks: [
      { id: TASK_A, title: "Keep\u0007me" },
      { id: TASK_A, title: "Duplicate" },
      { id: "has space", title: "Bad id" },
      { id: 42, title: "Not a string" },
      { id: TASK_B, title: long },
      ...many,
    ],
  });
  const tasks = (ref as { tasks?: { id: string; title: string }[] }).tasks!;
  expect(tasks).toHaveLength(MAX_SELECTED_TASKS);
  expect(tasks[0]).toEqual({ id: TASK_A, title: "Keep me" });
  expect(tasks[1]!.title).toHaveLength(MAX_TASK_TITLE_CHARS);
  expect(tasks.some((task) => task.id === "has space")).toBe(false);
});

test("a malformed tasks field costs only the tasks, never the conversation reference", () => {
  const ref = parseSelectedContextRef({ ...selected(), tasks: "nope" });
  expect(ref).toMatchObject({ state: "selected", conversationId: "conversation_atlas_a" });
  expect("tasks" in ref!).toBe(false);
});

test("the seat reads one plain line per task, and the history row can take them back off the text", () => {
  const tasks = [{ id: TASK_A, title: "Fix the mobile board" }, { id: TASK_B, title: 'Say "hi"' }];
  const prelude = taskReferencePrelude(tasks);
  const lines = prelude.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain(TASK_A);
  expect(lines[0]).toContain("Fix the mobile board");
  expect(lines[1]).toContain(TASK_B);
  expect(lines[0]).toContain("get_task");
  expect(taskReferencePrelude([])).toBe("");
  expect(stripTaskReferencePrelude(`${prelude}\nstart this one`, tasks)).toBe("start this one");
  expect(stripTaskReferencePrelude(`[viewer context — x]\n${prelude}\nstart this one`, tasks)).toBe("[viewer context — x]\nstart this one");
  /* Only the exact lines go; a message that merely mentions a task id stays whole. */
  expect(stripTaskReferencePrelude(`look at ${TASK_A}`, tasks)).toBe(`look at ${TASK_A}`);
  expect(stripTaskReferencePrelude("plain", undefined)).toBe("plain");
});

test("the task reference survives delivery: the durable record the seat's turn names returns it", () => {
  const ref = withSelectedTasks(selected(), [{ id: TASK_A, title: "Fix the mobile board" }]);
  const text = `${taskReferencePrelude(ref.tasks)}\nStart this one.`;
  const wire = encodeCodexStructuredUserText(text, undefined, ref, { kind: "operator" }, "a".repeat(64));
  expect(wire.split("\n")[0]).toMatch(/^<!-- llv:structured-user ctx=\S+ -->$/);
  /* The marker is a handle; the typed reference lives on the record behind it. */
  expect(wire.split("\n")[0]).not.toContain(TASK_A);
  const decoded = decodeCodexStructuredUserText(wire);
  expect(decoded.selectedContext).toEqual(ref);
  expect(decoded.selectedContext?.state === "selected" && decoded.selectedContext.conversationId).toBe("conversation_atlas_a");
  expect(decoded.text).toContain(TASK_A);
});

test("a conversation-only reference still delivers and decodes as before", () => {
  const ref = selected();
  const wire = encodeCodexStructuredUserText("Look at that one.", undefined, ref, { kind: "operator" }, "b".repeat(64));
  expect(decodeCodexStructuredUserText(wire).selectedContext).toEqual(ref);
});

const IDENTIFIER_TITLE = "request_attention: the target blinks, intent open opens the conversation (#1696) in __init__.py";

test("a chip's title keeps identifiers: `_` and `#` reach the reference line, the record and the history", () => {
  const title = taskChipTitle(IDENTIFIER_TITLE);
  expect(title).toBe(IDENTIFIER_TITLE.slice(0, MAX_TASK_TITLE_CHARS).trim());
  expect(title).toContain("request_attention");
  expect(title).toContain("#1696".slice(0, 1));
  const ref = withSelectedTasks(selected(), [{ id: TASK_A, title }]);
  expect(ref.tasks).toEqual([{ id: TASK_A, title }]);
  const prelude = taskReferencePrelude(ref.tasks);
  expect(prelude).toContain("request_attention");
  const wire = encodeCodexStructuredUserText(`${prelude}\nstart`, undefined, ref, { kind: "operator" }, "c".repeat(64));
  expect(decodeCodexStructuredUserText(wire).selectedContext?.tasks).toEqual([{ id: TASK_A, title }]);
  expect(taskChipTitle("Fix __init__.py and my_var")).toBe("Fix __init__.py and my_var");
});

test("the chip title is capped once, and the same card text gives the same title everywhere", () => {
  const long = `${"word_".repeat(40)}#9`;
  const title = taskChipTitle(long);
  expect([...title]).toHaveLength(MAX_TASK_TITLE_CHARS);
  /* The wire's own bound leaves an already-capped title as it is. */
  expect(withSelectedTasks(selected(), [{ id: TASK_A, title }]).tasks).toEqual([{ id: TASK_A, title }]);
  expect(taskChipTitle(`  spaced\ttitle\n`)).toBe("spaced title");
  expect(taskChipTitle("   ")).toBe("");
});

test("a receipt that holds only the wire text shows the operator's words: reference lines go, nothing else", () => {
  const prelude = taskReferencePrelude([
    { id: TASK_A, title: IDENTIFIER_TITLE },
    { id: TASK_B, title: 'He said "go" \\ now' },
  ]);
  expect(stripTaskReferenceLines(`${prelude}\nstart this one`)).toBe("start this one");
  expect(stripTaskReferenceLines(`${prelude}\n[viewer context — x]\nstart`)).toBe("[viewer context — x]\nstart");
  expect(stripTaskReferenceLines("plain words")).toBe("plain words");
  expect(stripTaskReferenceLines(`look at [task reference — id ${TASK_A}] please`)).toBe(`look at [task reference — id ${TASK_A}] please`);
});


test("wire-only receipt recovery decodes quoted titles and bounds task references", () => {
  const tasks = [{ id: TASK_A, title: 'Fix "quoted" __init__.py (#42)' }, { id: TASK_B, title: "Second" }];
  const text = taskReferencePrelude(tasks) + "\nstart this one";
  expect(taskReferencesFromText(text)).toEqual(tasks);
  expect(taskReferencesFromText(text + "\n" + taskReferencePrelude(tasks))).toEqual(tasks);
  expect(taskReferencesFromText('[task reference — id bad/id, title "bad"; read it with get_task]')).toEqual([]);
  expect(taskReferencesFromText('[task reference — id valid, title "bad\\q"; read it with get_task]')).toEqual([]);
  expect(taskReferencesFromText(taskReferencePrelude(Array.from({ length: 10 }, (_, i) => ({ id: `task_${i}`, title: "Title" }))))).toHaveLength(MAX_SELECTED_TASKS);
});
