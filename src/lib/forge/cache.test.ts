import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyRepositoryEntry, forgeCacheView, readForgeCache, resetForgeCacheForTests, updateForgeCache } from "./cache";

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cache-"));
  file = path.join(directory, "forge-links.json");
  resetForgeCacheForTests();
});
afterEach(() => {
  resetForgeCacheForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});

function body(canonical = "acme/widgets"): string {
  return JSON.stringify({ schemaVersion: 1, repositories: { "acme/widgets": { ...emptyRepositoryEntry(), canonical } } });
}

test("warm reads reuse stored data, the indexed view and the outer result", () => {
  fs.writeFileSync(file, body());
  const first = readForgeCache(file);
  expect(readForgeCache(file)).toBe(first);
  expect(readForgeCache(file).data).toBe(first.data);
  expect(forgeCacheView(file)).toBe(first.view);
  expect(first.view.repository("acme/widgets")).toBe(first.view.repository("acme/widgets"));
});

test("the forge owner keeps its snapshot across module reloads", async () => {
  fs.writeFileSync(file, body());
  const first = readForgeCache(file);
  const modulePath = "./cache.ts?cached-json-reload";
  const reloaded = await import(modulePath);
  expect(reloaded.readForgeCache).not.toBe(readForgeCache);
  expect(reloaded.readForgeCache(file)).toBe(first);
});

test("updates clone the stored data, invalidate the view and preserve prior snapshots", () => {
  fs.writeFileSync(file, body());
  const first = readForgeCache(file);
  const written = updateForgeCache(data => { data.repositories["acme/widgets"]!.canonical = "acme/renamed"; }, file);
  expect(written).not.toBe(first.data);
  expect(first.data.repositories["acme/widgets"]!.canonical).toBe("acme/widgets");
  const second = readForgeCache(file);
  expect(second.data).toEqual(written);
  expect(second.view).not.toBe(first.view);
  expect(second.view.repository("acme/renamed")).toBe(second.view.repository("acme/widgets"));
  expect(fs.readFileSync(file, "utf8")).toBe(`${JSON.stringify(written)}\n`);
});

test("a same-size same-mtime replacement rebuilds the indexed view", () => {
  const stamp = new Date("2026-10-01T00:00:00Z");
  fs.writeFileSync(file, body("acme/first"));
  fs.utimesSync(file, stamp, stamp);
  const first = readForgeCache(file);
  const replacement = path.join(directory, "replacement.json");
  fs.writeFileSync(replacement, body("acme/other"));
  fs.utimesSync(replacement, stamp, stamp);
  fs.renameSync(replacement, file);
  const second = readForgeCache(file);
  expect(second.view).not.toBe(first.view);
  expect(second.view.repository("acme/other")?.canonical).toBe("acme/other");
  expect(second.view.repository("acme/first")).toBeNull();
});

test("absent and malformed files default to empty without removing malformed bytes", () => {
  expect(readForgeCache(file).data).toEqual({ schemaVersion: 1, repositories: {} });
  fs.writeFileSync(file, "{malformed");
  expect(readForgeCache(file).data).toEqual({ schemaVersion: 1, repositories: {} });
  expect(fs.readFileSync(file, "utf8")).toBe("{malformed");
  fs.writeFileSync(file, body());
  expect(forgeCacheView(file).repository("acme/widgets")).not.toBeNull();
});
