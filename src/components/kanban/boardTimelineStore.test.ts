import { expect, test } from "bun:test";
import { BoardTimelineStore, earlierKey, earlierOpen, groupKey, groupOpen, parseTimelinePreference, timelineExpanded, TIMELINE_HOURS } from "./boardTimelineStore";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("live work starts expanded; explicit collapse survives a new store and later clocks", () => {
  const disk = storage();
  const first = new BoardTimelineStore("project-a", disk);
  expect(timelineExpanded(first.snapshot(), "task-a", true)).toBe(true);
  expect(timelineExpanded(first.snapshot(), "task-b", false)).toBe(false);
  first.update({ view: "timeline", hours: 6, expanded: { "task-a": false, "task-b": true } });
  const restarted = new BoardTimelineStore("project-a", disk);
  expect(restarted.snapshot()).toEqual(first.snapshot());
  expect(timelineExpanded(restarted.snapshot(), "task-a", true)).toBe(false);
  expect(timelineExpanded(restarted.snapshot(), "task-b", false)).toBe(true);
  expect(timelineExpanded(restarted.snapshot(), "new-task", true)).toBe(true);
  expect(new BoardTimelineStore("project-b", disk).snapshot()).toEqual({ view: "board", hours: 24, expanded: {} });
  restarted.update({ expanded: { ...restarted.snapshot().expanded, "task-a": true } });
  expect(timelineExpanded(new BoardTimelineStore("project-a", disk).snapshot(), "task-a", false)).toBe(true);
});

test("every zoom, view and fold writer output reloads without losing sibling choices", () => {
  const disk = storage();
  for (const view of ["board", "timeline"] as const) for (const hours of TIMELINE_HOURS) {
    const writer = new BoardTimelineStore("project-a", disk);
    writer.update({ view, hours, expanded: { first: false, second: true } });
    writer.update({ expanded: { ...writer.snapshot().expanded, third: false } });
    expect(new BoardTimelineStore("project-a", disk).snapshot()).toEqual({ view, hours, expanded: { first: false, second: true, third: false } });
  }
});

test("malformed and unsupported storage values retain valid independent fields", () => {
  for (const raw of [null, "{", "null", "42"]) expect(parseTimelinePreference(raw)).toEqual({ view: "board", hours: 24, expanded: {} });
  expect(parseTimelinePreference(JSON.stringify({ view: "timeline", hours: 7, expanded: { yes: true, no: false, bad: "true" } })))
    .toEqual({ view: "timeline", hours: 24, expanded: { yes: true, no: false } });
});

test("storage refusal preserves usable choices in the mounted store", () => {
  for (const disk of [null, { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } },
    { getItem() { return null; }, setItem() { throw new Error("full"); } }]) {
    const store = new BoardTimelineStore("project-a", disk);
    store.update({ view: "timeline", expanded: { first: false } });
    store.update({ hours: 168 });
    expect(store.snapshot()).toEqual({ view: "timeline", hours: 168, expanded: { first: false } });
  }
});

test("a storage update from another surface is read before the next local write", () => {
  const disk = storage();
  const desktop = new BoardTimelineStore("project-a", disk);
  const phone = new BoardTimelineStore("project-a", disk);
  desktop.update({ expanded: { first: false } });
  phone.update({ hours: 72 });
  expect(desktop.snapshot()).toEqual({ view: "board", hours: 72, expanded: { first: false } });
});

test("group folds share the task record, survive a write and a parse, and never collide with a task id", () => {
  const disk = storage();
  const writer = new BoardTimelineStore("project-a", disk);
  expect(groupOpen(writer.snapshot(), "needs-you")).toBe(false);
  writer.update({ expanded: { ...writer.snapshot().expanded, [groupKey("needs-you")]: true, [groupKey("still")]: true, "task-a": false } });
  const reader = new BoardTimelineStore("project-a", disk).snapshot();
  expect(groupOpen(reader, "needs-you")).toBe(true);
  expect(groupOpen(reader, "still")).toBe(true);
  expect(groupOpen(reader, "still-long")).toBe(false);
  expect(timelineExpanded(reader, "task-a", true)).toBe(false);
  expect(Object.keys(reader.expanded).filter(key => key.startsWith("group:")).sort()).toEqual(["group:needs-you", "group:still"]);
});

test("a task's fold of earlier stages is closed until opened, is kept per task, and does not touch the task's own expansion", () => {
  const disk = storage();
  const writer = new BoardTimelineStore("project-a", disk);
  expect(earlierOpen(writer.snapshot(), "task-a")).toBe(false);
  writer.update({ expanded: { ...writer.snapshot().expanded, [earlierKey("task-a")]: true } });
  const reader = new BoardTimelineStore("project-a", disk).snapshot();
  expect(earlierOpen(reader, "task-a")).toBe(true);
  expect(earlierOpen(reader, "task-b")).toBe(false);
  expect(timelineExpanded(reader, "task-a", true)).toBe(true);
  expect(timelineExpanded(reader, "task-a", false)).toBe(false);
});
