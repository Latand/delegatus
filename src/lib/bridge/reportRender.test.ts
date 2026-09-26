import { expect, test } from "bun:test";

import { renderPlain, renderReport, REPORT_PLAIN_BUDGET_BYTES, type RenderReportInput } from "./reportRender";
import { bridgeReportBody } from "./store";
import { renderTelegram } from "./telegramReport";

/* docs/design/orchestrator-reports.md §3.2: one cut report, two renderings.
   Every text below is written for these tests. */

const AT = new Date("2026-09-25T18:45:00Z");

function render(overrides: Partial<RenderReportInput> = {}) {
  return renderReport({ class: "status", name: "Delegatus", at: AT, locale: "en", timeZone: "Europe/Kyiv", ...overrides });
}

test("the header carries the class emoji, the name, the kind and the local time; sections come in their fixed order", () => {
  const { cut, warnings, empty } = render({
    summary: "Two lanes running, nothing needed from you.",
    sections: { queued: ["find out why agent turns hang"], inProgress: ["the board's scroll speed"], decision: ["pick the next wave"], prod: ["release 1.5.0"], merged: ["the RRSI document (#2222)"] },
  });
  expect(empty).toBe(false);
  expect(warnings).toEqual([]);
  const lines = renderPlain(cut).split("\n");
  expect(lines[0]).toMatch(/^🕒 Delegatus · status · 25\/09, 21:45 /);
  expect(lines[1]).toBe("Two lanes running, nothing needed from you.");
  expect(lines.filter((line) => /^\S+ [A-Z]/.test(line) && !line.startsWith("•")).slice(1)).toEqual([
    "✅ On prod", "🔀 Merged, goes out with the next deploy", "🛠 In progress", "⏳ Next", "❓ Needs a decision",
  ]);
});

test("Ukrainian headings, kind words and date follow the interface language", () => {
  const { cut } = render({ class: "blocked", locale: "uk", deploy: true, summary: "Деплой зупинився на DNS.", sections: { decision: ["потрібно перезапустити сервіс"] } });
  const plain = renderPlain(cut);
  expect(plain.split("\n")[0]).toMatch(/^⛔ Delegatus · деплой · 25\.09, 21:45 /);
  expect(plain).toContain("❓ Чекає рішення\n• потрібно перезапустити сервіс");
});

test("with no interface language known, the headings are English; with no time zone, the host's is used", () => {
  const { cut } = render({ locale: null, timeZone: null, class: "question", summary: "Which wave next?", sections: { decision: ["pick one"] } });
  expect(renderPlain(cut)).toContain(" · question · ");
  expect(renderPlain(cut)).toContain("❓ Needs a decision");
});

test("without a summary the first item stands in, cut at a word at 120 characters", () => {
  const long = `${"word ".repeat(30)}end`;
  const { cut } = render({ sections: { inProgress: [long.slice(0, 190)] } });
  expect(cut.summary.length).toBeLessThanOrEqual(120);
  expect(cut.summary.endsWith("…")).toBe(true);
  expect(cut.summary).not.toMatch(/wor…$/);
});

test("an item over 200 characters is dropped whole, and a section's items past its limit become one count line", () => {
  const { cut, warnings } = render({
    summary: "Busy day.",
    sections: { queued: ["a", "b", "c", "d", "e", "f"], inProgress: ["x".repeat(201), "short"] },
  });
  const plain = renderPlain(cut);
  expect(plain).not.toContain("x".repeat(201));
  expect(plain).toContain("• short");
  expect(plain).toContain("⏳ Next\n• a\n• b\n• c\n• d\n• and 2 more");
  expect(warnings.some((warning) => warning.includes("over 200 characters"))).toBe(true);
});

test("a blocked or question report without a decision item is warned about, and machine ids in an item too", () => {
  expect(render({ class: "question", summary: "Which wave next?" }).warnings.some((warning) => warning.includes("decision section"))).toBe(true);
  expect(render({ summary: "ok", sections: { prod: ["deploy 1c41d3610c6f3b1e"] } }).warnings.some((warning) => warning.includes("machine ids"))).toBe(true);
});

const TITLE = (index: number) => `Задача номер ${index}: прокрутка великої дошки гальмує на телефоні`;

test("a Ukrainian deploy report with 3 in-progress items and 8 Done plus 8 New titles fits 1 900 bytes, cutting task titles first and nothing mid-text", () => {
  const inProgress = [
    "npm ще показує 1.4.0: публікація пройшла, реєстр не оновився; перевірю на наступному пробудженні",
    "документ RRSI (#2222): змерджу, коли пройдуть перевірки, і тоді оновлю дошку та журнал",
    "третя частина «Спершу оркестратор» (#2166): ревʼю, раунд 2, збирач виправляє два зауваження",
  ];
  const result = render({
    locale: "uk",
    class: "completed",
    deploy: true,
    summary: "Реліз 1.5.0 на проді; npm ще оновлює версію.",
    sections: { prod: ["реліз 1.5.0: тег v1.5.0 і реліз на GitHub, у CHANGELOG 34 PR після 1.4.0 (#2221); прод відповідає 200"], inProgress },
    taskChanges: {
      groups: {
        done: Array.from({ length: 8 }, (_, index) => TITLE(index)),
        created: Array.from({ length: 8 }, (_, index) => TITLE(index + 100)),
      },
      notOnProdYet: false,
    },
  });
  const plain = renderPlain(result.cut);
  expect(Buffer.byteLength(plain, "utf8")).toBeLessThanOrEqual(REPORT_PLAIN_BUDGET_BYTES);
  /* The store keeps it whole: no "…" is added. */
  expect(bridgeReportBody(plain)).toBe(plain);
  /* Every in-progress item survived: the task groups gave way first. */
  for (const item of inProgress) expect(plain).toContain(`• ${item}`);
  const tasks = result.cut.sections.find((section) => section.id === "tasks")!;
  expect(tasks.groups!.every((group) => group.titles.length < 6)).toBe(true);
  /* Nothing is cut mid-text: every title shown is one of the originals. */
  const originals = new Set([...Array.from({ length: 8 }, (_, index) => TITLE(index)), ...Array.from({ length: 8 }, (_, index) => TITLE(index + 100))]);
  for (const group of tasks.groups!) for (const title of group.titles) expect(originals.has(title)).toBe(true);
  expect(plain).toMatch(/Готово: .*; і ще \d+/);
  /* The Telegram copy lists exactly the same items. */
  const html = renderTelegram(result.cut);
  for (const item of inProgress) expect(html).toContain(item.replace(/</g, "&lt;"));
  for (const group of tasks.groups!) for (const title of group.titles) expect(html).toContain(title);
  expect(result.warnings.some((warning) => warning.includes("cut to fit"))).toBe(true);
});

test("the decision section and the summary survive the tightest cut", () => {
  const filler = (prefix: string) => Array.from({ length: 6 }, (_, index) => `${prefix} ${index}: ${"довгий опис роботи ".repeat(9).trim()}`.slice(0, 199));
  const decision = ["перше рішення, яке потрібне від тебе сьогодні", "друге рішення", "третє рішення"];
  const result = render({
    locale: "uk",
    class: "blocked",
    summary: "Потрібні три рішення, поки все інше чекає.",
    sections: { prod: filler("прод"), merged: filler("змерджено"), inProgress: filler("в роботі"), queued: filler("далі").slice(0, 4), decision },
  });
  const plain = renderPlain(result.cut);
  expect(Buffer.byteLength(plain, "utf8")).toBeLessThanOrEqual(REPORT_PLAIN_BUDGET_BYTES);
  expect(plain.split("\n")[1]).toBe("Потрібні три рішення, поки все інше чекає.");
  for (const item of decision) expect(plain).toContain(`• ${item}`);
  expect(plain).toContain("• і ще");
});

test("a report whose only content was private is empty, and the classes are counted", () => {
  const result = render({ summary: "", sections: { prod: ["the build reads /home/someone/checkout"] } });
  expect(result.empty).toBe(true);
  expect(result.dropped).toEqual({ path: 1 });
});

test("a summary with private information is replaced by the first remaining item", () => {
  const result = render({ summary: "deploy on localhost:8898 passed", sections: { prod: ["release 1.5.0 on prod"] } });
  expect(result.cut.summary).toBe("release 1.5.0 on prod");
  expect(result.warnings.some((warning) => warning.includes("summary carried private information"))).toBe(true);
});

test("a failed deploy's task changes are headed as not on prod yet; hidden titles are counted", () => {
  const { cut } = render({
    class: "failed",
    deploy: true,
    summary: "The deploy failed.",
    taskChanges: { groups: { done: ["A task title", "Title naming /home/x/y"] }, notOnProdYet: true },
    deny: { accounts: [], people: [], local: [], projects: [] },
  });
  expect(renderPlain(cut)).toContain("📋 Tasks since the previous deploy (not on prod yet)\n• Done: A task title (1 hidden)");
});
