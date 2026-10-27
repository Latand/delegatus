import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bridgeReportsSetting, codexCloudEnvironmentId, mergeOnReviewSetting, reportTelegramChoice, resetProjectSettingsForTests, setMergeOnReview, setReportTelegram } from "./settings";

let directory: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-settings-"));
  process.env.LLV_STATE_DIR = directory;
  resetProjectSettingsForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  resetProjectSettingsForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});

const NOW = "2026-10-01T00:00:00Z";

test("switches and report destinations are copied on every read and after writes", () => {
  setMergeOnReview("project", true, "operator", NOW);
  setReportTelegram("project", { chat: "team", name: "Widgets" }, "operator", NOW);
  const first = mergeOnReviewSetting("project");
  expect(mergeOnReviewSetting("project")).not.toBe(first);
  first.enabled = false;
  expect(mergeOnReviewSetting("project").enabled).toBe(true);
  const destination = reportTelegramChoice("project")!;
  expect(reportTelegramChoice("project")).not.toBe(destination);
  destination.chat = null;
  expect(reportTelegramChoice("project")?.chat).toBe("team");
});

test("absent, malformed and invalid entries retain the domain defaults and source", () => {
  expect(mergeOnReviewSetting("project")).toEqual({ enabled: false, changedAt: null, changedBy: null });
  expect(bridgeReportsSetting("project")).toEqual({ enabled: true, changedAt: null, changedBy: null });
  expect(reportTelegramChoice("project")).toBeNull();
  const file = path.join(directory, "project-settings.json");
  fs.writeFileSync(file, "{malformed");
  expect(mergeOnReviewSetting("project").enabled).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe("{malformed");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: {
    project: { mergeOnReview: { enabled: "yes" }, codexCloudEnvironmentId: 3 },
    valid: { mergeOnReview: { enabled: true, changedAt: NOW, changedBy: "operator" } },
  } }));
  expect(mergeOnReviewSetting("project").enabled).toBe(false);
  expect(codexCloudEnvironmentId("project")).toBe("");
  expect(mergeOnReviewSetting("valid").enabled).toBe(true);
});

test("a same-size same-mtime replacement changes settings without a reset", () => {
  const file = path.join(directory, "project-settings.json");
  const replacement = path.join(directory, "replacement.json");
  const body = (id: string) => JSON.stringify({ schemaVersion: 1, projects: { project: { codexCloudEnvironmentId: id } } });
  const stamp = new Date(NOW);
  fs.writeFileSync(file, body("cloud-a"));
  fs.utimesSync(file, stamp, stamp);
  expect(codexCloudEnvironmentId("project")).toBe("cloud-a");
  fs.writeFileSync(replacement, body("cloud-b"));
  fs.utimesSync(replacement, stamp, stamp);
  fs.renameSync(replacement, file);
  expect(codexCloudEnvironmentId("project")).toBe("cloud-b");
});
