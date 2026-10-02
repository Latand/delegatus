import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "@/lib/i18n";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.legacy.fixture";
import { captureSelectedContext, taskReferencePrelude, withSelectedTasks } from "@/lib/selection/selectedContext";

import { FeedItem } from "./FeedItem";
import { createFeedSession, type Item } from "./parse";

/**
 * The round trip that makes the badge evidence rather than decoration: what the
 * composer submitted, persisted onto the canonical structured-user record, read
 * back out of the transcript, and rendered by the SAME badge component.
 */

const REFERENCE = captureSelectedContext({
  context: { project: "atlas" },
  slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
  cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: "conversation_atlas_a", label: "Worker A" }],
  identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
  revision: 4,
  now: Date.parse("2026-07-31T09:00:00.000Z"),
});

function userItems(recordText: string): Item[] {
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  const line = JSON.stringify({
    timestamp: "2026-07-31T09:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: recordText }] },
  });
  return session.feed([line], 0, false).items.map((entry) => entry.item);
}

test("a persisted record's reference reaches the rendered user row", () => {
  const items = userItems(encodeCodexStructuredUserText("Look at that one.", undefined, REFERENCE));
  const user = items.find((item) => item.kind === "user");
  expect(user).toBeDefined();
  expect(user!.kind === "user" && user!.text).toBe("Look at that one.");
  expect(user!.kind === "user" && user!.selectedContext).toEqual(REFERENCE);
});

test("a record with no reference produces a row with none — nothing is invented", () => {
  const items = userItems(encodeCodexStructuredUserText("Look at that one."));
  const user = items.find((item) => item.kind === "user");
  expect(user!.kind === "user" && user!.selectedContext).toBeUndefined();
});

test("the transcript row renders the same badge the composer showed", () => {
  setLocale("en");
  const items = userItems(encodeCodexStructuredUserText("Look at that one.", undefined, REFERENCE));
  const user = items.find((item) => item.kind === "user")!;
  const html = renderToStaticMarkup(<FeedItem item={user} />);
  expect(html).toContain("Worker A");
  expect(html).toMatch(/aria-label="[^"]*Worker A[^"]*"/);
  expect(html).toContain("Look at that one.");
});

test("a row sent with an explicit empty selection carries the reference and shows no chip", () => {
  setLocale("en");
  const empty = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
    revision: 5,
    now: Date.parse("2026-07-31T09:00:00.000Z"),
  });
  const items = userItems(encodeCodexStructuredUserText("Anything running?", undefined, empty));
  const user = items.find((item) => item.kind === "user")!;
  /* The record still says the operator asked with nothing selected (#844) — the
     reference survives the round trip — while the row itself stays clean: a chip
     repeating that over every bare operator message is the noise of #1148. */
  expect(user.kind === "user" && user.selectedContext).toEqual(empty);
  const html = renderToStaticMarkup(<FeedItem item={user} />);
  expect(html).toContain("Anything running?");
  expect(html).not.toContain("data-selected-context");
  expect(html.toLowerCase()).not.toContain("nothing selected");
});

test("a row with no reference renders no badge markup at all", () => {
  setLocale("en");
  const items = userItems(encodeCodexStructuredUserText("Look at that one."));
  const user = items.find((item) => item.kind === "user")!;
  expect(renderToStaticMarkup(<FeedItem item={user} />)).not.toContain("data-selected-context");
});

/* Task chips (the card's «Ask» button): the references the operator attached
   come back out of the transcript record and render as chips in the history,
   while the plain lines the seat read are not shown a second time. */
const TASK_A = ["11111111", "2222", "4333", "8444", "555555555555"].join("-");
const TASK_B = ["66666666", "7777", "4888", "8999", "000000000000"].join("-");

test("a sent message with task chips shows them in the history and hides the seat's reference lines", () => {
  setLocale("en");
  const tasks = [{ id: TASK_A, title: "Fix the mobile board" }, { id: TASK_B, title: "Second task" }];
  const reference = withSelectedTasks(REFERENCE, tasks);
  const seatText = `${taskReferencePrelude(tasks)}\nStart these.`;
  const items = userItems(encodeCodexStructuredUserText(seatText, undefined, reference));
  const user = items.find((item) => item.kind === "user")!;
  expect(user.kind === "user" && user.selectedContext).toEqual(reference);
  const html = renderToStaticMarkup(<FeedItem item={user} />);
  expect(html).toContain(`data-task-badge="${TASK_A}"`);
  expect(html).toContain(`data-task-badge="${TASK_B}"`);
  expect(html).toContain("Fix the mobile board");
  expect(html).toContain("Start these.");
  expect(html).not.toContain("task reference");
  /* The conversation badge beside them still renders. */
  expect(html).toContain("Worker A");
});

test("task chips on a message sent with no selected conversation still render", () => {
  setLocale("en");
  const empty = captureSelectedContext({
    context: { project: "atlas" }, slice: { focusedPath: null, selectedPaths: [] }, cards: [], identity: null, revision: null,
    now: Date.parse("2026-07-31T09:00:00.000Z"),
  });
  const tasks = [{ id: TASK_A, title: "Fix the mobile board" }];
  const items = userItems(encodeCodexStructuredUserText(`${taskReferencePrelude(tasks)}\nStart this.`, undefined, withSelectedTasks(empty, tasks)));
  const html = renderToStaticMarkup(<FeedItem item={items.find((item) => item.kind === "user")!} />);
  expect(html).toContain(`data-task-badge="${TASK_A}"`);
  expect(html).not.toContain("data-selected-context");
});

test("a message whose text merely mentions a task id keeps its text whole", () => {
  setLocale("en");
  const items = userItems(encodeCodexStructuredUserText(`What happened to ${TASK_A}?`, undefined, REFERENCE));
  const html = renderToStaticMarkup(<FeedItem item={items.find((item) => item.kind === "user")!} />);
  expect(html).toContain(TASK_A);
  expect(html).not.toContain("data-task-badge");
});


for (const engine of ["codex", "claude"] as const) {
  test(`legacy ${engine} task references round-trip through authoritative transcript and clean badges`, () => {
    const refs = [{ id: TASK_A, title: "Fix __init__.py (#42)" }];
    const text = taskReferencePrelude(refs) + "\nstart this one";
    const session = createFeedSession({ engine, fmt: engine, showSvc: false, lineFilter: "" });
    const record = engine === "codex" ? { timestamp: "2026-10-02T09:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }
      : { type: "user", uuid: "legacy-task", timestamp: "2026-10-02T09:00:00.000Z", message: { role: "user", content: text } };
    const item = session.feed([JSON.stringify(record)], 0, false).items.find((row) => row.item.kind === "user")!.item;
    const html = renderToStaticMarkup(<FeedItem item={item} />);
    expect(html).toContain(`data-task-badge="${TASK_A}"`);
    expect(html).toContain("Fix __init__.py (#42)");
    expect(html).toContain("start this one");
    expect(html).not.toContain("task reference");
  });
}
