import { expect, test } from "bun:test";

import { renderPlain, renderReport, sectionLines } from "./reportRender";
import { renderTelegram } from "./telegramReport";

/* docs/design/orchestrator-reports.md §5.5: the compact Telegram copy. */

const cut = renderReport({
  class: "completed",
  deploy: true,
  name: "Delegatus",
  at: new Date("2026-09-25T18:45:00Z"),
  locale: "uk",
  timeZone: "Europe/Kyiv",
  summary: "Реліз 1.5.0 на проді; <b>npm</b> ще оновлює версію & тег.",
  sections: {
    prod: ["реліз 1.5.0 (#2221); прод відповідає 200"],
    inProgress: ["документ RRSI (#2222): змерджу, коли пройдуть перевірки", "DNS падав (#2220), повторю"],
  },
}).cut;

const PULL_REQUESTS = new Set([2221, 2222]);

test("line 1 is the emoji, the bold name and kind and the time; line 2 the summary; every section sits in one expandable quote", () => {
  const html = renderTelegram(cut, PULL_REQUESTS);
  const lines = html.split("\n");
  expect(lines[0]).toMatch(/^✅ <b>Delegatus · деплой<\/b> · 25\.09, 21:45 /);
  expect(lines[1]).toBe("Реліз 1.5.0 на проді; &lt;b&gt;npm&lt;/b&gt; ще оновлює версію &amp; тег.");
  expect(lines[2]).toBe("<blockquote expandable>✅ <b>На проді</b>");
  expect(html.match(/<blockquote/g)).toHaveLength(1);
  expect(html.endsWith("</blockquote>")).toBe(true);
  expect(html).toContain("\n\n🛠 <b>В роботі</b>\n• документ RRSI (PR 2222)");
});

test("no link and no URL is ever emitted; known pull requests read PR N and an issue stays #N", () => {
  const html = renderTelegram(cut, PULL_REQUESTS);
  expect(html).not.toContain("<a");
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).toContain("(PR 2221)");
  expect(html).toContain("(#2220)");
});

test("the Telegram copy lists exactly the items of the bridge copy, in the same order", () => {
  const plainItems = renderPlain(cut).split("\n").filter((line) => line.startsWith("• ")).map((line) => line.slice(2));
  const shown = cut.sections.flatMap((section) => sectionLines(section, cut.locale));
  expect(plainItems).toEqual(shown);
  const html = renderTelegram(cut, new Set());
  const htmlItems = html.split("\n").filter((line) => line.startsWith("• ")).map((line) => line.slice(2).replace("</blockquote>", "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  expect(htmlItems).toEqual(plainItems);
});
