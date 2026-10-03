import { describe, expect, test } from "bun:test";

import { HISTORY_MAX_BYTES, historyReadBytes } from "@/lib/logRead";
import { MAX_CHUNK } from "@/lib/scanner/roots";

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
