import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import { formatDue } from "@/lib/tasks/helpers";

import { hasTaskMeta, TaskMeta } from "./TaskMeta";

/*
 * The task's deadline and image count on the kanban card: the two facts the
 * old Tasks panel alone drew, in its own wording (`formatDue`, «📎 N»), with
 * the overdue state said in words as well as ink.
 */

const NOW = Date.parse("2026-10-12T12:00:00Z");
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const images = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `attachments/tasks/${index}.png` })) as never;

test("a deadline ahead reads as the panel wrote it, in the zone it was set in, and the images as «📎 N»", () => {
  const task = { dueAt: "2026-10-14T09:30:00Z", dueTz: "Europe/Kyiv", attachments: images(3) };
  const markup = renderToStaticMarkup(<TaskMeta task={task} nowMs={NOW} />);
  expect(text(markup)).toBe(`⏰ ${formatDue(task.dueAt, task.dueTz, "en")}📎 3`);
  expect(markup).toContain('data-task-due="due"');
  expect(markup).toContain(`title="${translate("en", "cardState.images", { count: 3 })}"`);
  expect(markup).toContain(`title="${translate("en", "cardState.dueTitle", { zone: "Europe/Kyiv" })}"`);
});

test("a deadline that passed says so in words as well as ink, on a 24-hour clock", () => {
  const task = { dueAt: "2026-10-11T09:30:00Z", dueTz: "Europe/Kyiv" };
  const markup = renderToStaticMarkup(<TaskMeta task={task} nowMs={NOW} />);
  expect(markup).toContain('data-task-due="overdue"');
  expect(text(markup)).toBe(`⏰ ${formatDue(task.dueAt, task.dueTz, "en")} · ${translate("en", "cardState.overdue")}`);
  expect(text(markup)).toContain("12:30");
  expect(text(markup)).not.toMatch(/AM|PM/);
});

test("a task with neither draws nothing", () => {
  expect(hasTaskMeta({})).toBe(false);
  expect(hasTaskMeta({ attachments: [] })).toBe(false);
  expect(hasTaskMeta({ dueAt: "2026-10-14T09:30:00Z" })).toBe(false);
  expect(hasTaskMeta({ attachments: images(1) })).toBe(true);
  expect(renderToStaticMarkup(<TaskMeta task={{}} nowMs={NOW} />)).toBe("");
});
