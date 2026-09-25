import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, spyOn, test } from "bun:test";

import { fsyncPath, writeJsonDurably } from "./durableJson";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-durable-json-test-"));
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

/* Windows refuses to open a directory for fsync, after the rename already
   published the file; the durable write must not report that as a failure. */
test("a directory fsync is skipped on Windows and still runs elsewhere", () => {
  const open = fs.openSync;
  const refuseDirectories = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    if (fs.statSync(target).isDirectory()) throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
    return (open as (...args: unknown[]) => number)(target, ...rest);
  }) as typeof fs.openSync);
  try {
    expect(() => fsyncPath(SANDBOX, "win32")).not.toThrow();
    expect(() => fsyncPath(SANDBOX, "linux")).toThrow("EISDIR");
    const file = path.join(SANDBOX, "record.json");
    fs.writeFileSync(file, "{}\n");
    expect(() => fsyncPath(file, "win32")).not.toThrow();
  } finally {
    refuseDirectories.mockRestore();
  }
  writeJsonDurably(path.join(SANDBOX, "written.json"), { a: 1 });
  expect(JSON.parse(fs.readFileSync(path.join(SANDBOX, "written.json"), "utf8"))).toEqual({ a: 1 });
});
