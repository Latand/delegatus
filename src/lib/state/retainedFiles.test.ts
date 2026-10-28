import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { operatorLocale, resetOperatorSettingsForTests, updateOperatorSettings } from "../operator/settings";
import { mergeOnReviewEnabled, resetProjectSettingsForTests, setMergeOnReview } from "../projects/settings";
import { atomicWrite } from "../links/state";

let directory: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "retained-files-"));
  process.env.LLV_STATE_DIR = directory;
  resetOperatorSettingsForTests();
  resetProjectSettingsForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

for (const failure of ["file", "directory"] as const) {
  test.skipIf(failure === "directory" && process.platform === "win32")(`retained writers report ${failure} flush failure and preserve published state`, () => {
    expect(updateOperatorSettings({ locale: "en", source: "chosen" })).not.toBeNull();
    expect(setMergeOnReview("project", false, "operator")).not.toBeNull();
    const link = path.join(directory, "links", "shared.json");
    atomicWrite(link, { v: 1, all: false, projects: [] });
    const open = fs.openSync;
    const opened = new Map<number, string>();
    const openSpy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
      const fd = open(...args);
      opened.set(fd, String(args[0]));
      return fd;
    }) as typeof open);
    const flush = fs.fsyncSync;
    const spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (failure === "directory" ? fs.fstatSync(fd).isDirectory() : opened.get(fd)?.endsWith(".tmp")) throw new Error("flush refused");
      flush(fd);
    });
    try {
      expect(updateOperatorSettings({ locale: "uk", source: "chosen" })).toBeNull();
      expect(setMergeOnReview("project", true, "operator")).toBeNull();
      expect(() => atomicWrite(link, { v: 1, all: true, projects: [] })).toThrow("flush refused");
    } finally {
      spy.mockRestore();
      openSpy.mockRestore();
    }
    expect(operatorLocale()).toBe(failure === "directory" ? "uk" : "en");
    expect(mergeOnReviewEnabled("project")).toBe(failure === "directory");
    expect(fs.readFileSync(link, "utf8")).toBe(`{"v":1,"all":${failure === "directory"},"projects":[]}\n`);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(fs.readdirSync(path.dirname(link))).toEqual(["shared.json"]);
  });
}

test("successful retained writes invalidate settings caches and keep private modes and serializers", () => {
  expect(operatorLocale()).toBeNull();
  expect(mergeOnReviewEnabled("project")).toBe(false);
  expect(updateOperatorSettings({ locale: "uk", source: "chosen" })).not.toBeNull();
  expect(setMergeOnReview("project", true, "operator")).not.toBeNull();
  expect(operatorLocale()).toBe("uk");
  expect(mergeOnReviewEnabled("project")).toBe(true);
  atomicWrite(path.join(directory, "links", "shared.json"), { v: 1 });
  for (const name of ["operator-settings.json", "project-settings.json", "links/shared.json"]) {
    expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
  }
  expect(fs.statSync(path.join(directory, "links")).mode & 0o777).toBe(0o700);
  expect(fs.readFileSync(path.join(directory, "operator-settings.json"), "utf8")).toContain('\n  "schemaVersion": 1,\n');
});
