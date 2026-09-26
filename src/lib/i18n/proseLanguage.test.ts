import { expect, test } from "bun:test";

import { languageMismatchWarning, proseLanguage } from "./proseLanguage";

/* Shapes seen in the report log (docs/design/orchestrator-reports.md §1.1,
   §1.6): the same seat wrote Russian, Ukrainian and English reports in one day,
   with code spans, #refs, shas and quoted UI labels mixed in. The texts are
   written for this table; none is a real report. */
const TABLE: readonly [string, "en" | "uk" | "ru" | null][] = [
  ["Release 1.5.0 is on prod; the deploy of 1c41d361 passed and prod answers 200.", "en"],
  ["Реліз 1.5.0 на проді, деплой 1c41d361 пройшов, прод відповідає 200, npm ще оновлюється.", "uk"],
  ["Релиз 1.5.0 на проде, деплой 1c41d361 прошёл, прод отвечает 200, npm ещё обновляется.", "ru"],
  /* A Ukrainian sentence quoting an English UI label and a code span is still Ukrainian. */
  ["Кнопка \"Merge when the review passes\" тепер вмикається в `settings`, а лейн #2187 завершився успішно.", "uk"],
  /* An English sentence around a quoted Ukrainian label stays English. */
  ["The toggle now reads «Змерджено» in the header and the lane for #2214 finished cleanly today.", "en"],
  /* Too short to say anything. */
  ["deploy ok", null],
  ["Готово.", null],
  /* Half and half says nothing. */
  ["The deploy passed and everything works fine. Деплой пройшов і все працює добре.", null],
  /* Hex ids, links and #refs alone are not prose. */
  ["1c41d361 5064e5ec #2221 #2222 https://example.invalid/pull/2222 `bun test`", null],
];

test.each(TABLE)("%p reads as %p", (text, language) => {
  expect(proseLanguage(text)).toBe(language);
});

test("the mismatch warning names both languages, and says nothing on a match, an unknown text or an unknown interface", () => {
  const english = "Release 1.5.0 is on prod; the deploy of 1c41d361 passed and prod answers 200.";
  expect(languageMismatchWarning("report", english, "uk")).toBe("This report reads as English; the operator's interface is Ukrainian. Write it in Ukrainian.");
  expect(languageMismatchWarning("report", english, "en")).toBeNull();
  expect(languageMismatchWarning("report", "deploy ok", "uk")).toBeNull();
  expect(languageMismatchWarning("report", english, null)).toBeNull();
});
