import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, spyOn, test } from "bun:test";

import { fsyncPath, writeJsonDurably } from "./durableJson";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-durable-json-test-"));
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

/* Windows refuses to open a directory for fsync, after the rename already
   published the file, and flushes a file only through a writable handle; the
   durable write must not report either as a failure. */
test("a directory fsync is skipped on Windows, a file is flushed writable there, and both run elsewhere", () => {
  const open = fs.openSync;
  const flags: unknown[] = [];
  const refuseDirectories = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    if (fs.statSync(target).isDirectory()) throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
    flags.push(rest[0]);
    return (open as (...args: unknown[]) => number)(target, ...rest);
  }) as typeof fs.openSync);
  try {
    expect(() => fsyncPath(SANDBOX, "win32")).not.toThrow();
    expect(() => fsyncPath(SANDBOX, "linux")).toThrow("EISDIR");
    const file = path.join(SANDBOX, "record.json");
    fs.writeFileSync(file, "{}\n");
    expect(() => fsyncPath(file, "win32")).not.toThrow();
    expect(flags).toEqual(["r+"]);
    /* The read-only flush is EPERM on a real Windows host, which is the point. */
    if (process.platform !== "win32") {
      expect(() => fsyncPath(file, "linux")).not.toThrow();
      expect(flags).toEqual(["r+", "r"]);
    }
  } finally {
    refuseDirectories.mockRestore();
  }
  writeJsonDurably(path.join(SANDBOX, "written.json"), { a: 1 });
  expect(JSON.parse(fs.readFileSync(path.join(SANDBOX, "written.json"), "utf8"))).toEqual({ a: 1 });
});


for (const failure of ["none", "write", "file flush", "rename", "directory flush"] as const) {
  test.skipIf(process.platform === "win32")(`durable publication order and cleanup: ${failure}`, () => {
    const directory = fs.mkdtempSync(path.join(SANDBOX, "ordered-"));
    const target = path.join(directory, "record.json");
    fs.writeFileSync(target, "old\n");
    const previousMode = fs.statSync(target).mode & 0o777;
    const events: string[] = [];
    const write = fs.writeFileSync;
    const flush = fs.fsyncSync;
    const rename = fs.renameSync;
    const step = (name: string) => {
      events.push(name);
      if (failure === name) throw new Error(name);
    };
    const spies = [
      spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof write>) => {
        step("write");
        return write(...args);
      }) as typeof write),
      spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        step(fs.fstatSync(fd).isDirectory() ? "directory flush" : "file flush");
        flush(fd);
      }),
      spyOn(fs, "renameSync").mockImplementation((from, to) => {
        step("rename");
        rename(from, to);
      }),
    ];
    try {
      if (failure === "none") writeJsonDurably(target, { next: true });
      else expect(() => writeJsonDurably(target, { next: true })).toThrow(failure);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const order = ["write", "file flush", "rename", "directory flush"];
    expect(events).toEqual(failure === "none" ? order : order.slice(0, order.indexOf(failure) + 1));
    // A failed directory flush cannot retract the published bytes. This tests
    // acknowledgement and ordering, not physical power-loss durability.
    expect(fs.readFileSync(target, "utf8")).toBe(
      failure === "none" || failure === "directory flush" ? '{\n  "next": true\n}\n' : "old\n",
    );
    expect(fs.readdirSync(directory)).toEqual(["record.json"]);
    expect(fs.statSync(target).mode & 0o777).toBe(failure === "none" || failure === "directory flush" ? 0o600 : previousMode);
  });
}
