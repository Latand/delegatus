import { afterAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HISTORY_MAX_BYTES, historyReadBytes, readHistoryChunk, readTailChunk } from "@/lib/logRead";
import { MAX_CHUNK } from "@/lib/scanner/roots";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "log-read-"));
afterAll(() => fs.rm(sandbox, { recursive: true, force: true }));

async function writeLog(name: string, data: string | Buffer): Promise<string> {
  const file = path.join(sandbox, name);
  await fs.writeFile(file, data);
  return file;
}

const allowed = () => true;

describe("UTF-8 tail boundaries", () => {
  for (const character of ["Ж", "€", "😀"]) {
    const width = Buffer.byteLength(character);
    for (let split = 1; split < width; split += 1) {
      test(`${width}-byte character split after byte ${split} at the default window`, async () => {
        const prefix = "a".repeat(MAX_CHUNK - split);
        const text = prefix + character + "tail";
        const file = await writeLog(`window-${width}-${split}`, text);
        const first = (await readTailChunk(file, 0, undefined, allowed))!;
        expect(first).toEqual({ start: 0, offset: prefix.length, size: Buffer.byteLength(text), data: prefix });
        const last = (await readTailChunk(file, first.offset, undefined, allowed))!;
        expect(last.start).toBe(first.offset);
        expect(last.offset).toBe(Buffer.byteLength(text));
        expect(first.data + last.data).toBe(text);
      });

      test(`${width}-byte character held until an incremental append completes byte ${split}`, async () => {
        const bytes = Buffer.from(character);
        const file = await writeLog(`append-${width}-${split}`, Buffer.concat([Buffer.from("a"), bytes.subarray(0, split)]));
        const first = (await readTailChunk(file, 0, undefined, allowed))!;
        expect(first).toEqual({ start: 0, offset: 1, size: 1 + split, data: "a" });
        const idle = await readTailChunk(file, first.offset, undefined, allowed);
        expect(idle).toEqual({ start: 1, offset: 1, size: 1 + split, data: "" });
        await fs.appendFile(file, bytes.subarray(split));
        const last = (await readTailChunk(file, first.offset, undefined, allowed))!;
        expect(last).toEqual({ start: 1, offset: 1 + width, size: 1 + width, data: character });
      });

      test(`${width}-byte first character waits for a sufficient byte budget after byte ${split}`, async () => {
        const file = await writeLog(`first-${width}-${split}`, character + "end");
        expect(await readTailChunk(file, 0, split, allowed)).toEqual({ start: 0, offset: 0, size: width + 3, data: "" });
        expect(await readTailChunk(file, 0, width, allowed)).toEqual({ start: 0, offset: width, size: width + 3, data: character });
        expect(await readTailChunk(file, width, 3, allowed)).toEqual({ start: width, offset: width + 3, size: width + 3, data: "end" });
      });

      test(`${width}-byte character crossing a jumped tail window remains in history after byte ${split}`, async () => {
        const tail = "x".repeat(MAX_CHUNK - (width - split));
        const text = "head\n" + character + tail;
        const file = await writeLog(`jump-${width}-${split}`, text);
        const last = (await readTailChunk(file, 0, undefined, allowed))!;
        expect(last).toEqual({ start: 5 + width, offset: Buffer.byteLength(text), size: Buffer.byteLength(text), data: tail });
        expect(await readHistoryChunk(file, last.start, undefined, allowed)).toEqual({ start: 0, offset: 0, size: Buffer.byteLength(text), data: "head\n" + character });
      });
    }
  }

  test("UTF-8 scalar range edges are retained until complete", async () => {
    for (const point of [0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff]) {
      const character = String.fromCodePoint(point);
      const width = Buffer.byteLength(character);
      const file = await writeLog(`scalar-${point}`, "a" + character);
      for (let split = 1; split < width; split += 1) {
        const first = (await readTailChunk(file, 0, 1 + split, allowed))!;
        const last = (await readTailChunk(file, first.offset, undefined, allowed))!;
        expect(first.offset).toBe(1);
        expect(first.data + last.data).toBe("a" + character);
        expect(last.offset).toBe(1 + width);
      }
    }
  });

  test("one-byte filesystem reads still decode complete slices in both directions", async () => {
    const text = "Ж€😀end";
    const file = await writeLog("short-reads", text);
    const open = fs.open.bind(fs);
    const opened: fs.FileHandle[] = [];
    const opening = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      opened.push(handle);
      const read = handle.read.bind(handle);
      handle.read = ((buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 1), position)) as typeof handle.read;
      return handle;
    });
    try {
      expect(await readTailChunk(file, 0, undefined, allowed)).toEqual({ start: 0, offset: 12, size: 12, data: text });
      expect(await readHistoryChunk(file, 12, undefined, allowed)).toEqual({ start: 0, offset: 0, size: 12, data: text });
      expect(opened.length).toBe(2);
      expect(opened.every(handle => handle.fd === -1)).toBe(true);
    } finally {
      opening.mockRestore();
      await Promise.all(opened.map(handle => handle.close()));
    }
  });

  test("backward pages retain the first and last multibyte characters and their byte cursors", async () => {
    const file = await writeLog("backward-edges", "Ж€😀");
    expect(await readHistoryChunk(file, 9, 2, allowed)).toEqual({ start: 9, offset: 9, size: 9, data: "" });
    expect(await readHistoryChunk(file, 9, 4, allowed)).toEqual({ start: 5, offset: 5, size: 9, data: "😀" });
    expect(await readHistoryChunk(file, 5, 4, allowed)).toEqual({ start: 2, offset: 2, size: 9, data: "€" });
    expect(await readHistoryChunk(file, 2, 4, allowed)).toEqual({ start: 0, offset: 0, size: 9, data: "Ж" });
  });

  test("invalid UTF-8 advances with the ordinary replacement decoding", async () => {
    for (const bytes of [[0x80], [0xc0], [0xe0, 0x80], [0xed, 0xa0], [0xf0, 0x80], [0xf4, 0x90], [0xf5], [0xe2, 0x41]]) {
      const input = Buffer.from(bytes);
      const file = await writeLog(`invalid-${bytes.join("-")}`, input);
      expect(await readTailChunk(file, 0, undefined, allowed)).toEqual({ start: 0, offset: input.length, size: input.length, data: input.toString("utf8") });
    }
  });

  test("refused and missing files return no data in either direction", async () => {
    const file = await writeLog("refused", "Ж€😀");
    for (const read of [readTailChunk, readHistoryChunk]) {
      expect(await read(file, 0, undefined, () => false)).toBeNull();
      expect(await read(path.join(sandbox, "missing"), 0, undefined, allowed)).toBeNull();
      expect(await read(sandbox, 0, undefined, allowed)).toBeNull();
    }
  });

  test("ASCII byte budgets and cursors are unchanged", async () => {
    const file = await writeLog("ascii", "abcdef\n");
    expect(await readTailChunk(file, 0, 3, allowed)).toEqual({ start: 0, offset: 3, size: 7, data: "abc" });
    expect(await readTailChunk(file, 3, 3, allowed)).toEqual({ start: 3, offset: 6, size: 7, data: "def" });
    expect(await readTailChunk(file, 6, 0, allowed)).toEqual({ start: 6, offset: 6, size: 7, data: "" });
    expect(await readTailChunk(file, 6, 3, allowed)).toEqual({ start: 6, offset: 7, size: 7, data: "\n" });
    expect(await readHistoryChunk(file, 7, 3, allowed)).toEqual({ start: 4, offset: 4, size: 7, data: "ef\n" });
    expect(await readHistoryChunk(file, 4, 3, allowed)).toEqual({ start: 1, offset: 1, size: 7, data: "bcd" });
    expect(await readHistoryChunk(file, 1, 3, allowed)).toEqual({ start: 0, offset: 0, size: 7, data: "a" });
    expect(await readHistoryChunk(file, 0, 3, allowed)).toEqual({ start: 0, offset: 0, size: 7, data: "" });
  });
});

describe("historyReadBytes", () => {
  test("an older-history read without a size is one tail window", () => {
    expect(historyReadBytes(null)).toBe(MAX_CHUNK);
  });

  test("a larger page is honoured up to the server's cap", () => {
    expect(historyReadBytes(String(2 * MAX_CHUNK))).toBe(2 * MAX_CHUNK);
    expect(historyReadBytes(String(HISTORY_MAX_BYTES))).toBe(HISTORY_MAX_BYTES);
    expect(historyReadBytes(String(HISTORY_MAX_BYTES * 64))).toBe(HISTORY_MAX_BYTES);
  });

  test("a size that is too small, negative or not a number falls back safely", () => {
    expect(historyReadBytes("1")).toBe(MAX_CHUNK);
    expect(historyReadBytes("-5000000")).toBe(MAX_CHUNK);
    expect(historyReadBytes("lots")).toBe(MAX_CHUNK);
    expect(historyReadBytes("Infinity")).toBe(MAX_CHUNK);
    expect(historyReadBytes("")).toBe(MAX_CHUNK);
  });
});
