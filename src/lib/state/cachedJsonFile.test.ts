import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cachedJsonFile } from "./cachedJsonFile";

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cached-json-"));
  file = path.join(directory, "record.json");
  fs.writeFileSync(file, '{"value":1}');
});
afterEach(() => {
  mock.restore();
  fs.rmSync(directory, { recursive: true, force: true });
});

const decode = (raw: string | null): { value: number } => JSON.parse(raw ?? '{"value":0}');

test("a warm snapshot needs one stat, no reread or decode, and keeps its reference", () => {
  const decoder = mock(decode);
  const cache = cachedJsonFile(decoder);
  const first = cache.read(file);
  const read = spyOn(fs, "readFileSync");
  const stat = spyOn(fs, "statSync");
  expect(cache.read(file)).toBe(first);
  expect(read).toHaveBeenCalledTimes(0);
  expect(stat).toHaveBeenCalledTimes(1);
  expect(decoder).toHaveBeenCalledTimes(1);
});

test("each owner binds its own decoder and retains only its last path", () => {
  const other = path.join(directory, "other.json");
  fs.writeFileSync(other, '{"value":2}');
  const cache = cachedJsonFile(decode);
  const first = cache.read(file);
  expect(cache.read(other)).toEqual({ value: 2 });
  expect(cache.read(file)).not.toBe(first);
  expect(cachedJsonFile(raw => ({ double: decode(raw).value * 2 })).read(file)).toEqual({ double: 2 });
});

test("explicit invalidation evicts even an unchanged observed token", () => {
  const stat = fs.statSync(file, { bigint: true });
  spyOn(fs, "statSync").mockReturnValue(stat);
  const cache = cachedJsonFile(decode);
  const first = cache.read(file);
  fs.writeFileSync(file, '{"value":2}');
  expect(cache.read(file)).toBe(first);
  cache.invalidate();
  expect(cache.read(file)).toEqual({ value: 2 });
});

test("deletion evicts the snapshot and recreation is read without invalidation", () => {
  const cache = cachedJsonFile(decode);
  expect(cache.read(file)).toEqual({ value: 1 });
  fs.unlinkSync(file);
  expect(cache.read(file)).toEqual({ value: 0 });
  fs.writeFileSync(file, '{"value":2}');
  expect(cache.read(file)).toEqual({ value: 2 });
});

test("a same-size replacement preserving mtime is observed", () => {
  const stamp = new Date("2026-10-01T00:00:00Z");
  fs.utimesSync(file, stamp, stamp);
  const cache = cachedJsonFile(decode);
  expect(cache.read(file)).toEqual({ value: 1 });
  const replacement = path.join(directory, "replacement.json");
  fs.writeFileSync(replacement, '{"value":2}');
  fs.utimesSync(replacement, stamp, stamp);
  fs.renameSync(replacement, file);
  expect(cache.read(file)).toEqual({ value: 2 });
});

for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
  test(`a changed ${field} alone evicts the snapshot`, () => {
    const initial = fs.statSync(file, { bigint: true });
    const stat = spyOn(fs, "statSync").mockReturnValue(initial);
    const cache = cachedJsonFile(decode);
    expect(cache.read(file)).toEqual({ value: 1 });
    fs.writeFileSync(file, '{"value":2}');
    stat.mockReturnValue({ ...initial, [field]: initial[field] + BigInt(1) });
    expect(cache.read(file)).toEqual({ value: 2 });
  });
}

test("replacement during read returns that decode once and leaves the memo cold", () => {
  const read = fs.readFileSync;
  let replaced = false;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
    const raw = read(...args);
    if (!replaced && args[0] === file) {
      replaced = true;
      const replacement = path.join(directory, "replacement.json");
      fs.writeFileSync(replacement, '{"value":2}');
      fs.renameSync(replacement, file);
    }
    return raw;
  }) as typeof read);
  const cache = cachedJsonFile(decode);
  expect(cache.read(file)).toEqual({ value: 1 });
  expect(cache.read(file)).toEqual({ value: 2 });
  expect(spy).toHaveBeenCalledTimes(2);
});

test("an unavailable post-read observation leaves the memo cold", () => {
  const stat = fs.statSync(file, { bigint: true });
  spyOn(fs, "statSync").mockReturnValue(stat)
    .mockReturnValueOnce(stat)
    .mockImplementationOnce(() => { throw new Error("stat refused"); });
  const cache = cachedJsonFile(decode);
  const first = cache.read(file);
  expect(cache.read(file)).toEqual(first);
  expect(cache.read(file)).not.toBe(first);
});

test("a changed post-read token is not published even if the first token returns", () => {
  const initial = fs.statSync(file, { bigint: true });
  spyOn(fs, "statSync").mockReturnValue(initial)
    .mockReturnValueOnce(initial)
    .mockReturnValueOnce({ ...initial, ino: initial.ino + BigInt(1) });
  const cache = cachedJsonFile(decode);
  const first = cache.read(file);
  const second = cache.read(file);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(cache.read(file)).toBe(second);
});

test("unavailable input delegates fallback to the decoder on every read", () => {
  const decoder = mock(decode);
  const cache = cachedJsonFile(decoder);
  const first = cache.read(file);
  const spy = spyOn(fs, "statSync").mockImplementation(() => { throw new Error("stat refused"); });
  expect(cache.read(file)).toEqual({ value: 0 });
  expect(cache.read(file)).toEqual({ value: 0 });
  expect(decoder.mock.calls.slice(1)).toEqual([[null], [null]]);
  spy.mockRestore();
  const recovered = cache.read(file);
  expect(recovered).toEqual({ value: 1 });
  expect(recovered).not.toBe(first);
});

test("unreadable input is not memoized, so recovery at the same token retries", () => {
  const cache = cachedJsonFile(decode);
  const spy = spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("read refused"); });
  expect(cache.read(file)).toEqual({ value: 0 });
  spy.mockRestore();
  expect(cache.read(file)).toEqual({ value: 1 });
});

test("malformed input can fall back or throw, without removing the source", () => {
  fs.writeFileSync(file, "{malformed");
  const tolerant = cachedJsonFile(raw => {
    try { return decode(raw); } catch { return { value: -1 }; }
  });
  const fallback = tolerant.read(file);
  expect(tolerant.read(file)).toBe(fallback);
  expect(fallback).toEqual({ value: -1 });
  const strict = cachedJsonFile(decode);
  expect(() => strict.read(file)).toThrow();
  expect(() => strict.read(file)).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("{malformed");
  fs.writeFileSync(file, '{"value":2}');
  expect(strict.read(file)).toEqual({ value: 2 });
  expect(tolerant.read(file)).toEqual({ value: 2 });
});

test("a fresh process starts cold even when the file token is unchanged", async () => {
  const script = `
    const { cachedJsonFile } = await import("./src/lib/state/cachedJsonFile.ts");
    let reads = 0;
    const cache = cachedJsonFile(raw => { reads++; return JSON.parse(raw); });
    cache.read(process.argv[1]);
    cache.read(process.argv[1]);
    console.log(reads);
  `;
  for (let run = 0; run < 2; run++) {
    const child = Bun.spawn([process.execPath, "-e", script, file], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    expect(output.trim()).toBe("1");
  }
});
