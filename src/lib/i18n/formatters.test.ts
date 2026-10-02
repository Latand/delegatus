import { expect, spyOn, test } from "bun:test";

import { hhmm } from "@/components/utils";
import { entryTime } from "@/components/orchestrator/reportLog/reportLogModel";

import { translate } from "./core";
import { setLocale } from "./index";

test("repeated plural translations reuse a formatter and preserve both locales", () => {
  const Original = Intl.PluralRules;
  const replacement = Object.assign(function (...args: ConstructorParameters<typeof Intl.PluralRules>) {
    return new Original(...args);
  }, { supportedLocalesOf: Original.supportedLocalesOf });
  const spy = spyOn(Intl, "PluralRules").mockImplementation(replacement as typeof Intl.PluralRules);
  try {
    for (let i = 0; i < 10; i++) {
      expect(translate("en", "kanban.loopRest", { from: "Review", to: "Fix", count: 1 })).toEndWith("1 round");
      expect(translate("uk", "kanban.loopRest", { from: "Review", to: "Fix", count: 21 })).toEndWith("21 раунду");
    }
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  } finally { spy.mockRestore(); }
});

test("feed timestamps reuse locale formatters with the same clock output", () => {
  const date = new Date("2026-10-02T13:04:05Z");
  const expected = { en: date.toLocaleTimeString("en-US", { hour12: false }), uk: date.toLocaleTimeString("uk-UA", { hour12: false }) };
  const spy = spyOn(Date.prototype, "toLocaleTimeString");
  const formats = spyOn(Intl, "DateTimeFormat");
  try {
    for (let i = 0; i < 10; i++) {
      for (const locale of ["en", "uk"] as const) {
        setLocale(locale);
        expect(hhmm(date.toISOString())).toBe(expected[locale]);
      }
    }
    expect(hhmm("invalid")).toBe("");
    expect(spy.mock.calls.length).toBe(0);
    expect(formats.mock.calls.length).toBeLessThanOrEqual(2);
  } finally { spy.mockRestore(); formats.mockRestore(); setLocale("en"); }
});

test("report times reuse formatters across day and year boundaries without changing output", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const dates = [now, new Date("2026-10-01T12:00:00Z"), new Date("2025-10-02T12:00:00Z")];
  const expected = new Map<string, string>();
  for (const locale of ["en-US", "uk-UA"]) for (const date of dates) {
    const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) }).format(date);
    expected.set(locale + date.toISOString(), date === now ? clock : `${day} ${clock}`);
  }
  const spy = spyOn(Intl, "DateTimeFormat");
  try {
    for (let i = 0; i < 10; i++) for (const locale of ["en-US", "uk-UA"]) for (const date of dates) {
      expect(entryTime(date.toISOString(), locale, now)).toBe(expected.get(locale + date.toISOString())!);
    }
    expect(entryTime("invalid", "en-US", now)).toBe("");
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
  } finally { spy.mockRestore(); }
});
