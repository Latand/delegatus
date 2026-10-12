import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { knownValueFingerprint } from "./generate-privacy-known-value-fingerprints";

let inspectorNumber = 0;
async function inspector(value: string, exactOnly: boolean, plaintext: boolean, catalog: string) {
  const names = ["LLV_PRIVACY_KNOWN_VALUES", "LLV_PRIVACY_KNOWN_VALUES_FORMAT",
    "LLV_PRIVACY_KNOWN_VALUES_FILE", "LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE"] as const;
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.LLV_PRIVACY_KNOWN_VALUES = plaintext ? JSON.stringify({ value, exactOnly }) : "";
    process.env.LLV_PRIVACY_KNOWN_VALUES_FORMAT = "jsonl";
    delete process.env.LLV_PRIVACY_KNOWN_VALUES_FILE;
    process.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE = catalog;
    return await import(`./privacy-publication-gate.ts?plaintext-reference=${inspectorNumber++}`) as typeof import("./privacy-publication-gate");
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
}

test("plaintext and opaque inspectors preserve complete reports across Unicode publication views", async () => {
  const directory = mkdtempSync(join(tmpdir(), "privacy-plaintext-reference-"));
  try {
    const catalog = join(directory, "catalog.json");
    const file = join(directory, "sample.txt");
    for (const value of ["syntheticascii", "ééééletters", "e\u0301ééletters", "𐐀𐐀𐐀𐐀letters", "＿ＦＵＬＬletters"]) {
      for (const exactOnly of [false, true]) {
        writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
          fingerprints: [knownValueFingerprint({ value, exactOnly })] }));
        const opaque = await inspector(value, exactOnly, false, catalog);
        const plain = await inspector(value, exactOnly, true, catalog);
        for (const source of [value, `prefix ${value} suffix`, value.toUpperCase(), value.normalize("NFKC"),
          encodeURIComponent(value), Array.from(value).map((char) => `&#${char.codePointAt(0)};`).join(""),
          JSON.stringify(value), value.slice(0, 4) + "**" + value.slice(4),
          value.slice(0, 4) + "\n" + value.slice(4), `\0${value}`, value.slice(0, 3), "unmatched text"]) {
          writeFileSync(file, source);
          const expectedNotices: string[] = [];
          const actualNotices: string[] = [];
          const expected = opaque.inspectPaths([file], false, true, directory, undefined, expectedNotices);
          const actual = plain.inspectPaths([file], false, true, directory, undefined, actualNotices);
          expect(actual).toEqual(expected);
          expect(plain.formatPrivacyReport(actual, actualNotices))
            .toBe(opaque.formatPrivacyReport(expected, expectedNotices));
        }
        expect(plain.sensitiveClasses(value).has("known_value")).toBe(true);
        expect(opaque.sensitiveClasses("unmatched text").has("known_value")).toBe(false);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replacement bytes and lone surrogates retain exact fingerprint aliases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "privacy-plaintext-alias-"));
  try {
    const catalog = join(directory, "catalog.json");
    for (const middle of ["\ufffd", "\ud800", "\udc00"]) {
      const value = `head${middle}tail`;
      writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
        fingerprints: [knownValueFingerprint({ value, exactOnly: true })] }));
      const plain = await inspector(value, true, true, catalog);
      const opaque = await inspector(value, true, false, catalog);
      for (const alias of ["\ufffd", "\ud800", "\udc00"]) {
        const source = `head${alias}tail`;
        expect(plain.sensitiveClasses(source)).toEqual(opaque.sensitiveClasses(source));
        expect(plain.sensitiveClasses(source).has("known_value")).toBe(true);
      }
    }
    // Compact plaintext must not replace an opaque exact-policy fingerprint.
    const value = "éééé-letters";
    writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
      fingerprints: [knownValueFingerprint({ value, exactOnly: true })] }));
    const plain = await inspector(value, false, true, catalog);
    expect(plain.sensitiveClasses(value).has("known_value")).toBe(true);
    const unrelated = await inspector("different letters", false, true, catalog);
    expect(unrelated.sensitiveClasses(value).has("known_value")).toBe(true);
    expect(unrelated.sensitiveClasses("unmatched text").has("known_value")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("negative windows across files cannot hide later matches or another inspector's policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "privacy-negative-reference-"));
  try {
    const catalog = join(directory, "catalog.json");
    const value = "éééé-negative-window-letters";
    for (const exactOnly of [false, true]) {
      writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
        fingerprints: [knownValueFingerprint({ value, exactOnly }), knownValueFingerprint({ value: "other phrase", exactOnly })] }));
      const opaque = await inspector(value, exactOnly, false, catalog);
      const prefix = "repeated safe prose ".repeat(1500);
      expect(opaque.sensitiveClasses(prefix).has("known_value")).toBe(false);
      expect(opaque.sensitiveClasses(prefix + "other phrase").has("known_value")).toBe(true);
      expect(opaque.sensitiveClasses(prefix + value).has("known_value")).toBe(true);
      expect(opaque.sensitiveClasses("other phrase" + prefix).has("known_value")).toBe(true);
      expect(opaque.sensitiveClasses(prefix + " safe suffix").has("known_value")).toBe(false);
    }
    writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
      fingerprints: [knownValueFingerprint({ value: "safe prose" })] }));
    const other = await inspector("safe prose", false, false, catalog);
    expect(other.sensitiveClasses("repeated safe prose ".repeat(1500)).has("known_value")).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
