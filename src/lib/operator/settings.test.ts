import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { operatorLocale, operatorTimeZone, readOperatorSettings, resetOperatorSettingsForTests, updateOperatorSettings } from "./settings";

/* docs/design/orchestrator-reports.md §4.2: one server-side operator setting
   the client writes, and every agent-facing surface reads. */

let sandbox = "";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-settings-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetOperatorSettingsForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("nothing is known until a client reports it", () => {
  expect(operatorLocale()).toBeNull();
  expect(operatorTimeZone()).toBeNull();
  expect(readOperatorSettings()).toEqual({ locale: null, timeZone: null });
});

test("a chosen language and a time zone are stored and read back", () => {
  updateOperatorSettings({ locale: "uk", source: "chosen", timeZone: "Europe/Kyiv" }, "2026-09-25T10:00:00.000Z");
  expect(operatorLocale()).toBe("uk");
  expect(operatorTimeZone()).toBe("Europe/Kyiv");
  expect(readOperatorSettings().locale).toEqual({ value: "uk", source: "chosen", changedAt: "2026-09-25T10:00:00.000Z" });
  expect(fs.statSync(path.join(sandbox, "operator-settings.json")).mode & 0o777).toBe(0o600);
});

test("a detected language never overwrites a chosen one, and a chosen one replaces a detected one", () => {
  updateOperatorSettings({ locale: "en", source: "detected" }, "2026-09-25T10:00:00.000Z");
  expect(operatorLocale()).toBe("en");
  updateOperatorSettings({ locale: "uk", source: "chosen" }, "2026-09-25T10:05:00.000Z");
  expect(operatorLocale()).toBe("uk");
  updateOperatorSettings({ locale: "en", source: "detected" }, "2026-09-25T10:10:00.000Z");
  expect(readOperatorSettings().locale).toEqual({ value: "uk", source: "chosen", changedAt: "2026-09-25T10:05:00.000Z" });
  /* The last choice wins, from any device. */
  updateOperatorSettings({ locale: "en", source: "chosen" }, "2026-09-25T10:15:00.000Z");
  expect(operatorLocale()).toBe("en");
});

test("a malformed file reads as nothing set", () => {
  fs.writeFileSync(path.join(sandbox, "operator-settings.json"), "{ not json");
  expect(operatorLocale()).toBeNull();
  fs.writeFileSync(path.join(sandbox, "operator-settings.json"), JSON.stringify({ schemaVersion: 1, locale: { value: "de", source: "chosen", changedAt: "x" } }));
  resetOperatorSettingsForTests();
  expect(operatorLocale()).toBeNull();
});
