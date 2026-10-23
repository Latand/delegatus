import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { knownValueFingerprint } from "./generate-privacy-known-value-fingerprints";
import { runPrivacyTestProcess } from "./privacy-test-process";

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

test("the committed catalog permits open-source prose", async () => {
  const scanner = await inspector("unrelated fixture value", false, false,
    join(import.meta.dir, "privacy-known-value-fingerprints.json"));

  for (const spelling of ["open-source", "open source", ["open", "source"].join("")]) {
    expect(scanner.sensitiveClasses(`the ${spelling} core`).has("known_value"), spelling).toBe(false);
  }
});

test("the dictionary phrase remains private in identity fields and account paths", async () => {
  const scanner = await inspector("unrelated fixture value", false, false,
    join(import.meta.dir, "privacy-known-value-fingerprints.json"));
  const label = ["open", "source"].join("");
  const sources = [
    `account_id="${label}"`, `{"accountId":"${label}"}`, `data-account-id='${label}'`,
    JSON.stringify({ accountLabel: label }), `account_label: ${label}`, `account-label = ${label}`,
    ...["\n", "\r\n", "\t\n "].map(space => `{"accountId":${space}"${label}"}`),
    `{"accountId"\n:\n"${label}"}`, `accountLabel\n=\n${label}`,
    `id="${label}"`, `account_name: ${label}`, `user_id: ${label}`, `username: ${label}`, `handle = ${label}`, `hostname=${label}`, `@${label}`,
    `accounts/claude/${label}/sessions`, `accounts/codex/${label}/sessions`,
    `accounts/copilot/${label}/sessions`, `accounts/${label}/sessions`,
    `accounts\\codex\\${label}\\sessions`,
  ];
  for (const source of sources) {
    for (const encoded of [source, source.toUpperCase(), encodeURIComponent(source),
      Array.from(source).map(char => `&#${char.codePointAt(0)};`).join("")]) {
      expect(scanner.sensitiveClasses(encoded).has("known_value"), source).toBe(true);
    }
    expect(scanner.sensitiveClasses(source.replaceAll(label, `prefix${label}suffix`)).has("known_value"), source).toBe(false);
  }
});

test("identity-context findings reach file and commit inspection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "privacy-identity-context-"));
  try {
    const scanner = await inspector("unrelated fixture value", false, false,
      join(import.meta.dir, "privacy-known-value-fingerprints.json"));
    const label = ["open", "source"].join("");
    const file = join(directory, "sample.txt");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", directory, ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-23T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-23T10:00:00Z", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" },
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    git("init", "--initial-branch=main");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture base");
    const cli = (args: string[]) => runPrivacyTestProcess({
      cmd: [process.execPath, join(import.meta.dir, "privacy-publication-gate.ts"),
        "--require-known-values", "--repository", directory, ...args, "--paths", file],
      env: { ...process.env, LLV_PRIVACY_KNOWN_VALUES: "", LLV_PRIVACY_KNOWN_VALUES_FILE: "",
        LLV_PRIVACY_KNOWN_VALUES_FORMAT: "plain",
        LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: join(import.meta.dir, "privacy-known-value-fingerprints.json") },
      stdout: "pipe", stderr: "pipe",
    });
    for (const { source, privateValue } of [
      ...[`account_id="${label}"`, JSON.stringify({ accountLabel: label }), `{"accountId":\n"${label}"}`]
        .map(source => ({ source, privateValue: true })),
      ...["open-source", "open source", label]
        .map(spelling => ({ source: `the ${spelling} core`, privateValue: false })),
    ]) {
      writeFileSync(file, source);
      expect(scanner.inspectPaths([file], false, true, directory).has("known_value"), source).toBe(privateValue);
      const fileResult = await cli([]);
      expect(fileResult.exitCode, source).toBe(privateValue ? 1 : 0);
      expect(fileResult.stdout.toString(), source).toStartWith(privateValue
        ? "PRIVACY GATE: FAIL\nknown_value: 1\n" : "PRIVACY GATE: PASS\n");
      expect(fileResult.stdout.toString()).not.toContain(label);
      expect(fileResult.stderr.toString()).toBe("");

      const base = git("rev-parse", "HEAD");
      git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", source);
      expect(scanner.commitMessageFindings(directory, base).has("known_value"), source).toBe(privateValue);
      writeFileSync(file, "safe publication prose");
      const commitResult = await cli(["--check-commits", "--base", base]);
      expect(commitResult.exitCode, source).toBe(privateValue ? 1 : 0);
      expect(commitResult.stdout.toString(), source).toContain(privateValue ? "known_value: 1\n" : "PRIVACY GATE: PASS\n");
      expect(commitResult.stdout.toString()).not.toContain(label);
      expect(commitResult.stderr.toString()).toBe("");
    }
    expect(scanner.commitMessageFindings(directory, "HEAD").size).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
