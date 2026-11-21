import { expect, test } from "bun:test";
import { publicationLanguageHints, publicationSummary, publicationTitle } from "./publicationLanguage";

test("title overrides and English board titles retain their meaning", () => {
  expect(publicationTitle("Виправити публікацію", "", "Fix publication text")).toBe("Fix publication text");
  expect(publicationTitle("Fix publication text\nDetails")).toBe("Fix publication text");
  expect(publicationTitle("Виправити публікацію", "Keep public reports in English\nPassed checks.")).toBe("Keep public reports in English");
  expect(publicationTitle("修复发布", "Зміни готові")).toBe("Implement project changes");
  expect(publicationTitle("", "")).toBe("Implement project changes");
  expect(publicationTitle("a".repeat(121))).toHaveLength(120);
});

test("body composition keeps English reports and omits foreign prose", () => {
  expect(publicationSummary("Implemented publication titles.\nChecks passed.")).toBe("Implemented publication titles.\nChecks passed.");
  expect(publicationSummary("Готово")).not.toContain("Готово");
  expect(publicationSummary("Done.\nЗмінено заголовок")).not.toContain("Змінено");
  expect(publicationSummary("")).toContain("committed changes");
});

test("the advisory guard detects individual short and mixed lines across scripts", () => {
  expect(publicationLanguageHints("title", "Fix the board — готово")).toEqual([{ part: "title", line: 1 }]);
  expect(publicationLanguageHints("body", "English\nГотово\n修复发布\nتقرير")).toEqual([
    { part: "body", line: 2 }, { part: "body", line: 3 }, { part: "body", line: 4 },
  ]);
  expect(publicationLanguageHints("body", "Café controls pass.")).toEqual([]);
  expect(publicationLanguageHints("body", Array(100).fill("Готово").join("\n"))).toHaveLength(20);
});

test("code, links and quoted UI labels keep their source language and line numbers", () => {
  const report = 'Use `готово` and «Завершити».\n```ts\nconst text = "Готово";\n```\nSee [Довідка](https://example.invalid/довідка).\nГотово';
  expect(publicationLanguageHints("body", report)).toEqual([{ part: "body", line: 6 }]);
  expect(publicationLanguageHints("body", 'The label is "Готово" or “Завершити”.')).toEqual([]);
});
