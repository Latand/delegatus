import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { fingerprintWindowDigest, matchesFingerprintWindows } from "./privacy-publication-gate";

function referenceDigest(window: string): string {
  return createHash("sha256").update(window).digest("hex");
}

function referenceMatch(text: string, length: number, hashes: ReadonlySet<string>): boolean {
  for (let index = 0; index <= text.length - length; index += 1) {
    if (hashes.has(referenceDigest(text.slice(index, index + length)))) return true;
  }
  return false;
}

test("fingerprint matching compares the entire digest and exact catalog spelling", () => {
  const text = "synthetic full digest control";
  const hash = referenceDigest(text);
  const samePrefix = hash.slice(0, -1) + (hash.endsWith("0") ? "1" : "0");
  for (const candidate of [samePrefix, hash.toUpperCase(), " " + hash, hash + ".", hash.slice(0, -1)]) {
    const hashes = new Set([candidate]);
    expect(matchesFingerprintWindows(text, text.length, hashes)).toBe(referenceMatch(text, text.length, hashes));
    expect(matchesFingerprintWindows(text, text.length, hashes)).toBe(false);
    hashes.add(hash);
    expect(matchesFingerprintWindows(text, text.length, hashes)).toBe(true);
  }
});

test("fingerprint digests match node crypto on Unicode and every sliding window", () => {
  const cases = ["", "ascii", "é", "e\u0301", "💡", "\ud800", "\udc00", "a\0b", "＿Ｆ", "\ufffd"];
  const source = "abcdefé💡e\u0301\ud800\0＿".repeat(6250);
  for (const value of cases) expect(fingerprintWindowDigest(value)).toBe(referenceDigest(value));
  for (let index = 0; index <= source.length - 18; index += 1) {
    const window = source.slice(index, index + 18);
    expect(fingerprintWindowDigest(window)).toBe(referenceDigest(window));
  }
});

test("fingerprint verdicts retain short, final, separator and block-crossing windows", () => {
  const missing = new Set([referenceDigest("absent synthetic phrase")]);
  for (const text of ["", "💡a\0b\ud800", "abcdef", "abcdef\0abcdef", "\0\0a\0\0b\0"]) {
    for (const length of [4, 5, 8, 12, 512]) {
      expect(matchesFingerprintWindows(text, length, missing)).toBe(referenceMatch(text, length, missing));
      for (let index = 0; index <= text.length - length; index += 1) {
        const hashes = new Set([referenceDigest(text.slice(index, index + length))]);
        expect(matchesFingerprintWindows(text, length, hashes)).toBe(referenceMatch(text, length, hashes));
      }
    }
  }
  const view = "synthetic text 💡 é ".repeat(1000);
  const text = `${view}\0${view}\0${view}unique tail`;
  for (const length of [4, 18, 512]) {
    for (const start of [16_383, 16_384, view.length - 2, view.length, text.length - length]) {
      const hashes = new Set([referenceDigest(text.slice(start, start + length))]);
      expect(matchesFingerprintWindows(text, length, hashes)).toBe(referenceMatch(text, length, hashes));
    }
    expect(matchesFingerprintWindows(text, length, missing)).toBe(referenceMatch(text, length, missing));
  }
});

test("negative cache eviction retains later fingerprint matches", () => {
  const text = Array.from({ length: 80_000 }, (_, index) => `${index.toString(36).padStart(5, "a")} `).join("");
  const ending = text.slice(-12);
  expect(matchesFingerprintWindows(text, 12, new Set([referenceDigest(ending)])))
    .toBe(referenceMatch(text, 12, new Set([referenceDigest(ending)])));
  // Evict the block cache too, then retain a final-window match.
  const large = Array.from({ length: 1040 }, (_, index) => `${index} ${"x".repeat(16_384)}`).join("");
  const tail = "after eviction phrase";
  expect(matchesFingerprintWindows(large + tail, tail.length, new Set([referenceDigest(tail)]))).toBe(true);
}, 20_000);
